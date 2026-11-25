import { MAIL_LIMITS, type ScreenerMode, type ScreenerStatus } from "@asterra/contracts";

/**
 * The Screener of a mailbox. The first mail from a new sender outside the organization waits out of the
 * inbox until a person screens the sender in or out. The column `messages.screen` marks held mail:
 * `pending` (the sender waits) or `out` (a person screened the sender out). The table `screener_senders`
 * holds one row for each sender that waits and for each decision of a person.
 */

/** The migration of the mailbox for the Screener. `mail/mailbox.ts` appends it to its list. */
export const SCREENER_MIGRATION: string[] = [
	// Null for mail that the Screener does not hold. 'pending' or 'out' for held mail.
	"ALTER TABLE messages ADD COLUMN screen TEXT",
	"CREATE INDEX messages_from ON messages (from_addr, screen)",
	`CREATE TABLE screener_senders (
		address TEXT PRIMARY KEY,
		name TEXT,
		status TEXT NOT NULL CHECK (status IN ('pending', 'in', 'out')),
		first_seen_at INTEGER NOT NULL,
		last_message_at INTEGER NOT NULL DEFAULT 0,
		decided_at INTEGER,
		decided_by_json TEXT
	) WITHOUT ROWID`,
	"CREATE INDEX screener_senders_pending ON screener_senders (status, last_message_at)",
	"CREATE INDEX screener_senders_decided ON screener_senders (status, decided_at)",
];

/** When a person screens a sender back in, the held mail of this last period goes to the inbox. */
export const SCREENER_RESTORE_MS = MAIL_LIMITS.screenerRestoreDays * 24 * 60 * 60 * 1000;

/** What the Worker tells the mailbox about the Screener at a delivery or a change of the settings. */
export interface ScreenerContext {
	/** The default of the organization. */
	orgDefault: boolean;
	/** False for the own mailbox of an agent or a service account: the Screener never applies there. */
	eligible: boolean;
}

/** True when the Screener holds new mail, from the mode of the mailbox and the context. */
export function screenerEnabled(mode: ScreenerMode, context: ScreenerContext): boolean {
	if (!context.eligible) return false;
	return mode === "on" || (mode === "inherit" && context.orgDefault);
}

type Row = Record<string, SqlStorageValue>;

function one<T extends Row>(sql: SqlStorage, query: string, ...params: SqlStorageValue[]): T | null {
	return (sql.exec<T>(query, ...params).toArray()[0] as T | undefined) ?? null;
}

function all<T extends Row>(sql: SqlStorage, query: string, ...params: SqlStorageValue[]): T[] {
	return sql.exec<T>(query, ...params).toArray();
}

/** The person who decided, as the row keeps it. */
export interface DecidedBy {
	principal_id: string;
	kind: "human" | "agent";
	display_name: string;
}

export interface SenderRow extends Row {
	address: string;
	name: string | null;
	status: ScreenerStatus;
	first_seen_at: number;
	last_message_at: number;
	decided_at: number | null;
	decided_by_json: string | null;
}

/** The row of a sender, or null. The address is lowercase. */
export function senderRow(sql: SqlStorage, address: string): SenderRow | null {
	return one<SenderRow>(
		sql,
		"SELECT address, name, status, first_seen_at, last_message_at, decided_at, decided_by_json FROM screener_senders WHERE address = ?",
		address,
	);
}

/**
 * Records held mail from a sender: a new sender gets a `pending` row. A sender with a row keeps its status,
 * and gets the newest name and time.
 */
export function recordHeld(sql: SqlStorage, address: string, name: string | null, at: number): void {
	sql.exec(
		`INSERT INTO screener_senders (address, name, status, first_seen_at, last_message_at) VALUES (?, ?, 'pending', ?, ?)
		ON CONFLICT (address) DO UPDATE SET
			name = CASE WHEN excluded.last_message_at >= last_message_at THEN coalesce(excluded.name, name) ELSE name END,
			last_message_at = MAX(last_message_at, excluded.last_message_at)`,
		address,
		name,
		at,
		at,
	);
}

