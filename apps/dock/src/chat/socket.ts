import { allowsResource, isErrorCode, operations, RoomId } from "@asterra/contracts";
import type { Hono } from "hono";
import { unauthenticatedResponse } from "../api/index.ts";
import {
	type AuthContext,
	authenticate,
	credentialRef,
	isSameOrigin,
	recordSocketOpen,
	refusedOutcome,
} from "../identity/index.ts";
import { CALLER_NAMES, log, OperationError, type RequestIdVariables } from "../platform/index.ts";
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
 * member. A refusal comes back as an `OperationError`, with the code that `chat.list_messages` gives,
 * or `conflict` when the member has too many sockets to the room.
 */
export async function openRoomSocket(
	env: Pick<Env, "CHAT_ROOM">,
	caller: AuthContext,
	roomId: string,
	options: { feed: boolean },
): Promise<Response> {
	// A service account with resource limits gets a socket only to a listed room. The route and the feeds of MCP both
	// come here.
	if (!allowsResource(caller.restriction, "room", roomId)) {
		throw new OperationError("forbidden", "This agent is limited, and its list does not name this room.");
	}
	const open: SocketOpen = {
		roomId,
		actor: {
			principal_id: caller.principal.id,
			kind: caller.principal.kind,
			display_name: caller.principal.display_name,
		},
		credential: credentialRef(caller),
		feed: options.feed,
		canType: caller.scopes.has("chat.write"),
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
		const caller = await authenticate(request, c.env, waitUntil, {
			allowSession: true,
			trace: { requestId: c.var.requestId, surface: "rest" },
		});
		if (!caller) return unauthenticatedResponse(c.var.requestId, new URL(request.url).pathname);
		const roomParam = RoomId.safeParse(c.req.param("room_id"));
		try {
			if (caller.credential === "session" && !isSameOrigin(request)) {
				throw new OperationError("forbidden", "A socket with the session cookie must come from this origin.");
			}
			if (!READ_OPERATION.callers.includes(caller.kind)) {
				throw new OperationError("forbidden", `${CALLER_NAMES[caller.kind]} cannot open a room socket.`);
			}
			const missing = READ_OPERATION.scopes.filter((scope) => !caller.scopes.has(scope));
			if (missing.length > 0) {
				throw new OperationError("forbidden", `The credential does not have the scope ${missing.join(", ")}.`);
			}
			// An id that is not a room id names no room. No object wakes for it.
			const roomId = RoomId.safeParse(c.req.param("room_id"));
			if (!roomId.success) throw new OperationError("not_found", "No room has that id, or you have no access to it.");
			const response = await openRoomSocket(c.env, caller, roomId.data, { feed: false });
			// A service account gets one entry in its activity log for each socket that it opens.
			recordSocketOpen(caller, c.env, waitUntil, c.var.requestId, "chat.open_room_socket", { room_id: roomId.data });
			log("info", "chat socket opened", {
				principalId: caller.id,
				credential: caller.credential,
				roomId: roomId.data,
				requestId: c.var.requestId,
			});
			return response;
		} catch (error) {
			// A service account gets an entry for a refused open too.
			recordSocketOpen(
				caller,
				c.env,
				waitUntil,
				c.var.requestId,
				"chat.open_room_socket",
				roomParam.success ? { room_id: roomParam.data } : {},
				refusedOutcome(error),
			);
			throw error;
		}
	});
}
