import { EmailMessage } from "cloudflare:email";
import { DurableObject } from "cloudflare:workers";
import { MAIL_LIMITS } from "@soldock/contracts";
import { getMailbox } from "../identity/index.ts";
import { log, newId } from "../platform/index.ts";
import { deliverInternal, mailboxIdOfRawKey } from "./delivery.ts";
import type { AttachmentMeta, AuthenticationResults, MailAddress, ParsedMail } from "./mime/parse.ts";
import { compileQuery, foldLabelName, parseQuery, QueryError } from "./search.ts";
import { hasReplyPrefix, htmlToText, normalizeSubject, snippetOf } from "./threading.ts";

class SenderUnavailable extends Error {}

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
	/** The SHA-256 of the request, so a reused idempotency key with another message is a conflict. */
	requestHash: string;
	contentHash: string;
	rawKey: string;
	size: number;
	internalDate: number;
	parsed: ParsedMail;
	bcc: MailAddress[];
	replyThreadId: string | null;
	recipients: { address: string; kind: "local" | "external"; mailboxId: string | null; self: boolean }[];
	sentBy: SentBy;
}

/** The person or agent that sent a message from this mailbox, with the name at that time. */
export interface SentBy {
	principal_id: string;
	kind: "human" | "agent";
	display_name: string;
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
	/** The body is left out of this thread result. `getMessage` returns it. */
	omitted: boolean;
	attachments: (AttachmentMeta & { index: number })[];
	authentication: AuthenticationResults | null;
	labels: string[];
	delivery: DeliveryRecord[] | null;
	sentBy: SentBy | null;
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

/** The tag of the watch sockets of a mailbox. The MCP stream of a subscriber holds one. */
const WATCH_TAG = "watch";

/** The message that each watch socket gets when a new message arrives in the inbox. */
export const INBOX_SIGNAL = "inbox";

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
			participants TEXT NOT NULL,
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
			name_folded TEXT NOT NULL,
			type TEXT NOT NULL CHECK (type IN ('system', 'user')),
			created_at INTEGER NOT NULL
		)`,
		"CREATE UNIQUE INDEX labels_name ON labels (name_folded)",
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
			request_hash TEXT NOT NULL,
			result TEXT NOT NULL,
			created_at INTEGER NOT NULL
		)`,
		...SYSTEM_LABEL_ORDER.map(
			(id) =>
				`INSERT INTO labels (id, name, name_folded, type, created_at) VALUES ('${id}', '${id}', '${id.toLowerCase()}', 'system', 0)`,
		),
	],
	// Who sent a message from this mailbox. In a team mailbox, it tells which member sent it.
	["ALTER TABLE messages ADD COLUMN sent_by_json TEXT"],
];

const MAX_TEXT_BYTES = 256 * 1024;
/**
 * The body characters of one thread result. An RPC value can be at most 32 MiB, and a character can
 * take two bytes in it, so this keeps a thread result well below that.
 */
export const THREAD_BODY_CHARS = 6_000_000;
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

/**
 * The lowercase addresses of the sender and the recipients, with JavaScript case folding. SQLite's
 * lower() folds ASCII only, so the threading check compares these exact values.
 */
function participantsOf(parsed: ParsedMail): string[] {
	const all = [parsed.from, ...parsed.to, ...parsed.cc].filter((a): a is MailAddress => a !== null);
	return [...new Set(all.map((a) => a.address.toLowerCase()))];
}

function addressText(addresses: MailAddress[]): string {
	return addresses.map((a) => `${a.name ?? ""} ${a.address}`.trim().toLowerCase()).join(", ");
}

function backoff(attempts: number): number {
	return Math.min(60_000 * 2 ** (attempts - 1), 60 * 60 * 1000);
}

type Row = Record<string, SqlStorageValue>;

