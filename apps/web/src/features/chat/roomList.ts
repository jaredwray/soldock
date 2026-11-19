import { CHAT_LIMITS, type ChatRoom } from "@asterra/contracts";

// The room list of the sidebar, with the changes of the events socket. It has no DOM and no network,
// so apps/web/test checks it.

/**
 * The rooms that the sidebar shows: the first page of `chat.list_rooms`, and each room with a star of
 * the first page of the starred view.
 */
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
 * The rooms in the order of `chat.list_rooms`: the first `ROOM_LIST_MAX` rooms, as the first page,
 * and after them only the rooms with a star. So a room with a star stays in the sidebar also when
 * more than `ROOM_LIST_MAX` rooms have a newer message.
 */
function kept(rooms: ChatRoom[]): ChatRoom[] {
	return rooms.sort(byActivity).filter((room, index) => index < ROOM_LIST_MAX || room.starred);
}

/**
 * The list with the change of one room from the events socket: the new state of the room, or null
 * for a room that the person left. A new room goes in at its place. The list keeps the rooms that
 * `kept` keeps.
 */
export function withRoom(rooms: readonly ChatRoom[], roomId: string, room: ChatRoom | null): ChatRoom[] {
	const others = rooms.filter((listed) => listed.id !== roomId);
	return room === null ? others : kept([...others, room]);
}

/**
 * The first page of `chat.list_rooms` with the rooms of the starred view that the page does not have.
 * When the two reads have the same room, the list keeps the room of the page.
 */
export function withStarred(page: readonly ChatRoom[], starred: readonly ChatRoom[]): ChatRoom[] {
	const ids = new Set(page.map((room) => room.id));
	return kept([...page, ...starred.filter((room) => !ids.has(room.id))]);
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
