import { EmailMessage } from "cloudflare:email";
import { DurableObject } from "cloudflare:workers";
import { MAIL_LIMITS } from "@soldock/contracts";
import { log, newId } from "../platform/index.ts";
import { deliverInternal } from "./delivery.ts";
import type { AttachmentMeta, AuthenticationResults, MailAddress, ParsedMail } from "./mime/parse.ts";
import { compileQuery, parseQuery, QueryError } from "./search.ts";
import { hasReplyPrefix, htmlToText, normalizeSubject, snippetOf } from "./threading.ts";

/** An expected failure, returned instead of thrown, because RPC does not keep error classes. */
export type Refusal = { error: { code: "invalid" | "not_found" | "conflict"; message: string } };

export interface DeliverInput {
	contentHash: string;
	rawKey: string;
	size: number;
	origin: "external" | "internal";
	internalDate: number;
	parsed: ParsedMail;
	spam: boolean;
}

export interface SendInput {
	messageId: string;
	idempotencyKey: string | null;
	contentHash: string;
	rawKey: string;
	size: number;
	internalDate: number;
	parsed: ParsedMail;
	bcc: MailAddress[];
	replyThreadId: string | null;
	recipients: { address: string; kind: "local" | "external"; principalId: string | null; self: boolean }[];
}

export interface DeliveryRecord {
	address: string;
	kind: "local" | "external";
	status: "queued" | "delivered" | "sent" | "failed";
	error: string | null;
}

export interface SendResult {
	message_id: string;
	thread_id: string;
	recipients: DeliveryRecord[];
}

export interface StoredMessage {
	id: string;
	threadId: string;
	origin: "external" | "internal" | "sent";
	messageIdHeader: string | null;
	subject: string;
	from: MailAddress | null;
	to: MailAddress[];
	cc: MailAddress[];
	bcc: MailAddress[];
	replyTo: MailAddress[];
	sentDate: number;
	internalDate: number;
	snippet: string;
	text: string | null;
	html: string | null;
	truncated: boolean;
	attachments: (AttachmentMeta & { index: number })[];
	authentication: AuthenticationResults | null;
	labels: string[];
	delivery: DeliveryRecord[] | null;
}

export interface ThreadSummaryRecord {
	id: string;
	subject: string;
	snippet: string;
	participants: MailAddress[];
	messageCount: number;
	labels: string[];
	hasAttachments: boolean;
	untrusted: boolean;
	lastMessageAt: number;
}

export interface LabelRecord {
	id: string;
	name: string;
	type: "system" | "user";
	threads_total: number;
	threads_unread: number;
}

const SYSTEM_LABEL_ORDER = ["INBOX", "STARRED", "IMPORTANT", "SENT", "SPAM", "TRASH", "UNREAD"];

