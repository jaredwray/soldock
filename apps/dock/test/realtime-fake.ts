import { vi } from "vitest";

// A stand-in for the Cloudflare Realtime API in the workerd tests. It replaces `fetch`, keeps the sessions and the
// tracks in memory, and records each call. It checks the App Secret and the TURN key token, so a test proves that
// the Worker sends them, and only to the Realtime API.
//
// Each stand-in puts a random tag in its session ids and its TURN user names. The meeting object of an earlier test
// can still run its alarm, and that alarm can close tracks or revoke a credential. Such a call has the tag of a
// different stand-in: it gets the answer for an unknown id, and it is not in `calls`.

export const REALTIME_BASE = "https://rtc.live.cloudflare.com/v1";
const APP_ID = "testrealtimeapp00000000000000001";
const APP_SECRET = "test-realtime-app-secret";
const TURN_KEY_ID = "testturnkey000000000000000000001";
const TURN_TOKEN = "test-turn-key-token";

export interface RealtimeCall {
	method: string;
	/** The path after the base, such as `/apps/<id>/sessions/new`. */
	path: string;
	body: Record<string, unknown> | null;
}

interface FakeTrack {
	trackName: string;
	mid: string;
	location: "local" | "remote";
	open: boolean;
	/** For a pull: the publisher session and track name. */
	source?: { sessionId: string; trackName: string };
}

export interface RealtimeFake {
	calls: RealtimeCall[];
	/** The calls whose path ends with this text. */
	callsTo(suffix: string): RealtimeCall[];
	/** The open tracks of a session. */
	openTracks(sessionId: string): FakeTrack[];
	/** The session ids that the fake made, in order. */
	sessions: string[];
	/** Makes the next SFU call fail with this status. With `match`, the next call whose method and path (`GET /apps/…`) contain that text. */
	failNext(status: number, match?: string): void;
	/** The next push or pull makes its tracks, and then gives no answer, as a request that timed out. */
	loseNextAnswer(): void;
	/**
	 * The next push or pull makes its tracks, and then gives the answer of `make` in place of the usual one. `make`
	 * gets the usual body.
	 */
	replaceNextAnswer(make: (usual: Record<string, unknown>) => Response): void;
	/** The SFU no longer has this session, as after its life ended. Each later call for it gets 410. */
	endSession(sessionId: string): void;
}

