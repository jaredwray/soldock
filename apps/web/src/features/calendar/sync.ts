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
