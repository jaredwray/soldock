/**
 * Gmail-style search queries. `parseQuery` turns the text into clauses. `compileQuery` turns the
 * clauses into one SQL condition on the `messages` table (alias `m`), with bound values only: no
 * part of the query text becomes SQL.
 */

export type Term =
	| { negate: boolean; kind: "text"; value: string }
	| { negate: boolean; kind: "op"; op: Operator; value: string };

/** The terms of a clause are joined with OR. The clauses of a query are joined with AND. */
export type Clause = Term[];

export const OPERATORS = [
	"from",
	"to",
	"cc",
	"bcc",
	"subject",
	"label",
	"in",
	"is",
	"has",
	"filename",
	"before",
	"after",
	"older_than",
	"newer_than",
	"larger",
	"smaller",
] as const;
export type Operator = (typeof OPERATORS)[number];

export class QueryError extends Error {}

const SYSTEM_IN = new Set(["inbox", "sent", "starred", "spam", "trash", "important", "unread"]);

/** Splits the text into tokens. A quoted part, with or without an operator before it, is one token. */
function tokenize(query: string): string[] {
	const tokens: string[] = [];
	const pattern = /(-?)([a-z_]+:)?"([^"]*)"?|(\S+)/gi;
	for (const match of query.matchAll(pattern)) {
		if (match[4] !== undefined) tokens.push(match[4]);
		else tokens.push(`${match[1] ?? ""}${match[2] ?? ""}"${match[3] ?? ""}"`);
	}
	return tokens;
}

function unquote(value: string): string {
	return value.startsWith('"') && value.endsWith('"') && value.length >= 2 ? value.slice(1, -1) : value;
}

export function parseQuery(query: string): Clause[] {
	const clauses: Clause[] = [];
	let joinNext = false;
	for (const token of tokenize(query.trim())) {
		if (token === "OR" || token === "|") {
			if (clauses.length > 0) joinNext = true;
			continue;
		}
		if (token === "AND") continue;
		let rest = token;
		let negate = false;
		if (rest.startsWith("-") && rest.length > 1) {
			negate = true;
			rest = rest.slice(1);
		}
		let term: Term | null = null;
		const colon = rest.indexOf(":");
		if (colon > 0) {
			const op = rest.slice(0, colon).toLowerCase();
			const value = unquote(rest.slice(colon + 1)).trim();
			if ((OPERATORS as readonly string[]).includes(op) && value.length > 0) {
				term = { negate, kind: "op", op: op as Operator, value };
			}
		}
		if (!term) {
			const value = unquote(rest).trim();
			if (value.length === 0) continue;
			term = { negate, kind: "text", value };
		}
		const previous = clauses.at(-1);
		if (joinNext && previous) previous.push(term);
		else clauses.push([term]);
		joinNext = false;
	}
	return clauses;
}

export interface CompiledQuery {
	/** A condition on `messages m`, or `1` for no condition. */
	where: string;
	params: (string | number)[];
}

export interface CompileOptions {
	/** The addresses of the mailbox owner, for `from:me` and `to:me`. */
	self: string[];
	/** Epoch milliseconds, for `older_than:` and `newer_than:`. */
	now: number;
}

