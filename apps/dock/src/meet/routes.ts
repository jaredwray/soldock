import {
	AnswerRequest,
	type CallInfo,
	isErrorCode,
	isMeetingCode,
	JoinRequest,
	type JoinResponse,
	MEET_LIMITS,
	MEET_SOCKET_SUBPROTOCOL,
	MEET_TOKEN_HEADER,
	MediaStateRequest,
	PublishRequest,
	SubscribeRequest,
	UnpublishRequest,
} from "@asterra/contracts";
import type { Context, Hono } from "hono";
import type { z } from "zod";
import { type AuthContext, authenticate, credentialRef, isSameOrigin } from "../identity/index.ts";
import {
	log,
	OperationError,
	type RequestIdVariables,
	randomToken,
	readBodyText,
	sha256Hex,
} from "../platform/index.ts";
import { accept, meetingStub } from "./handlers.ts";
import { type Refusal, TOKEN_HASH_HEADER } from "./meeting.ts";
import { meetConfigured } from "./realtime.ts";

// The call routes of Meet: what a browser uses to join a meeting and to carry its media. They are not operations,
// as the room socket of Chat and the uploads of Drive are not: a guest is not a principal, and an agent sends no
// media. Members and guests use the same routes.
//
// - `GET /api/v1/meet/calls/{code}`: what each person with the link can read.
// - `POST .../join`: a new participant and its token. A signed-in member is known from the session cookie.
// - Each other route needs the participant token in `x-asterra-meet-token`. The object keeps only its hash.
// - `GET /ws/meet/{code}`: the socket of the meeting, with the token as the subprotocol `token.<token>`.

type MeetEnv = { Bindings: Env; Variables: RequestIdVariables };

const BASE = "/api/v1/meet/calls/:code";
const NO_STORE = { "cache-control": "no-store" };
const TOKEN_PREFIX = "mpt_";
const TOKEN_PATTERN = /^mpt_[A-Za-z0-9_-]{43}$/;
/** The most bytes of a body without an SDP text. A larger body gets `413`, and no object wakes for it. */
const SMALL_BODY_BYTES = 1024;
/** The most bytes of a subscribe body: the largest list of track ids. */
const SUBSCRIBE_BODY_BYTES = 4 * 1024;
/** The most bytes of a body with an SDP text. JSON makes each line end of the SDP text two times longer. */
const SDP_BODY_BYTES = 2 * MEET_LIMITS.sdpBytes + SMALL_BODY_BYTES;

function codeOf(c: Context<MeetEnv>): string {
	const code = c.req.param("code") ?? "";
	// A code with a bad form names no meeting. No object wakes for it.
	if (!isMeetingCode(code)) throw new OperationError("not_found", "No meeting has that code.");
	return code;
}

async function tokenHashOf(token: string | null | undefined): Promise<string> {
	if (!token || !TOKEN_PATTERN.test(token)) {
		throw new OperationError("unauthenticated", "Send the participant token of this meeting. Join again.");
	}
	return sha256Hex(token);
}

async function bodyOf<S extends z.ZodType>(c: Context<MeetEnv>, schema: S, maxBytes: number): Promise<z.output<S>> {
	const text = await readBodyText(c.req.raw, maxBytes);
	let value: unknown = {};
	if (text.trim() !== "") {
		try {
			value = JSON.parse(text);
		} catch {
			throw new OperationError("invalid", "The body must be a JSON object.");
		}
	}
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		throw new OperationError("invalid", parsed.error.issues.map((issue) => issue.message).join(" "));
	}
	return parsed.data;
}

/** The signed-in person of the request, from the session cookie only. An API key never joins a call. */
async function memberOf(c: Context<MeetEnv>): Promise<AuthContext | null> {
	if (c.req.header("authorization") !== undefined) return null;
	const caller = await authenticate(c.req.raw, c.env, (promise) => c.executionCtx.waitUntil(promise), {
		allowSession: true,
		trace: { requestId: c.var.requestId, surface: "rest" },
	});
	return caller?.credential === "session" ? caller : null;
}

function json(c: Context<MeetEnv>, value: unknown, status: 200 | 201 = 200): Response {
	return c.json(value as object, status, NO_STORE);
}