/** Ordered migrations. Each inner list runs in one transaction. Append only. */
const MIGRATIONS: string[][] = [
	[
		`CREATE TABLE threads (
			id TEXT PRIMARY KEY,
			subject TEXT NOT NULL,
			normalized_subject TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			last_message_at INTEGER NOT NULL
		)`,
		"CREATE INDEX threads_subject ON threads (normalized_subject, last_message_at)",
		`CREATE TABLE messages (
			seq INTEGER PRIMARY KEY,
			id TEXT NOT NULL UNIQUE,
			thread_id TEXT NOT NULL REFERENCES threads (id),
			content_hash TEXT NOT NULL UNIQUE,
			raw_key TEXT NOT NULL,
			origin TEXT NOT NULL CHECK (origin IN ('external', 'internal', 'sent')),
			message_id_header TEXT,
			subject TEXT NOT NULL,
			from_name TEXT,
			from_addr TEXT,
			to_json TEXT NOT NULL,
			cc_json TEXT NOT NULL,
			bcc_json TEXT NOT NULL,
			reply_to_json TEXT NOT NULL,
			to_text TEXT NOT NULL,
			cc_text TEXT NOT NULL,
			bcc_text TEXT NOT NULL,
			sent_date INTEGER NOT NULL,
			internal_date INTEGER NOT NULL,
			snippet TEXT NOT NULL,
			text_body TEXT,
			html_body TEXT,
			body_truncated INTEGER NOT NULL,
			size INTEGER NOT NULL,
			has_attachments INTEGER NOT NULL,
			attachments_json TEXT NOT NULL,
			attachment_names TEXT NOT NULL,
			auth_json TEXT
		)`,
		"CREATE INDEX messages_thread ON messages (thread_id, internal_date)",
		"CREATE INDEX messages_date ON messages (internal_date)",
		"CREATE INDEX messages_message_id ON messages (message_id_header)",
		`CREATE TABLE message_refs (
			message_seq INTEGER NOT NULL,
			position INTEGER NOT NULL,
			ref TEXT NOT NULL,
			PRIMARY KEY (message_seq, position)
		) WITHOUT ROWID`,
		"CREATE INDEX message_refs_ref ON message_refs (ref)",
		`CREATE TABLE labels (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			type TEXT NOT NULL CHECK (type IN ('system', 'user')),
			created_at INTEGER NOT NULL
		)`,
		"CREATE UNIQUE INDEX labels_name ON labels (lower(name))",
		`CREATE TABLE message_labels (
			message_seq INTEGER NOT NULL,
			label_id TEXT NOT NULL,
			PRIMARY KEY (message_seq, label_id)
		) WITHOUT ROWID`,
		"CREATE INDEX message_labels_label ON message_labels (label_id, message_seq)",
		"CREATE VIRTUAL TABLE messages_fts USING fts5 (subject, people, body, attachments, tokenize = 'unicode61 remove_diacritics 2')",
		`CREATE TABLE delivery (
			message_seq INTEGER NOT NULL,
			address TEXT NOT NULL,
			kind TEXT NOT NULL CHECK (kind IN ('local', 'external')),
			status TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'sent', 'failed')),
			error TEXT,
			provider_id TEXT,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (message_seq, address)
		) WITHOUT ROWID`,
		`CREATE TABLE outbox (
			id INTEGER PRIMARY KEY,
			message_seq INTEGER NOT NULL,
			kind TEXT NOT NULL CHECK (kind IN ('deliver', 'smtp')),
			target TEXT NOT NULL,
			address TEXT NOT NULL,
			attempts INTEGER NOT NULL DEFAULT 0,
			next_attempt_at INTEGER NOT NULL,
			last_error TEXT
		)`,
		"CREATE INDEX outbox_due ON outbox (next_attempt_at)",
		`CREATE TABLE idempotency (
			key TEXT PRIMARY KEY,
			result TEXT NOT NULL,
			created_at INTEGER NOT NULL
		)`,
		...SYSTEM_LABEL_ORDER.map(
			(id) => `INSERT INTO labels (id, name, type, created_at) VALUES ('${id}', '${id}', 'system', 0)`,
		),
	],
];

const MAX_TEXT_BYTES = 256 * 1024;
const MAX_HTML_BYTES = 1024 * 1024;
const MAX_INDEXED_BODY_CHARS = 100_000;
const SUBJECT_THREAD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const OUTBOX_MAX_ATTEMPTS = 8;
const OUTBOX_BATCH = 25;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Cuts a string to at most `maxBytes` of UTF-8, at a character boundary. */
function capUtf8(value: string | null, maxBytes: number): { value: string | null; truncated: boolean } {
	if (value === null || value.length * 3 <= maxBytes) return { value, truncated: false };
	const bytes = encoder.encode(value);
	if (bytes.byteLength <= maxBytes) return { value, truncated: false };
	return { value: decoder.decode(bytes.subarray(0, maxBytes)).replace(/�+$/, ""), truncated: true };
}

function addressText(addresses: MailAddress[]): string {
	return addresses.map((a) => `${a.name ?? ""} ${a.address}`.trim().toLowerCase()).join(", ");
}

function backoff(attempts: number): number {
	return Math.min(60_000 * 2 ** (attempts - 1), 60 * 60 * 1000);
}

type Row = Record<string, SqlStorageValue>;

interface MessageRow extends Row {
	seq: number;
	id: string;
	thread_id: string;
	origin: string;
	message_id_header: string | null;
	subject: string;
	from_name: string | null;
	from_addr: string | null;
	to_json: string;
	cc_json: string;
	bcc_json: string;
	reply_to_json: string;
	sent_date: number;
	internal_date: number;
	snippet: string;
	text_body: string | null;
	html_body: string | null;
	body_truncated: number;
	attachments_json: string;
	auth_json: string | null;
}

/**
 * One mailbox, keyed by the principal id of its owner. It holds the messages, threads, labels,
 * search index, delivery status and outbox of that mailbox in its SQLite database. Raw messages
 * stay in R2. Side effects on other objects (local delivery, Email Service) go through the outbox
 * and its alarm, with retries.
 */
