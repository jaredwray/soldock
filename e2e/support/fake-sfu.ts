// A stand-in for the Cloudflare Realtime SFU, for the tests of pull requests. They run with no Cloudflare
// credentials. The server speaks the subset of the Connection API that the meet module calls: sessions/new,
// tracks/new (push and pull), renegotiate, tracks/close and GET session, and the TURN generate-ice-servers call.
// One headless Chromium page holds one real RTCPeerConnection for each SFU session. It sends a received track
// to each subscriber connection. So the browsers of a test send and receive real media through it.
//
// It proves the gate, the brokering and the client logic of Asterra. It does not prove the paths of the real
// SFU. The live-meet workflow runs the same specs against Cloudflare Realtime.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type Browser, chromium, type Page } from "@playwright/test";

export const FAKE_SFU_PORT = 8798;
export const FAKE_SFU_BASE = `http://127.0.0.1:${FAKE_SFU_PORT}/v1`;
export const FAKE_APP_ID = "e2eapp0000000000000000000000000a";
export const FAKE_APP_SECRET = "e2e-fake-realtime-app-secret-0123456789abcdef";
export const FAKE_TURN_KEY_ID = "e2eturn00000000000000000000000ab";
export const FAKE_TURN_KEY_TOKEN = "e2e-fake-turn-key-token-0123456789abcdef";

/** Chromium flags for a browser that sends media to the stand-in on the same machine. */
export const LOCAL_WEBRTC_FLAGS = [
	"--allow-loopback-in-peer-connection",
	"--disable-features=WebRtcHideLocalIpsWithMdns",
];

/** One call that the stand-in got, for the checks of a test. */
export interface FakeSfuCall {
	method: string;
	path: string;
	body: unknown;
}

