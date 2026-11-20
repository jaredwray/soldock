import { type CallContext, openEventsSocket } from "../identity/index.ts";
import { OperationError, type ResourceWatcher, type WatcherMap } from "../platform/index.ts";
import { joinedRoomIds } from "./room-index.ts";
import { openRoomSocket } from "./socket.ts";

/**
 * The change feed of the `chat.room` resource: the messages of one room. The feed is a room socket,
 * the same socket that the web app opens, so the room makes the same member check and the same
 * credential check for the two. Each `message` event of the socket is one change.
 *
 * `allowed` reads the index in D1: one query for all rooms of a stream, which wakes no room. The index
 * is a first filter only, and it can be behind the room. The object of the room decides when the feed
 * opens. When it refuses the caller, `open` returns null, and the stream leaves the room out. The room
 * closes the socket of a member that it removes, which ends the stream.
 *
 * A feed counts for the limit of sockets of one member in one room. The room never closes a feed to
 * make room for a new socket, because that would end a stream with all of its other feeds. At the
 * limit, the room refuses a new feed, and the stream leaves the room out.
 */
/** The refusals of a room that leave the room out of a stream. Each other failure fails the request. */
const REFUSALS: ReadonlySet<string> = new Set(["not_found", "forbidden", "conflict"]);

/** The `type` of a socket event, or null for text that is no event. */
function eventType(data: string): string | null {
	try {
		const type = (JSON.parse(data) as { type?: unknown }).type;
		return typeof type === "string" ? type : null;
	} catch {
		return null;
	}
}

const roomWatcher: ResourceWatcher<CallContext> = {
	async allowed(call, resources) {
		const ids = resources.map((vars) => vars.room_id);
		const joined = await joinedRoomIds(
			call.env.DIRECTORY,
			call.caller.id,
			ids.filter((id) => id !== undefined),
		);
		return ids.map((id) => id !== undefined && joined.has(id));
	},

	async open(call, vars, listener) {
		let response: Response;
		try {
			response = await openRoomSocket(call.env, call.caller, vars.room_id as string, { feed: true });
		} catch (error) {
			// `not_found`, `forbidden`: the index has the caller as a member, and the room does not, so the
			// index is behind. `conflict`: the caller has too many sockets to the room.
			if (error instanceof OperationError && REFUSALS.has(error.code)) return null;
			throw error;
		}
		const socket = response.webSocket as WebSocket;
		socket.accept();
		let closed = false;
		const ended = () => {
			if (closed) return;
			closed = true;
			listener.end();
		};
		socket.addEventListener("message", (event) => {
			if (closed || typeof event.data !== "string") return;
			// Only a change of a message or a reply is a change of this resource. `hello` and `room` are not.
			const type = eventType(event.data);
			if (type === "message" || type === "reply") listener.change();
		});
		socket.addEventListener("close", ended);
		socket.addEventListener("error", ended);
		return {
			close() {
				if (closed) return;
				closed = true;
				try {
					socket.close(1000, "The subscription ended.");
				} catch {
					// Closed already.
				}
			},
		};
	},
};

/**
 * A change feed from the events socket of the caller, the same socket that the web app opens, so the
 * `PrincipalDO` makes the same credential checks for the two. Each event whose type is in `types` is one
 * change.
 *
 * A resource of this feed has no variables, and each caller that can read the resource can watch it. A
 * feed counts for the limit of sockets of the principal. The object never closes a feed for that limit.
 * At the limit, it refuses a new feed, and the stream leaves the resource out.
 */
function eventsWatcher(types: ReadonlySet<string>): ResourceWatcher<CallContext> {
	return {
		async allowed(_call, resources) {
			return resources.map(() => true);
		},

		async open(call, _vars, listener) {
			let response: Response;
			try {
				response = await openEventsSocket(call.env, call.caller, { feed: true });
			} catch (error) {
				if (error instanceof OperationError && error.code === "conflict") return null;
				throw error;
			}
			const socket = response.webSocket as WebSocket;
			socket.accept();
			let closed = false;
			const ended = () => {
				if (closed) return;
				closed = true;
				listener.end();
			};
			socket.addEventListener("message", (event) => {
				if (closed || typeof event.data !== "string") return;
				const type = eventType(event.data);
				if (type !== null && types.has(type)) listener.change();
			});
			socket.addEventListener("close", ended);
			socket.addEventListener("error", ended);
			return {
				close() {
					if (closed) return;
					closed = true;
					try {
						socket.close(1000, "The subscription ended.");
					} catch {
						// Closed already.
					}
				},
			};
		},
	};
}

/** The change feed of the `chat.rooms` resource: each change of each room of the caller. */
const roomsWatcher = eventsWatcher(new Set(["chat.room", "chat.room_removed"]));

/**
 * The change feed of the `chat.addressed` resource: only a change that is for the caller. The room finds
 * the reason of each member at the change, and the `PrincipalDO` sends `chat.addressed` for a change that
 * is newer than the one that it has. So this feed reads no message.
 */
const addressedWatcher = eventsWatcher(new Set(["chat.addressed"]));

export const chatWatchers: Pick<WatcherMap<CallContext>, "chat.room" | "chat.rooms" | "chat.addressed"> = {
	"chat.room": roomWatcher,
	"chat.rooms": roomsWatcher,
	"chat.addressed": addressedWatcher,
};
