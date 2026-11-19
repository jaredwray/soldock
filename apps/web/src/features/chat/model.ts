import type { ChatBody, ChatFile, ChatMessage, ChatRoom } from "@asterra/contracts";
import type { OutboxState, PendingMessage } from "./outbox.ts";

// The pure rules of the Chat page. They have no DOM and no network, so apps/web/test checks them.

/**
 * True for a message of the room list: a message of the room, or a reply that its author also sent to the
 * room. The socket and `changed_after` of a thread view bring replies too. The room list leaves them out.
 */
export function inRoomList(message: Pick<ChatMessage, "parent_id" | "also_in_room">): boolean {
	return message.parent_id === null || message.also_in_room;
}

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
 * The key of the send of a stored message, for a message of `own` that has one. A different author can
 * use the same value as a key, so the key of a message of a different author is not a key of this page.
 */
function sendKeyOf(message: ChatMessage, own: ChatMessage["author"]): string | null {
	return message.author.principal_id === own.principal_id ? message.idempotency_key : null;
}

/**
 * The send of each stored message that the outbox still has, by the id of the message. The room
 * stores each message with the key of its send (`idempotency_key`), so the pair is certain: the
 * socket, or a read, can bring the stored message before the answer of its send, and also when
 * each answer of the send got lost.
 */
function storedOf(
	messages: readonly ChatMessage[],
	outbox: OutboxState,
	own: ChatMessage["author"],
): Map<string, PendingMessage> {
	const sends = new Map(outbox.pending.map((pending) => [pending.key, pending]));
	const stored = new Map<string, PendingMessage>();
	for (const message of messages) {
		const key = sendKeyOf(message, own);
		const pending = key === null ? undefined : sends.get(key);
		if (pending) stored.set(message.id, pending);
	}
	return stored;
}

/**
 * The rows of the list: the stored messages, then the messages that wait, in the order of the sends.
 *
 * - A stored message that this outbox sent has the key of its send as its row key (`outbox.keys`), so
 *   the row of a send stays the same row when the stored message comes. Each other message has its
 *   id. A row key never changes when a page of messages comes.
 * - A message that waits shows as a message of `own`, after the last stored message.
 * - A send whose stored message the list has shows as that stored message, at the position that the
 *   room gave it, with the key of the send. So the message shows one time, and it does not move when
 *   the answer of the send arrives.
 * - A stored message shows with its change that waits for the server (`changes`).
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
				...(pending.body ? { body: pending.body } : {}),
				created_at: pending.created_at,
				edited_at: null,
				deleted: false,
				version: 0,
				idempotency_key: pending.key,
				reactions: [],
				mentions: [],
				group_mentions: [],
				parent_id: null,
				also_in_room: false,
				thread: null,
				files: [...(pending.files ?? [])],
				link_previews: [],
			},
			pending,
		});
	}
	return rows;
}

/**
 * The failed sends whose message the room has: a message of `own` in `messages` has the key of the
 * send. The answers of such a send got lost, and the server stored the message. Give each pair to
 * `settle` of the outbox: the send did not fail, and "Try again" and "Delete" must not show for a
 * message that the room has. `messages` can be messages that the list does not show, for example a
 * message from the socket while the list is at older messages.
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
 * A send can fail without an answer of the server. The room possibly has that message: the page
 * settles the send when the room tells of it, but a message that the room stored before the list
 * loaded does not come in a sync. So the line does not tell that the message was not sent. "Try
 * again" on the row is safe: the send keeps its key, and the room stores it one time.
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
 * a delete. `at` is the time of the edit on the device. `files` is the new list of the files, when the
 * edit removed a file.
 */
export type LocalChange =
	| { kind: "edit"; body: ChatBody; text: string; at: string; files?: readonly ChatFile[] }
	| { kind: "delete" };

const NO_CHANGES: ReadonlyMap<string, LocalChange> = new Map();

/**
 * The messages as the person sees them: each message with its change that waits for the server. So
 * an edit and a delete show at once.
 *
 * - An edit shows the new text, with the edited mark, and the files that the edit kept.
 * - A delete shows the message as deleted, without its text, its files and its link previews.
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
		if (change.kind === "delete") return { ...message, text: "", deleted: true, files: [], link_previews: [] };
		// The server makes the Markdown of the new body. Until its answer, the message has none.
		const { markdown: _old, ...rest } = message;
		const files = change.files ? { files: [...change.files] } : {};
		return { ...rest, body: change.body, text: change.text, edited_at: change.at, ...files };
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

/**
 * The rooms of the sidebar: the rooms and the direct messages with a star, then the other rooms with a
 * name, then the other direct messages. A room is in one part only. Each part keeps the order of the list.
 */
export function sidebarRooms(rooms: readonly ChatRoom[]): {
	starred: ChatRoom[];
	named: ChatRoom[];
	direct: ChatRoom[];
} {
	const others = rooms.filter((room) => !room.starred);
	return {
		starred: rooms.filter((room) => room.starred),
		named: others.filter((room) => room.kind !== "dm"),
		direct: others.filter((room) => room.kind === "dm"),
	};
}

/**
 * The box of a picture of `size` pixels in a message: as large as the picture, and at most `max`. The
 * picture keeps its shape. The list gives the box before the picture loads, so a row keeps its height.
 */
export function fitBox(
	size: { width: number; height: number },
	max: { width: number; height: number },
): { width: number; height: number } | null {
	if (!(size.width > 0 && size.height > 0)) return null;
	const scale = Math.min(1, max.width / size.width, max.height / size.height);
	return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) };
}

/**
 * The link of a link preview, when it is an http or https address. Null for each other address, so a
 * preview never gets a link that runs a script. The server fetches only https links, so null is a
 * second layer.
 */
export function safeLinkPreviewHref(url: string): string | null {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
	} catch {
		return null;
	}
}

/** True when two lists name the same files in the same order. */
export function sameFileIds(a: readonly Pick<ChatFile, "item_id">[], b: readonly Pick<ChatFile, "item_id">[]): boolean {
	return a.length === b.length && a.every((file, index) => file.item_id === b[index]?.item_id);
}