/** Installs the stand-in. Other requests reach a 599 answer, so a test sees a call to an unknown host. */
export function fakeRealtime(): RealtimeFake {
	const calls: RealtimeCall[] = [];
	const sessions = new Map<string, FakeTrack[]>();
	const order: string[] = [];
	let failStatus: number | null = null;
	let failMatch = "";
	let loseAnswer = false;
	let replaceAnswer: ((usual: Record<string, unknown>) => Response) | null = null;
	let counter = 0;
	const tag = crypto.randomUUID().slice(0, 8);
	const foreign = (path: string) => {
		const made = /\/(?:sessions\/s|credentials\/user)([0-9a-f]{8})-\d+(?:\/|$)/.exec(path);
		return made !== null && made[1] !== tag;
	};
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const outgoing = new Request(input, init);
		const url = new URL(outgoing.url);
		if (!outgoing.url.startsWith(REALTIME_BASE)) return new Response("unknown host", { status: 599 });
		const path = url.pathname.slice("/v1".length);
		const text = await outgoing.text();
		const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
		if (foreign(path)) {
			if (path.startsWith("/turn/")) return new Response("{}", { status: 404 });
			return Response.json({ errorCode: "session_error" }, { status: 410 });
		}
		calls.push({ method: outgoing.method, path, body });
		const auth = outgoing.headers.get("authorization");
		if (path.startsWith("/turn/")) {
			if (auth !== `Bearer ${TURN_TOKEN}` || !path.startsWith(`/turn/keys/${TURN_KEY_ID}/`)) {
				return new Response("{}", { status: 401 });
			}
			if (path.endsWith("/revoke")) return new Response(null, { status: 204 });
			return Response.json(
				{
					iceServers: [
						{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
						{
							urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:53?transport=udp"],
							username: `user${tag}-${++counter}`,
							credential: "secret",
						},
					],
				},
				{ status: 201 },
			);
		}
		if (auth !== `Bearer ${APP_SECRET}` || !path.startsWith(`/apps/${APP_ID}/`)) {
			return Response.json({ errorCode: "unauthorized" }, { status: 401 });
		}
		if (failStatus !== null && `${outgoing.method} ${path}`.includes(failMatch)) {
			const status = failStatus;
			failStatus = null;
			return Response.json({ errorCode: "retryable_transient_error", errorDescription: "test" }, { status });
		}
		const rest = path.slice(`/apps/${APP_ID}`.length);
		if (rest === "/sessions/new") {
			const id = `s${tag}-${String(++counter).padStart(22, "0")}`;
			sessions.set(id, []);
			order.push(id);
			return Response.json({ sessionId: id }, { status: 201 });
		}
		const match = /^\/sessions\/([^/]+)(\/.*)?$/.exec(rest);
		const tracks = match ? sessions.get(match[1] as string) : undefined;
		if (!match || !tracks) return Response.json({ errorCode: "session_error" }, { status: 410 });
		const action = match[2] ?? "";
		const items = (body?.tracks ?? []) as { location?: string; mid?: string; trackName?: string; sessionId?: string }[];
		if (action === "/tracks/new") {
			const local = items.filter((item) => item.location === "local");
			const lose = loseAnswer;
			loseAnswer = false;
			const replace = replaceAnswer;
			replaceAnswer = null;
			const respond = (usual: Record<string, unknown>) => (replace ? replace(usual) : Response.json(usual));
			if (local.length > 0) {
				for (const item of local) {
					tracks.push({ trackName: item.trackName as string, mid: item.mid as string, location: "local", open: true });
				}
				if (lose) throw new Error("no answer");
				return respond({
					requiresImmediateRenegotiation: false,
					tracks: local.map((item) => ({ mid: item.mid, trackName: item.trackName })),
					sessionDescription: { type: "answer", sdp: "v=0 answer" },
				});
			}
			const out = items.map((item) => {
				const source = sessions.get(item.sessionId as string)?.find((t) => t.trackName === item.trackName && t.open);
				if (!source) {
					return { trackName: item.trackName, sessionId: item.sessionId, errorCode: "not_found_track_error" };
				}
				const mid = String(tracks.length);
				tracks.push({
					trackName: `pull-${mid}`,
					mid,
					location: "remote",
					open: true,
					source: { sessionId: item.sessionId as string, trackName: item.trackName as string },
				});
				return { mid, trackName: item.trackName, sessionId: item.sessionId };
			});
			if (lose) throw new Error("no answer");
			return respond({
				requiresImmediateRenegotiation: true,
				tracks: out,
				sessionDescription: { type: "offer", sdp: "v=0 offer" },
			});
		}
		if (action === "/renegotiate") return Response.json({});
		if (action === "" && outgoing.method === "GET") {
			return Response.json({
				tracks: tracks.map((track) => ({
					location: track.location,
					mid: track.mid,
					trackName: track.trackName,
					status: track.open ? "active" : "inactive",
				})),
			});
		}
		if (action === "/tracks/close") {
			return Response.json({
				requiresImmediateRenegotiation: false,
				tracks: items.map((item) => {
					const track = tracks.find((t) => t.mid === item.mid && t.open);
					if (!track) return { mid: item.mid, errorCode: "close_track_error" };
					track.open = false;
					return { mid: item.mid };
				}),
			});
		}
		return Response.json({ errorCode: "not_found" }, { status: 404 });
	});
	return {
		calls,
		callsTo: (suffix) => calls.filter((call) => call.path.endsWith(suffix)),
		openTracks: (sessionId) => (sessions.get(sessionId) ?? []).filter((track) => track.open),
		sessions: order,
		failNext(status, match = "") {
			failStatus = status;
			failMatch = match;
		},
		loseNextAnswer() {
			loseAnswer = true;
		},
		replaceNextAnswer(make) {
			replaceAnswer = make;
		},
		endSession(sessionId) {
			sessions.delete(sessionId);
		},
	};
}
