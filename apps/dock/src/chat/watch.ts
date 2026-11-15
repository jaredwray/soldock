import type { CallContext } from "../identity/index.ts";
import type { ResourceWatcher, WatcherMap } from "../platform/index.ts";
import { joinedRoomIds } from "./room-index.ts";
import { openRoomSocket } from "./socket.ts";

/**
 * The change feed of the `chat.room` resource: the messages of one room. The feed is a room socket,
 * the same socket that the web app opens, so the room makes the same member check and the same
 * credential check for the two. Each `message` event of the socket is one change.
 *
 * `allowed` reads the index in D1: one query for all rooms of a stream, which wakes no room. The index
 * is a first filter only. The object of the room decides when the feed opens, and it closes the socket
 * of a member that it removes, which ends the stream.
 */
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
		const response = await openRoomSocket(call.env, call.caller, vars.room_id as string);
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
			// Only a change of a message is a change of this resource. `hello` and `room` are not.
			if (event.data.startsWith('{"type":"message"')) listener.change();
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

export const chatWatchers: Pick<WatcherMap<CallContext>, "chat.room"> = { "chat.room": roomWatcher };
