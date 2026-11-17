import { CHAT_LIMITS, type ChatRoom } from "@soldock/contracts";

// The room list of the sidebar, with the changes of the events socket. It has no DOM and no network,
// so apps/web/test checks it.

/** The rooms that the sidebar shows: the first page of `chat.list_rooms`. */
const ROOM_LIST_MAX = CHAT_LIMITS.pageSize;

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
 * for a room that the person left. A new room goes in at its place. The list keeps the first
 * `ROOM_LIST_MAX` rooms, as the first page of `chat.list_rooms`.
 */
export function withRoom(rooms: readonly ChatRoom[], roomId: string, room: ChatRoom | null): ChatRoom[] {
	const others = rooms.filter((listed) => listed.id !== roomId);
	return room === null ? others : [...others, room].sort(byActivity).slice(0, ROOM_LIST_MAX);
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

/**
 * Removes the changes that a read of the list that applied already covers: each change up to
 * `since` of that read. An older read that answers later does not apply, so no read needs them.
 */
export function forgetChangesUpTo(changes: Map<string, RoomChange>, since: number): void {
	for (const [roomId, change] of changes) {
		if (change.at <= since) changes.delete(roomId);
	}
}
