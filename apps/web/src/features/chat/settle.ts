import type { ChatMessage } from "@asterra/contracts";
import { storedSends } from "./model.ts";
import type { OutboxState } from "./outbox.ts";

// The sends of one room whose answers got lost, and whose message the room has. It has no DOM, so
// apps/web/test checks it.

export interface SendSettlerOptions {
	/** The person of the page. Only a message of this person is the message of a send of the page. */
	own: ChatMessage["author"];
	/** The state of the outbox at this moment, not the state of the last render. */
	state(): OutboxState;
	/** Takes a failed send out of the outbox: the room has its message, `id`. */
	settle(key: string, id: string): void;
	/** Gets the number of sends that settled in one step. */
	onSettled(count: number): void;
}

export interface SendSettler {
	/**
	 * Takes the messages that the room told of through the socket or a sync. The list can drop a
	 * message outside its part of the history. The settler keeps each message of a send that waits,
	 * for a send that fails after its message came.
	 */
	fromRoom(messages: readonly ChatMessage[]): void;
	/** Settles each failed send whose message is in `list`, or in the messages that the room told of. */
	check(list: readonly ChatMessage[]): void;
}

/**
 * Makes the settler of one room. A failed send settles when the room has a message of the person
 * with the key of the send (`storedSends`). Each step reads the state of the outbox at that moment,
 * so a send settles, and counts, one time.
 */
export function createSendSettler(options: SendSettlerOptions): SendSettler {
	const { own, state, settle, onSettled } = options;
	/** The messages of sends that wait, from the socket or a sync. A message goes when its send goes. */
	let reported: ChatMessage[] = [];

	function pendingKeys(): Set<string> {
		return new Set(state().pending.map((pending) => pending.key));
	}

	function check(list: readonly ChatMessage[]): void {
		const keys = pendingKeys();
		reported = reported.filter((message) => keys.has(message.idempotency_key ?? ""));
		const settled = storedSends([...list, ...reported], state(), own);
		for (const { key, id } of settled) settle(key, id);
		if (settled.length > 0) onSettled(settled.length);
	}

	return {
		fromRoom(messages) {
			const keys = pendingKeys();
			const ofSends = messages.filter(
				(message) =>
					message.author.principal_id === own.principal_id &&
					message.idempotency_key !== null &&
					keys.has(message.idempotency_key),
			);
			if (ofSends.length === 0) return;
			reported = [...reported, ...ofSends];
			check([]);
		},
		check,
	};
}
