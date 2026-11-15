import { ApiError, type ChatMessage } from "@soldock/contracts";

// The messages of one room that the person sent and that the server does not have yet. It has no DOM
// and no network of its own, so apps/web/test checks it.

/** The waits before a new attempt of a send that can succeed later. After the last one, the message is `failed`. */
export const RETRY_WAITS_MS = [1000, 2000, 4000];
/** The most message keys that an outbox keeps. A row needs its key only while the list shows it. */
const MAX_KEYS = 200;

/** A message that waits for the server. */
export interface PendingMessage {
	/**
	 * The idempotency key of the send, so a second attempt never makes a second message. It is also
	 * the key of the row, from the send to the stored message.
	 */
	key: string;
	text: string;
	/** The time of the send on the device. */
	created_at: string;
	/** `waiting`: a message before it is in the line. `sending`: the call runs, or waits for a new attempt. */
	state: "waiting" | "sending" | "failed";
	/** Why the send failed, for the person. Null while it did not fail. */
	error: string | null;
}

export interface OutboxState {
	/** The messages that wait, in the order of the sends. */
	pending: readonly PendingMessage[];
	/** The key of each message that this outbox sent, by the id of the message. */
	keys: ReadonlyMap<string, string>;
	/** The key of the message whose call runs now, or null. */
	sendingKey: string | null;
}

export interface OutboxOptions {
	/** Posts the text with the idempotency key, and returns the stored message. */
	post(text: string, key: string): Promise<ChatMessage>;
	/** The text of a failure for the person. */
	describe(error: unknown): string;
}

export interface Outbox {
	getState(): OutboxState;
	/** Calls `listener` after each change of the state. Returns a function that removes the listener. */
	subscribe(listener: () => void): () => void;
	/** Where a stored message goes after its send. Null while no list shows the room. */
	deliverTo(sink: ((message: ChatMessage) => void) | null): void;
	/** Adds a message to the end of the line. */
	send(text: string): void;
	/** Sends a failed message again, with the same key. */
	retry(key: string): void;
	/** Removes a message that failed or that waits. A message whose call runs stays. */
	discard(key: string): void;
}

/**
 * True when a later attempt can succeed: the network failed, the server had a failure, or the room
 * refused the message because of its rate limit. Each other refusal is final, for example a person
 * that is not a member of the room now.
 */
function canSucceedLater(error: unknown): boolean {
	if (error instanceof ApiError) return error.code === "rate_limited" || error.status >= 500;
	return true;
}

/**
 * Sends the messages of one room, one at a time, in the order of the sends. So the room has them in
 * the order in which the person wrote them.
 *
 * - A message shows at once, as `pending`. The call for it starts when the call before it ends.
 * - Each attempt of one message has the same idempotency key. So a lost answer never makes a second message.
 * - A failure that can go away gets new attempts, after the waits of `RETRY_WAITS_MS`. Then the
 *   message is `failed`, and the next message goes. The person sends a failed message again, or removes it.
 * - A final refusal makes the message `failed` at once.
 */
export function createOutbox(options: OutboxOptions): Outbox {
	let state: OutboxState = { pending: [], keys: new Map(), sendingKey: null };
	const listeners = new Set<() => void>();
	let sink: ((message: ChatMessage) => void) | null = null;

	function change(next: Partial<OutboxState>): void {
		state = { ...state, ...next };
		for (const listener of listeners) listener();
	}

	function update(key: string, changes: Partial<PendingMessage>): readonly PendingMessage[] {
		return state.pending.map((message) => (message.key === key ? { ...message, ...changes } : message));
	}

	function attempt(message: PendingMessage, attempts: number): void {
		options.post(message.text, message.key).then(
			(stored) => {
				const keys = new Map(state.keys).set(stored.id, message.key);
				for (const id of keys.keys()) {
					if (keys.size <= MAX_KEYS) break;
					keys.delete(id);
				}
				change({ pending: state.pending.filter((entry) => entry.key !== message.key), keys, sendingKey: null });
				sink?.(stored);
				pump();
			},
			(error: unknown) => {
				const wait = canSucceedLater(error) ? RETRY_WAITS_MS[attempts] : undefined;
				if (wait !== undefined) {
					setTimeout(() => attempt(message, attempts + 1), wait);
					return;
				}
				change({
					pending: update(message.key, { state: "failed", error: options.describe(error) }),
					sendingKey: null,
				});
				pump();
			},
		);
	}

	/** Starts the call of the first message that waits, when no call runs. */
	function pump(): void {
		if (state.sendingKey !== null) return;
		const next = state.pending.find((message) => message.state === "waiting");
		if (!next) return;
		change({ pending: update(next.key, { state: "sending" }), sendingKey: next.key });
		attempt(next, 0);
	}

	return {
		getState: () => state,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		deliverTo(next) {
			sink = next;
		},
		send(text) {
			const message: PendingMessage = {
				key: crypto.randomUUID(),
				text,
				created_at: new Date().toISOString(),
				state: "waiting",
				error: null,
			};
			change({ pending: [...state.pending, message] });
			pump();
		},
		retry(key) {
			if (!state.pending.some((message) => message.key === key && message.state === "failed")) return;
			change({ pending: update(key, { state: "waiting", error: null }) });
			pump();
		},
		discard(key) {
			if (key === state.sendingKey) return;
			change({ pending: state.pending.filter((message) => message.key !== key) });
		},
	};
}