const MESSAGE_META_COLUMNS = `seq, id, thread_id, origin, message_id_header, subject, from_name, from_addr,
	to_json, cc_json, bcc_json, reply_to_json, sent_date, internal_date, snippet, body_truncated, attachments_json, auth_json,
	sent_by_json`;

interface MessageMetaRow extends Row {
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
	body_truncated: number;
	attachments_json: string;
	auth_json: string | null;
	sent_by_json: string | null;
	text_chars?: number | null;
	html_chars?: number | null;
}

/**
 * One mailbox, keyed by its mailbox id: the id of the principal that owns it, or the id of a team
 * mailbox. The object does not know which callers can use it: the Worker checks that. It holds the messages, threads, labels,
 * search index, delivery status and outbox of that mailbox in its SQLite database. Raw messages
 * stay in R2. Side effects on other objects (local delivery, Email Service) go through the outbox
 * and its alarm, with retries.
 */
export class MailboxDO extends DurableObject<Env> {
	private readonly sql: SqlStorage;
	private drainTask: Promise<void> | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		ctx.blockConcurrencyWhile(async () => {
			this.migrate();
			// send() sets the alarm after its transaction commits. If the object stopped between the
			// two, the outbox has rows and no alarm: set one now.
			const pending = this.one<{ n: number }>("SELECT COUNT(*) AS n FROM outbox")?.n ?? 0;
			if (pending > 0 && (await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now());
		});
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
				subjectFallback: !input.spam,
				sentBy: null,
			});
			this.bump();
			return inserted;
		});
		if (!input.spam) this.signalInbox();
		return { status: "delivered", messageId: stored.id, threadId: stored.threadId };
	}

	// --- Watch sockets ---------------------------------------------------------------------------

	/**
	 * Accepts a watch socket: a hibernatable WebSocket that gets `INBOX_SIGNAL` for each new message in
	 * the inbox. The Worker opens it for a `subscriptions/listen` stream after it checks the access of
	 * the caller. The object can sleep while its sockets wait, and wakes when mail arrives.
	 */
	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			return new Response("This object accepts watch sockets only.", {
				status: 426,
				headers: { upgrade: "websocket" },
			});
		}
		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server, [WATCH_TAG]);
		return new Response(null, { status: 101, webSocket: client });
	}

	/** Tells each watch socket that a new message is in the inbox. A socket that closed is skipped. */
	private signalInbox(): void {
		for (const socket of this.ctx.getWebSockets(WATCH_TAG)) {
			try {
				socket.send(INBOX_SIGNAL);
			} catch {
				// The socket closed between the list and the send.
			}
		}
	}

	/** A watcher sends nothing. A message from one has no effect. */
	override webSocketMessage(): void {}

	override webSocketClose(socket: WebSocket, code: number, reason: string): void {
		try {
			// Completes the close handshake. The runtime can reply by itself, and a closed socket throws.
			socket.close(code, reason);
		} catch {
			// Closed already.
		}
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
		/** False for spam: a forged sender must not join a thread by its subject. */
		subjectFallback: boolean;
		sentBy: SentBy | null;
	}): { seq: number; id: string; threadId: string } {
		const { parsed } = m;
		const threadId = this.resolveThread(parsed, m.internalDate, m.threadHint, m.subjectFallback);
		const text = capUtf8(parsed.text, MAX_TEXT_BYTES);
		const html = capUtf8(parsed.html, MAX_HTML_BYTES);
		const plain = parsed.text ?? (parsed.html ? htmlToText(parsed.html) : "");
		const attachments = parsed.attachments.map((attachment, index) => ({ ...attachment, index }));
		const seq = this.one<{ seq: number }>(
			`INSERT INTO messages (id, thread_id, content_hash, raw_key, origin, message_id_header, subject, from_name,
				from_addr, to_json, cc_json, bcc_json, reply_to_json, to_text, cc_text, bcc_text, participants, sent_date,
				internal_date, snippet, text_body, html_body, body_truncated, size, has_attachments, attachments_json,
				attachment_names, auth_json, sent_by_json)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
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
			JSON.stringify(participantsOf(parsed)),
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
			m.sentBy ? JSON.stringify(m.sentBy) : null,
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
	private resolveThread(
		parsed: ParsedMail,
		internalDate: number,
		hint: string | null,
		subjectFallback: boolean,
	): string {
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
		if (subjectFallback && found.size === 0 && normalized && sender && hasReplyPrefix(parsed.subject)) {
			// Only a participant of the thread can join it by subject: its sender wrote to the thread or
			// was a recipient of it. A stranger's "Re:" starts a new thread.
			const row = this.one<{ id: string }>(
				`SELECT t.id FROM threads t
				WHERE t.normalized_subject = ? AND t.last_message_at >= ?
				AND EXISTS (
					SELECT 1 FROM messages m, json_each(m.participants) p
					WHERE m.thread_id = t.id AND p.value = ?
				)
				ORDER BY t.last_message_at DESC LIMIT 1`,
				normalized,
				internalDate - SUBJECT_THREAD_WINDOW_MS,
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

	/**
	 * A thread with its messages, oldest first. The bodies of the newest messages come first, up to
	 * `THREAD_BODY_CHARS`: an RPC result can be at most 32 MiB, so the bodies of older messages in a
	 * very large thread are left out (`omitted`), and `getMessage` returns each one.
	 */
	getThread(threadId: string): { id: string; subject: string; messages: StoredMessage[] } | null {
		const thread = this.one<{ id: string; subject: string }>("SELECT id, subject FROM threads WHERE id = ?", threadId);
		if (!thread) return null;
		const rows = this.all<MessageMetaRow>(
			`SELECT ${MESSAGE_META_COLUMNS}, length(text_body) AS text_chars, length(html_body) AS html_chars
			FROM messages WHERE thread_id = ? ORDER BY internal_date, seq`,
			threadId,
		);
		const withBody = new Set<number>();
		let budget = THREAD_BODY_CHARS;
		for (const row of [...rows].reverse()) {
			const chars = (row.text_chars ?? 0) + (row.html_chars ?? 0);
			if (chars > budget && withBody.size > 0) break;
			withBody.add(row.seq);
			budget -= chars;
		}
		const labels = this.labelsOf("m.thread_id = ?", threadId);
		const delivery = this.deliveryOf("m.thread_id = ?", threadId);
		return {
			id: thread.id,
			subject: thread.subject,
			messages: rows.map((row) => {
				const body = withBody.has(row.seq)
					? this.one<{ text_body: string | null; html_body: string | null }>(
							"SELECT text_body, html_body FROM messages WHERE seq = ?",
							row.seq,
						)
					: null;
				return this.toStored(row, body, labels, delivery);
			}),
		};
	}

	/** One message with its full body, or null. */
	getMessage(messageId: string): StoredMessage | null {
		const row = this.one<MessageMetaRow & { text_body: string | null; html_body: string | null }>(
			`SELECT ${MESSAGE_META_COLUMNS}, text_body, html_body FROM messages WHERE id = ?`,
			messageId,
		);
		if (!row) return null;
		return this.toStored(row, row, this.labelsOf("m.seq = ?", row.seq), this.deliveryOf("m.seq = ?", row.seq));
	}

	private labelsOf(where: string, value: SqlStorageValue): Map<number, string[]> {
		const labels = new Map<number, string[]>();
		for (const row of this.all<{ message_seq: number; label_id: string }>(
			`SELECT ml.message_seq, ml.label_id FROM message_labels ml JOIN messages m ON m.seq = ml.message_seq WHERE ${where}`,
			value,
		)) {
			labels.set(row.message_seq, [...(labels.get(row.message_seq) ?? []), row.label_id]);
		}
		return labels;
	}

	private deliveryOf(where: string, value: SqlStorageValue): Map<number, DeliveryRecord[]> {
		const delivery = new Map<number, DeliveryRecord[]>();
		for (const row of this.all<{
			message_seq: number;
			address: string;
			kind: string;
			status: string;
			error: string | null;
		}>(
			`SELECT d.message_seq, d.address, d.kind, d.status, d.error FROM delivery d JOIN messages m ON m.seq = d.message_seq WHERE ${where} ORDER BY d.address`,
			value,
		)) {
			const record = {
				address: row.address,
				kind: row.kind as DeliveryRecord["kind"],
				status: row.status as DeliveryRecord["status"],
				error: row.error,
			};
			delivery.set(row.message_seq, [...(delivery.get(row.message_seq) ?? []), record]);
		}
		return delivery;
	}

	private toStored(
		row: MessageMetaRow,
		body: { text_body: string | null; html_body: string | null } | null,
		labels: Map<number, string[]>,
		delivery: Map<number, DeliveryRecord[]>,
	): StoredMessage {
		return {
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
			text: body?.text_body ?? null,
			html: body?.html_body ?? null,
			truncated: row.body_truncated === 1,
			omitted: body === null,
			attachments: JSON.parse(row.attachments_json) as StoredMessage["attachments"],
			authentication: row.auth_json ? (JSON.parse(row.auth_json) as AuthenticationResults) : null,
			labels: labels.get(row.seq) ?? [],
			delivery: row.origin === "sent" ? (delivery.get(row.seq) ?? []) : null,
			sentBy: row.sent_by_json ? (JSON.parse(row.sent_by_json) as SentBy) : null,
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
		// JavaScript folds the case, because SQLite's lower() folds ASCII only.
		const folded = foldLabelName(name);
		if (this.one("SELECT 1 AS found FROM labels WHERE name_folded = ?", folded)) {
			return { error: { code: "conflict", message: `A label named "${name}" exists.` } };
		}
		const id = newId("lbl");
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(
				"INSERT INTO labels (id, name, name_folded, type, created_at) VALUES (?, ?, ?, 'user', ?)",
				id,
				name,
				folded,
				Date.now(),
			);
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

	/**
	 * The stored result of an earlier send with this idempotency key in the last 24 hours, if any. The
	 * key is bound to its request: the same key with a different message is a conflict.
	 */
	idempotentResult(key: string, requestHash: string): SendResult | Refusal | null {
		const row = this.one<{ result: string; request_hash: string }>(
			"SELECT result, request_hash FROM idempotency WHERE key = ? AND created_at >= ?",
			key,
			Date.now() - IDEMPOTENCY_TTL_MS,
		);
		if (!row) return null;
		if (row.request_hash !== requestHash) {
			return { error: { code: "conflict", message: "This idempotency key was used for a different message." } };
		}
		return JSON.parse(row.result) as SendResult;
	}

	/**
	 * Stores a sent message with the SENT label and queues its deliveries in the outbox, in one
	 * transaction. With an idempotency key that was used before, it stores nothing and returns the
	 * first result.
	 */
	async send(input: SendInput): Promise<{ duplicate: boolean; result: SendResult } | Refusal> {
		if (this.meta("delivery_pause"))
			return { error: { code: "conflict", message: "This mailbox is paused for a reset." } };
		const now = Date.now();
		const selfDelivery = input.recipients.some((r) => r.self);
		const result = this.ctx.storage.transactionSync(() => {
			this.sql.exec("DELETE FROM idempotency WHERE created_at < ?", now - IDEMPOTENCY_TTL_MS);
			if (input.idempotencyKey) {
				const earlier = this.idempotentResult(input.idempotencyKey, input.requestHash);
				if (earlier && "error" in earlier) return earlier;
				if (earlier) return { duplicate: true, result: earlier };
			}
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
				subjectFallback: true,
				sentBy: input.sentBy,
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
					recipient.kind === "local" ? (recipient.mailboxId as string) : recipient.address,
					recipient.address,
					now,
				);
			}
			const sendResult: SendResult = { message_id: stored.id, thread_id: stored.threadId, recipients };
			if (input.idempotencyKey) {
				this.sql.exec(
					"INSERT INTO idempotency (key, request_hash, result, created_at) VALUES (?, ?, ?, ?)",
					input.idempotencyKey,
					input.requestHash,
					JSON.stringify(sendResult),
					now,
				);
			}
			this.bump();
			return { duplicate: false, result: sendResult };
		});
		if ("error" in result || result.duplicate) return result;
		// Mail to the mailbox itself is in its inbox now.
		if (selfDelivery) this.signalInbox();
		if (input.recipients.some((r) => !r.self)) await this.ctx.storage.setAlarm(now);
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
		if (this.drainTask) return this.drainTask;
		if (this.meta("delivery_pause")) return;
		this.drainTask = this.runAlarm();
		try {
			await this.drainTask;
		} finally {
			this.drainTask = null;
		}
	}

	private async runAlarm(): Promise<void> {
		await this.drainOutbox();
		if (this.meta("delivery_pause")) return;
		const next = this.one<{ at: number | null }>("SELECT MIN(next_attempt_at) AS at FROM outbox")?.at ?? null;
		if (next !== null) await this.ctx.storage.setAlarm(Math.max(next, Date.now()));
	}

	/** Blocks new sends and waits for every active delivery before the directory reset. */
	async pauseDeliveries(token: string, generation: number): Promise<void> {
		if (Number(this.meta("delivery_pause_generation") ?? 0) > generation) return;
		this.ctx.storage.transactionSync(() => {
			this.setMeta("delivery_pause", token);
			this.setMeta("delivery_pause_generation", String(generation));
		});
		if (this.drainTask) await this.drainTask;
		await this.ctx.storage.deleteAlarm();
	}

	/** Resumes the mailbox if the directory transaction did not commit. */
	async resumeDeliveries(token: string): Promise<void> {
		if (this.meta("delivery_pause") !== token) return;
		this.sql.exec("DELETE FROM meta WHERE key = 'delivery_pause'");
		if (this.one<{ n: number }>("SELECT COUNT(*) AS n FROM outbox")?.n) await this.ctx.storage.setAlarm(Date.now());
	}

	/** Cancels the old outbox after the directory reset. The mailbox stays paused. */
	cancelDeliveries(token: string): void {
		if (this.meta("delivery_pause") !== token) return;
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(
				"UPDATE delivery SET status = 'failed', error = ?, updated_at = ? WHERE status = 'queued'",
				"The sender account no longer owns this address.",
				Date.now(),
			);
			this.sql.exec("DELETE FROM outbox");
			this.bump();
		});
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
		// Only the raw message of the current row stays in memory. Rows of one message are adjacent
		// (ORDER BY o.id), so each message is read once, and a batch never holds more than one.
		let currentKey: string | null = null;
		let currentRaw = new Uint8Array();
		for (const row of due) {
			try {
				if (currentKey !== row.raw_key) {
					currentKey = null;
					currentRaw = new Uint8Array();
					const object = await this.env.BLOBS.get(row.raw_key);
					if (!object) throw new Error("the raw message is missing from R2");
					currentRaw = new Uint8Array(await object.arrayBuffer());
					currentKey = row.raw_key;
				}
				const raw = currentRaw;
				let status: "delivered" | "sent";
				let providerId: string | null = null;
				// The raw key keeps the original mailbox id, even if a reset reuses the address.
				const senderId = mailboxIdOfRawKey(row.raw_key);
				const sender = senderId ? await getMailbox(this.env.DIRECTORY, senderId) : null;
				if (this.meta("delivery_pause")) return;
				if (!sender || sender.address !== row.from_addr) {
					throw new SenderUnavailable("The sender account no longer owns this address.");
				}
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
				const attempts = error instanceof SenderUnavailable ? OUTBOX_MAX_ATTEMPTS : row.attempts + 1;
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
