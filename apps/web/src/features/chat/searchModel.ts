import type { DraftStorage } from "./drafts.ts";

// The rules of the Search view: the text of a result with its found words, and the recent searches of a
// person. It has no DOM, so apps/web/test checks it.

/** A part of the text of a result. A marked part is a word that the search found. */
export interface TextPart {
	text: string;
	marked: boolean;
}

/** The characters of the text of one result that show. */
const RESULT_CHARS = 280;
/** The most characters that show before the first found word of a long text: a quarter of the text that shows, at most. */
const LEAD_CHARS = 60;

/** True when a position is between the two code units of one character, so a cut there breaks the character. */
function splitsPair(text: string, position: number): boolean {
	const before = text.charCodeAt(position - 1);
	const after = text.charCodeAt(position);
	return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/**
 * The text of a result as parts, with each found word marked. `highlights` are the positions that the
 * server found, in UTF-16 code units. A long text shows the part around its first found word, with "…"
 * where text is left out. A line break shows as a space. A position that is not in the text is ignored.
 */
export function resultParts(
	text: string,
	highlights: readonly { start: number; end: number }[],
	max = RESULT_CHARS,
): TextPart[] {
	const line = text.replace(/\s/g, " ");
	const ranges: { start: number; end: number }[] = [];
	for (const range of [...highlights].sort((a, b) => a.start - b.start)) {
		const start = Math.max(range.start, ranges[ranges.length - 1]?.end ?? 0);
		const end = Math.min(range.end, line.length);
		if (Number.isInteger(range.start) && Number.isInteger(range.end) && start < end) ranges.push({ start, end });
	}
	let from = 0;
	let to = line.length;
	if (line.length > max) {
		const lead = Math.min(LEAD_CHARS, Math.floor(max / 4));
		from = Math.max(0, Math.min((ranges[0]?.start ?? 0) - lead, line.length - max));
		to = from + max;
		if (splitsPair(line, from)) from += 1;
		if (splitsPair(line, to)) to -= 1;
	}
	const parts: TextPart[] = [];
	const add = (part: string, marked: boolean) => {
		if (part !== "") parts.push({ text: part, marked });
	};
	if (from > 0) add("…", false);
	let position = from;
	for (const range of ranges) {
		const start = Math.max(range.start, from);
		const end = Math.min(range.end, to);
		if (start >= end) continue;
		add(line.slice(position, start), false);
		add(line.slice(start, end), true);
		position = end;
	}
	add(line.slice(position, to), false);
	if (to < line.length) add("…", false);
	return parts;
}

/** The start of the `localStorage` key of the recent searches of one person. The id of the person follows. */
const PREFIX = "soldock:chat-searches:";

/** The recent searches that the browser keeps for one person. */
export const RECENT_SEARCHES = 8;
/** The longest query that the server takes (`CHAT_LIMITS.searchQueryChars`). A longer value is not from this app. */
const QUERY_CHARS = 500;

/** The recent searches of a person, the newest first. */
export function recentSearches(storage: DraftStorage | null, owner: string): string[] {
	if (!storage) return [];
	try {
		const parsed: unknown = JSON.parse(storage.getItem(PREFIX + owner) ?? "[]");
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter((query): query is string => typeof query === "string" && query !== "" && query.length <= QUERY_CHARS)
			.slice(0, RECENT_SEARCHES);
	} catch {
		// The browser refused the read, or the value is not from this app. The person has no recent searches then.
		return [];
	}
}

/**
 * Puts a query at the start of the recent searches of a person. A query that is there already, in each
 * letter case, moves to the start. A write that the browser refuses changes nothing.
 */
export function rememberSearch(storage: DraftStorage | null, owner: string, query: string): void {
	const text = query.trim();
	if (!storage || text === "" || text.length > QUERY_CHARS) return;
	const others = recentSearches(storage, owner).filter((recent) => recent.toLowerCase() !== text.toLowerCase());
	try {
		storage.setItem(PREFIX + owner, JSON.stringify([text, ...others].slice(0, RECENT_SEARCHES)));
	} catch {
		// The storage is full or refused. The recent searches stay as they are.
	}
}

/** Removes the recent searches of each person that is not `owner`: all of them when `owner` is null. */
export function forgetOtherSearches(storage: DraftStorage | null, owner: string | null): void {
	if (!storage) return;
	try {
		const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
		for (const key of keys) {
			if (key?.startsWith(PREFIX) && (owner === null || key !== PREFIX + owner)) storage.removeItem(key);
		}
	} catch {
		// The browser refused the storage. It has no recent searches then.
	}
}

/** Removes the recent searches of one person: the "Clear" button of the Search view. */
export function clearSearches(storage: DraftStorage | null, owner: string): void {
	try {
		storage?.removeItem(PREFIX + owner);
	} catch {
		// The browser refused the storage.
	}
}
