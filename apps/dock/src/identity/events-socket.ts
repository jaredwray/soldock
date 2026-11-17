import { EVENTS_SOCKET_PATH, operations } from "@soldock/contracts";
import type { Hono } from "hono";
import { unauthenticatedResponse } from "../api/index.ts";
import { log, OperationError, type RequestIdVariables } from "../platform/index.ts";
import { credentialRef } from "./access.ts";
import { authenticate, isSameOrigin } from "./auth.ts";
import { EVENTS_SOCKET_HEADER, type EventsSocketOpen } from "./principal.ts";

type SocketEnv = { Bindings: Env; Variables: RequestIdVariables };

/**
 * The socket carries the rooms as `chat.list_rooms` returns them, so a credential gets a socket only
 * when it can call that operation. A later event type that is not Chat needs its own check.
 */
const READ_OPERATION = operations["chat.list_rooms"];

/**
 * Mounts the events socket of a principal: `GET /ws/events` with a WebSocket upgrade.
 *
 * The Worker authenticates the caller as REST does: a bearer token, or the session cookie. A browser
 * sends the cookie on each WebSocket request, also from a different site, so a session must come with
 * the `Origin` of this host. The socket ends in the `PrincipalDO` of the caller, and nowhere else.
 */
export function mountEventsSocket(app: Hono<SocketEnv>): void {
	app.get(EVENTS_SOCKET_PATH, async (c) => {
		const request = c.req.raw;
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			throw new OperationError("invalid", "This path accepts a WebSocket upgrade only.");
		}
		const waitUntil = (promise: Promise<unknown>) => c.executionCtx.waitUntil(promise);
		const caller = await authenticate(request, c.env, waitUntil, { allowSession: true });
		if (!caller) return unauthenticatedResponse(c.var.requestId, new URL(request.url).pathname);
		if (caller.credential === "session" && !isSameOrigin(request)) {
			throw new OperationError("forbidden", "A socket with the session cookie must come from this origin.");
		}
		if (!READ_OPERATION.callers.includes(caller.kind)) {
			throw new OperationError("forbidden", `An ${caller.kind} cannot open the events socket.`);
		}
		const missing = READ_OPERATION.scopes.filter((scope) => !caller.scopes.has(scope));
		if (missing.length > 0) {
			throw new OperationError("forbidden", `The credential does not have the scope ${missing.join(", ")}.`);
		}
		const open: EventsSocketOpen = { credential: credentialRef(caller) };
		const principal = c.env.PRINCIPAL.get(c.env.PRINCIPAL.idFromName(caller.principal.id));
		const response = await principal.fetch("https://principal.internal/events", {
			headers: { upgrade: "websocket", [EVENTS_SOCKET_HEADER]: encodeURIComponent(JSON.stringify(open)) },
		});
		if (response.status !== 101 || !response.webSocket) {
			throw new Error(`The principal object refused the socket with status ${response.status}.`);
		}
		log("info", "events socket opened", {
			principalId: caller.principal.id,
			credential: caller.credential,
			requestId: c.var.requestId,
		});
		return response;
	});
}
