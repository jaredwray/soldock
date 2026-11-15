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
 * The stored message of each send whose answer did not arrive, by the id of the message. The socket,
 * or a read, can bring the stored message before the answer of its send, and when each answer got
 * lost. The message of a send is a message of `own` with the text of the send, that the outbox did
 * not send before, and that came after the start of the call of the send.
 *
 * Only a send whose call runs, or whose answers got lost, can have a stored message. A send that the
 * server refused has none. A call that started while no list showed the room has none: the list does
 * not know which messages came after its start.
 *
 * The send whose call runs comes first. A person can write the text of a failed send again. The
 * message that arrives is then the message of the new send, and the failed send must stay.
 *
 * Two failed sends with the same text get no stored message: the list cannot know which of them the
 * server has. The two stay "Not sent". "Try again" then gives the correct answer for each one: the
 * stored message for the send that the server has, and a new message for the other one.
 */
function storedOf(
	messages: readonly ChatMessage[],
	outbox: OutboxState,
	own: ChatMessage["author"],
): Map<string, PendingMessage> {
	const stored = new Map<string, PendingMessage>();
	const failed = outbox.pending.filter((pending) => pending.state === "failed" && pending.uncertain);
	const sends = [
		...outbox.pending.filter((pending) => pending.state === "sending"),
		...failed.filter((pending) => failed.every((other) => other === pending || other.text !== pending.text)),
	];
	for (const pending of sends) {
		const afterSeq = pending.afterSeq;
		if (afterSeq === null) continue;
		const message = messages.find(
			(entry) =>
				entry.seq > afterSeq &&
				entry.author.principal_id === own.principal_id &&
				entry.text === pending.text &&
				!outbox.keys.has(entry.id) &&
				!stored.has(entry.id),
		);
		if (message) stored.set(message.id, pending);
	}
	return stored;
}

/**
 * The rows of the list: the stored messages, then the messages that wait, in the order of the sends.
 *
 * - A stored message that the outbox sent has the key of its send.
 * - A message that waits shows as a message of `own`, after the last stored message.
 * - A send whose stored message the list has shows as that stored message, at the position that the
 *   room gave it, with the key of the send. So the message shows one time, and it does not move when
 *   the answer of the send arrives.
 */
export function chatRows(
	messages: readonly ChatMessage[],
	outbox: OutboxState,
	own: ChatMessage["author"],
	roomId: string,
): ChatRow[] {
	const stored = storedOf(messages, outbox, own);
	const rows: ChatRow[] = messages.map((message) => ({
		key: stored.get(message.id)?.key ?? outbox.keys.get(message.id) ?? message.id,
		message,
		pending: null,
	}));
	const shown = new Set([...stored.values()].map((pending) => pending.key));
	let seq = messages[messages.length - 1]?.seq ?? 0;
	for (const pending of outbox.pending) {
		if (shown.has(pending.key)) continue;
		seq += 1;
		rows.push({
			key: pending.key,
			message: {
				id: pending.key,
				room_id: roomId,
				seq,
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
 * The failed sends whose message the list has. The answers of such a send got lost, and the server
 * stored the message. Give each pair to `settle` of the outbox: the send did not fail, and "Try again"
 * and "Delete" must not show for a message that the room has.
 */
export function storedSends(
	messages: readonly ChatMessage[],
	outbox: OutboxState,
	own: ChatMessage["author"],
): { key: string; id: string }[] {
	return [...storedOf(messages, outbox, own)]
		.filter(([, pending]) => pending.state === "failed")
		.map(([id, pending]) => ({ key: pending.key, id }));
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
