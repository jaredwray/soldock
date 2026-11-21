import { OperationError } from "../platform/index.ts";

// The query of chat.search_messages. `parseSearch` reads the text of a query into words and filters. The
// handler finds the principals and the rooms that the filters name, and gives a `SearchFilter` to the room
// and to the index. `searchSql` makes the conditions of a `SearchFilter`, with bound values only: no part
// of the query text becomes SQL.

/** The filters of a query, as the caller wrote their values. */
export interface ParsedSearch {
	/** The words as one FTS5 query, or null for a query with filters only. */
	match: string | null;
	from: string[];
	in: string[];
	mentions: string[];
	hasLink: boolean;
	hasFile: boolean;
	isThread: boolean;
	/** The time before which a message was written, in milliseconds, or null. */
	before: number | null;
	/** The time from which a message was written, in milliseconds, or null. */
	after: number | null;
}

/** A query for a room or for the index: the words, and each filter with the ids that it names. */
export interface SearchFilter {
	match: string | null;
	/** The principal ids of the authors. A message of one of them matches. Empty for each author. */
	from: string[];
	/** The principal ids that the message must mention, each of them. */
	mentions: string[];
	hasLink: boolean;
	hasFile: boolean;
	isThread: boolean;
	before: number | null;
	after: number | null;
}

const FILTERS = ["from", "in", "mentions", "has", "is", "before", "after", "on"] as const;
type FilterName = (typeof FILTERS)[number];

/** The most words and filters of one query. Durable Object SQLite binds at most 100 values in one statement. */
const MAX_TERMS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function invalid(message: string): OperationError {
	return new OperationError("invalid", message);
}

/**
 * The tokenizer of the search tables (`unicode61`) makes a word from letters and digits. A text without
 * one of them has no word, so no search finds it.
 */
const HAS_WORD = /[\p{L}\p{N}]/u;

/** The parts of a text with letters and digits only: the words that the tokenizer makes. */
const WORD_CHARS = /[\p{L}\p{N}]+/gu;
/** The fewest characters of the last word before a `*`. */
const PREFIX_CHARS = 3;

/** An FTS5 phrase: a quoted string, so the FTS operators in the text have no effect. */
function ftsPhrase(text: string): string {
	return `"${text.replaceAll('"', '""')}"`;
}

/** The start of a day in UTC, in milliseconds. */
function dayOf(filter: string, value: string): number {
	const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value);
	const time = match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : Number.NaN;
	// A month or a day outside its range moves the date, so the parts must come back the same.
	const date = new Date(time);
	if (
		!match ||
		Number.isNaN(time) ||
		date.getUTCMonth() !== Number(match[2]) - 1 ||
		date.getUTCDate() !== Number(match[3])
	) {
		throw invalid(`Use a date such as 2026-10-31 for ${filter}:, not "${value}".`);
	}
	return time;
}

/**
 * Reads the text of a query. A quoted part is a phrase, also after a filter (`in:"Release plans"`). A
 * word that ends with `*` finds each word with that start. A word with a `:` that is no filter is a word.
 */
export function parseSearch(query: string): ParsedSearch {
	const parsed: ParsedSearch = {
		match: null,
		from: [],
		in: [],
		mentions: [],
		hasLink: false,
		hasFile: false,
		isThread: false,
		before: null,
		after: null,
	};
	const words: string[] = [];
	let terms = 0;
	// Control characters mean nothing in a query, and a NUL would end an FTS5 string early.
	const text = query.replace(/\p{Cc}/gu, " ");
	for (const token of text.matchAll(/([a-z]+:)?"([^"]*)"?(\*?)|(\S+)/gi)) {
		const quoted = token[2] !== undefined;
		let filter: string | null = token[1]?.slice(0, -1).toLowerCase() ?? null;
		let value = quoted ? (token[2] as string) : (token[4] as string);
		let prefix = quoted && token[3] === "*";
		if (!quoted) {
			const colon = value.indexOf(":");
			if (colon > 0 && (FILTERS as readonly string[]).includes(value.slice(0, colon).toLowerCase())) {
				filter = value.slice(0, colon).toLowerCase();
				value = value.slice(colon + 1);
			}
		}
		if (filter !== null && !(FILTERS as readonly string[]).includes(filter)) {
			// A word and a quoted part: `note:"a b"` finds the word and the phrase.
			if (HAS_WORD.test(filter)) words.push(ftsPhrase(filter));
			filter = null;
		}
		terms += 1;
		if (terms > MAX_TERMS) throw invalid(`A query has at most ${MAX_TERMS} words and filters.`);
		if (filter === null) {
			if (!quoted && value.length > 1 && value.endsWith("*")) {
				prefix = true;
				value = value.slice(0, -1);
			}
			// A text without a letter or a digit has no word. It finds nothing, so it is no part of the query.
			if (!HAS_WORD.test(value)) continue;
			// A short start finds a large part of all words, which costs much for each search.
			if (prefix && (value.match(WORD_CHARS)?.pop()?.length ?? 0) < PREFIX_CHARS) {
				throw invalid(`Write ${PREFIX_CHARS} letters or digits or more before the *, not "${value}*".`);
			}
			words.push(prefix ? `${ftsPhrase(value)}*` : ftsPhrase(value));
			continue;
		}
		value = value.trim();
		if (value === "") throw invalid(`The filter ${filter}: needs a value, such as ${EXAMPLES[filter as FilterName]}.`);
		const lower = value.toLowerCase();
		switch (filter as FilterName) {
			case "from":
				parsed.from.push(value);
				break;
			case "in":
				parsed.in.push(value);
				break;
			case "mentions":
				parsed.mentions.push(value);
				break;
			case "has":
				if (lower === "link") parsed.hasLink = true;
				else if (lower === "file") parsed.hasFile = true;
				else throw invalid(`has:${value} is not known. Use has:link or has:file.`);
				break;
			case "is":
				if (lower === "thread") parsed.isThread = true;
				else throw invalid(`is:${value} is not known. Use is:thread.`);
				break;
			case "before":
				parsed.before = Math.min(parsed.before ?? Number.POSITIVE_INFINITY, dayOf("before", value));
				break;
			case "after":
				parsed.after = Math.max(parsed.after ?? Number.NEGATIVE_INFINITY, dayOf("after", value));
				break;
			case "on": {
				const day = dayOf("on", value);
				parsed.after = Math.max(parsed.after ?? Number.NEGATIVE_INFINITY, day);
				parsed.before = Math.min(parsed.before ?? Number.POSITIVE_INFINITY, day + DAY_MS);
				break;
			}
		}
	}
	if (words.length > 0) parsed.match = words.join(" ");
	const hasFilter =
		parsed.from.length > 0 ||
		parsed.in.length > 0 ||
		parsed.mentions.length > 0 ||
		parsed.hasLink ||
		parsed.hasFile ||
		parsed.isThread ||
		parsed.before !== null ||
		parsed.after !== null;
	if (parsed.match === null && !hasFilter) {
		throw invalid("The query has no word with a letter or a digit, and no filter. Search finds words.");
	}
	return parsed;
}

