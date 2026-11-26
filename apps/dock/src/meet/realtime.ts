import type { IceServer } from "@asterra/contracts";
import { log } from "../platform/index.ts";

// The client of the Cloudflare Realtime SFU (the Connection API) and of Realtime TURN. Only the Worker and
// `MeetingDO` call it: the App Secret and the TURN key token never go to a browser. The SFU has no access control
// of its own, so each call here is a call that `MeetingDO` allowed.

const DEFAULT_BASE = "https://rtc.live.cloudflare.com/v1";
/** The STUN server of Cloudflare. A deployment without a TURN key gets only this server. */
export const CLOUDFLARE_STUN: IceServer = { urls: "stun:stun.cloudflare.com:3478" };
/** The life of a TURN credential, in seconds. The longest call of v1 is shorter. */
export const TURN_TTL_SECONDS = 12 * 60 * 60;
/** The SFU accepts at most 64 tracks in one request. */
const TRACKS_PER_REQUEST = 64;
const TIMEOUT_MS = 10_000;

export interface RealtimeConfig {
	base: string;
	appId: string;
	appSecret: string;
	turn: { keyId: string; token: string } | null;
}

/** A failure of the SFU or of TURN. `status` is the HTTP status, or 0 when no answer came. */
export class RealtimeError extends Error {
	readonly status: number;
	readonly code: string | null;
	constructor(message: string, status: number, code: string | null) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

/** True for a base that may get the App Secret: https, or a loopback host for the tests on one machine. */
function safeBase(value: string): boolean {
	try {
		const url = new URL(value);
		if (url.protocol === "https:") return true;
		return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
	} catch {
		return false;
	}
}

/** The Realtime settings of the deployment, or null when Meet is not set up. */
export function realtimeConfig(env: Env): RealtimeConfig | null {
	const appId = env.REALTIME_APP_ID?.trim();
	const appSecret = env.REALTIME_APP_SECRET?.trim();
	if (!appId || !appSecret) return null;
	const base = (env.REALTIME_API_BASE?.trim() || DEFAULT_BASE).replace(/\/+$/, "");
	if (!safeBase(base)) {
		log("error", "REALTIME_API_BASE must be an https URL or a loopback URL; Meet is off", {});
		return null;
	}
	const keyId = env.REALTIME_TURN_KEY_ID?.trim();
	const token = env.REALTIME_TURN_KEY_TOKEN?.trim();
	return { base, appId, appSecret, turn: keyId && token ? { keyId, token } : null };
}

export function meetConfigured(env: Env): boolean {
	return realtimeConfig(env) !== null;
}

export interface SessionDescription {
	type: "offer" | "answer";
	sdp: string;
}

export interface TrackResult {
	mid?: string;
	trackName?: string;
	sessionId?: string;
	errorCode?: string;
	errorDescription?: string;
}

interface TracksAnswer {
	requiresImmediateRenegotiation?: boolean;
	sessionDescription?: SessionDescription;
	tracks?: TrackResult[];
	errorCode?: string;
	errorDescription?: string;
}

async function call<T>(config: RealtimeConfig, method: string, path: string, body?: unknown): Promise<T> {
	let response: Response;
	try {
		response = await fetch(`${config.base}/apps/${encodeURIComponent(config.appId)}${path}`, {
			method,
			headers: { authorization: `Bearer ${config.appSecret}`, "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (error) {
		throw new RealtimeError(`The media service did not answer: ${String(error)}`, 0, null);
	}
	const text = await response.text();
	let parsed: Record<string, unknown> = {};
	if (text.trim() !== "") {
		try {
			parsed = JSON.parse(text) as Record<string, unknown>;
		} catch {
			throw new RealtimeError(
				`The media service gave an answer that is not JSON (${response.status}).`,
				response.status,
				null,
			);
		}
	}
	const code = typeof parsed.errorCode === "string" ? parsed.errorCode : null;
	if (!response.ok || code) {
		const description = typeof parsed.errorDescription === "string" ? parsed.errorDescription : "";
		throw new RealtimeError(
			`The media service refused the request (${response.status} ${code ?? ""} ${description}).`.replace(/\s+\)/, ")"),
			response.status,
			code,
		);
	}
	return parsed as T;
}

/** A new SFU session. */
export async function newSession(config: RealtimeConfig): Promise<string> {
	const answer = await call<{ sessionId?: string }>(config, "POST", "/sessions/new");
	if (typeof answer.sessionId !== "string" || answer.sessionId === "") {
		throw new RealtimeError("The media service gave no session id.", 200, null);
	}
	return answer.sessionId;
}

/** Pushes the local tracks of an offer. Returns the answer of the SFU and the result of each track. */
export async function pushTracks(
	config: RealtimeConfig,
	sessionId: string,
	offer: string,
	tracks: readonly { mid: string; trackName: string }[],
): Promise<{ answer: string; tracks: TrackResult[] }> {
	const answer = await call<TracksAnswer>(config, "POST", `/sessions/${encodeURIComponent(sessionId)}/tracks/new`, {
		sessionDescription: { type: "offer", sdp: offer },
		tracks: tracks.map((track) => ({ location: "local", mid: track.mid, trackName: track.trackName })),
	});
	if (answer.sessionDescription?.type !== "answer") {
		throw new RealtimeError("The media service gave no answer to the offer.", 200, null);
	}
	return { answer: answer.sessionDescription.sdp, tracks: answer.tracks ?? [] };
}

/** Pulls the tracks of other sessions into a session. The SFU then sends an offer that the browser answers. */
export async function pullTracks(
	config: RealtimeConfig,
	sessionId: string,
	tracks: readonly { sessionId: string; trackName: string }[],
): Promise<{ offer: string | null; renegotiate: boolean; tracks: TrackResult[] }> {
	const answer = await call<TracksAnswer>(config, "POST", `/sessions/${encodeURIComponent(sessionId)}/tracks/new`, {
		tracks: tracks.map((track) => ({ location: "remote", sessionId: track.sessionId, trackName: track.trackName })),
	});
	const offer = answer.sessionDescription?.type === "offer" ? answer.sessionDescription.sdp : null;
	return { offer, renegotiate: answer.requiresImmediateRenegotiation === true, tracks: answer.tracks ?? [] };
}

/** Gives the SFU the answer of the browser to its offer. */
export async function renegotiate(config: RealtimeConfig, sessionId: string, sdp: string): Promise<void> {
	await call(config, "PUT", `/sessions/${encodeURIComponent(sessionId)}/renegotiate`, {
		sessionDescription: { type: "answer", sdp },
	});
}

/**
 * Closes tracks of a session with `force`, without an SDP exchange: the SFU stops the media of each mid at once.
 * A mid that is already closed counts as closed. Returns false when a request failed.
 */
export async function closeTracks(
	config: RealtimeConfig,
	sessionId: string,
	mids: readonly string[],
): Promise<boolean> {
	let ok = true;
	for (let start = 0; start < mids.length; start += TRACKS_PER_REQUEST) {
		const batch = mids.slice(start, start + TRACKS_PER_REQUEST);
		try {
			await call(config, "PUT", `/sessions/${encodeURIComponent(sessionId)}/tracks/close`, {
				tracks: batch.map((mid) => ({ mid })),
				force: true,
			});
		} catch (error) {
			ok = false;
			log("warn", "meet: the media service did not close tracks", {
				error: error instanceof Error ? error.message : String(error),
				count: batch.length,
			});
		}
	}
	return ok;
}

/**
 * The ICE servers of one admitted participant: a short TURN credential when the deployment has a TURN key, and
 * the STUN server of Cloudflare without one. Returns the TURN user name too, for a later revoke.
 */
export async function iceServers(config: RealtimeConfig): Promise<{ servers: IceServer[]; username: string | null }> {
	if (!config.turn) return { servers: [CLOUDFLARE_STUN], username: null };
	let response: Response;
	try {
		response = await fetch(
			`${config.base}/turn/keys/${encodeURIComponent(config.turn.keyId)}/credentials/generate-ice-servers`,
			{
				method: "POST",
				headers: { authorization: `Bearer ${config.turn.token}`, "content-type": "application/json" },
				body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
				signal: AbortSignal.timeout(TIMEOUT_MS),
			},
		);
	} catch (error) {
		log("warn", "meet: TURN did not answer; STUN only", { error: String(error) });
		return { servers: [CLOUDFLARE_STUN], username: null };
	}
	if (!response.ok) {
		log("warn", "meet: TURN refused the credential request; STUN only", { status: response.status });
		return { servers: [CLOUDFLARE_STUN], username: null };
	}
	const body = (await response.json().catch(() => ({}))) as { iceServers?: unknown };
	const servers: IceServer[] = [];
	let username: string | null = null;
	for (const entry of Array.isArray(body.iceServers) ? body.iceServers : []) {
		if (typeof entry !== "object" || entry === null) continue;
		const raw = (entry as { urls?: unknown }).urls;
		// Browsers block port 53. Without trickle ICE, such a URL only makes the gathering wait.
		const urls = (Array.isArray(raw) ? raw : [raw]).filter(
			(url): url is string => typeof url === "string" && !/:53(\?|$)/.test(url),
		);
		if (urls.length === 0) continue;
		const server: IceServer = { urls };
		const { username: user, credential } = entry as { username?: unknown; credential?: unknown };
		if (typeof user === "string" && typeof credential === "string") {
			server.username = user;
			server.credential = credential;
			username = user;
		}
		servers.push(server);
	}
	return { servers, username };
}

/** Revokes a TURN credential. A failure only writes a log line: the credential ends with its ttl. */
export async function revokeTurn(config: RealtimeConfig, username: string): Promise<void> {
	if (!config.turn) return;
	try {
		const response = await fetch(
			`${config.base}/turn/keys/${encodeURIComponent(config.turn.keyId)}/credentials/${encodeURIComponent(username)}/revoke`,
			{
				method: "POST",
				headers: { authorization: `Bearer ${config.turn.token}` },
				signal: AbortSignal.timeout(TIMEOUT_MS),
			},
		);
		if (!response.ok && response.status !== 404) log("warn", "meet: TURN revoke failed", { status: response.status });
	} catch (error) {
		log("warn", "meet: TURN revoke did not answer", { error: String(error) });
	}
}