export function mountMeetCalls(app: Hono<MeetEnv>): void {
	app.get(BASE, async (c) => {
		const code = codeOf(c);
		const member = await memberOf(c);
		const info = accept(await meetingStub(c.env, code).info(member?.principal.id ?? null));
		const out: CallInfo = {
			code: info.code,
			title: info.title,
			host_name: info.host_name,
			status: info.status,
			origin: info.origin,
			media: meetConfigured(c.env) ? "ready" : "not_configured",
			viewer: member ? { display_name: member.principal.display_name, is_host: info.viewer_is_host } : null,
		};
		return json(c, out);
	});

	app.post(`${BASE}/join`, async (c) => {
		const code = codeOf(c);
		if (!meetConfigured(c.env)) throw new OperationError("unavailable", "Meet is not set up on this server.");
		const input = await bodyOf(c, JoinRequest, SMALL_BODY_BYTES);
		const member = await memberOf(c);
		if (member && !isSameOrigin(c.req.raw)) {
			throw new OperationError("forbidden", "A join with the session cookie must come from this origin.");
		}
		if (!member && input.display_name === undefined) throw new OperationError("invalid", "Enter your name.");
		const token = `${TOKEN_PREFIX}${randomToken(32)}`;
		const self = accept(
			await meetingStub(c.env, code).join({
				tokenHash: await sha256Hex(token),
				member: member
					? {
							principalId: member.principal.id,
							displayName: member.principal.display_name,
							credential: credentialRef(member),
						}
					: null,
				displayName: member ? null : (input.display_name ?? null),
			}),
		);
		log("info", "meet join", { code: code.slice(0, 4), participantId: self.id, kind: self.kind, state: self.state });
		const out: JoinResponse = { token, participant: self };
		return json(c, out, 201);
	});

	app.get(`${BASE}/state`, async (c) => {
		const code = codeOf(c);
		const hash = await tokenHashOf(c.req.header(MEET_TOKEN_HEADER));
		return json(c, accept(await meetingStub(c.env, code).state(hash)));
	});

	app.post(`${BASE}/leave`, async (c) => {
		const code = codeOf(c);
		const hash = await tokenHashOf(c.req.header(MEET_TOKEN_HEADER));
		accept(await meetingStub(c.env, code).leave(hash));
		return json(c, {});
	});

	app.post(`${BASE}/media/session`, async (c) => {
		const code = codeOf(c);
		const hash = await tokenHashOf(c.req.header(MEET_TOKEN_HEADER));
		return json(c, accept(await meetingStub(c.env, code).mediaSession(hash)));
	});

	app.post(`${BASE}/media/publish`, async (c) => {
		const code = codeOf(c);
		const hash = await tokenHashOf(c.req.header(MEET_TOKEN_HEADER));
		const input = await bodyOf(c, PublishRequest, SDP_BODY_BYTES);
		const result = accept(
			await meetingStub(c.env, code).publish(hash, {
				session: input.session,
				offer: input.offer.sdp,
				tracks: input.tracks,
			}),
		);
		return json(c, { answer: { sdp: result.answer }, tracks: result.tracks });
	});

	app.post(`${BASE}/media/unpublish`, async (c) => {
		const code = codeOf(c);
		const hash = await tokenHashOf(c.req.header(MEET_TOKEN_HEADER));
		const input = await bodyOf(c, UnpublishRequest, SMALL_BODY_BYTES);
		accept(await meetingStub(c.env, code).unpublish(hash, input));
		return json(c, {});
	});

	app.post(`${BASE}/media/subscribe`, async (c) => {
		const code = codeOf(c);
		const hash = await tokenHashOf(c.req.header(MEET_TOKEN_HEADER));
		const input = await bodyOf(c, SubscribeRequest, SUBSCRIBE_BODY_BYTES);
		const result = accept(
			await meetingStub(c.env, code).subscribe(hash, { session: input.session, trackIds: input.track_ids }),
		);
		return json(c, {
			offer: result.offer === null ? null : { sdp: result.offer },
			tracks: result.tracks,
			failed: result.failed,
		});
	});

	app.post(`${BASE}/media/answer`, async (c) => {
		const code = codeOf(c);
		const hash = await tokenHashOf(c.req.header(MEET_TOKEN_HEADER));
		const input = await bodyOf(c, AnswerRequest, SDP_BODY_BYTES);
		accept(await meetingStub(c.env, code).answer(hash, { session: input.session, sdp: input.answer.sdp }));
		return json(c, {});
	});

	app.post(`${BASE}/media/state`, async (c) => {
		const code = codeOf(c);
		const hash = await tokenHashOf(c.req.header(MEET_TOKEN_HEADER));
		const input = await bodyOf(c, MediaStateRequest, SMALL_BODY_BYTES);
		accept(await meetingStub(c.env, code).setMediaState(hash, { audioMuted: input.audio_muted }));
		return json(c, {});
	});
}

/** The token of a socket request: the subprotocol `token.<token>` next to `asterra-meet.v1`. */
function socketToken(request: Request): string | null {
	const offered = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((part) => part.trim());
	if (!offered.includes(MEET_SOCKET_SUBPROTOCOL)) return null;
	const entry = offered.find((part) => part.startsWith("token."));
	return entry ? entry.slice("token.".length) : null;
}

export function mountMeetSocket(app: Hono<MeetEnv>): void {
	app.get("/ws/meet/:code", async (c) => {
		const request = c.req.raw;
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			throw new OperationError("invalid", "This path accepts a WebSocket upgrade only.");
		}
		const code = codeOf(c);
		const hash = await tokenHashOf(socketToken(request));
		const response = await meetingStub(c.env, code).fetch("https://meeting.internal/socket", {
			headers: { upgrade: "websocket", [TOKEN_HASH_HEADER]: hash },
		});
		if (response.status === 101 && response.webSocket) return response;
		const refusal = (await response.json().catch(() => null)) as Partial<Refusal> | null;
		const errorCode = refusal?.error?.code;
		if (isErrorCode(errorCode)) {
			throw new OperationError(errorCode, refusal?.error?.message ?? "The meeting refused the socket.");
		}
		throw new Error(`The meeting refused the socket with status ${response.status}.`);
	});
}