export class MailboxDO extends DurableObject<Env> {
	private readonly sql: SqlStorage;
	private draining = false;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		ctx.blockConcurrencyWhile(async () => this.migrate());
	}

	private migrate(): void {
		this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		const current = Number(this.meta("schema_version") ?? 0);
		for (let version = current; version < MIGRATIONS.length; version++) {
			this.ctx.storage.transactionSync(() => {
				for (const statement of MIGRATIONS[version] ?? []) this.sql.exec(statement);
				this.setMeta("schema_version", String(version + 1));
				if (version === 0) this.setMeta("version", "0");
			});
		}
	}

	private meta(key: string): string | null {
		return this.one<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value ?? null;
	}

	private setMeta(key: string, value: string): void {
		this.sql.exec(
			"INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
			key,
			value,
		);
	}

	/** The change counter. Clients compare it to find out if they must refetch. */
	private bump(): void {
		this.sql.exec("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'version'");
	}

	private one<T extends Row>(query: string, ...params: SqlStorageValue[]): T | null {
		return (this.sql.exec<T>(query, ...params).toArray()[0] as T | undefined) ?? null;
	}

	private all<T extends Row>(query: string, ...params: SqlStorageValue[]): T[] {
		return this.sql.exec<T>(query, ...params).toArray();
	}

	// --- Delivery -------------------------------------------------------------------------------

	/** Stores a message that arrived for this mailbox. A second copy of the same content is dropped. */
	deliver(input: DeliverInput): { status: "delivered" | "duplicate"; messageId: string; threadId: string } {
		const existing = this.one<{ id: string; thread_id: string }>(
			"SELECT id, thread_id FROM messages WHERE content_hash = ?",
			input.contentHash,
		);
		if (existing) return { status: "duplicate", messageId: existing.id, threadId: existing.thread_id };
		const labels = input.spam ? ["SPAM", "UNREAD"] : ["INBOX", "UNREAD"];
		const stored = this.ctx.storage.transactionSync(() => {
			const inserted = this.insertMessage({
				id: newId("msg"),
				threadHint: null,
				parsed: input.parsed,
				origin: input.origin,
				rawKey: input.rawKey,
				contentHash: input.contentHash,
				size: input.size,
				internalDate: input.internalDate,
				bcc: [],
				labels,
			});
			this.bump();
			return inserted;
		});
		return { status: "delivered", messageId: stored.id, threadId: stored.threadId };
	}

	private insertMessage(m: {
		id: string;
		threadHint: string | null;
		parsed: ParsedMail;
		origin: "external" | "internal" | "sent";
		rawKey: string;
		contentHash: string;
		size: number;
		internalDate: number;
		bcc: MailAddress[];
		labels: string[];
	}): { seq: number; id: string; threadId: string } {
		const { parsed } = m;
		const threadId = this.resolveThread(parsed, m.internalDate, m.threadHint);
		const text = capUtf8(parsed.text, MAX_TEXT_BYTES);
		const html = capUtf8(parsed.html, MAX_HTML_BYTES);
		const plain = parsed.text ?? (parsed.html ? htmlToText(parsed.html) : "");
		const attachments = parsed.attachments.map((attachment, index) => ({ ...attachment, index }));
		const seq = this.one<{ seq: number }>(
			`INSERT INTO messages (id, thread_id, content_hash, raw_key, origin, message_id_header, subject, from_name,
				from_addr, to_json, cc_json, bcc_json, reply_to_json, to_text, cc_text, bcc_text, sent_date, internal_date,
				snippet, text_body, html_body, body_truncated, size, has_attachments, attachments_json, attachment_names, auth_json)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
			m.id,
			threadId,
			m.contentHash,
			m.rawKey,
			m.origin,
			parsed.messageIdHeader,
			parsed.subject,
			parsed.from?.name ?? null,
			parsed.from?.address.toLowerCase() ?? null,
			JSON.stringify(parsed.to),
			JSON.stringify(parsed.cc),
			JSON.stringify(m.bcc),
			JSON.stringify(parsed.replyTo),
			addressText(parsed.to),
			addressText(parsed.cc),
			addressText(m.bcc),
			parsed.date ?? m.internalDate,
			m.internalDate,
			snippetOf(plain),
			text.value,
			html.value,
			text.truncated || html.truncated ? 1 : 0,
			m.size,
			attachments.some((a) => !a.inline) ? 1 : 0,
			JSON.stringify(attachments),
			attachments.map((a) => a.filename).join(" "),
			parsed.authentication ? JSON.stringify(parsed.authentication) : null,
		)?.seq as number;
		const refs = [...new Set([...parsed.references, ...(parsed.inReplyTo ? [parsed.inReplyTo] : [])])];
		refs.forEach((ref, position) => {
			this.sql.exec("INSERT INTO message_refs (message_seq, position, ref) VALUES (?, ?, ?)", seq, position, ref);
		});
		for (const label of m.labels) {
			this.sql.exec("INSERT OR IGNORE INTO message_labels (message_seq, label_id) VALUES (?, ?)", seq, label);
		}
		const people = [parsed.from, ...parsed.to, ...parsed.cc, ...m.bcc]
			.filter((a): a is MailAddress => a !== null)
			.map((a) => `${a.name ?? ""} ${a.address}`)
			.join(" ");
		this.sql.exec(
			"INSERT INTO messages_fts (rowid, subject, people, body, attachments) VALUES (?, ?, ?, ?, ?)",
			seq,
			parsed.subject,
			people,
			plain.slice(0, MAX_INDEXED_BODY_CHARS),
			attachments.map((a) => a.filename).join(" "),
		);
		this.sql.exec(
			"UPDATE threads SET last_message_at = MAX(last_message_at, ?) WHERE id = ?",
			m.internalDate,
			threadId,
		);
		return { seq, id: m.id, threadId };
	}

	/**
	 * Finds the thread of a new message: a thread that holds a message it references, or a message
	 * that references it (for mail that arrives out of order). A reply with no known reference joins
	 * a recent thread with the same subject. When the message links two threads, they merge.
	 */
	private resolveThread(parsed: ParsedMail, internalDate: number, hint: string | null): string {
		const found = new Set<string>();
		if (hint && this.one("SELECT 1 AS found FROM threads WHERE id = ?", hint)) found.add(hint);
		const refs = [...new Set([...(parsed.inReplyTo ? [parsed.inReplyTo] : []), ...parsed.references])].slice(-50);
		for (const ref of refs) {
			for (const row of this.all<{ thread_id: string }>(
				"SELECT DISTINCT thread_id FROM messages WHERE message_id_header = ?",
				ref,
			)) {
				found.add(row.thread_id);
			}
		}
		if (parsed.messageIdHeader) {
			for (const row of this.all<{ thread_id: string }>(
				"SELECT DISTINCT m.thread_id FROM message_refs r JOIN messages m ON m.seq = r.message_seq WHERE r.ref = ?",
				parsed.messageIdHeader,
			)) {
				found.add(row.thread_id);
			}
		}
		const normalized = normalizeSubject(parsed.subject);
		const sender = parsed.from?.address.toLowerCase();
		if (found.size === 0 && normalized && sender && hasReplyPrefix(parsed.subject)) {
			// Only a participant of the thread can join it by subject: its sender wrote to the thread or
			// was a recipient of it. A stranger's "Re:" starts a new thread.
			const row = this.one<{ id: string }>(
				`SELECT t.id FROM threads t
				WHERE t.normalized_subject = ? AND t.last_message_at >= ?
				AND EXISTS (
					SELECT 1 FROM messages m WHERE m.thread_id = t.id
					AND (m.from_addr = ? OR instr(m.to_text, ?) > 0 OR instr(m.cc_text, ?) > 0)
				)
				ORDER BY t.last_message_at DESC LIMIT 1`,
				normalized,
				internalDate - SUBJECT_THREAD_WINDOW_MS,
				sender,
				sender,
				sender,
			);
			if (row) found.add(row.id);
		}
		if (found.size === 0) {
			const id = newId("thr");
			this.sql.exec(
				"INSERT INTO threads (id, subject, normalized_subject, created_at, last_message_at) VALUES (?, ?, ?, ?, ?)",
				id,
				parsed.subject,
				normalized,
				internalDate,
				internalDate,
			);
			return id;
		}
		const ordered = [...found]
			.map((id) => this.one<{ id: string; created_at: number }>("SELECT id, created_at FROM threads WHERE id = ?", id))
			.filter((row): row is { id: string; created_at: number } => row !== null)
			.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
		const [target, ...others] = ordered.map((row) => row.id);
		for (const other of others) {
			this.sql.exec("UPDATE messages SET thread_id = ? WHERE thread_id = ?", target as string, other);
			this.sql.exec("DELETE FROM threads WHERE id = ?", other);
		}
		if (others.length > 0) {
			this.sql.exec(
				"UPDATE threads SET last_message_at = (SELECT MAX(internal_date) FROM messages WHERE thread_id = ?) WHERE id = ?",
				target as string,
				target as string,
			);
		}
		return target as string;
	}

	// --- Reading --------------------------------------------------------------------------------

	profile(): { messages_total: number; threads_total: number; inbox_unread: number; version: number } {
		const counts = this.one<{ messages: number; threads: number }>(
			"SELECT (SELECT COUNT(*) FROM messages) AS messages, (SELECT COUNT(*) FROM threads) AS threads",
		);
		const unread = this.one<{ n: number }>(
			`SELECT COUNT(DISTINCT m.thread_id) AS n FROM messages m
			JOIN message_labels inbox ON inbox.message_seq = m.seq AND inbox.label_id = 'INBOX'
			JOIN message_labels unread ON unread.message_seq = m.seq AND unread.label_id = 'UNREAD'
			WHERE NOT EXISTS (SELECT 1 FROM message_labels x WHERE x.message_seq = m.seq AND x.label_id IN ('SPAM', 'TRASH'))`,
		);
		return {
			messages_total: counts?.messages ?? 0,
			threads_total: counts?.threads ?? 0,
			inbox_unread: unread?.n ?? 0,
			version: Number(this.meta("version") ?? 0),
		};
	}

	listLabels(): LabelRecord[] {
		// Spam and trash count their own threads. Every other label hides the messages in spam or trash.
		const counts = new Map(
			this.all<{ id: string; total: number; unread: number }>(
				`SELECT ml.label_id AS id, COUNT(DISTINCT m.thread_id) AS total,
					COUNT(DISTINCT CASE WHEN u.message_seq IS NOT NULL THEN m.thread_id END) AS unread
				FROM message_labels ml
				JOIN messages m ON m.seq = ml.message_seq
				LEFT JOIN message_labels u ON u.message_seq = m.seq AND u.label_id = 'UNREAD'
				WHERE ml.label_id IN ('SPAM', 'TRASH') OR NOT EXISTS (
					SELECT 1 FROM message_labels x WHERE x.message_seq = m.seq AND x.label_id IN ('SPAM', 'TRASH')
				)
				GROUP BY ml.label_id`,
			).map((row) => [row.id, row]),
		);
		return this.all<{ id: string; name: string; type: string }>("SELECT id, name, type FROM labels")
			.map((row) => ({
				id: row.id,
				name: row.name,
				type: row.type as "system" | "user",
				threads_total: counts.get(row.id)?.total ?? 0,
				threads_unread: counts.get(row.id)?.unread ?? 0,
			}))
			.sort((a, b) => {
				if (a.type !== b.type) return a.type === "system" ? -1 : 1;
				if (a.type === "system") return SYSTEM_LABEL_ORDER.indexOf(a.id) - SYSTEM_LABEL_ORDER.indexOf(b.id);
				return a.name.localeCompare(b.name);
			});
	}

	listThreads(params: {
		query: string;
		cursor: string | null;
		limit: number;
		self: string[];
		now: number;
	}): { threads: ThreadSummaryRecord[]; nextCursor: string | null } | Refusal {
		let compiled: ReturnType<typeof compileQuery>;
		try {
			compiled = compileQuery(parseQuery(params.query), { self: params.self, now: params.now });
		} catch (error) {
			if (error instanceof QueryError) return { error: { code: "invalid", message: error.message } };
			throw error;
		}
		let after: [number, string] | null = null;
		if (params.cursor) {
			try {
				const decoded = JSON.parse(atob(params.cursor)) as unknown;
				if (Array.isArray(decoded) && typeof decoded[0] === "number" && typeof decoded[1] === "string") {
					after = [decoded[0], decoded[1]];
				}
			} catch {
				// Handled below.
			}
			if (!after) return { error: { code: "invalid", message: "The cursor is not valid." } };
		}
		const rows = this.all<{ thread_id: string; last_date: number }>(
			`SELECT m.thread_id AS thread_id, MAX(m.internal_date) AS last_date FROM messages m
			WHERE ${compiled.where}
			GROUP BY m.thread_id
			HAVING ? = 0 OR last_date < ? OR (last_date = ? AND m.thread_id < ?)
			ORDER BY last_date DESC, m.thread_id DESC
			LIMIT ?`,
			...compiled.params,
			after ? 1 : 0,
			after?.[0] ?? 0,
			after?.[0] ?? 0,
			after?.[1] ?? "",
			params.limit + 1,
		);
		const page = rows.slice(0, params.limit);
		const last = page.at(-1);
		return {
			threads: page.map((row) => this.summarize(row.thread_id, row.last_date)),
			nextCursor: rows.length > params.limit && last ? btoa(JSON.stringify([last.last_date, last.thread_id])) : null,
		};
	}

	private summarize(threadId: string, lastDate: number): ThreadSummaryRecord {
		const thread = this.one<{ subject: string }>("SELECT subject FROM threads WHERE id = ?", threadId);
		const messages = this.all<{
			from_name: string | null;
			from_addr: string | null;
			snippet: string;
			origin: string;
			has_attachments: number;
		}>(
			"SELECT from_name, from_addr, snippet, origin, has_attachments FROM messages WHERE thread_id = ? ORDER BY internal_date, seq",
			threadId,
		);
		const labels = this.all<{ label_id: string }>(
			"SELECT DISTINCT ml.label_id FROM message_labels ml JOIN messages m ON m.seq = ml.message_seq WHERE m.thread_id = ?",
			threadId,
		).map((row) => row.label_id);
		const participants = new Map<string, MailAddress>();
		for (const message of messages) {
			if (message.from_addr && !participants.has(message.from_addr)) {
				participants.set(message.from_addr, { name: message.from_name, address: message.from_addr });
			}
		}
		return {
			id: threadId,
			subject: thread?.subject ?? "",
			snippet: messages.at(-1)?.snippet ?? "",
			participants: [...participants.values()].slice(0, 5),
			messageCount: messages.length,
			labels,
			hasAttachments: messages.some((message) => message.has_attachments === 1),
			untrusted: messages.some((message) => message.origin === "external"),
			lastMessageAt: lastDate,
		};
	}

	getThread(threadId: string): { id: string; subject: string; messages: StoredMessage[] } | null {
		const thread = this.one<{ id: string; subject: string }>("SELECT id, subject FROM threads WHERE id = ?", threadId);
		if (!thread) return null;
		const rows = this.all<MessageRow>(
			"SELECT * FROM messages WHERE thread_id = ? ORDER BY internal_date, seq",
			threadId,
		);
		const labels = new Map<number, string[]>();
		for (const row of this.all<{ message_seq: number; label_id: string }>(
			"SELECT ml.message_seq, ml.label_id FROM message_labels ml JOIN messages m ON m.seq = ml.message_seq WHERE m.thread_id = ?",
			threadId,
		)) {
			labels.set(row.message_seq, [...(labels.get(row.message_seq) ?? []), row.label_id]);
		}
		const delivery = new Map<number, DeliveryRecord[]>();
		for (const row of this.all<{
			message_seq: number;
			address: string;
			kind: string;
			status: string;
			error: string | null;
		}>(
			"SELECT d.message_seq, d.address, d.kind, d.status, d.error FROM delivery d JOIN messages m ON m.seq = d.message_seq WHERE m.thread_id = ? ORDER BY d.address",
			threadId,
		)) {
			const record = {
				address: row.address,
				kind: row.kind as DeliveryRecord["kind"],
				status: row.status as DeliveryRecord["status"],
				error: row.error,
			};
			delivery.set(row.message_seq, [...(delivery.get(row.message_seq) ?? []), record]);
		}
		return {
			id: thread.id,
			subject: thread.subject,
			messages: rows.map((row) => ({
				id: row.id,
				threadId: row.thread_id,
				origin: row.origin as StoredMessage["origin"],
				messageIdHeader: row.message_id_header,
				subject: row.subject,
				from: row.from_addr ? { name: row.from_name, address: row.from_addr } : null,
				to: JSON.parse(row.to_json) as MailAddress[],
				cc: JSON.parse(row.cc_json) as MailAddress[],
				bcc: JSON.parse(row.bcc_json) as MailAddress[],
				replyTo: JSON.parse(row.reply_to_json) as MailAddress[],
				sentDate: row.sent_date,
				internalDate: row.internal_date,
				snippet: row.snippet,
				text: row.text_body,
				html: row.html_body,
				truncated: row.body_truncated === 1,
				attachments: JSON.parse(row.attachments_json) as StoredMessage["attachments"],
				authentication: row.auth_json ? (JSON.parse(row.auth_json) as AuthenticationResults) : null,
				labels: labels.get(row.seq) ?? [],
				delivery: row.origin === "sent" ? (delivery.get(row.seq) ?? []) : null,
			})),
		};
	}

	/** What a reply needs from the message that it answers. */
	getReplyContext(
		messageId: string,
	): { threadId: string; messageIdHeader: string | null; references: string[]; subject: string } | null {
		const row = this.one<{ seq: number; thread_id: string; message_id_header: string | null; subject: string }>(
			"SELECT seq, thread_id, message_id_header, subject FROM messages WHERE id = ?",
			messageId,
		);
		if (!row) return null;
		const references = this.all<{ ref: string }>(
			"SELECT ref FROM message_refs WHERE message_seq = ? ORDER BY position",
			row.seq,
		).map((r) => r.ref);
		return {
			threadId: row.thread_id,
			messageIdHeader: row.message_id_header,
			references,
			subject: row.subject,
		};
	}

	/** Where the raw message of an attachment is. */
	getAttachmentSource(
		messageId: string,
	): { rawKey: string; origin: StoredMessage["origin"]; attachments: StoredMessage["attachments"] } | null {
		const row = this.one<{ raw_key: string; origin: string; attachments_json: string }>(
			"SELECT raw_key, origin, attachments_json FROM messages WHERE id = ?",
			messageId,
		);
		if (!row) return null;
		return {
			rawKey: row.raw_key,
			origin: row.origin as StoredMessage["origin"],
			attachments: JSON.parse(row.attachments_json) as StoredMessage["attachments"],
		};
	}

	// --- Changes --------------------------------------------------------------------------------

	createLabel(name: string): LabelRecord | Refusal {
		const users = this.one<{ n: number }>("SELECT COUNT(*) AS n FROM labels WHERE type = 'user'")?.n ?? 0;
		if (users >= MAIL_LIMITS.userLabels) {
			return { error: { code: "invalid", message: `A mailbox can have at most ${MAIL_LIMITS.userLabels} labels.` } };
		}
		if (this.one("SELECT 1 AS found FROM labels WHERE lower(name) = lower(?)", name)) {
			return { error: { code: "conflict", message: `A label named "${name}" exists.` } };
		}
		const id = newId("lbl");
		this.ctx.storage.transactionSync(() => {
			this.sql.exec("INSERT INTO labels (id, name, type, created_at) VALUES (?, ?, 'user', ?)", id, name, Date.now());
			this.bump();
		});
		return { id, name, type: "user", threads_total: 0, threads_unread: 0 };
	}

	deleteLabel(id: string): { deleted: true } | Refusal {
		if (!this.one("SELECT 1 AS found FROM labels WHERE id = ? AND type = 'user'", id)) {
			return { error: { code: "not_found", message: "No user label has that id." } };
		}
		this.ctx.storage.transactionSync(() => {
			this.sql.exec("DELETE FROM message_labels WHERE label_id = ?", id);
			this.sql.exec("DELETE FROM labels WHERE id = ?", id);
			this.bump();
		});
		return { deleted: true };
	}

	modifyThreads(params: {
		threadIds: string[];
		add: string[];
		remove: string[];
		dryRun: boolean;
	}): { threads_changed: number; messages_changed: number; dry_run: boolean } | Refusal {
		for (const label of [...params.add, ...params.remove]) {
			if (!this.one("SELECT 1 AS found FROM labels WHERE id = ?", label)) {
				return { error: { code: "not_found", message: `No label has the id ${label}.` } };
			}
		}
		const threadIds = [...new Set(params.threadIds)];
		const changes: { seq: number; add: string[]; remove: string[] }[] = [];
		let threadsChanged = 0;
		for (const threadId of threadIds) {
			if (!this.one("SELECT 1 AS found FROM threads WHERE id = ?", threadId)) {
				return { error: { code: "not_found", message: `No thread has the id ${threadId}.` } };
			}
			let changed = false;
			for (const { seq } of this.all<{ seq: number }>("SELECT seq FROM messages WHERE thread_id = ?", threadId)) {
				const has = new Set(
					this.all<{ label_id: string }>("SELECT label_id FROM message_labels WHERE message_seq = ?", seq).map(
						(row) => row.label_id,
					),
				);
				const add = params.add.filter((label) => !has.has(label));
				const remove = params.remove.filter((label) => has.has(label));
				if (add.length > 0 || remove.length > 0) {
					changes.push({ seq, add, remove });
					changed = true;
				}
			}
			if (changed) threadsChanged++;
		}
		if (!params.dryRun && changes.length > 0) {
			this.ctx.storage.transactionSync(() => {
				for (const change of changes) {
					for (const label of change.add) {
						this.sql.exec(
							"INSERT OR IGNORE INTO message_labels (message_seq, label_id) VALUES (?, ?)",
							change.seq,
							label,
						);
					}
					for (const label of change.remove) {
						this.sql.exec("DELETE FROM message_labels WHERE message_seq = ? AND label_id = ?", change.seq, label);
					}
				}
				this.bump();
			});
		}
		return { threads_changed: threadsChanged, messages_changed: changes.length, dry_run: params.dryRun };
	}

	// --- Sending --------------------------------------------------------------------------------

	/** The stored result of an earlier send with this idempotency key in the last 24 hours, if any. */
	idempotentResult(key: string): SendResult | null {
		const row = this.one<{ result: string }>(
			"SELECT result FROM idempotency WHERE key = ? AND created_at >= ?",
			key,
			Date.now() - IDEMPOTENCY_TTL_MS,
		);
		return row ? (JSON.parse(row.result) as SendResult) : null;
	}

	/**
	 * Stores a sent message with the SENT label and queues its deliveries in the outbox, in one
	 * transaction. With an idempotency key that was used before, it stores nothing and returns the
	 * first result.
	 */
	async send(input: SendInput): Promise<{ duplicate: boolean; result: SendResult }> {
		const now = Date.now();
		const result = this.ctx.storage.transactionSync(() => {
			this.sql.exec("DELETE FROM idempotency WHERE created_at < ?", now - IDEMPOTENCY_TTL_MS);
			if (input.idempotencyKey) {
				const earlier = this.idempotentResult(input.idempotencyKey);
				if (earlier) return { duplicate: true, result: earlier };
			}
			const selfDelivery = input.recipients.some((r) => r.self);
			const stored = this.insertMessage({
				id: input.messageId,
				threadHint: input.replyThreadId,
				parsed: input.parsed,
				origin: "sent",
				rawKey: input.rawKey,
				contentHash: input.contentHash,
				size: input.size,
				internalDate: input.internalDate,
				bcc: input.bcc,
				labels: selfDelivery ? ["SENT", "INBOX"] : ["SENT"],
			});
			const recipients: DeliveryRecord[] = [];
			for (const recipient of input.recipients) {
				const status = recipient.self ? "delivered" : "queued";
				this.sql.exec(
					"INSERT OR IGNORE INTO delivery (message_seq, address, kind, status, updated_at) VALUES (?, ?, ?, ?, ?)",
					stored.seq,
					recipient.address,
					recipient.kind,
					status,
					now,
				);
				recipients.push({ address: recipient.address, kind: recipient.kind, status, error: null });
				if (recipient.self) continue;
				this.sql.exec(
					"INSERT INTO outbox (message_seq, kind, target, address, next_attempt_at) VALUES (?, ?, ?, ?, ?)",
					stored.seq,
					recipient.kind === "local" ? "deliver" : "smtp",
					recipient.kind === "local" ? (recipient.principalId as string) : recipient.address,
					recipient.address,
					now,
				);
			}
			const sendResult: SendResult = { message_id: stored.id, thread_id: stored.threadId, recipients };
			if (input.idempotencyKey) {
				this.sql.exec(
					"INSERT INTO idempotency (key, result, created_at) VALUES (?, ?, ?)",
					input.idempotencyKey,
					JSON.stringify(sendResult),
					now,
				);
			}
			this.bump();
			return { duplicate: false, result: sendResult };
		});
		if (!result.duplicate && input.recipients.some((r) => !r.self)) await this.ctx.storage.setAlarm(now);
		return result;
	}

	/**
	 * Drains the outbox: local deliveries go straight to the recipient's mailbox, external ones to
	 * Email Service. A failure is retried with backoff, up to `OUTBOX_MAX_ATTEMPTS`, then the
	 * recipient is marked failed. Delivery is at least once: a crash after a send and before the
	 * outbox row is deleted sends again.
	 */
	override async alarm(): Promise<void> {
		// One drain at a time. A drain that is running schedules the next one when it ends.
		if (this.draining) return;
		this.draining = true;
		try {
			await this.drainOutbox();
		} finally {
			this.draining = false;
		}
		const next = this.one<{ at: number | null }>("SELECT MIN(next_attempt_at) AS at FROM outbox")?.at ?? null;
		if (next !== null) await this.ctx.storage.setAlarm(Math.max(next, Date.now()));
	}

	private async drainOutbox(): Promise<void> {
		const now = Date.now();
		const due = this.all<{
			id: number;
			message_seq: number;
			kind: string;
			target: string;
			address: string;
			attempts: number;
			raw_key: string;
			from_addr: string | null;
		}>(
			`SELECT o.id, o.message_seq, o.kind, o.target, o.address, o.attempts, m.raw_key, m.from_addr
			FROM outbox o JOIN messages m ON m.seq = o.message_seq
			WHERE o.next_attempt_at <= ? ORDER BY o.id LIMIT ?`,
			now,
			OUTBOX_BATCH,
		);
		const raws = new Map<string, Uint8Array>();
		for (const row of due) {
			try {
				let raw = raws.get(row.raw_key);
				if (!raw) {
					const object = await this.env.BLOBS.get(row.raw_key);
					if (!object) throw new Error("the raw message is missing from R2");
					raw = new Uint8Array(await object.arrayBuffer());
					raws.set(row.raw_key, raw);
				}
				let status: "delivered" | "sent";
				let providerId: string | null = null;
				if (row.kind === "deliver") {
					await deliverInternal(this.env, row.target, raw);
					status = "delivered";
				} else {
					if (!row.from_addr) throw new Error("the message has no sender address");
					const sent = await this.env.EMAIL.send(new EmailMessage(row.from_addr, row.address, decoder.decode(raw)));
					status = "sent";
					providerId = sent.messageId;
				}
				this.ctx.storage.transactionSync(() => {
					this.sql.exec("DELETE FROM outbox WHERE id = ?", row.id);
					this.sql.exec(
						"UPDATE delivery SET status = ?, provider_id = ?, error = NULL, updated_at = ? WHERE message_seq = ? AND address = ?",
						status,
						providerId,
						Date.now(),
						row.message_seq,
						row.address,
					);
					this.bump();
				});
			} catch (error) {
				const attempts = row.attempts + 1;
				const message = error instanceof Error ? error.message : String(error);
				log("warn", "outbox delivery failed", {
					kind: row.kind,
					attempts,
					recipientDomain: row.address.split("@").pop(),
					error: message,
				});
				this.ctx.storage.transactionSync(() => {
					if (attempts >= OUTBOX_MAX_ATTEMPTS) {
						this.sql.exec("DELETE FROM outbox WHERE id = ?", row.id);
						this.sql.exec(
							"UPDATE delivery SET status = 'failed', error = ?, updated_at = ? WHERE message_seq = ? AND address = ?",
							message.slice(0, 500),
							Date.now(),
							row.message_seq,
							row.address,
						);
						this.bump();
					} else {
						this.sql.exec(
							"UPDATE outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?",
							attempts,
							Date.now() + backoff(attempts),
							message.slice(0, 500),
							row.id,
						);
					}
				});
			}
		}
	}
}
