import type { ChatRoom } from "@soldock/contracts";

// The room list of the sidebar, with the changes of the events socket. It has no DOM and no network,
// so apps/web/test checks it.

/** The time of the newest message of a room, or the time of its creation. The list has the newest first. */
function activityOf(room: ChatRoom): number {
	return Date.parse(room.last_message_at ?? room.created_at);
}

/** The order of `chat.list_rooms`: the newest activity first, then the highest id. */
function byActivity(a: ChatRoom, b: ChatRoom): number {
	return activityOf(b) - activityOf(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/**
 * The list with the change of one room from the events socket: the new state of the room, or null
 * for a room that the person left. A new room goes in at its place.
 */
export function withRoom(rooms: readonly ChatRoom[], roomId: string, room: ChatRoom | null): ChatRoom[] {
	const others = rooms.filter((listed) => listed.id !== roomId);
	return room === null ? others : [...others, room].sort(byActivity);
}

/** The last change of one room from the events socket, with its number in the order of the events. */
export interface RoomChange {
	at: number;
	room: ChatRoom | null;
}

/**
 * A list from `chat.list_rooms` with each change of the socket that came after the start of its read.
 * The read can answer after an event, and then its room is older than the room of the event.
 * `since` is the number of the last event at the start of the read.
 */
export function withChangesSince(
	list: readonly ChatRoom[],
	changes: ReadonlyMap<string, RoomChange>,
	since: number,
): ChatRoom[] {
	let rooms = [...list];
	for (const [roomId, change] of changes) {
		if (change.at > since) rooms = withRoom(rooms, roomId, change.room);
	}
	return rooms;
}
