import { ChatAddressedChange, ChatRoom } from "./chat.ts";
import { z } from "./zod.ts";

// The events socket of a principal: one socket for each tab or client, with the changes of the state
// of the principal. A client can report its activity on this socket.

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
 * - `chat.addressed` has the facts of a change of a room that is for the principal, as an entry of
 *   chat.list_addressed without the room: a message in a direct message, a mention, a reply in a
 *   followed thread, or a delete of a message of the principal by a different member. Changes of one
 *   room in a short time give one event, with the newest change.
 * - `calendar.reminder` tells that an occurrence of an event of the principal starts soon. The same reminder
 *   is in chat.list_activity, with the kind `calendar_reminder`.
 */
export const PrincipalEvent = z.discriminatedUnion("type", [
	z.object({ type: z.literal("hello"), protocol: z.number().int() }),
	z.object({ type: z.literal("chat.room"), room: ChatRoom }),
	z.object({ type: z.literal("chat.room_removed"), room_id: z.string() }),
	z.object({ type: z.literal("chat.threads"), room_id: z.string() }),
	z.object({ type: z.literal("chat.unread"), unread_count: z.number().int().nonnegative() }),
	z.object({
		type: z.literal("chat.notification"),
		room_id: z.string(),
		message_id: z.string(),
		parent_id: z.string().nullable(),
	}),
	ChatAddressedChange.omit({ room: true }).extend({ type: z.literal("chat.addressed"), room_id: z.string() }),
	z.object({ type: z.literal("chat.activity"), unread_count: z.number().int().nonnegative() }),
	z.object({ type: z.literal("chat.sections") }),
	z.object({ type: z.literal("chat.draft"), room_id: z.string(), parent_id: z.string().nullable() }),
	z.object({
		type: z.literal("chat.reminder"),
		reminder_id: z.string(),
		room_id: z.string(),
		message_id: z.string(),
		note: z.string(),
	}),
	z.object({ type: z.literal("chat.scheduled"), scheduled_id: z.string(), room_id: z.string() }),
	z.object({
		type: z.literal("calendar.reminder"),
		event_id: z.string(),
		occurrence_id: z.string().nullable(),
		title: z.string(),
		start: z.string(),
		minutes: z.number().int(),
	}),
]);
export type PrincipalEvent = z.infer<typeof PrincipalEvent>;
