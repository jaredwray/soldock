import { isErrorCode, operations, RoomId } from "@soldock/contracts";
import type { Hono } from "hono";
import { type AuthContext, authenticate, credentialRef, isSameOrigin } from "../identity/index.ts";
import { log, OperationError, type RequestIdVariables } from "../platform/index.ts";
import { type Refusal, SOCKET_HEADER, type SocketOpen } from "./room.ts";

type SocketEnv = { Bindings: Env; Variables: RequestIdVariables };

/** The path of a room socket in the Worker. `chatSocketPath` of the contracts makes the same path for a client. */
const SOCKET_ROUTE = "/ws/chat/rooms/:room_id";

/**
 * The socket carries what `chat.list_messages` returns, so a credential gets a socket only when it can
 * call that operation.
 */
const READ_OPERATION = operations["chat.list_messages"];

/**
 * Asks the object of a room for a socket for the caller. The object accepts the socket only for a
 * member. A refusal comes back as an `OperationError`, with the code that `chat.list_messages` gives.
 */
export async function openRoomSocket(
	env: Pick<Env, "CHAT_ROOM">,
	caller: AuthContext,
	roomId: string,
): Promise<Response> {
	const open: SocketOpen = {
		roomId,
		actor: {
			principal_id: caller.principal.id,
			kind: caller.principal.kind,
			display_name: caller.principal.display_name,
		},
		credential: credentialRef(caller),
	};
	const response = await env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(roomId)).fetch("https://room.internal/socket", {
		headers: { upgrade: "websocket", [SOCKET_HEADER]: encodeURIComponent(JSON.stringify(open)) },
	});
	if (response.status === 101 && response.webSocket) return response;
	const refusal = (await response.json().catch(() => null)) as Partial<Refusal> | null;
	const code = refusal?.error?.code;
	if (isErrorCode(code)) throw new OperationError(code, refusal?.error?.message ?? "The room refused the socket.");
	throw new Error(`The room refused the socket with status ${response.status}.`);
}

/**
 * Mounts the socket of a room: `GET /ws/chat/rooms/{room_id}` with a WebSocket upgrade.
 *
 * The Worker authenticates the caller as REST does: a bearer token, or the session cookie. A browser
 * sends the cookie on each WebSocket request, also from a different site, so a session must come with
 * the `Origin` of this host. The object of the room then decides if the caller is a member.
 */
export function mountChatSocket(app: Hono<SocketEnv>): void {
	app.get(SOCKET_ROUTE, async (c) => {
		const request = c.req.raw;
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			throw new OperationError("invalid", "This path accepts a WebSocket upgrade only.");
		}
		const waitUntil = (promise: Promise<unknown>) => c.executionCtx.waitUntil(promise);
		const caller = await authenticate(request, c.env, waitUntil, { allowSession: true });
		if (!caller) throw new OperationError("unauthenticated", "Send an API key as a bearer token, or sign in.");
		if (caller.credential === "session" && !isSameOrigin(request)) {
			throw new OperationError("forbidden", "A socket with the session cookie must come from this origin.");
		}
		if (!READ_OPERATION.callers.includes(caller.kind)) {
			throw new OperationError("forbidden", `An ${caller.kind} cannot open a room socket.`);
		}
		const missing = READ_OPERATION.scopes.filter((scope) => !caller.scopes.has(scope));
		if (missing.length > 0) {
			throw new OperationError("forbidden", `The credential does not have the scope ${missing.join(", ")}.`);
		}
		// An id that is not a room id names no room. No object wakes for it.
		const roomId = RoomId.safeParse(c.req.param("room_id"));
		if (!roomId.success) throw new OperationError("not_found", "No room has that id, or you have no access to it.");
		const response = await openRoomSocket(c.env, caller, roomId.data);
		log("info", "chat socket opened", {
			principalId: caller.id,
			credential: caller.credential,
			roomId: roomId.data,
			requestId: c.var.requestId,
		});
		return response;
	});
}