/** Writes the decision of a person for a sender. */
export function writeDecision(
	sql: SqlStorage,
	address: string,
	status: "in" | "out",
	by: DecidedBy,
	now: number,
): void {
	sql.exec(
		`INSERT INTO screener_senders (address, name, status, first_seen_at, last_message_at, decided_at, decided_by_json)
		VALUES (?, NULL, ?, ?, 0, ?, ?)
		ON CONFLICT (address) DO UPDATE SET status = excluded.status, decided_at = excluded.decided_at,
			decided_by_json = excluded.decided_by_json`,
		address,
		status,
		now,
		now,
		JSON.stringify(by),
	);
}

/** The senders that wait for a decision. */
export function pendingCount(sql: SqlStorage): number {
	return one<{ n: number }>(sql, "SELECT COUNT(*) AS n FROM screener_senders WHERE status = 'pending'")?.n ?? 0;
}

/** The decider from the stored JSON, or null when the column is empty or not valid. */
export function decidedByOf(json: string | null): DecidedBy | null {
	if (!json) return null;
	try {
		const value = JSON.parse(json) as Partial<DecidedBy>;
		if ((value.kind !== "human" && value.kind !== "agent") || typeof value.principal_id !== "string") return null;
		return { principal_id: value.principal_id, kind: value.kind, display_name: value.display_name ?? "" };
	} catch {
		return null;
	}
}

/** A sender of `listSenders`. */
export interface ScreenerSenderRecord {
	address: string;
	name: string | null;
	status: ScreenerStatus;
	messagesHeld: number;
	firstSeenAt: number;
	latest: {
		threadId: string;
		messageId: string;
		subject: string;
		snippet: string;
		receivedAt: number;
		hasAttachments: boolean;
	} | null;
	decidedAt: number | null;
	decidedBy: DecidedBy | null;
}

/**
 * One page of the senders with a status. Senders that wait come newest mail first. Decisions come newest
 * decision first. `after` is the sort time and the address of the last sender of the page before.
 */
export function listSenders(
	sql: SqlStorage,
	status: ScreenerStatus,
	after: [number, string] | null,
	limit: number,
): { senders: ScreenerSenderRecord[]; next: [number, string] | null } {
	const timeColumn = status === "pending" ? "last_message_at" : "coalesce(decided_at, 0)";
	const rows = all<SenderRow & { sort_at: number }>(
		sql,
		`SELECT address, name, status, first_seen_at, last_message_at, decided_at, decided_by_json, ${timeColumn} AS sort_at
		FROM screener_senders
		WHERE status = ? AND (? = 0 OR ${timeColumn} < ? OR (${timeColumn} = ? AND address < ?))
		ORDER BY sort_at DESC, address DESC
		LIMIT ?`,
		status,
		after ? 1 : 0,
		after?.[0] ?? 0,
		after?.[0] ?? 0,
		after?.[1] ?? "",
		limit + 1,
	);
	const page = rows.slice(0, limit);
	// A sender that is screened in has no held mail. Mail of a sender that waits is `pending`, and of a sender
	// that is screened out, `out`.
	const held = status === "pending" ? "pending" : status === "out" ? "out" : null;
	const senders = page.map((row): ScreenerSenderRecord => {
		const count = held
			? (one<{ n: number }>(
					sql,
					"SELECT COUNT(*) AS n FROM messages WHERE from_addr = ? AND screen = ?",
					row.address,
					held,
				)?.n ?? 0)
			: 0;
		const latest = held
			? one<{
					id: string;
					thread_id: string;
					subject: string;
					snippet: string;
					internal_date: number;
					has_attachments: number;
				}>(
					sql,
					`SELECT id, thread_id, subject, snippet, internal_date, has_attachments FROM messages
					WHERE from_addr = ? AND screen = ? ORDER BY internal_date DESC, seq DESC LIMIT 1`,
					row.address,
					held,
				)
			: null;
		return {
			address: row.address,
			name: row.name,
			status: row.status,
			messagesHeld: count,
			firstSeenAt: row.first_seen_at,
			latest: latest
				? {
						threadId: latest.thread_id,
						messageId: latest.id,
						subject: latest.subject,
						snippet: latest.snippet,
						receivedAt: latest.internal_date,
						hasAttachments: latest.has_attachments === 1,
					}
				: null,
			decidedAt: row.decided_at,
			decidedBy: decidedByOf(row.decided_by_json),
		};
	});
	const last = page.at(-1);
	return { senders, next: rows.length > limit && last ? [last.sort_at, last.address] : null };
}
