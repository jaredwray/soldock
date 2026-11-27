import { EVENTS_SOCKET_PATH, operations } from "@asterra/contracts";
import type { Hono } from "hono";
import { unauthenticatedResponse } from "../api/index.ts";
import { CALLER_NAMES, log, OperationError, type RequestIdVariables } from "../platform/index.ts";
import { credentialRef, recordSocketOpen, refusedOutcome } from "./access.ts";
import { type AuthContext, authenticate, isSameOrigin } from "./auth.ts";
import { EVENTS_SOCKET_HEADER, type EventsSocketOpen } from "./principal.ts";

type SocketEnv = { Bindings: Env; Variables: RequestIdVariables };

/**
 * The socket carries the rooms as `chat.list_rooms` returns them, so a credential gets a socket only
 * when it can call that operation. A later event type that is not Chat needs its own check: the hint
 * `calendar.changed` goes only to a socket whose credential holds `calendar.read` (`EventsSocketOpen.calendar`).
 */
const READ_OPERATION = operations["chat.list_rooms"];

/**
 * Asks the `PrincipalDO` of the caller for an events socket. The caller must be authenticated, and
 * able to call `chat.list_rooms`. A refusal for too many sockets comes back as `conflict`: a feed is
 * never refused for another reason.
 */
export async function openEventsSocket(
	env: Pick<Env, "PRINCIPAL">,
	caller: AuthContext,
	options: { feed: boolean },
): Promise<Response> {
	const open: EventsSocketOpen = {
		credential: credentialRef(caller),
		feed: options.feed,
		calendar: caller.scopes.has("calendar.read"),
	};
	const principal = env.PRINCIPAL.get(env.PRINCIPAL.idFromName(caller.principal.id));
	const response = await principal.fetch("https://principal.internal/events", {
		headers: { upgrade: "websocket", [EVENTS_SOCKET_HEADER]: encodeURIComponent(JSON.stringify(open)) },
	});
	if (response.status === 101 && response.webSocket) return response;
	if (response.status === 409) throw new OperationError("conflict", "You have too many sockets open.");
	throw new Error(`The principal object refused the socket with status ${response.status}.`);
}

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
		const caller = await authenticate(request, c.env, waitUntil, {
			allowSession: true,
			trace: { requestId: c.var.requestId, surface: "rest" },
		});
		if (!caller) return unauthenticatedResponse(c.var.requestId, new URL(request.url).pathname);
		try {
			if (caller.credential === "session" && !isSameOrigin(request)) {
				throw new OperationError("forbidden", "A socket with the session cookie must come from this origin.");
			}
			if (!READ_OPERATION.callers.includes(caller.kind)) {
				throw new OperationError("forbidden", `${CALLER_NAMES[caller.kind]} cannot open the events socket.`);
			}
			// The socket also carries the personal Chat state of the caller: activity, sections, drafts, reminders
			// and scheduled messages. That state has no room, so the account scope decides the open, also for an
			// agent. A room socket is the way to follow one room by its membership.
			const missing = READ_OPERATION.scopes.filter((scope) => !caller.scopes.has(scope));
			if (missing.length > 0) {
				throw new OperationError("forbidden", `The credential does not have the scope ${missing.join(", ")}.`);
			}
			const response = await openEventsSocket(c.env, caller, { feed: false });
			// A service account gets one entry in its activity log for each socket that it opens.
			recordSocketOpen(caller, c.env, waitUntil, c.var.requestId, "events.open_socket");
			log("info", "events socket opened", {
				principalId: caller.principal.id,
				credential: caller.credential,
				requestId: c.var.requestId,
			});
			return response;
		} catch (error) {
			// A service account gets an entry for a refused open too.
			recordSocketOpen(caller, c.env, waitUntil, c.var.requestId, "events.open_socket", {}, refusedOutcome(error));
			throw error;
		}
	});
}
