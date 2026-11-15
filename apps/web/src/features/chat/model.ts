import type { ChatMessage, ChatRoom } from "@soldock/contracts";
import type { OutboxState, PendingMessage } from "./outbox.ts";

// The pure rules of the Chat page. They have no DOM and no network, so apps/web/test checks them.

/** The name that a room shows: its name, or the name of the other member for a direct message. */
export function roomTitle(room: Pick<ChatRoom, "kind" | "name" | "peer">): string {
	if (room.kind === "dm") return room.peer?.display_name ?? "Direct message";
	return room.name ?? "Room";
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
 * - A stored message shows with its change that waits for the server (`changes`). The list finds the
 *   stored message of a send with the text that the room has, not with the text of a change.
 */
export function chatRows(
	messages: readonly ChatMessage[],
	outbox: OutboxState,
	own: ChatMessage["author"],
	roomId: string,
	changes: ReadonlyMap<string, LocalChange> = NO_CHANGES,
): ChatRow[] {
	const stored = storedOf(messages, outbox, own);
	const rows: ChatRow[] = withLocalChanges(messages, changes).map((message) => ({
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

/**
 * The line below a list that is not at the newest messages, about the messages of the person that
 * the list does not show: the messages that wait for the server, and `sent`, the number of messages
 * that the room stored since the list left the newest messages. Without the line, the person sees
 * nothing of a send, and can send the message a second time. Null when the list hides no such message.
 *
 * A send can fail without an answer of the server. The room possibly has that message, and a list
 * that is not at the newest messages cannot find it. So the line does not tell that the message was
 * not sent. "Try again" on the row is safe: the send keeps its key, and the room stores it one time.
 */
export function unseenSendsNote(outbox: OutboxState, sent: number): string | null {
	const failed = outbox.pending.filter((pending) => pending.state === "failed");
	if (failed.some((pending) => !pending.uncertain)) {
		return "A message was not sent. Go to the newest messages to send it again.";
	}
	if (failed.length > 0) {
		return "The page got no answer for a message. Go to the newest messages to see if the room has it.";
	}
	if (outbox.pending.length > 0) return "Your new messages wait. They show after the newest messages.";
	if (sent > 0) return "The room has your new messages. They show after the newest messages.";
	return null;
}

/**
 * A change of a stored message that the page shows before the answer of the server: a new text, or
 * a delete. `at` is the time of the edit on the device.
 */
export type LocalChange = { kind: "edit"; text: string; at: string } | { kind: "delete" };

const NO_CHANGES: ReadonlyMap<string, LocalChange> = new Map();

/**
 * The messages as the person sees them: each message with its change that waits for the server. So
 * an edit and a delete show at once.
 *
 * - An edit shows the new text, with the edited mark.
 * - A delete shows the message as deleted, without its text.
 * - A message that the room deleted stays deleted: an edit of it shows nothing.
 *
 * Without a change, the result is the same list, so a list that did not change makes no new rows.
 */
export function withLocalChanges(
	messages: readonly ChatMessage[],
	changes: ReadonlyMap<string, LocalChange>,
): readonly ChatMessage[] {
	if (changes.size === 0) return messages;
	return messages.map((message) => {
		const change = changes.get(message.id);
		if (!change || message.deleted) return message;
		if (change.kind === "delete") return { ...message, text: "", deleted: true };
		return { ...message, text: change.text, edited_at: change.at };
	});
}

/**
 * What the person saw of the open room.
 *
 * - `seenSeq` is the seq of the last message that the person saw.
 * - `newAfter` is the seq of the message before the "New messages" line, or null without a line.
 * - `lineSeen` is true after the person looked at the room while the line showed. The line then
 *   stays, and it moves when the next message comes while the person does not look.
 */
export interface Reading {
	seenSeq: number;
	newAfter: number | null;
	lineSeen: boolean;
}

/** The reading of a room that opens, from the read marker of the person in that room. */
export function startReading(lastReadSeq: number): Reading {
	return { seenSeq: lastReadSeq, newAfter: null, lineSeen: false };
}

/**
 * The reading after a change of the list, or of `looking`. The person looks when the tab shows and
 * the list is at the end of the newest messages.
 *
 * - While the person looks, each message of the list is seen.
 * - When a message of a different author comes while the person does not look, the line goes
 *   after the last message that the person saw. A line that the person did not see yet stays where
 *   it is: it marks the first message that is new.
 *
 * Without a change, the result is the same object.
 */
export function nextReading(
	reading: Reading,
	messages: readonly ChatMessage[],
	ownId: string,
	looking: boolean,
): Reading {
	if (looking) {
		const seenSeq = Math.max(reading.seenSeq, messages[messages.length - 1]?.seq ?? 0);
		const lineSeen = reading.newAfter !== null;
		if (seenSeq === reading.seenSeq && lineSeen === reading.lineSeen) return reading;
		return { ...reading, seenSeq, lineSeen };
	}
	if (reading.newAfter !== null && !reading.lineSeen) return reading;
	if (newMessages(messages, reading, ownId) === 0) return reading;
	return { ...reading, newAfter: reading.seenSeq, lineSeen: false };
}

/** The number of messages of the list, of a different author, that the person did not see. */
export function newMessages(messages: readonly ChatMessage[], reading: Reading, ownId: string): number {
	return messages.filter((message) => message.seq > reading.seenSeq && message.author.principal_id !== ownId).length;
}

/**
 * True when the "New messages" line goes before a message: the message is the first one after
 * `newAfter`. When the message is the first one of the list, and the room has older messages, the
 * list does not know that, and shows no line.
 */
export function startsNew(
	previous: ChatMessage | undefined,
	message: ChatMessage,
	newAfter: number | null,
	hasOlder: boolean,
): boolean {
	if (newAfter === null || message.seq <= newAfter) return false;
	return previous ? previous.seq <= newAfter : !hasOlder;
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
