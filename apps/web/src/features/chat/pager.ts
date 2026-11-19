import type { ChatMessage } from "@asterra/contracts";
import { type History, withChanges, withNewer, withOlder } from "./history.ts";
import type { ChangePage, RoomSync } from "./sync.ts";

// The page reads of one open room, and their order with the sync of the room. It has no DOM and no
// network of its own, so apps/web/test checks it.

/** The part of the history that shows, with the direction of the page read that runs. */
export interface PagerState extends History {
	paging: "older" | "newer" | null;
}

export interface PagerOptions {
	/** Reads a page of the history: before a seq, after a seq, or the newest messages. */
	read(range: { before?: number; after?: number }): Promise<ChangePage>;
	/** The sync of the room. Its `apply` must be the `apply` of this pager. */
	sync: Pick<RoomSync, "start" | "rewind" | "run">;
	/** The state that shows. */
	state(): PagerState;
	/** Changes the state. A change that returns its input changes nothing. */
	update(change: (current: PagerState) => PagerState): void;
	/** False after the page left the room. An answer that arrives then is dropped. */
	alive(): boolean;
}

export interface RoomPager {
	/** Puts the changes of the sync, or of the socket, into the history. See `withChanges`. */
	apply(changes: readonly ChatMessage[]): void;
	/**
	 * The state for a list that a load of the room replaces with the newest messages, or with nothing
	 * for a room without access to its messages. Each read that runs is for the list from before, and
	 * does not apply. Put the state on the page in the same step, then run the sync.
	 */
	replace(page: ChangePage | null): PagerState;
	/**
	 * Reads the page before the first message, or after the last message, of the history. It does
	 * nothing when a page read runs, or when the room has no messages in that direction.
	 */
	readPage(direction: "older" | "newer"): Promise<void>;
	/**
	 * Puts the history at the newest messages of the room again. False when the read did not apply: a
	 * newer read, or a load, replaced the list first, or the page left the room.
	 */
	toLatest(): Promise<boolean>;
	/**
	 * Puts the history at one message of the room: the page of messages up to it, and the page after
	 * it. False when the read did not apply, as for `toLatest`. A room that does not have the message
	 * gets its newest messages.
	 */
	toMessage(seq: number): Promise<boolean>;
	/**
	 * Makes each read of `toLatest` and of `toMessage` that runs not apply. Use it when the person
	 * goes to a different place of the room: the answer of the read from before must not move the list.
	 */
	cancel(): void;
	/** Tells if the person looks at the end of the list. A full history then drops its oldest messages. */
	follow(atEnd: boolean): void;
}

/**
 * Makes the pager of one open room.
 *
 * A page has the messages as they were at its version of the room. The sync can be after that
 * version, and it dropped each change to a message that the history did not have then. So after each
 * page, the sync reads the changes after the version of the page again (`rewind`). Without that, an
 * old text stays, and a history that claims the end of the room can miss a message.
 */
export function createRoomPager(options: PagerOptions): RoomPager {
	const { read, sync, state, update, alive } = options;
	/** The number of the last page read, and of the last read of the newest messages. An older read does not apply. */
	let pageReads = 0;
	let latestReads = 0;
	let following = true;

	function replace(page: ChangePage | null): PagerState {
		if (page) sync.start(page.version);
		pageReads += 1;
		latestReads += 1;
		return { messages: page?.messages ?? [], hasOlder: page?.has_more ?? false, hasNewer: false, paging: null };
	}

	return {
		apply(changes) {
			update((current) => {
				const history = withChanges(current, changes, following);
				return history === current ? current : { ...history, paging: current.paging };
			});
		},
		replace,
		async readPage(direction) {
			const { messages, hasOlder, hasNewer, paging } = state();
			const edge = direction === "older" ? messages[0] : messages[messages.length - 1];
			if (!edge || paging !== null || !(direction === "older" ? hasOlder : hasNewer)) return;
			const request = ++pageReads;
			const current = () => alive() && request === pageReads;
			update((before) => ({ ...before, paging: direction }));
			try {
				const page = await read(direction === "older" ? { before: edge.seq } : { after: edge.seq });
				if (!current()) return;
				update((before) => ({
					...(direction === "older"
						? withOlder(before, page.messages, edge.seq, page.has_more)
						: withNewer(before, page.messages, edge.seq, page.has_more)),
					paging: null,
				}));
				sync.rewind(page.version);
			} catch (caught) {
				if (current()) update((before) => ({ ...before, paging: null }));
				throw caught;
			}
		},
		async toLatest() {
			const request = ++latestReads;
			const page = await read({});
			if (!alive() || request !== latestReads) return false;
			const next = replace(page);
			update(() => next);
			// As after a load: one read gets the changes after this list at once.
			void sync.run();
			return true;
		},
		async toMessage(seq) {
			const request = ++latestReads;
			const [upTo, after] = await Promise.all([read({ before: seq + 1 }), read({ after: seq })]);
			if (!alive() || request !== latestReads) return false;
			// The two pages are one part of the history without a gap: a seq never changes. The two reads
			// can be at different versions of the room, so the sync starts at the older one.
			sync.start(Math.min(upTo.version, after.version));
			pageReads += 1;
			latestReads += 1;
			const next: PagerState = {
				messages: [...upTo.messages, ...after.messages],
				hasOlder: upTo.has_more,
				hasNewer: after.has_more,
				paging: null,
			};
			update(() => next);
			void sync.run();
			return true;
		},
		cancel() {
			latestReads += 1;
		},
		follow(atEnd) {
			following = atEnd;
		},
	};
}
