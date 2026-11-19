import type { ChatMessage, ChatThreadFollow } from "@soldock/contracts";

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

/** The wait before the first retry of a failed catch-up for a room version that the view has, in ms. */
export const THREAD_RETRY_MS = 1_000;
/** The longest wait before a retry. Each failure doubles the wait up to this value. */
export const THREAD_RETRY_MAX_MS = 60_000;
/** The shortest time between two reads for the room lists of a room that is not in the room list, in ms. */
export const THREAD_POLL_MS = 15_000;

/**
 * The seq of the first new reply for a person: the first reply after the read marker of the thread that
 * stays and that a different principal wrote, or null. The server counts `unread_count` with the same rule.
 */
export function firstUnread(
	replies: readonly Pick<ChatMessage, "seq" | "deleted" | "author">[],
	lastReadSeq: number,
	ownId: string,
): number | null {
	const reply = replies.find((one) => one.seq > lastReadSeq && !one.deleted && one.author.principal_id !== ownId);
	return reply?.seq ?? null;
}

/** A part of the state of a thread for a person: the follow, or the read marker with its unread count. */
export type FollowPart = "following" | "marker";

/** The counts of the own changes of each part when a read or a call started. */
export interface FollowTicket {
	following: number;
	marker: number;
}

/**
 * The state of a thread for a person, from reads and own calls that can overlap. The follow and the marker
 * are two parts, each with a count of own changes.
 * - An own call (`begin`, then `finish`) adds 1 to the count of its part at its start and at its end. So a
 *   response that started during the call does not show that part: the server can answer it before the call.
 * - The response of the own call sets its own part, unless an own reply (`local`) changed it during the call.
 *   It sets the other part only when that part had no own change since the call started.
 * - A read (`ticket`, then `apply`) sets each part that had no own change since the read started.
 */
export interface FollowKeeper {
	current(): ChatThreadFollow | null;
	ticket(): FollowTicket;
	apply(ticket: FollowTicket, follow: ChatThreadFollow | undefined): void;
	begin(part: FollowPart): FollowTicket;
	finish(ticket: FollowTicket, part: FollowPart, follow: ChatThreadFollow | null): void;
	/** Sets the state after an own change that has no call of its own (an own reply), for both parts. */
	local(change: (follow: ChatThreadFollow) => ChatThreadFollow): void;
}

export function createFollowKeeper(show: (follow: ChatThreadFollow) => void): FollowKeeper {
	let state: ChatThreadFollow | null = null;
	const counts: FollowTicket = { following: 0, marker: 0 };
	const set = (next: ChatThreadFollow) => {
		state = next;
		show(next);
	};
	/** The state with the parts of `follow` that `keep` allows, on the current state. */
	const merge = (follow: ChatThreadFollow, keep: Record<FollowPart, boolean>): ChatThreadFollow | null => {
		if (state === null) return keep.following && keep.marker ? follow : null;
		return {
			following: keep.following ? follow.following : state.following,
			last_read_seq: keep.marker ? follow.last_read_seq : state.last_read_seq,
			unread_count: keep.marker ? follow.unread_count : state.unread_count,
		};
	};
	return {
		current: () => state,
		ticket: () => ({ ...counts }),
		apply(ticket, follow) {
			if (!follow) return;
			const next = merge(follow, {
				following: ticket.following === counts.following,
				marker: ticket.marker === counts.marker,
			});
			if (next) set(next);
		},
		begin(part) {
			counts[part] += 1;
			return { ...counts };
		},
		finish(ticket, part, follow) {
			const other: FollowPart = part === "following" ? "marker" : "following";
			// An own reply during the call (`local`) changed the part after the server did the call.
			const ownKept = ticket[part] === counts[part];
			const otherKept = ticket[other] === counts[other];
			counts[part] += 1;
			if (!follow) return;
			const next = merge(follow, { [part]: ownKept, [other]: otherKept } as Record<FollowPart, boolean>);
			if (next) set(next);
		},
		local(change) {
			counts.following += 1;
			counts.marker += 1;
			if (state) set(change(state));
		},
	};
}

/** One page of `chat.list_replies`. */
export interface RepliesPage {
	parent: ChatMessage;
	replies: ChatMessage[];
	version: number;
	has_more: boolean;
	/** The state of the thread for the caller: the follow, the read marker and the unread count. */
	follow?: ChatThreadFollow | undefined;
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
	 * when its last catch-up failed and the wait before a retry is over. A room list that does not have
	 * the room gives null: the view reads at most one time in `THREAD_POLL_MS`.
	 */
	catchUp(roomVersion?: number | null): void;
	/** The thread that shows, or null before the first load. */
	current(): ThreadState | null;
}

/**
 * The data of the view of one thread, with no DOM and no network of its own. A message of the socket that
 * comes during the load waits, and goes into the thread after it. The load reads the changes after the
 * version of its first page, so a change during the read of a later page shows too. One catch-up runs at
 * a time. A call during a catch-up makes it run one more time. A failed catch-up keeps the version, so the
 * next catch-up asks for the same changes again. For the same room version, it waits first: 1 s, then
 * twice as long after each failure, up to 60 s.
 */
export function createThreadView(read: ReadReplies, show: (thread: ThreadState) => void): ThreadView {
	let thread: ThreadState | null = null;
	let waiting: ChatMessage[] = [];
	let running = false;
	/** True after a catch-up that failed: a catch-up after `retryAt` reads, also for the same version of the room. */
	let failed = false;
	/** The failures after the last catch-up that did not fail. */
	let failures = 0;
	/** The time (ms) after which a room list for a version that the view has tries a failed catch-up again. */
	let retryAt = 0;
	/** The highest version of the room that a catch-up asked for. A read that runs or ran covers it. */
	let asked = 0;
	/** The time (ms) after which a room list with no version of the room reads again. */
	let pollAt = 0;
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
			failures = 0;
		} catch {
			// The version did not move. A connect, a new room version, or a room list after the wait reads again.
			failed = true;
			failures += 1;
			retryAt = Date.now() + Math.min(THREAD_RETRY_MAX_MS, THREAD_RETRY_MS * 2 ** (failures - 1));
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
			if (roomVersion === null) {
				// The room list does not show if this room changed, so it reads at most one time in THREAD_POLL_MS.
				const now = Date.now();
				if (running || now < pollAt || (failed && now < retryAt)) return;
				pollAt = now + THREAD_POLL_MS;
			} else if (roomVersion !== undefined) {
				// A read that runs covers each version up to `asked`. After a failure, a room list for a covered
				// version waits for `retryAt`, so the room lists of other rooms do not repeat a read that fails.
				const covered = roomVersion <= Math.max(thread.version, asked);
				if (covered && (running || !failed || Date.now() < retryAt)) return;
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