const EXAMPLES: Record<FilterName, string> = {
	from: "from:ada",
	in: "in:general",
	mentions: "mentions:me",
	has: "has:link",
	is: "is:thread",
	before: "before:2026-10-31",
	after: "after:2026-10-01",
	on: "on:2026-10-15",
};

/**
 * The text of a message as the search tables keep it. The two characters that mark a found word in a
 * result (`HIGHLIGHT_OPEN`, `HIGHLIGHT_CLOSE`) become spaces of the same length, so a position in this
 * text is a position in the text of the message.
 */
export function indexedText(text: string): string {
	return text.replaceAll(HIGHLIGHT_OPEN, " ").replaceAll(HIGHLIGHT_CLOSE, " ");
}

/** The marks around a found word in the text that FTS5 returns: two characters of the private use area. */
export const HIGHLIGHT_OPEN = "";
export const HIGHLIGHT_CLOSE = "";

/** The found parts of a text, from the text with the marks of `highlight()`: positions in UTF-16 code units. */
export function highlightRanges(marked: string): { start: number; end: number }[] {
	const ranges: { start: number; end: number }[] = [];
	let position = 0;
	let start = -1;
	for (const char of marked) {
		if (char === HIGHLIGHT_OPEN) start = position;
		else if (char === HIGHLIGHT_CLOSE) {
			if (start >= 0 && position > start) ranges.push({ start, end: position });
			start = -1;
		} else position += char.length;
	}
	return ranges;
}

/** True when a message has a link: a link mark in its body, or an http or https address in its text. */
export function hasLink(text: string, bodyJson: string): boolean {
	// The JSON of a body has a quote in a text as \", so this text is in it only as a mark of a node.
	return /https?:\/\//i.test(text) || bodyJson.includes('"type":"link"');
}

/** The same rule as `hasLink`, as a condition on the table `messages`, for the messages from before the column. */
export const HAS_LINK_SQL = `(text LIKE '%http://%' OR text LIKE '%https://%' OR body_json LIKE '%"type":"link"%')`;

/** The names of the search tables and columns of one store: a room, or the index. */
export interface SearchColumns {
	/** The FTS5 table. Its rowid is `rowid`. */
	fts: string;
	/** The table of the messages, with the alias `m`. */
	messages: string;
	/** The column of `m` that is the rowid of the FTS5 table. */
	rowid: string;
	author: string;
	createdAt: string;
	/** A condition that is true for a message with a link, with a file, and in a thread. */
	hasLink: string;
	hasFile: string;
	isThread: string;
	/** A condition with one `?` for the id of a principal that the message mentions. */
	mentions: string;
}

/** The FROM part and the conditions of a filter, with the values in the order of their `?`. */
export function searchSql(
	filter: SearchFilter,
	columns: SearchColumns,
): { from: string; where: string[]; params: (string | number)[] } {
	const where: string[] = [];
	const params: (string | number)[] = [];
	let from = columns.messages;
	if (filter.match !== null) {
		from = `${columns.fts} JOIN ${columns.messages} ON ${columns.rowid} = ${columns.fts}.rowid`;
		where.push(`${columns.fts} MATCH ?`);
		params.push(filter.match);
	}
	if (filter.from.length > 0) {
		where.push(`${columns.author} IN (SELECT value FROM json_each(?))`);
		params.push(JSON.stringify(filter.from));
	}
	for (const principalId of filter.mentions) {
		where.push(columns.mentions);
		params.push(principalId);
	}
	if (filter.hasLink) where.push(columns.hasLink);
	if (filter.hasFile) where.push(columns.hasFile);
	if (filter.isThread) where.push(columns.isThread);
	if (filter.before !== null) {
		where.push(`${columns.createdAt} < ?`);
		params.push(filter.before);
	}
	if (filter.after !== null) {
		where.push(`${columns.createdAt} >= ?`);
		params.push(filter.after);
	}
	return { from, where, params };
}