// The relay runs in the page. Each function gets JSON and returns JSON.
const RELAY = `
const sessions = new Map();
const published = new Map();
const queues = new Map();
let counter = 0;

function queued(sid, run) {
	const previous = queues.get(sid) ?? Promise.resolve();
	const next = previous.catch(() => {}).then(run);
	queues.set(sid, next);
	return next;
}

async function gathered(pc) {
	if (pc.iceGatheringState === "complete") return;
	await new Promise((done) => {
		const timer = setTimeout(done, 3000);
		pc.addEventListener("icegatheringstatechange", () => {
			if (pc.iceGatheringState === "complete") {
				clearTimeout(timer);
				done();
			}
		});
	});
}

function key(sid, trackName) {
	return sid + "/" + trackName;
}

window.relay = {
	newSession() {
		const sid = (Date.now().toString(16) + (++counter).toString(16).padStart(8, "0")).padEnd(32, "0").slice(0, 32);
		const pc = new RTCPeerConnection({ bundlePolicy: "max-bundle" });
		sessions.set(sid, { pc, pushed: new Map(), pulled: new Map() });
		return { sessionId: sid };
	},
	push(sid, sdp, tracks) {
		return queued(sid, async () => {
			const session = sessions.get(sid);
			if (!session) return { errorCode: "session_error", errorDescription: "no session" };
			await session.pc.setRemoteDescription({ type: "offer", sdp });
			const out = [];
			for (const track of tracks) {
				const transceiver = session.pc.getTransceivers().find((t) => t.mid === track.mid);
				if (!transceiver) {
					out.push({ mid: track.mid, trackName: track.trackName, errorCode: "invalid_params", errorDescription: "no mid" });
					continue;
				}
				session.pushed.set(track.mid, track.trackName);
				// Chromium sends a received audio track on to a second connection only while a media element plays it.
				if (transceiver.receiver.track.kind === "audio") {
					const sink = new Audio();
					sink.muted = true;
					sink.srcObject = new MediaStream([transceiver.receiver.track]);
					sink.play().catch(() => {});
				}
				published.set(key(sid, track.trackName), { track: transceiver.receiver.track, senders: new Set() });
				out.push({ mid: track.mid, trackName: track.trackName });
			}
			const answer = await session.pc.createAnswer();
			await session.pc.setLocalDescription(answer);
			await gathered(session.pc);
			return {
				requiresImmediateRenegotiation: false,
				tracks: out,
				sessionDescription: { type: "answer", sdp: session.pc.localDescription.sdp },
			};
		});
	},
	pull(sid, tracks) {
		return queued(sid, async () => {
			const session = sessions.get(sid);
			if (!session) return { errorCode: "session_error", errorDescription: "no session" };
			const added = [];
			const out = [];
			for (const track of tracks) {
				const source = published.get(key(track.sessionId, track.trackName));
				if (!source) {
					out.push({ trackName: track.trackName, sessionId: track.sessionId, errorCode: "not_found_track_error", errorDescription: "Track not found" });
					continue;
				}
				const transceiver = session.pc.addTransceiver(source.track, { direction: "sendonly" });
				source.senders.add(transceiver.sender);
				added.push({ transceiver, track, source });
			}
			if (added.length === 0) return { requiresImmediateRenegotiation: false, tracks: out };
			const offer = await session.pc.createOffer();
			await session.pc.setLocalDescription(offer);
			await gathered(session.pc);
			for (const { transceiver, track, source } of added) {
				session.pulled.set(transceiver.mid, { sender: transceiver.sender, source });
				out.push({ mid: transceiver.mid, trackName: track.trackName, sessionId: track.sessionId });
			}
			return {
				requiresImmediateRenegotiation: true,
				tracks: out,
				sessionDescription: { type: "offer", sdp: session.pc.localDescription.sdp },
			};
		});
	},
	answer(sid, sdp) {
		return queued(sid, async () => {
			const session = sessions.get(sid);
			if (!session) return { errorCode: "session_error", errorDescription: "no session" };
			await session.pc.setRemoteDescription({ type: "answer", sdp });
			return {};
		});
	},
	close(sid, mids) {
		return queued(sid, async () => {
			const session = sessions.get(sid);
			if (!session) return { errorCode: "session_error", errorDescription: "no session" };
			const out = [];
			for (const mid of mids) {
				const pulled = session.pulled.get(mid);
				const pushedName = session.pushed.get(mid);
				if (pulled) {
					await pulled.sender.replaceTrack(null);
					pulled.source.senders.delete(pulled.sender);
					session.pulled.delete(mid);
					out.push({ mid });
				} else if (pushedName !== undefined) {
					const source = published.get(key(sid, pushedName));
					if (source) {
						for (const sender of source.senders) await sender.replaceTrack(null);
						published.delete(key(sid, pushedName));
					}
					session.pushed.delete(mid);
					out.push({ mid });
				} else {
					out.push({ mid, errorCode: "close_track_error", errorDescription: "Track doesn't exist or was already closed" });
				}
			}
			return { requiresImmediateRenegotiation: false, tracks: out };
		});
	},
	drop(prefix) {
		let dropped = 0;
		for (const [sid, session] of sessions) {
			if (![...session.pushed.values()].some((name) => name.startsWith(prefix))) continue;
			for (const name of session.pushed.values()) published.delete(key(sid, name));
			session.pc.close();
			sessions.delete(sid);
			dropped++;
		}
		return { dropped };
	},
	state(sid) {
		const session = sessions.get(sid);
		if (!session) return null;
		const tracks = [];
		for (const [mid, trackName] of session.pushed) tracks.push({ location: "local", mid, trackName, status: "active" });
		for (const [mid] of session.pulled) tracks.push({ location: "remote", mid, status: "active" });
		return { tracks, dataChannels: [] };
	},
};
`;

async function readJson(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	const text = Buffer.concat(chunks).toString("utf8");
	return text.trim() === "" ? null : JSON.parse(text);
}

function send(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(body === undefined ? "" : JSON.stringify(body));
}

export interface FakeSfu {
	calls: FakeSfuCall[];
	stop(): Promise<void>;
}

