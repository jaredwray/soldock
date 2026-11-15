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
	/**
	 * True for a failed message with an attempt whose answer did not arrive: the network failed, or
	 * the server had a failure. The server can have the message. False when the server refused each
	 * attempt: it does not have the message.
	 */
	uncertain: boolean;
	/**
	 * The seq of the last message of the list at the start of the call. A stored message of the person
	 * with a higher seq can be the message of this send. Null before the call, and when no list with
	 * its messages showed the room at that time.
	 */
	afterSeq: number | null;
}

/** The list that shows the room of an outbox. */
export interface OutboxView {
	/** Takes a stored message after its send. */
	deliver(message: ChatMessage): void;
	/** The seq of the last message of the list, or null while the list did not load. */
	lastSeq(): number | null;
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
	/**
	 * True while the person of this outbox is the person of the page. The page sends each call with
	 * the session of its person, so an outbox of a different person must not send.
	 */
	active(): boolean;
}

export interface Outbox {
	getState(): OutboxState;
	/** Calls `listener` after each change of the state. Returns a function that removes the listener. */
	subscribe(listener: () => void): () => void;
	/** The list that shows the room now. Null while no list shows it. */
	attach(view: OutboxView | null): void;
	/** Adds a message to the end of the line. */
	send(text: string): void;
	/** Sends a failed message again, with the same key. */
	retry(key: string): void;
	/** Removes a message that failed or that waits. A message whose call runs stays. */
	discard(key: string): void;
	/**
	 * Records that the server has a failed message as the message `id`: the list got it, and the
	 * answers of the send did not arrive. The stored message then has the key of the send.
	 */
	settle(key: string, id: string): void;
	/** Stops each send and removes each message, for example when the person of the page changes. */
	stop(): void;
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
 * - An outbox sends only while its person is the person of the page.
 */
export function createOutbox(options: OutboxOptions): Outbox {
	let state: OutboxState = { pending: [], keys: new Map(), sendingKey: null };
	const listeners = new Set<() => void>();
	let view: OutboxView | null = null;
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	function change(next: Partial<OutboxState>): void {
		state = { ...state, ...next };
		for (const listener of listeners) listener();
	}

	function update(key: string, changes: Partial<PendingMessage>): readonly PendingMessage[] {
		return state.pending.map((message) => (message.key === key ? { ...message, ...changes } : message));
	}

	/** The keys with one more message. The oldest keys go when the map is full. */
	function withKey(id: string, key: string): ReadonlyMap<string, string> {
		const keys = new Map(state.keys).set(id, key);
		for (const old of keys.keys()) {
			if (keys.size <= MAX_KEYS) break;
			keys.delete(old);
		}
		return keys;
	}

	function stop(): void {
		stopped = true;
		clearTimeout(timer);
		change({ pending: [], sendingKey: null });
	}

	/** `lost` is true when the answer of an earlier attempt of this send did not arrive. */
	function attempt(message: PendingMessage, attempts: number, lost: boolean): void {
		if (stopped) return;
		if (!options.active()) {
			stop();
			return;
		}
		options.post(message.text, message.key).then(
			(stored) => {
				// An outbox that stopped shows nothing. The server has the message, and the next load of the room gets it.
				if (stopped) return;
				change({
					pending: state.pending.filter((entry) => entry.key !== message.key),
					keys: withKey(stored.id, message.key),
					sendingKey: null,
				});
				view?.deliver(stored);
				pump();
			},
			(error: unknown) => {
				if (stopped) return;
				// A refusal is an answer: that attempt stored nothing. The rate limit is a refusal too.
				const refused = error instanceof ApiError && error.status < 500;
				const uncertain = lost || !refused;
				const wait = canSucceedLater(error) ? RETRY_WAITS_MS[attempts] : undefined;
				if (wait !== undefined) {
					timer = setTimeout(() => attempt(message, attempts + 1, uncertain), wait);
					return;
				}
				change({
					pending: update(message.key, { state: "failed", error: options.describe(error), uncertain }),
					sendingKey: null,
				});
				pump();
			},
		);
	}

	/** Starts the call of the first message that waits, when no call runs. */
	function pump(): void {
		if (stopped || state.sendingKey !== null) return;
		const next = state.pending.find((message) => message.state === "waiting");
		if (!next) return;
		// A send that the person sends again keeps the start of its first call: the server can have
		// its message from that call.
		const afterSeq = next.afterSeq ?? view?.lastSeq() ?? null;
		change({ pending: update(next.key, { state: "sending", afterSeq }), sendingKey: next.key });
		attempt({ ...next, afterSeq }, 0, next.uncertain);
	}

	return {
		getState: () => state,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		attach(next) {
			view = next;
		},
		send(text) {
			if (stopped) return;
			const message: PendingMessage = {
				key: crypto.randomUUID(),
				text,
				created_at: new Date().toISOString(),
				state: "waiting",
				error: null,
				uncertain: false,
				afterSeq: null,
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
		settle(key, id) {
			if (!state.pending.some((message) => message.key === key && message.state === "failed")) return;
			change({ pending: state.pending.filter((message) => message.key !== key), keys: withKey(id, key) });
		},
		stop,
	};
}
