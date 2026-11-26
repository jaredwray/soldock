import type { OutputOf } from "@asterra/contracts";

// The catch-up of the web calendar from its cursor in the change feed (`calendar.list_changes`). A change has
// ids only, so the page reads its range again after a change. The cursor only moves forward, and the range
// replaces the events on screen, so a change that comes two times never shows an event two times.

export type ChangePage = Pick<OutputOf<"calendar.list_changes">, "changes" | "cursor" | "has_more" | "expired">;

/** The most pages of one catch-up. After them the page reads its range again, which is always correct. */
const MAX_PAGES = 50;

export interface CatchUp {
	/** The cursor after the last change that the catch-up read. */
	cursor: string;
	/** True when the range must load again: a change came, or the cursor expired. */
	reload: boolean;
}

/**
 * Reads the changes after `cursor`, page by page. An expired cursor gives the head cursor and a reload: the
 * full read of the range then gives the current state. No change gives the same cursor and no reload.
 */
export async function catchUp(cursor: string, list: (cursor: string) => Promise<ChangePage>): Promise<CatchUp> {
	let current = cursor;
	let reload = false;
	for (let page = 0; page < MAX_PAGES; page++) {
		const result = await list(current);
		current = result.cursor;
		if (result.expired) return { cursor: current, reload: true };
		if (result.changes.length > 0) reload = true;
		if (!result.has_more) return { cursor: current, reload };
	}
	return { cursor: current, reload: true };
}

/** What the sync of one range needs. A test gives its own parts. */
export interface SyncParts {
	/** The position of the page in the change feed. Each range of the page uses the same object. */
	cursor: { current: string | null };
	/** Reads the cursor of now. */
	head: () => Promise<string>;
	/** Reads one page of changes after a cursor. */
	list: (cursor: string) => Promise<ChangePage>;
	/**
	 * Reads the range. `fresh` shows the loading state with no events. The result is true only when this read
	 * put its events on screen. It is false after a failure, and when a newer read replaced this one.
	 */
	load: (fresh: boolean) => Promise<boolean>;
	/**
	 * True when the events of this range are on screen, also after a load outside the sync, such as Try again.
	 * Then a read of the range keeps the events while it loads.
	 */
	shown: () => boolean;
	/** True after the page left the range of this sync. */
	stopped: () => boolean;
}

/**
 * Makes the sync of one range. Each hint, connect and fallback tick calls the function that it returns.
 *
 * - One catch-up runs at a time. A call during a catch-up runs one more catch-up after it.
 * - The first read gets the cursor of now, then reads the range. So a change that commits during the read of
 *   the range is after the cursor, and the next catch-up reads it.
 * - The cursor is set, and moves, only after the range loaded. A failed read of the range keeps the cursor, so the next
 *   sync reads the same changes and loads the range again.
 * - A sync of a range that the page left does not move the cursor. The read of the new range started before
 *   the changes of that catch-up, so the next catch-up must read them again.
 * - While the feed gives no cursor, each sync reads the range. Only the first of these reads shows the
 *   loading state.
 */
export function createSync(parts: SyncParts): () => Promise<void> {
	const { cursor, stopped } = parts;
	let running = false;
	let again = false;
	/** A read after the events of this range are on screen keeps them while it loads. */
	const loadRange = () => parts.load(!parts.shown());
	const first = async () => {
		let head: string;
		try {
			head = await parts.head();
		} catch {
			if (!stopped()) await loadRange();
			return;
		}
		if (stopped()) return;
		// The cursor of now applies only when the range read after it is on screen. After a failed read, the next
		// sync gets a new cursor and reads the range again.
		const shown = await loadRange();
		if (shown && !stopped()) cursor.current = head;
	};
	const next = async (from: string) => {
		const result = await catchUp(from, parts.list);
		if (stopped()) return;
		if (result.reload && !(await parts.load(false))) return;
		if (!stopped()) cursor.current = result.cursor;
	};
	return async () => {
		if (running) {
			again = true;
			return;
		}
		running = true;
		try {
			do {
				again = false;
				try {
					if (cursor.current === null) await first();
					else await next(cursor.current);
				} catch {
					// The next hint, connect or fallback tick tries again.
				}
			} while (again && !stopped());
		} finally {
			running = false;
		}
	};
}
