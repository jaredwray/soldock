import { ChatBody } from "@asterra/contracts";
import { textToBody } from "./composerSchema.ts";
import type { PendingMessage } from "./outbox.ts";

// The rules for the messages that wait for the server, across a reload of the page. It has no DOM
// and no storage of its own, so apps/web/test checks it. `outboxStore.ts` keeps the records.

/**
 * A message that waits, as the browser keeps it. It has the person and the room of the message, and
 * not the position in the list: after a reload, the page does not know that position.
 */
export interface SavedMessage {
	/** The idempotency key of the send. It is the key of the record. */
	key: string;
	/** The principal id of the person that wrote the message. */
	owner: string;
	roomId: string;
	text: string;
	/** The body of the message. A record from before the box had formats has none. */
	body?: ChatBody;
	created_at: string;
	state: PendingMessage["state"];
	error: string | null;
	uncertain: boolean;
}

/**
 * After this time, a message from before a reload does not go out by itself. The room keeps an
 * idempotency key for 24 hours. After that, a second attempt of a send can make a second message.
 * A text from the day before can also be wrong now, so the person decides.
 */
export const RESTORE_SEND_MS = 12 * 60 * 60 * 1000;

export const TOO_OLD = "This message waited too long. Send it again if it is still correct.";

/** The record of one message that waits. */
export function toSaved(message: PendingMessage, owner: string, roomId: string): SavedMessage {
	return {
		key: message.key,
		owner,
		roomId,
		text: message.text,
		...(message.body ? { body: message.body } : {}),
		created_at: message.created_at,
		state: message.state,
		error: message.error,
		uncertain: message.uncertain,
	};
}

/**
 * The messages of one room after a reload of the page, in the order of the sends.
 *
 * - A message that waited, or whose call ran, goes out again with the same key. The server can have
 *   the message of a call that ran, so that message is uncertain.
 * - A message older than `RESTORE_SEND_MS` shows as "Not sent", and the person decides. So does a
 *   message with a time in the future, or a time that is no time: its age is not known.
 * - A failed message stays failed.
 * - No message knows the start of its call in the new list.
 */
export function fromSaved(saved: readonly SavedMessage[], now: number): PendingMessage[] {
	return [...saved]
		.sort((a, b) => a.created_at.localeCompare(b.created_at))
		.map((record) => {
			// The record is from the storage of the browser. A record with a body that the contract does not
			// take goes out as its plain text. Only a record from before the box had formats has no body: its
			// text is the Markdown that the person typed.
			const body =
				record.body === undefined ? undefined : (ChatBody.safeParse(record.body).data ?? textToBody(record.text));
			const message: PendingMessage = {
				key: record.key,
				text: record.text,
				...(body ? { body } : {}),
				created_at: record.created_at,
				state: "waiting",
				error: null,
				uncertain: record.uncertain || record.state === "sending",
			};
			if (record.state === "failed") return { ...message, state: "failed", error: record.error };
			// A time in the future shows that the clock of the device went back. The age is then not known.
			const age = now - Date.parse(record.created_at);
			if (!(age >= 0 && age < RESTORE_SEND_MS)) return { ...message, state: "failed", error: TOO_OLD };
			return message;
		});
}

/**
 * What the store must do after a change of the messages that wait: the records to write, and the
 * keys of the records to remove. A message that did not change needs no write.
 */
export function savedChanges(
	before: readonly PendingMessage[],
	after: readonly PendingMessage[],
): { put: PendingMessage[]; remove: string[] } {
	const earlier = new Map(before.map((message) => [message.key, message]));
	const kept = new Set(after.map((message) => message.key));
	return {
		put: after.filter((message) => {
			const old = earlier.get(message.key);
			return !old || old.state !== message.state || old.error !== message.error || old.uncertain !== message.uncertain;
		}),
		remove: before.filter((message) => !kept.has(message.key)).map((message) => message.key),
	};
}
