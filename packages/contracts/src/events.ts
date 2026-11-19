import { z } from "zod";
import { ChatRoom } from "./chat.ts";

// The events socket of a principal: one socket for each tab or client, with the changes of the state
// of the principal. It carries events from the server only. Each change is an operation.

/** The version of the events of this socket. A new version can add event types. */
export const EVENTS_SOCKET_PROTOCOL = 1;

/** The path of the events socket. The caller is the principal of the socket. */
export const EVENTS_SOCKET_PATH = "/ws/events";

export const EVENTS_LIMITS = {
	/** The live sockets of one principal. At the limit, a new socket closes the oldest one. */
	socketsPerPrincipal: 20,
} as const;

/** The codes with which the server closes an events socket. Each other code is a failure: try again later. */
export const EVENTS_SOCKET_CLOSE = {
	/**
	 * The server must authenticate the credential again. Open a new socket now. An OAuth client gets this
	 * code when its access token expired or when a refresh replaced the token: use the new token.
	 */
	reconnect: 4001,
	/** The principal opened more sockets than `EVENTS_LIMITS.socketsPerPrincipal`, and this one is the oldest. */
	replaced: 4002,
	/** The credential stopped and cannot be renewed. Do not open a new socket with this credential. */
	ended: 4003,
} as const;

/**
 * An event of the events socket.
 *
 * - `hello` is the first event. A client then calls chat.list_rooms, to get what changed while it had no socket.
 * - `chat.room` has a room of the principal as chat.list_rooms returns it, after a change: a new
 *   message, a changed name, a read marker, a new member. Replace the room that you have.
 * - `chat.room_removed` tells that the principal is not a member of the room now.
 * - `chat.threads` tells that the threads that the principal follows in a room changed: a new reply, a
 *   read marker, a follow or a stop. Call chat.list_threads again.
 */
export const PrincipalEvent = z.discriminatedUnion("type", [
	z.object({ type: z.literal("hello"), protocol: z.number().int() }),
	z.object({ type: z.literal("chat.room"), room: ChatRoom }),
	z.object({ type: z.literal("chat.room_removed"), room_id: z.string() }),
	z.object({ type: z.literal("chat.threads"), room_id: z.string() }),
]);
export type PrincipalEvent = z.infer<typeof PrincipalEvent>;