/** Starts the stand-in on FAKE_SFU_PORT. */
export async function startFakeSfu(port = FAKE_SFU_PORT): Promise<FakeSfu> {
	const browser: Browser = await chromium.launch({ args: LOCAL_WEBRTC_FLAGS });
	const page: Page = await browser.newPage();
	await page.setContent("<!doctype html><title>fake sfu</title>");
	await page.evaluate(RELAY);
	const calls: FakeSfuCall[] = [];

	const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		const body = await readJson(request);
		calls.push({ method: request.method ?? "", path: url.pathname, body });
		const auth = request.headers.authorization ?? "";
		const turn = /^\/v1\/turn\/keys\/([^/]+)\/credentials\/generate-ice-servers$/.exec(url.pathname);
		if (turn) {
			if (turn[1] !== FAKE_TURN_KEY_ID || auth !== `Bearer ${FAKE_TURN_KEY_TOKEN}`) return send(response, 401, {});
			// The browsers of a test are on this machine: host candidates are enough.
			return send(response, 201, { iceServers: [] });
		}
		// Test only: closes the SFU side of each session that sends a track of one participant, as a lost network does.
		if (url.pathname === "/test/drop" && request.method === "POST") {
			const prefix = String((body as { prefix?: unknown } | null)?.prefix ?? "");
			if (!/^par_[0-9A-Z]{26}$/.test(prefix)) return send(response, 400, {});
			const result = await page.evaluate(
				(p) => (window as never as { relay: { drop(p: string): unknown } }).relay.drop(p),
				prefix,
			);
			return send(response, 200, result);
		}
		const turnRevoke = /^\/v1\/turn\/keys\/([^/]+)\/credentials\/([^/]+)\/revoke$/.exec(url.pathname);
		if (turnRevoke) return send(response, 204, undefined);
		const match = /^\/v1\/apps\/([^/]+)\/sessions\/(new|[0-9a-f]+)(\/.*)?$/.exec(url.pathname);
		if (!match) return send(response, 404, { errorCode: "not_found" });
		if (match[1] !== FAKE_APP_ID || auth !== `Bearer ${FAKE_APP_SECRET}`) {
			return send(response, 401, { errorCode: "unauthorized", errorDescription: "bad secret" });
		}
		const sid = match[2] as string;
		const rest = match[3] ?? "";
		const input = (body ?? {}) as Record<string, unknown>;
		if (sid === "new" && request.method === "POST") {
			return send(
				response,
				201,
				await page.evaluate(() => (window as never as { relay: { newSession(): unknown } }).relay.newSession()),
			);
		}
		type Track = { location: string; mid?: string; trackName: string; sessionId?: string };
		const tracks = (input.tracks ?? []) as Track[];
		if (rest === "/tracks/new" && request.method === "POST") {
			const description = input.sessionDescription as { type: string; sdp: string } | undefined;
			const local = tracks.filter((track) => track.location === "local");
			const remote = tracks.filter((track) => track.location === "remote");
			if (local.length > 0 && remote.length > 0) return send(response, 400, { errorCode: "invalid_params" });
			if (local.length > 0) {
				if (description?.type !== "offer") return send(response, 400, { errorCode: "invalid_params" });
				const result = await page.evaluate(
					([s, sdp, t]) => (window as never as { relay: { push(...a: unknown[]): unknown } }).relay.push(s, sdp, t),
					[sid, description.sdp, local] as const,
				);
				return send(response, 200, result);
			}
			const result = await page.evaluate(
				([s, t]) => (window as never as { relay: { pull(...a: unknown[]): unknown } }).relay.pull(s, t),
				[sid, remote] as const,
			);
			return send(response, 200, result);
		}
		if (rest === "/renegotiate" && request.method === "PUT") {
			const description = input.sessionDescription as { type: string; sdp: string } | undefined;
			if (description?.type !== "answer") return send(response, 400, { errorCode: "invalid_params" });
			const result = await page.evaluate(
				([s, sdp]) => (window as never as { relay: { answer(...a: unknown[]): unknown } }).relay.answer(s, sdp),
				[sid, description.sdp] as const,
			);
			return send(response, 200, result);
		}
		if (rest === "/tracks/close" && request.method === "PUT") {
			const mids = tracks.map((track) => track.mid as string);
			const result = await page.evaluate(
				([s, m]) => (window as never as { relay: { close(...a: unknown[]): unknown } }).relay.close(s, m),
				[sid, mids] as const,
			);
			return send(response, 200, result);
		}
		if (rest === "" && request.method === "GET") {
			const state = await page.evaluate(
				(s) => (window as never as { relay: { state(s: string): unknown } }).relay.state(s),
				sid,
			);
			return state ? send(response, 200, state) : send(response, 404, { errorCode: "session_error" });
		}
		return send(response, 404, { errorCode: "not_found" });
	};

	const server: Server = createServer((request, response) => {
		route(request, response).catch((error: unknown) => {
			send(response, 500, { errorCode: "internal_error", errorDescription: String(error) });
		});
	});
	await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
	return {
		calls,
		async stop() {
			await new Promise<void>((done) => server.close(() => done()));
			await browser.close();
		},
	};
}
