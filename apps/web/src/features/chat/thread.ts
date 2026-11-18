import type { ChatMessage } from "@soldock/contracts";

// The pure rules of the view of one thread. They have no DOM and no network, so apps/web/test checks them.

/** The view of one thread: the message that starts it, its replies oldest first, and the version of the read. */
export interface ThreadState {
	parent: ChatMessage;
	replies: readonly ChatMessage[];
	/** The version of the room at the last read of the thread. A catch-up reads the changes after it. */
	version: number;
}

/**
 * The thread with `messages` in it: the newer copy of the parent, and each new or newer reply of this
 * parent, in the order of the seq. A message of a different thread or of the room list changes nothing.
 * A copy that is not newer than the one that shows changes nothing, so the socket and a read can bring
 * the same message in each order.
 */
export function mergeThread(state: ThreadState, messages: readonly ChatMessage[]): ThreadState {
	let parent = state.parent;
	const replies = new Map(state.replies.map((reply) => [reply.id, reply]));
	let changed = false;
	for (const message of messages) {
		if (message.id === parent.id) {
			if (message.version > parent.version) {
				parent = message;
				changed = true;
			}
		} else if (message.parent_id === parent.id) {
			const shown = replies.get(message.id);
			if (!shown || message.version > shown.version) {
				replies.set(message.id, message);
				changed = true;
			}
		}
	}
	if (!changed) return state;
	return { ...state, parent, replies: [...replies.values()].sort((a, b) => a.seq - b.seq) };
}

/** True when a message of the socket belongs to the thread of `parentId`: the parent or one of its replies. */
export function inThread(message: Pick<ChatMessage, "id" | "parent_id">, parentId: string): boolean {
	return message.id === parentId || message.parent_id === parentId;
}

/** One page of `chat.list_replies`. */
export interface RepliesPage {
	parent: ChatMessage;
	replies: ChatMessage[];
	version: number;
	has_more: boolean;
}

/** Reads one page of the replies: the first page, the page after a seq, or the changes after a version. */
export type ReadReplies = (range: { after?: number; changed_after?: number }) => Promise<RepliesPage>;

export interface ThreadView {
	/** Reads each page of the thread, then the changes of the time of the read. Throws when a read fails. */
	load(): Promise<void>;
	/** Takes one message from the socket of the room. A message before the end of the load waits for it. */
	receive(message: ChatMessage): void;
	/**
	 * Tells the view to read the changes that it missed. A new connect of the socket gives no version, and
	 * the view always reads. A new room list gives the version of the room: the view reads only when the
	 * room is after the version of the thread and after each version that a catch-up asked for before, or
	 * when its last catch-up failed.
	 */
	catchUp(roomVersion?: number): void;
	/** The thread that shows, or null before the first load. */
	current(): ThreadState | null;
}

/**
 * The data of the view of one thread, with no DOM and no network of its own. A message of the socket that
 * comes during the load waits, and goes into the thread after it. The load reads the changes after the
 * version of its first page, so a change during the read of a later page shows too. One catch-up runs at
 * a time. A call during a catch-up makes it run one more time. A failed catch-up keeps the version, so the
 * next catch-up asks for the same changes again.
 */
export function createThreadView(read: ReadReplies, show: (thread: ThreadState) => void): ThreadView {
	let thread: ThreadState | null = null;
	let waiting: ChatMessage[] = [];
	let running = false;
	/** True after a catch-up that failed: the next catch-up reads, also for the same version of the room. */
	let failed = false;
	/** The highest version of the room that a catch-up asked for. A read that runs or ran covers it. */
	let asked = 0;
	let again = false;

	const set = (next: ThreadState) => {
		if (next === thread) return;
		thread = next;
		show(next);
	};

	async function readChanges(): Promise<void> {
		if (thread === null) return;
		if (running) {
			again = true;
			return;
		}
		running = true;
		try {
			do {
				again = false;
				let after = thread.version;
				for (;;) {
					const page = await read({ changed_after: after });
					const merged = mergeThread(thread, [page.parent, ...page.replies]);
					const last = page.replies[page.replies.length - 1];
					const more = page.has_more && last !== undefined;
					// A page that is not the last one continues from the version of its last reply.
					after = more && last ? last.version : page.version;
					set(after > merged.version ? { ...merged, version: after } : merged);
					if (!more) break;
				}
			} while (again);
			failed = false;
		} catch {
			// The version did not move. The next catch-up (a connect or a room list) reads again.
			failed = true;
		} finally {
			running = false;
		}
	}

	return {
		async load() {
			let page = await read({});
			// The changes after the first page come with the catch-up below, so the thread keeps its version.
			const version = page.version;
			const replies = [...page.replies];
			while (page.has_more) {
				const last = replies[replies.length - 1];
				if (!last) break;
				page = await read({ after: last.seq });
				replies.push(...page.replies);
			}
			const loaded = mergeThread({ parent: page.parent, replies, version }, waiting);
			waiting = [];
			thread = null;
			set(loaded);
			await readChanges();
		},
		receive(message) {
			if (thread === null) waiting.push(message);
			else set(mergeThread(thread, [message]));
		},
		catchUp(roomVersion) {
			// Before the end of the load there is nothing to do: the load reads the changes at its end.
			if (thread === null) return;
			if (roomVersion !== undefined) {
				// A read that runs covers each version up to `asked`. If it fails, the next room list reads again.
				const covered = roomVersion <= Math.max(thread.version, asked);
				if (covered && (running || !failed)) return;
				asked = Math.max(asked, roomVersion);
			}
			void readChanges();
		},
		current: () => thread,
	};
}

/** The last send of a reply: its idempotency key, and the request that the key belongs to. */
export interface ReplyAttempt {
	key: string;
	request: string;
}

/**
 * The attempt for a send of `request` (the body and the options, as JSON). A second send of the same
 * request after a lost answer keeps the key, so the room stores the reply one time. A changed request
 * gets a new key: the old key with a different request would get `conflict` forever.
 */
export function replyAttempt(previous: ReplyAttempt | null, request: string, newKey: () => string): ReplyAttempt {
	return previous !== null && previous.request === request ? previous : { key: newKey(), request };
}