function like(value: string): string {
	return `%${value.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** An FTS5 query for one word or phrase: a quoted string, so FTS operators in the text have no effect. */
function ftsPhrase(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function hasLabel(labelId: string): { sql: string; params: string[] } {
	return {
		sql: "EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_seq = m.seq AND ml.label_id = ?)",
		params: [labelId],
	};
}

function parseDate(value: string): number {
	const match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(value);
	if (!match) throw new QueryError(`Use a date such as 2026/10/31, not "${value}".`);
	const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
	if (Number.isNaN(time)) throw new QueryError(`"${value}" is not a date.`);
	return time;
}

function parseAge(value: string, now: number): number {
	const match = /^(\d{1,5})([dmy])$/i.exec(value);
	if (!match) throw new QueryError(`Use an age such as 7d, 3m or 1y, not "${value}".`);
	const days = { d: 1, m: 30, y: 365 }[(match[2] as string).toLowerCase() as "d" | "m" | "y"];
	return now - Number(match[1]) * days * 24 * 60 * 60 * 1000;
}

function parseSize(value: string): number {
	const match = /^(\d{1,9})([km]?)b?$/i.exec(value);
	if (!match) throw new QueryError(`Use a size such as 500K or 2M, not "${value}".`);
	const unit = { "": 1, k: 1024, m: 1024 * 1024 }[(match[2] as string).toLowerCase() as "" | "k" | "m"];
	return Number(match[1]) * unit;
}

function addressCondition(column: string, value: string, options: CompileOptions): { sql: string; params: string[] } {
	if (value.toLowerCase() === "me") {
		if (options.self.length === 0) return { sql: "0", params: [] };
		return {
			sql: `(${options.self.map(() => `lower(coalesce(${column}, '')) LIKE ? ESCAPE '\\'`).join(" OR ")})`,
			params: options.self.map(like),
		};
	}
	// coalesce: a NULL column would make the condition NULL, and NOT NULL is not true, so a negated
	// term would drop every message without a display name.
	return { sql: `lower(coalesce(${column}, '')) LIKE ? ESCAPE '\\'`, params: [like(value)] };
}

function compileTerm(term: Term, options: CompileOptions): { sql: string; params: (string | number)[] } {
	if (term.kind === "text") {
		return {
			sql: "m.seq IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)",
			params: [ftsPhrase(term.value)],
		};
	}
	const value = term.value;
	const lower = value.toLowerCase();
	switch (term.op) {
		case "from": {
			const name = addressCondition("m.from_name", value, options);
			const address = addressCondition("m.from_addr", value, options);
			return { sql: `(${address.sql} OR ${name.sql})`, params: [...address.params, ...name.params] };
		}
		case "to":
			return addressCondition("m.to_text", value, options);
		case "cc":
			return addressCondition("m.cc_text", value, options);
		case "bcc":
			return addressCondition("m.bcc_text", value, options);
		case "subject":
			return { sql: "lower(m.subject) LIKE ? ESCAPE '\\'", params: [like(value)] };
		case "label":
			return {
				sql: `EXISTS (SELECT 1 FROM message_labels ml JOIN labels l ON l.id = ml.label_id
					WHERE ml.message_seq = m.seq AND (l.id = ? OR replace(lower(l.name), ' ', '-') = replace(?, ' ', '-')))`,
				params: [value, lower],
			};
		case "in":
			if (lower === "anywhere" || lower === "all") return { sql: "1", params: [] };
			if (!SYSTEM_IN.has(lower))
				throw new QueryError(`in:${value} is not a folder. Use inbox, sent, starred, spam, trash or anywhere.`);
			return hasLabel(lower.toUpperCase());
		case "is":
			if (lower === "unread") return hasLabel("UNREAD");
			if (lower === "read") return { sql: `NOT ${hasLabel("UNREAD").sql}`, params: ["UNREAD"] };
			if (lower === "starred") return hasLabel("STARRED");
			if (lower === "important") return hasLabel("IMPORTANT");
			throw new QueryError(`is:${value} is not known. Use unread, read, starred or important.`);
		case "has":
			if (lower === "attachment") return { sql: "m.has_attachments = 1", params: [] };
			throw new QueryError(`has:${value} is not known. Use has:attachment.`);
		case "filename":
			return { sql: "lower(m.attachment_names) LIKE ? ESCAPE '\\'", params: [like(value)] };
		case "before":
			return { sql: "m.internal_date < ?", params: [parseDate(value)] };
		case "after":
			return { sql: "m.internal_date >= ?", params: [parseDate(value)] };
		case "older_than":
			return { sql: "m.internal_date < ?", params: [parseAge(value, options.now)] };
		case "newer_than":
			return { sql: "m.internal_date >= ?", params: [parseAge(value, options.now)] };
		case "larger":
			return { sql: "m.size > ?", params: [parseSize(value)] };
		case "smaller":
			return { sql: "m.size < ?", params: [parseSize(value)] };
	}
}

/** Durable Object SQLite binds at most 100 values in one statement. The listing query adds 5. */
export const MAX_QUERY_PARAMS = 90;

/** True when the query names spam or trash, so the default exclusion of spam and trash does not apply. */
function namesSpamOrTrash(clauses: Clause[]): boolean {
	return clauses.some((clause) =>
		clause.some(
			(term) =>
				term.kind === "op" &&
				(term.op === "in" || term.op === "label") &&
				["spam", "trash", "anywhere"].includes(term.value.toLowerCase()),
		),
	);
}

export function compileQuery(clauses: Clause[], options: CompileOptions): CompiledQuery {
	const parts: string[] = [];
	const params: (string | number)[] = [];
	for (const clause of clauses) {
		const terms = clause.map((term) => {
			const compiled = compileTerm(term, options);
			params.push(...compiled.params);
			return term.negate ? `NOT (${compiled.sql})` : `(${compiled.sql})`;
		});
		parts.push(terms.length === 1 ? (terms[0] as string) : `(${terms.join(" OR ")})`);
	}
	if (params.length > MAX_QUERY_PARAMS) throw new QueryError("The query has too many terms. Use fewer terms.");
	if (!namesSpamOrTrash(clauses)) {
		parts.push(
			"NOT EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_seq = m.seq AND ml.label_id IN ('SPAM', 'TRASH'))",
		);
	}
	return { where: parts.length > 0 ? parts.join(" AND ") : "1", params };
}
