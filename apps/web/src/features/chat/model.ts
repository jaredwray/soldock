import type { ChatMessage, ChatRoom } from "@soldock/contracts";
import type { OutboxState, PendingMessage } from "./outbox.ts";

// The pure rules of the Chat page. They have no DOM and no network, so apps/web/test checks them.

/** The name that a room shows: its name, or the name of the other member for a direct message. */
export function roomTitle(room: Pick<ChatRoom, "kind" | "name" | "peer">): string {
	if (room.kind === "dm") return room.peer?.display_name ?? "Direct message";
	return room.name ?? "Room";
}

function merged(current: readonly ChatMessage[], incoming: readonly ChatMessage[]): ChatMessage[] {
	const byId = new Map(current.map((message) => [message.id, message]));
	for (const message of incoming) {
		const known = byId.get(message.id);
		// An answer can arrive after a newer one. The message with the higher version is the current one.
		if (!known || message.version >= known.version) byId.set(message.id, message);
	}
	return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

/** The list with a page of older messages before it. */
export function withOlder(current: readonly ChatMessage[], page: readonly ChatMessage[]): ChatMessage[] {
	return merged(current, page);
}

/**
 * The list with the changes of a sync: a new message goes to the end, and a changed or deleted message
 * replaces the old one. `hasOlder` is true while the room has messages before the first message of the
 * list. Then a change to a message before the first one is dropped: the list has no gap, so "load
 * older" continues from its first message. Without older messages, the list has the start of the room,
 * and each change goes in.
 */
export function withChanges(
	current: readonly ChatMessage[],
	changes: readonly ChatMessage[],
	hasOlder: boolean,
): ChatMessage[] {
	const first = current[0];
	return merged(current, hasOlder && first ? changes.filter((message) => message.seq >= first.seq) : changes);
}

/** One row of the message list: a stored message, or a message that waits for the server. */
export interface ChatRow {
	/** The key of the row. A message keeps it from its send to its stored form, so the row stays the same. */
	key: string;
	message: ChatMessage;
	/** The state of the send, for a message that the server does not have yet. */
	pending: PendingMessage | null;
}

/**
 * True for a stored message that can be the message of the send `pending`: a message of `own` that
 * the outbox did not send, and that came after the start of the call of that send.
 */
function canBeSendOf(
	message: ChatMessage,
	pending: PendingMessage,
	outbox: OutboxState,
	own: ChatMessage["author"],
): boolean {
	return (
		pending.afterSeq !== null &&
		message.seq > pending.afterSeq &&
		message.author.principal_id === own.principal_id &&
		!outbox.keys.has(message.id)
	);
}

/**
 * The rows of the list: the stored messages, then the messages that wait, in the order of the sends.
 *
 * - A stored message that the outbox sent has the key of its send.
 * - A message that waits shows as a message of `own`, after the last stored message.
 * - While a call runs, the socket can bring the stored message before the answer of the call. That
 *   message has no key yet, and the row of its send still shows. So a message that can be the message
 *   of that call stays out of the list until the call ends.
 * - A call that started while no list showed the room has no such limit: each stored message shows.
 */
export function chatRows(
	messages: readonly ChatMessage[],
	outbox: OutboxState,
	own: ChatMessage["author"],
	roomId: string,
): ChatRow[] {
	const sending = outbox.pending.find((pending) => pending.key === outbox.sendingKey);
	const rows: ChatRow[] = [];
	for (const message of messages) {
		if (sending && canBeSendOf(message, sending, outbox, own)) continue;
		rows.push({ key: outbox.keys.get(message.id) ?? message.id, message, pending: null });
	}
	const lastSeq = messages[messages.length - 1]?.seq ?? 0;
	for (const [index, pending] of outbox.pending.entries()) {
		rows.push({
			key: pending.key,
			message: {
				id: pending.key,
				room_id: roomId,
				seq: lastSeq + index + 1,
				author: own,
				text: pending.text,
				created_at: pending.created_at,
				edited_at: null,
				deleted: false,
				version: 0,
			},
			pending,
		});
	}
	return rows;
}

/**
 * The failed sends whose message the list has. The answers of such a send did not arrive, and the
 * server stored the message: the socket or a read brought it. The stored message is a message of
 * `own` with the same text, that came after the start of the call. Give each pair to `settle` of the
 * outbox, so the list shows the message one time, and not a second time as "Not sent".
 */
export function storedSends(
	messages: readonly ChatMessage[],
	outbox: OutboxState,
	own: ChatMessage["author"],
): { key: string; id: string }[] {
	const pairs: { key: string; id: string }[] = [];
	const taken = new Set<string>();
	for (const pending of outbox.pending) {
		if (pending.state !== "failed" || !pending.uncertain) continue;
		const stored = messages.find(
			(message) =>
				!taken.has(message.id) && message.text === pending.text && canBeSendOf(message, pending, outbox, own),
		);
		if (!stored) continue;
		taken.add(stored.id);
		pairs.push({ key: pending.key, id: stored.id });
	}
	return pairs;
}

const GROUP_MS = 5 * 60 * 1000;

/**
 * True when a message is the first message of its day in the list. The day is the day of the device.
 * The list then shows the date above the message. The day uses the same format as the date label, so
 * the two always agree, also after the time zone of the device changes.
 */
export function startsDay(previous: ChatMessage | undefined, message: ChatMessage): boolean {
	if (!previous) return true;
	return dayLabel(previous.created_at) !== dayLabel(message.created_at);
}

/**
 * True when a message shows its avatar, its author and its time. A message from the same author, on
 * the same day and less than five minutes after the message before it, continues the group of that
 * message.
 */
export function startsGroup(previous: ChatMessage | undefined, message: ChatMessage): boolean {
	if (!previous || startsDay(previous, message)) return true;
	if (previous.author.principal_id !== message.author.principal_id) return true;
	return Date.parse(message.created_at) - Date.parse(previous.created_at) > GROUP_MS;
}

// The formats keep the time zone of the device when the page loads, as the formats of lib/format.ts do.
const dayFormat = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "long", day: "numeric" });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** The date between the messages of two days, for example "October 31, 2026". */
export function dayLabel(iso: string): string {
	return dayFormat.format(new Date(iso));
}

/** The time next to the author of a message. The date is above the first message of the day. */
export function timeLabel(iso: string): string {
	return timeFormat.format(new Date(iso));
}

/** The text in the empty box for a new message: "Message #room", or "Message" and the name of the other member. */
export function draftPlaceholder(room: Pick<ChatRoom, "kind" | "name" | "peer">): string {
	return `Message ${room.kind === "dm" ? "" : "#"}${roomTitle(room)}`;
}

/** The rooms of the sidebar: the rooms with a name, then the direct messages. Each keeps the order of the list. */
export function sidebarRooms(rooms: readonly ChatRoom[]): { named: ChatRoom[]; direct: ChatRoom[] } {
	return {
		named: rooms.filter((room) => room.kind !== "dm"),
		direct: rooms.filter((room) => room.kind === "dm"),
	};
}
