import { EmailMessage } from "cloudflare:email";
import { DurableObject } from "cloudflare:workers";
import {
	AUTO_LABEL_LIMITS,
	AUTO_LABELS,
	type AutoLabelSettings,
	MAIL_LIMITS,
	MailboxId,
	type MailSettings,
	ScreenerMode,
	type ScreenerStatus,
	SYSTEM_LABELS,
	WEBHOOK_LIMITS,
} from "@asterra/contracts";
import { addressTag, getMailbox, getPrincipal } from "../identity/index.ts";
import { log, newId } from "../platform/index.ts";
import type { WebhookEventJob } from "../webhooks/index.ts";
import type { AutoLabelJob } from "./autolabel/consumer.ts";
import type { PromptInput } from "./autolabel/prompt.ts";
import { PROMPT_CORRECTIONS } from "./autolabel/prompt.ts";
import {
	type Decision,
	decide,
	type LabelDef,
	type LabelPick,
	type MailFacts,
	resolvePicks,
} from "./autolabel/rules.ts";
import { readSignals } from "./autolabel/signals.ts";
import {
	AUTO_LABEL_ENABLED_KEY,
	AUTO_LABEL_INITIALIZED_KEY,
	AUTOLABEL_MIGRATION,
	autoKeyOfLabel,
	correctionsOfSender,
	enableBuiltin,
	enabledLabelDefs,
	ensureUserLabel,
	exampleCorrections,
	messageFacts,
	readFacts,
	recordCorrection,
	type StoreRefusal,
	settingsView,
} from "./autolabel/store.ts";
import { deliverInternal, mailboxIdOfRawKey } from "./delivery.ts";
import type { AttachmentMeta, AuthenticationResults, MailAddress, ParsedMail } from "./mime/parse.ts";
import { deniedOutboundAddresses, outboundMode, outboundPolicyDenial } from "./outbound.ts";
import {
	type DecidedBy,
	listSenders,
	pendingCount,
	recordHeld,
	SCREENER_MIGRATION,
	SCREENER_RESTORE_MS,
	type ScreenerContext,
	type ScreenerSenderRecord,
	SENT_BY_PERSON,
	screenerEnabled,
	senderRow,
	writeDecision,
} from "./screener/store.ts";
import { compileQuery, foldLabelName, parseQuery, QueryError } from "./search.ts";
import { hasReplyPrefix, htmlToText, normalizeSubject, snippetOf } from "./threading.ts";

class SenderUnavailable extends Error {
	/** Text for the log. The delivery row keeps `message`, which can name an external address. */
	readonly logReason: string | null;

	constructor(message: string, logReason: string | null = null) {
		super(message);
		this.logReason = logReason;
	}
}

/** The sender recorded on a message, or null when the column is empty or not valid JSON. */
function sentByOf(json: string | null): SentBy | null {
	if (!json) return null;
	try {
		const value = JSON.parse(json) as Partial<SentBy>;
		if ((value.kind !== "agent" && value.kind !== "human") || typeof value.principal_id !== "string") return null;
		return { principal_id: value.principal_id, kind: value.kind, display_name: value.display_name ?? "" };
	} catch {
		return null;
	}
}

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
	/**
	 * The `+tag` of the recipient address. The message gets the user label with the same name, if one
	 * exists. A tag never creates a label and never selects a system label. The field is optional,
	 * because earlier callers do not send it.
	 */
	tag?: string | null;
	/**
	 * Set when the organization lets auto labels run. The mailbox applies them when its own setting is on.
	 * The address is the address of the mailbox, for the facts of the rules. Optional, because earlier
	 * callers do not send it.
	 */
	autoLabel?: { ownerAddress: string } | null;
	/**
	 * Set for mail from outside that is not spam. The mailbox holds the mail in the Screener when its
	 * setting and this context turn the Screener on. Optional, because earlier callers do not send it.
	 */
	screener?: ScreenerContext | null;
}

/** The result of `screenSender`. */
export interface ScreenResult {
	address: string;
	decision: "in" | "out";
	changed: boolean;
	messages_to_inbox: number;
	messages_archived: number;
	messages_screened_out: number;
	dry_run: boolean;
}

/**
 * Where a new message can join a thread. Held mail and visible mail never share a thread, and held mail
 * of two senders never shares a thread, so a thread view never shows held mail in a view.
 */
type ThreadScope = { held: false } | { held: true; sender: string };

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
	/**
	 * True when the sender can decide in the Screener: a person, with mail.modify in the credential and, in a
	 * team mailbox, in the membership. Only then does the send screen in a recipient that waits.
	 */
	mayScreen?: boolean;
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
	/** The ids in `labels` that auto labels applied. */
	autoLabels: string[];
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
	/** The ids in `labels` that auto labels applied to each message of the thread that has them. */
	autoLabels: string[];
	hasAttachments: boolean;
	untrusted: boolean;
	/** The time of the order of the list: the newest message that matches, or the end of a snooze when that is later. */
	lastMessageAt: number;
	/** The time when the snooze of the thread ends, or null. */
	snoozedUntil: number | null;
}

/** An address that the mailbox sent mail to. */
export interface RecipientRecord {
	address: string;
	times_sent: number;
	last_sent_at: number;
}

export interface LabelRecord {
	id: string;
	name: string;
	type: "system" | "user";
	threads_total: number;
	threads_unread: number;
}

/** The order of the system labels in `listLabels`. */
const SYSTEM_LABEL_ORDER: readonly string[] = SYSTEM_LABELS;

/** The system labels of the first migration. Migrations are append only, so this list never changes. */
const FIRST_SYSTEM_LABELS = ["INBOX", "STARRED", "IMPORTANT", "SENT", "SPAM", "TRASH", "UNREAD"];

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
		...FIRST_SYSTEM_LABELS.map(
			(id) =>
				`INSERT INTO labels (id, name, name_folded, type, created_at) VALUES ('${id}', '${id}', '${id.toLowerCase()}', 'system', 0)`,
		),
	],
	// Who sent a message from this mailbox. In a team mailbox, it tells which member sent it.
	["ALTER TABLE messages ADD COLUMN sent_by_json TEXT"],
	// Webhook events: new mail in the inbox, for the queue soldock-webhooks. Mail that arrives while a
	// row waits joins that row, so the table has at most one row.
	[
		`CREATE TABLE event_outbox (
			id INTEGER PRIMARY KEY,
			event_id TEXT NOT NULL,
			occurred_at INTEGER NOT NULL,
			attempts INTEGER NOT NULL DEFAULT 0,
			next_attempt_at INTEGER NOT NULL,
			last_error TEXT
		)`,
	],
	// The addresses that the mailbox sent mail to, for mail.suggest_recipients. The key is the address in
	// lowercase. The backfill reads the sent mail that exists, with the rules of recordRecipients: one
	// message counts once for each address, the first entry of a message (To, then Cc, then Bcc) gives its
	// form, and the newest message gives the stored form (the later message when two have the same time).
	// Addresses are ASCII (the EmailAddress schema), so SQLite's lower() gives the same key as toLowerCase().
	[
		`CREATE TABLE recipients (
			address_key TEXT PRIMARY KEY,
			address TEXT NOT NULL,
			times_sent INTEGER NOT NULL,
			last_sent_at INTEGER NOT NULL
		) WITHOUT ROWID`,
		`INSERT INTO recipients (address_key, address, times_sent, last_sent_at)
		SELECT address_key, address, times_sent, sent_at FROM (
			SELECT address_key, address, sent_at,
				COUNT(*) OVER (PARTITION BY address_key) AS times_sent,
				ROW_NUMBER() OVER (PARTITION BY address_key ORDER BY sent_at DESC, seq DESC) AS newest
			FROM (
				SELECT address_key, address, seq, sent_at,
					ROW_NUMBER() OVER (PARTITION BY address_key, seq ORDER BY part, position) AS first
				FROM (
					SELECT m.seq, m.internal_date AS sent_at, 0 AS part, a.key AS position,
						json_extract(a.value, '$.address') AS address, lower(json_extract(a.value, '$.address')) AS address_key
					FROM messages m, json_each(m.to_json) a WHERE m.origin = 'sent'
					UNION ALL
					SELECT m.seq, m.internal_date, 1, a.key, json_extract(a.value, '$.address'), lower(json_extract(a.value, '$.address'))
					FROM messages m, json_each(m.cc_json) a WHERE m.origin = 'sent'
					UNION ALL
					SELECT m.seq, m.internal_date, 2, a.key, json_extract(a.value, '$.address'), lower(json_extract(a.value, '$.address'))
					FROM messages m, json_each(m.bcc_json) a WHERE m.origin = 'sent'
				)
				WHERE address_key IS NOT NULL
			)
			WHERE first = 1
		)
		WHERE newest = 1`,
	],
	// Auto labels: marks, signals, settings, corrections and the classifier outbox (autolabel/store.ts).
	AUTOLABEL_MIGRATION,
	// The Screener: the held state of a message and the senders (screener/store.ts).
	SCREENER_MIGRATION,
	// Reply later: the system label of the threads that the mailbox answers later. Label names are unique
	// without regard to case. So a user label with the name reply_later first gets the lowest number n after its
	// name, as "Reply_Later (n)", for which no label has that name. A person can make any name, also
	// "Reply_Later (1)", so the number is not fixed. Both statements can run again with no change.
	[
		`WITH RECURSIVE n(i) AS (
			SELECT 1
			UNION ALL
			SELECT i + 1 FROM n WHERE EXISTS (SELECT 1 FROM labels WHERE name_folded = 'reply_later (' || i || ')')
		)
		UPDATE labels SET name = name || ' (' || (SELECT MAX(i) FROM n) || ')',
			name_folded = 'reply_later (' || (SELECT MAX(i) FROM n) || ')'
		WHERE type = 'user' AND name_folded = 'reply_later'`,
		"INSERT OR IGNORE INTO labels (id, name, name_folded, type, created_at) VALUES ('REPLY_LATER', 'REPLY_LATER', 'reply_later', 'system', 0)",
	],
	// Snooze replaces Reply later. `snoozed_until` is the time when a snoozed thread comes back. `woke_at` is
	// the time when its last snooze ended at its time: the thread then has that place in the order of a list.
	// A thread of Reply later has no time. So it goes back to the inbox now, at the top, as a thread whose
	// snooze ends now, and the label REPLY_LATER goes away. The version grows, so an open client gets the
	// lists again. A user label with the name snoozed gets a free name, as for REPLY_LATER above.
	[
		"ALTER TABLE threads ADD COLUMN snoozed_until INTEGER",
		"ALTER TABLE threads ADD COLUMN woke_at INTEGER",
		"CREATE INDEX threads_snoozed ON threads (snoozed_until) WHERE snoozed_until IS NOT NULL",
		`UPDATE threads SET woke_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE id IN (
			SELECT m.thread_id FROM messages m JOIN message_labels ml ON ml.message_seq = m.seq
			WHERE ml.label_id = 'REPLY_LATER'
		)`,
		`INSERT OR IGNORE INTO message_labels (message_seq, label_id)
			SELECT message_seq, 'INBOX' FROM message_labels WHERE label_id = 'REPLY_LATER'`,
		"DELETE FROM message_labels WHERE label_id = 'REPLY_LATER'",
		"DELETE FROM labels WHERE id = 'REPLY_LATER'",
		"UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'version'",
		`WITH RECURSIVE n(i) AS (
			SELECT 1
			UNION ALL
			SELECT i + 1 FROM n WHERE EXISTS (SELECT 1 FROM labels WHERE name_folded = 'snoozed (' || i || ')')
		)
		UPDATE labels SET name = name || ' (' || (SELECT MAX(i) FROM n) || ')',
			name_folded = 'snoozed (' || (SELECT MAX(i) FROM n) || ')'
		WHERE type = 'user' AND name_folded = 'snoozed'`,
		"INSERT OR IGNORE INTO labels (id, name, name_folded, type, created_at) VALUES ('SNOOZED', 'SNOOZED', 'snoozed', 'system', 0)",
	],
];

/** The sends of one message to the classifier queue. A send that gets no result is repeated after `AUTOLABEL_RESEND_MS`. */
const AUTOLABEL_MAX_SENDS = 3;
const AUTOLABEL_RESEND_MS = 15 * 60 * 1000;
const AUTOLABEL_BATCH = 25;
/** The meta key that holds the id of this mailbox for the classifier jobs. The object does not know its own id. */
const AUTO_LABEL_MAILBOX_KEY = "auto_label_mailbox_id";
const AUTO_LABELS_ORDER = AUTO_LABELS.map((label) => label.key);
/** The folded names of the built-in auto labels. A custom auto label cannot take one. */
const AUTO_LABELS_NAMES = new Set(AUTO_LABELS.map((label) => foldLabelName(label.name)));

/** The labels that `modifyThreads` can change on a thread that the Screener holds. */
const HELD_MAIL_LABELS: ReadonlySet<string> = new Set(["UNREAD", "STARRED", "IMPORTANT"]);

/** A refusal thrown inside a transaction, so the transaction rolls back. */
class AutoLabelRefusal extends Error {
	readonly refusal: Refusal;

	constructor(refusal: Refusal) {
		super(refusal.error.message);
		this.refusal = refusal;
	}
}

/** What the classifier needs for one message. Null when the message needs no classifier. */
export interface AutoLabelContext {
	prompt: PromptInput;
	decision: Pick<Decision, "candidates" | "needsReplyStrict">;
}

/** The result of `runAutoLabels`. */
export interface AutoLabelRun {
	messages: number;
	labeled_by_rules: number;
	queued: number;
	dry_run: boolean;
}

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
/** The attempts to put one webhook event on the queue. */
const EVENT_MAX_ATTEMPTS = 8;
/** The meta key that holds the id of this mailbox once a webhook watches it. Its presence turns events on. */
const EVENTS_MAILBOX_KEY = "webhook_mailbox_id";
/** The meta key of the time when the last webhook event went to the queue. */
const EVENTS_LAST_KEY = "webhook_last_event_at";
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
/** A change to the mail settings: only the named settings change. */
export interface SettingsPatch {
	sidebar?:
		| { shared_mailboxes_collapsed?: boolean | undefined; agent_mailboxes_collapsed?: boolean | undefined }
		| undefined;
	/**
	 * The default From address of one mailbox. A null `from_mailbox_id` removes the setting. The handler
	 * checks both mailboxes before it calls the object.
	 */
	default_from?: { mailbox_id: string; from_mailbox_id: string | null } | undefined;
}

/** The saved settings with the default for each setting that was never saved. A bad value gets the default. */
function readSettings(raw: string | null): MailSettings {
	let saved: { sidebar?: Record<string, unknown>; default_from?: unknown } = {};
	try {
		saved = raw ? (JSON.parse(raw) as typeof saved) : {};
	} catch {
		// A value that does not parse gets the defaults. The next change writes a good value.
	}
	const flag = (value: unknown) => value === true;
	// An entry with a key or a value that is not a mailbox id is dropped. A value that is the same as its
	// key is the default, so it is dropped too.
	const defaultFrom: Record<string, string> = {};
	if (saved.default_from !== null && typeof saved.default_from === "object" && !Array.isArray(saved.default_from)) {
		for (const [key, value] of Object.entries(saved.default_from)) {
			if (MailboxId.safeParse(key).success && MailboxId.safeParse(value).success && key !== value) {
				defaultFrom[key] = value as string;
			}
		}
	}
	return {
		sidebar: {
			shared_mailboxes_collapsed: flag(saved.sidebar?.shared_mailboxes_collapsed),
			agent_mailboxes_collapsed: flag(saved.sidebar?.agent_mailboxes_collapsed),
		},
		default_from: defaultFrom,
	};
}

/** The meta key of the settings of the mailbox itself, which each member of a team mailbox shares. */
const MAILBOX_SETTINGS_KEY = "mailbox_settings";

/** The settings of the mailbox itself, without its id. */
export interface StoredMailboxSettings {
	signature: string;
	/** The Screener setting. `inherit` uses the default of the organization. */
	screener: ScreenerMode;
}

/** A change to the settings of the mailbox: only the named settings change. */
export interface MailboxSettingsPatch {
	signature?: string | undefined;
	screener?: ScreenerMode | undefined;
}

/** The saved settings of the mailbox, with the default for each setting that was never saved or does not parse. */
function readMailboxSettings(raw: string | null): StoredMailboxSettings {
	let saved: { signature?: unknown; screener?: unknown } = {};
	try {
		saved = raw ? (JSON.parse(raw) as typeof saved) : {};
	} catch {
		// A value that does not parse gets the defaults. The next change writes a good value.
	}
	const screener = ScreenerMode.safeParse(saved.screener);
	return {
		signature: typeof saved.signature === "string" ? saved.signature : "",
		screener: screener.success ? screener.data : "inherit",
	};
}

/**
 * The stored form of a signature: `\n` for each line break, no spaces at the end of a line, and no empty
 * lines at the start or the end. So a signature from a Windows client and one from the web app are the same.
 */
function normalizeSignature(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/^\n+|\n+$/g, "");
}

export class MailboxDO extends DurableObject<Env> {
	private readonly sql: SqlStorage;
	private drainTask: Promise<void> | null = null;
	/**
	 * The event outbox row whose queue send runs now. New mail cannot join it: the receiver can read the
	 * inbox before the send returns, so that mail gets a row of its own.
	 */
	private sendingEventRow: number | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		ctx.blockConcurrencyWhile(async () => {
			this.migrate();
			// send(), deliver() and snoozeThreads() set the alarm after their transaction commits. If the object
			// stopped between the two, an outbox has rows or a thread is snoozed, and no alarm is set: set one now.
			// The alarm then sets itself to the time of the next work.
			if (this.hasPendingWork() && (await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now());
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

	/** True when an outbox has a row, or a thread is snoozed. The alarm then has work now or at a later time. */
	private hasPendingWork(): boolean {
		return (
			(this.one<{ n: number }>(
				`SELECT (SELECT COUNT(*) FROM outbox) + (SELECT COUNT(*) FROM event_outbox) + (SELECT COUNT(*) FROM autolabel_outbox)
					+ (SELECT COUNT(*) FROM threads WHERE snoozed_until IS NOT NULL) AS n`,
			)?.n ?? 0) > 0
		);
	}

	/** Sets the alarm to `at`, unless it is set to an earlier time already. */
	private async alarmBy(at: number): Promise<void> {
		const current = await this.ctx.storage.getAlarm();
		if (current === null || current > at) await this.ctx.storage.setAlarm(at);
	}

	// --- Delivery -------------------------------------------------------------------------------

	/**
	 * The id of the user label whose name is the `+tag` of a recipient address, or null. Only an existing
	 * user label matches: a sender cannot create labels, and `ada+spam@` does not select `SPAM`.
	 */
	private tagLabel(tag: string | null | undefined): string | null {
		if (!tag) return null;
		return (
			this.one<{ id: string }>("SELECT id FROM labels WHERE name_folded = ? AND type = 'user'", foldLabelName(tag))
				?.id ?? null
		);
	}

	/**
	 * Stores a message that arrived for this mailbox. A second copy of the same content is dropped.
	 * The second copy can come to a different `+tag` of this mailbox, so the copy adds its tag label.
	 */
	async deliver(input: DeliverInput): Promise<{
		status: "delivered" | "duplicate";
		messageId: string;
		threadId: string;
		screened: "pending" | "out" | null;
	}> {
		const tagLabel = this.tagLabel(input.tag);
		const existing = this.one<{ seq: number; id: string; thread_id: string; screen: string | null }>(
			"SELECT seq, id, thread_id, screen FROM messages WHERE content_hash = ?",
			input.contentHash,
		);
		if (existing) {
			if (tagLabel) {
				this.ctx.storage.transactionSync(() => {
					const added = this.sql.exec(
						"INSERT OR IGNORE INTO message_labels (message_seq, label_id) VALUES (?, ?)",
						existing.seq,
						tagLabel,
					).rowsWritten;
					if (added > 0) this.bump();
				});
			}
			return {
				status: "duplicate",
				messageId: existing.id,
				threadId: existing.thread_id,
				screened: existing.screen === "pending" || existing.screen === "out" ? existing.screen : null,
			};
		}
		// The Screener applies only to mail from outside that is not spam. Spam goes to SPAM first.
		const context = input.screener ?? null;
		const screenerOn = context !== null && screenerEnabled(this.mailboxSettings().screener, context);
		const screen = screenerOn && !input.spam && input.origin === "external" ? this.screenVerdict(input.parsed) : null;
		// The Screener is off now, but mail waits in it: the default of the organization went off. The mail
		// moves to the inbox now, so a change of the default needs no write to each mailbox.
		const releaseWaiting = context !== null && !screenerOn && pendingCount(this.sql) > 0;
		const labels = [
			...(input.spam ? ["SPAM", "UNREAD"] : screen ? ["UNREAD"] : ["INBOX", "UNREAD"]),
			...(tagLabel ? [tagLabel] : []),
		];
		// Held mail gets no auto labels: content from a stranger does not go to the model.
		const autoLabel = !input.spam && !screen && input.autoLabel && this.autoLabelsOn() ? input.autoLabel : null;
		let eventAt: number | null = null;
		let inInbox = !input.spam && !screen;
		let classify = false;
		let released = 0;
		const stored = this.ctx.storage.transactionSync(() => {
			if (releaseWaiting) released = this.releaseAllPending();
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
				screen,
			});
			if (screen && input.parsed.from) {
				recordHeld(this.sql, input.parsed.from.address.toLowerCase(), input.parsed.from.name, input.internalDate);
			}
			if (autoLabel) {
				// The rule stage runs in the transaction of the message, so mail that skips the inbox never shows there.
				const outcome = this.autoLabelAtDelivery(inserted.seq, autoLabel.ownerAddress, { mayArchive: true });
				if (outcome === "archived") inInbox = false;
				if (outcome === "queued") classify = true;
			}
			// New mail in the inbox ends the snooze of its thread: the person sees the thread now.
			if (inInbox) this.endSnooze(inserted.threadId, null);
			this.bump();
			if (inInbox || released > 0) eventAt = this.queueInboxEvent();
			return inserted;
		});
		if (inInbox || released > 0) this.signalInbox();
		if (classify) await this.alarmBy(Date.now());
		if (eventAt !== null) await this.alarmBy(eventAt);
		return { status: "delivered", messageId: stored.id, threadId: stored.threadId, screened: screen };
	}

	// --- The Screener ---------------------------------------------------------------------------

	/**
	 * Where the Screener puts new mail from outside, when it is on: null for the inbox, `pending` to wait for
	 * a decision, or `out` for a sender that a person screened out. A decision of a person comes first. With
	 * no decision, a sender that a person wrote to, a reply to mail that a person sent, and a sender
	 * with earlier mail in the views go to the inbox. So when the Screener goes on, only new senders wait.
	 * Mail without a From address is not held: no decision can name its sender.
	 */
	private screenVerdict(parsed: ParsedMail): "pending" | "out" | null {
		const address = parsed.from?.address.toLowerCase();
		if (!address) return null;
		const row = senderRow(this.sql, address);
		if (row) return row.status === "in" ? null : row.status;
		// A send by an agent decides nothing, so only the sends of a person count here and for the references.
		if (this.one("SELECT 1 AS found FROM recipients WHERE address_key = ? AND person_sent = 1", address)) return null;
		const refs = [...new Set([...(parsed.inReplyTo ? [parsed.inReplyTo] : []), ...parsed.references])].slice(-50);
		for (const ref of refs) {
			const sent = this.one(
				`SELECT 1 AS found FROM messages m WHERE m.message_id_header = ? AND m.origin = 'sent' AND ${SENT_BY_PERSON}`,
				ref,
			);
			if (sent) return null;
		}
		const earlier = this.one(
			`SELECT 1 AS found FROM messages m WHERE m.from_addr = ? AND m.screen IS NULL AND m.origin <> 'sent'
			AND NOT EXISTS (SELECT 1 FROM message_labels x WHERE x.message_seq = m.seq AND x.label_id = 'SPAM') LIMIT 1`,
			address,
		);
		return earlier ? null : "pending";
	}

	/**
	 * Moves held mail to the views, inside a transaction. `where` selects the messages, on the alias `m`.
	 * With `inbox`, they get INBOX and keep UNREAD. Without it, they go to All mail and are marked as read.
	 * Returns the number of messages.
	 */
	private releaseHeld(where: string, params: SqlStorageValue[], inbox: boolean): number {
		const seqs = this.all<{ seq: number }>(`SELECT m.seq FROM messages m WHERE ${where}`, ...params).map(
			(row) => row.seq,
		);
		for (const seq of seqs) {
			if (inbox) this.sql.exec("INSERT OR IGNORE INTO message_labels (message_seq, label_id) VALUES (?, 'INBOX')", seq);
			else this.sql.exec("DELETE FROM message_labels WHERE message_seq = ? AND label_id = 'UNREAD'", seq);
			this.sql.exec("UPDATE messages SET screen = NULL WHERE seq = ?", seq);
		}
		return seqs.length;
	}

	/** Moves all mail that waits to the inbox, and removes the senders that wait. Inside a transaction. */
	private releaseAllPending(): number {
		const moved = this.releaseHeld("m.screen = 'pending'", [], true);
		this.sql.exec("DELETE FROM screener_senders WHERE status = 'pending'");
		return moved;
	}

	/**
	 * Screens a sender in for a send by a person to the sender, inside the transaction of the send. Only a
	 * sender that waits changes: a decision of a person stays. Returns the senders that changed and the
	 * messages that went to the inbox.
	 */
	private screenInRecipients(addresses: MailAddress[], by: DecidedBy, now: number): { senders: number; moved: number } {
		let senders = 0;
		let moved = 0;
		for (const address of new Set(addresses.map((a) => a.address.toLowerCase()))) {
			if (senderRow(this.sql, address)?.status !== "pending") continue;
			moved += this.releaseHeld("m.from_addr = ? AND m.screen = 'pending'", [address], true);
			writeDecision(this.sql, address, "in", by, now);
			senders++;
		}
		return { senders, moved };
	}

	/**
	 * Records the decision of a person for a sender, and moves the held mail of the sender. `in`: the mail
	 * that waits goes to the inbox. The mail of a sender that was screened out goes to the inbox for the last
	 * `SCREENER_RESTORE_MS`, and to All mail, read, when it is older. `out`: the mail that waits is screened
	 * out. Mail that is in a view already stays. The same decision again changes nothing.
	 */
	async screenSender(input: {
		address: string;
		decision: "in" | "out";
		by: DecidedBy;
		dryRun: boolean;
		now: number;
	}): Promise<ScreenResult> {
		const address = input.address.toLowerCase();
		const cutoff = input.now - SCREENER_RESTORE_MS;
		const count = (where: string, ...params: SqlStorageValue[]) =>
			this.one<{ n: number }>(
				`SELECT COUNT(*) AS n FROM messages m WHERE m.from_addr = ? AND ${where}`,
				address,
				...params,
			)?.n ?? 0;
		const changed = senderRow(this.sql, address)?.status !== input.decision;
		const result: ScreenResult = {
			address,
			decision: input.decision,
			changed,
			messages_to_inbox: 0,
			messages_archived: 0,
			messages_screened_out: 0,
			dry_run: input.dryRun,
		};
		if (input.decision === "in") {
			result.messages_to_inbox = count("(m.screen = 'pending' OR (m.screen = 'out' AND m.internal_date >= ?))", cutoff);
			result.messages_archived = count("m.screen = 'out' AND m.internal_date < ?", cutoff);
		} else {
			result.messages_screened_out = count("m.screen = 'pending'");
		}
		const moves = result.messages_to_inbox + result.messages_archived + result.messages_screened_out;
		if (input.dryRun || (!changed && moves === 0)) return result;
		let eventAt: number | null = null;
		this.ctx.storage.transactionSync(() => {
			if (input.decision === "in") {
				this.releaseHeld(
					"m.from_addr = ? AND (m.screen = 'pending' OR (m.screen = 'out' AND m.internal_date >= ?))",
					[address, cutoff],
					true,
				);
				this.releaseHeld("m.from_addr = ? AND m.screen = 'out' AND m.internal_date < ?", [address, cutoff], false);
			} else {
				this.sql.exec("UPDATE messages SET screen = 'out' WHERE from_addr = ? AND screen = 'pending'", address);
			}
			writeDecision(this.sql, address, input.decision, input.by, input.now);
			this.bump();
			if (result.messages_to_inbox > 0) eventAt = this.queueInboxEvent();
		});
		if (result.messages_to_inbox > 0) this.signalInbox();
		if (eventAt !== null) await this.alarmBy(eventAt);
		return result;
	}

	/** One page of the senders with a status, or a refusal for a cursor that is not valid. */
	listScreener(params: {
		status: ScreenerStatus;
		cursor: string | null;
		limit: number;
	}): { senders: ScreenerSenderRecord[]; nextCursor: string | null } | Refusal {
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
		const page = listSenders(this.sql, params.status, after, params.limit);
		return { senders: page.senders, nextCursor: page.next ? btoa(JSON.stringify(page.next)) : null };
	}

	// --- Webhook events -------------------------------------------------------------------------

	/**
	 * Turns on webhook events for this mailbox: from now on, new mail in the inbox puts an event on the
	 * queue soldock-webhooks. The Worker calls it when it creates a webhook. The object does not know its
	 * own id, so the call gives it. The events stay on: an event with no webhook costs one queue message.
	 */
	enableWebhookEvents(mailboxId: string): void {
		if (this.meta(EVENTS_MAILBOX_KEY) !== mailboxId) this.setMeta(EVENTS_MAILBOX_KEY, mailboxId);
	}

	/**
	 * Records new mail in the inbox as a webhook event, inside the transaction of the message. Mail that
	 * arrives while an event waits joins that event, but not an event whose queue send runs now. One
	 * mailbox sends at most one event in each `eventGapMs`. Returns the time of the alarm that sends the
	 * new event, or null.
	 */
	private queueInboxEvent(): number | null {
		if (this.meta(EVENTS_MAILBOX_KEY) === null) return null;
		const sending = this.sendingEventRow;
		if (this.one<{ id: number }>("SELECT id FROM event_outbox WHERE id IS NOT ? LIMIT 1", sending)) return null;
		const now = Date.now();
		// While a send runs, the new event waits one gap after now, because the last event goes out now.
		const last = sending === null ? Number(this.meta(EVENTS_LAST_KEY) ?? 0) : now;
		const at = Math.max(now, last + WEBHOOK_LIMITS.eventGapMs);
		this.sql.exec(
			"INSERT INTO event_outbox (event_id, occurred_at, next_attempt_at) VALUES (?, ?, ?)",
			newId("evt"),
			now,
			at,
		);
		return at;
	}

	/**
	 * Puts the due webhook events on the queue. A failure is retried with backoff, up to `EVENT_MAX_ATTEMPTS`.
	 * The event keeps its id on each attempt, so a crash after a send and before the delete sends an event
	 * whose POST requests have the same `webhook-id`, and a receiver can drop them.
	 */
	private async drainEvents(): Promise<void> {
		const now = Date.now();
		const due = this.all<{ id: number; event_id: string; occurred_at: number; attempts: number }>(
			"SELECT id, event_id, occurred_at, attempts FROM event_outbox WHERE next_attempt_at <= ? ORDER BY id",
			now,
		);
		const mailboxId = this.meta(EVENTS_MAILBOX_KEY);
		for (const row of due) {
			try {
				if (mailboxId === null) throw new Error("webhook events are off");
				const job: WebhookEventJob = {
					v: 1,
					kind: "event",
					mailboxId,
					eventId: row.event_id,
					occurredAt: row.occurred_at,
				};
				this.sendingEventRow = row.id;
				try {
					await this.env.WEBHOOKS.send(job);
				} finally {
					this.sendingEventRow = null;
				}
				this.ctx.storage.transactionSync(() => {
					this.sql.exec("DELETE FROM event_outbox WHERE id = ?", row.id);
					this.setMeta(EVENTS_LAST_KEY, String(Date.now()));
				});
			} catch (error) {
				const attempts = mailboxId === null ? EVENT_MAX_ATTEMPTS : row.attempts + 1;
				const message = error instanceof Error ? error.message : String(error);
				if (attempts >= EVENT_MAX_ATTEMPTS) {
					log("error", "webhook event dropped after its last attempt", { attempts, error: message });
					this.sql.exec("DELETE FROM event_outbox WHERE id = ?", row.id);
				} else {
					log("warn", "webhook event could not be queued; retrying", { attempts, error: message });
					this.sql.exec(
						"UPDATE event_outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?",
						attempts,
						Date.now() + backoff(attempts),
						message.slice(0, 500),
						row.id,
					);
				}
			}
		}
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
		/** The held state of the message in the Screener. Null for mail in the views. */
		screen?: "pending" | "out" | null;
	}): { seq: number; id: string; threadId: string } {
		const { parsed } = m;
		const screen = m.screen ?? null;
		const sender = parsed.from?.address.toLowerCase() ?? "";
		const scope: ThreadScope = screen ? { held: true, sender } : { held: false };
		const threadId = this.resolveThread(parsed, m.internalDate, m.threadHint, m.subjectFallback, scope);
		const text = capUtf8(parsed.text, MAX_TEXT_BYTES);
		const html = capUtf8(parsed.html, MAX_HTML_BYTES);
		const plain = parsed.text ?? (parsed.html ? htmlToText(parsed.html) : "");
		const attachments = parsed.attachments.map((attachment, index) => ({ ...attachment, index }));
		const seq = this.one<{ seq: number }>(
			`INSERT INTO messages (id, thread_id, content_hash, raw_key, origin, message_id_header, subject, from_name,
				from_addr, to_json, cc_json, bcc_json, reply_to_json, to_text, cc_text, bcc_text, participants, sent_date,
				internal_date, snippet, text_body, html_body, body_truncated, size, has_attachments, attachments_json,
				attachment_names, auth_json, sent_by_json, signals_json, screen)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
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
			m.origin === "sent" ? null : JSON.stringify(parsed.signals),
			screen,
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
	 * a recent thread with the same subject. When the message links two threads, they merge. `scope` keeps
	 * held mail out of the threads of the views: held mail joins only held mail of the same sender.
	 */
	private resolveThread(
		parsed: ParsedMail,
		internalDate: number,
		hint: string | null,
		subjectFallback: boolean,
		scope: ThreadScope,
	): string {
		const found = new Set<string>();
		// The condition on a message (alias m) of a thread that the new message can join.
		const inScope = scope.held ? "m.screen IS NOT NULL AND m.from_addr = ?" : "m.screen IS NULL";
		const scopeParams: SqlStorageValue[] = scope.held ? [scope.sender] : [];
		if (
			hint &&
			!scope.held &&
			this.one("SELECT 1 AS found FROM threads WHERE id = ?", hint) &&
			!this.one("SELECT 1 AS found FROM messages WHERE thread_id = ? AND screen IS NOT NULL", hint)
		) {
			found.add(hint);
		}
		const refs = [...new Set([...(parsed.inReplyTo ? [parsed.inReplyTo] : []), ...parsed.references])].slice(-50);
		for (const ref of refs) {
			for (const row of this.all<{ thread_id: string }>(
				`SELECT DISTINCT m.thread_id FROM messages m WHERE m.message_id_header = ? AND ${inScope}`,
				ref,
				...scopeParams,
			)) {
				found.add(row.thread_id);
			}
		}
		if (parsed.messageIdHeader) {
			for (const row of this.all<{ thread_id: string }>(
				`SELECT DISTINCT m.thread_id FROM message_refs r JOIN messages m ON m.seq = r.message_seq
				WHERE r.ref = ? AND ${inScope}`,
				parsed.messageIdHeader,
				...scopeParams,
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
					WHERE m.thread_id = t.id AND p.value = ? AND ${inScope}
				)
				ORDER BY t.last_message_at DESC LIMIT 1`,
				normalized,
				internalDate - SUBJECT_THREAD_WINDOW_MS,
				sender,
				...scopeParams,
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
			// The snooze of a thread that merges stays: the thread that remains gets the earliest time.
			this.sql.exec(
				`UPDATE threads SET snoozed_until = (SELECT MIN(snoozed_until) FROM threads WHERE id IN (?, ?)),
					woke_at = (SELECT MAX(woke_at) FROM threads WHERE id IN (?, ?))
				WHERE id = ?`,
				target as string,
				other,
				target as string,
				other,
				target as string,
			);
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

	profile(): {
		messages_total: number;
		threads_total: number;
		inbox_unread: number;
		screener_pending: number;
		version: number;
	} {
		// The totals do not count the mail that the Screener holds. A thread is all held or all in the views.
		const counts = this.one<{ messages: number; threads: number }>(
			`SELECT (SELECT COUNT(*) FROM messages WHERE screen IS NULL) AS messages,
				(SELECT COUNT(*) FROM threads) - (SELECT COUNT(DISTINCT thread_id) FROM messages WHERE screen IS NOT NULL) AS threads`,
		);
		const unread = this.one<{ n: number }>(
			`SELECT COUNT(DISTINCT m.thread_id) AS n FROM messages m
			JOIN message_labels inbox ON inbox.message_seq = m.seq AND inbox.label_id = 'INBOX'
			JOIN message_labels unread ON unread.message_seq = m.seq AND unread.label_id = 'UNREAD'
			WHERE m.screen IS NULL
			AND NOT EXISTS (SELECT 1 FROM message_labels x WHERE x.message_seq = m.seq AND x.label_id IN ('SPAM', 'TRASH'))`,
		);
		return {
			messages_total: counts?.messages ?? 0,
			threads_total: counts?.threads ?? 0,
			inbox_unread: unread?.n ?? 0,
			screener_pending: pendingCount(this.sql),
			version: Number(this.meta("version") ?? 0),
		};
	}

	/** The mail settings of the person who owns this mailbox. Only the own mailbox of a person has them. */
	settings(): MailSettings {
		return readSettings(this.meta("settings"));
	}

	/**
	 * Changes the named settings, keeps the others, and returns all of them. A setting is not mail, so the
	 * change counter stays: a change does not make the web app get the list and the labels again.
	 */
	updateSettings(patch: SettingsPatch): MailSettings {
		const current = readSettings(this.meta("settings"));
		const sidebar = { ...current.sidebar };
		for (const key of ["shared_mailboxes_collapsed", "agent_mailboxes_collapsed"] as const) {
			const value = patch.sidebar?.[key];
			if (typeof value === "boolean") sidebar[key] = value;
		}
		const defaultFrom = { ...current.default_from };
		if (patch.default_from) {
			const { mailbox_id: mailboxId, from_mailbox_id: fromId } = patch.default_from;
			if (fromId === null || fromId === mailboxId) delete defaultFrom[mailboxId];
			else defaultFrom[mailboxId] = fromId;
		}
		const next: MailSettings = { sidebar, default_from: defaultFrom };
		this.setMeta("settings", JSON.stringify(next));
		return next;
	}

	/** The settings of this mailbox. In a team mailbox, each member reads the same settings. */
	mailboxSettings(): StoredMailboxSettings {
		return readMailboxSettings(this.meta(MAILBOX_SETTINGS_KEY));
	}

	/**
	 * Changes the named settings of this mailbox, keeps the others, and returns all of them. A setting is
	 * not mail, so the change counter stays, as for `updateSettings`. When the change turns the Screener off,
	 * the mail that waits in it moves to the inbox in the same transaction, and the counter grows.
	 * `context` tells the default of the organization, for a change of the Screener.
	 */
	async updateMailboxSettings(patch: MailboxSettingsPatch, context?: ScreenerContext): Promise<StoredMailboxSettings> {
		const current = readMailboxSettings(this.meta(MAILBOX_SETTINGS_KEY));
		const next: StoredMailboxSettings = {
			signature: patch.signature === undefined ? current.signature : normalizeSignature(patch.signature),
			screener: patch.screener ?? current.screener,
		};
		const turnsOff =
			context !== undefined &&
			!screenerEnabled(next.screener, context) &&
			(screenerEnabled(current.screener, context) || patch.screener !== undefined);
		let eventAt: number | null = null;
		let released = 0;
		this.ctx.storage.transactionSync(() => {
			this.setMeta(MAILBOX_SETTINGS_KEY, JSON.stringify(next));
			if (turnsOff) released = this.releaseAllPending();
			if (released > 0) {
				this.bump();
				eventAt = this.queueInboxEvent();
			}
		});
		if (released > 0) this.signalInbox();
		if (eventAt !== null) await this.alarmBy(eventAt);
		return next;
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
				WHERE m.screen IS NULL AND (ml.label_id IN ('SPAM', 'TRASH') OR NOT EXISTS (
					SELECT 1 FROM message_labels x WHERE x.message_seq = m.seq AND x.label_id IN ('SPAM', 'TRASH')
				))
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
		// A thread whose snooze ended at its time has the place of that time, so it shows at the top of the inbox.
		const rows = this.all<{ thread_id: string; last_date: number }>(
			`SELECT m.thread_id AS thread_id,
				MAX(MAX(m.internal_date), COALESCE((SELECT t.woke_at FROM threads t WHERE t.id = m.thread_id), 0)) AS last_date
			FROM messages m
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
		const thread = this.one<{ subject: string; snoozed_until: number | null }>(
			"SELECT subject, snoozed_until FROM threads WHERE id = ?",
			threadId,
		);
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
		const labelRows = this.all<{ label_id: string; all_auto: number }>(
			`SELECT ml.label_id, MIN(ml.auto IS NOT NULL) AS all_auto FROM message_labels ml
			JOIN messages m ON m.seq = ml.message_seq WHERE m.thread_id = ? GROUP BY ml.label_id`,
			threadId,
		);
		const labels = labelRows.map((row) => row.label_id);
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
			autoLabels: labelRows.filter((row) => row.all_auto === 1).map((row) => row.label_id),
			hasAttachments: messages.some((message) => message.has_attachments === 1),
			untrusted: messages.some((message) => message.origin === "external"),
			lastMessageAt: lastDate,
			snoozedUntil: thread?.snoozed_until ?? null,
		};
	}

	/**
	 * A thread with its messages, oldest first. The bodies of the newest messages come first, up to
	 * `THREAD_BODY_CHARS`: an RPC result can be at most 32 MiB, so the bodies of older messages in a
	 * very large thread are left out (`omitted`), and `getMessage` returns each one.
	 */
	getThread(
		threadId: string,
	): { id: string; subject: string; snoozedUntil: number | null; messages: StoredMessage[] } | null {
		const thread = this.one<{ id: string; subject: string; snoozed_until: number | null }>(
			"SELECT id, subject, snoozed_until FROM threads WHERE id = ?",
			threadId,
		);
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
			snoozedUntil: thread.snoozed_until,
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

	private labelsOf(where: string, value: SqlStorageValue): Map<number, { all: string[]; auto: string[] }> {
		const labels = new Map<number, { all: string[]; auto: string[] }>();
		for (const row of this.all<{ message_seq: number; label_id: string; auto: string | null }>(
			`SELECT ml.message_seq, ml.label_id, ml.auto FROM message_labels ml JOIN messages m ON m.seq = ml.message_seq WHERE ${where}`,
			value,
		)) {
			const entry = labels.get(row.message_seq) ?? { all: [], auto: [] };
			entry.all.push(row.label_id);
			if (row.auto !== null) entry.auto.push(row.label_id);
			labels.set(row.message_seq, entry);
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
		labels: Map<number, { all: string[]; auto: string[] }>,
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
			labels: labels.get(row.seq)?.all ?? [],
			autoLabels: labels.get(row.seq)?.auto ?? [],
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

	/**
	 * The addresses that this mailbox sent mail to and that hold `query`, without regard to case. An
	 * address that starts with the query comes first. Then comes an address with a part that starts with
	 * it: after `@`, `.`, `_`, `-` or `+`, or a query that starts with one of them. Then the others. The
	 * most recent send comes first in each group. An empty query matches each address.
	 */
	suggestRecipients(query: string, limit: number): RecipientRecord[] {
		return this.all<RecipientRecord & Row>(
			`WITH q (text) AS (SELECT ?)
			SELECT r.address, r.times_sent, r.last_sent_at FROM recipients r, q
			WHERE instr(r.address_key, q.text) > 0
			ORDER BY CASE
				WHEN instr(r.address_key, q.text) = 1 THEN 0
				WHEN substr(q.text, 1, 1) IN ('@', '.', '_', '-', '+')
					OR instr(r.address_key, '@' || q.text) > 0 OR instr(r.address_key, '.' || q.text) > 0
					OR instr(r.address_key, '_' || q.text) > 0 OR instr(r.address_key, '-' || q.text) > 0
					OR instr(r.address_key, '+' || q.text) > 0 THEN 1
				ELSE 2 END,
				r.last_sent_at DESC, r.address_key
			LIMIT ?`,
			query.trim().toLowerCase(),
			limit,
		).map((row) => ({ address: row.address, times_sent: row.times_sent, last_sent_at: row.last_sent_at }));
	}

	/**
	 * Counts one send to each address of a sent message, inside the transaction of the message. The same
	 * address twice in one message (for example in To and in Cc) counts once, with the form of its first
	 * entry. The stored form is the form of the newest send. A send with the same time as the stored one
	 * is newer, because it is stored later. The migration backfill uses the same rules. `byPerson` tells that
	 * a person sent the message: the Screener lets an address in only for such a send.
	 */
	private recordRecipients(addresses: MailAddress[], sentAt: number, byPerson: boolean): void {
		const seen = new Set<string>();
		for (const { address } of addresses) {
			const key = address.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			this.sql.exec(
				`INSERT INTO recipients (address_key, address, times_sent, last_sent_at, person_sent) VALUES (?, ?, 1, ?, ?)
				ON CONFLICT (address_key) DO UPDATE SET
					address = CASE WHEN excluded.last_sent_at >= last_sent_at THEN excluded.address ELSE address END,
					times_sent = times_sent + 1,
					last_sent_at = MAX(last_sent_at, excluded.last_sent_at),
					person_sent = MAX(person_sent, excluded.person_sent)`,
				key,
				address,
				sentAt,
				byPerson ? 1 : 0,
			);
		}
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
			// An auto label without its user label cannot apply. A built-in one is off until a person turns it on again.
			this.sql.exec("DELETE FROM auto_labels WHERE label_id = ?", id);
			this.bump();
		});
		return { deleted: true };
	}

	modifyThreads(params: {
		threadIds: string[];
		add: string[];
		remove: string[];
		dryRun: boolean;
		/**
		 * True when a person makes the change. A person who removes an auto label, or adds one, corrects auto
		 * labels, and the mailbox learns from it. A change by an agent or a service account teaches nothing.
		 */
		learn?: boolean;
	}): { threads_changed: number; messages_changed: number; dry_run: boolean } | Refusal {
		for (const label of [...params.add, ...params.remove]) {
			if (!this.one("SELECT 1 AS found FROM labels WHERE id = ?", label)) {
				return { error: { code: "not_found", message: `No label has the id ${label}.` } };
			}
		}
		const threadIds = [...new Set(params.threadIds)];
		const heldChange = [...params.add, ...params.remove].some((label) => !HELD_MAIL_LABELS.has(label));
		const changes: { seq: number; add: string[]; remove: string[] }[] = [];
		let threadsChanged = 0;
		for (const threadId of threadIds) {
			if (!this.one("SELECT 1 AS found FROM threads WHERE id = ?", threadId)) {
				return { error: { code: "not_found", message: `No thread has the id ${threadId}.` } };
			}
			// Held mail is in no view. A view label would put it in a view with no decision, or would stay on it
			// after a decision. So only the read state and the marks of a person change on held mail.
			if (
				heldChange &&
				this.one("SELECT 1 AS found FROM messages WHERE thread_id = ? AND screen IS NOT NULL", threadId)
			) {
				return {
					error: {
						code: "conflict",
						message: `The Screener holds the thread ${threadId}. On held mail, only ${[...HELD_MAIL_LABELS].join(", ")} can change. To move the mail, a person screens the sender in or out (mail.screen_sender).`,
					},
				};
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
		// A thread without SNOOZED has no time. The time of a thread that loses SNOOZED goes with the label.
		const endsSnooze = params.remove.includes("SNOOZED");
		const learning = !params.dryRun && params.learn === true && this.autoLabelsOn();
		const corrections = learning ? this.correctionsOfChange(threadIds, params.add, params.remove) : [];
		// A person who adds a label that auto labels applied confirms it: the mark goes.
		const confirm = learning ? params.add.filter((label) => autoKeyOfLabel(this.sql, label) !== null) : [];
		if (!params.dryRun && (changes.length > 0 || corrections.length > 0 || confirm.length > 0)) {
			this.ctx.storage.transactionSync(() => {
				const now = Date.now();
				for (const correction of corrections) recordCorrection(this.sql, { ...correction, now });
				for (const label of confirm) {
					for (const threadId of threadIds) {
						this.sql.exec(
							"UPDATE message_labels SET auto = NULL WHERE label_id = ? AND message_seq IN (SELECT seq FROM messages WHERE thread_id = ?)",
							label,
							threadId,
						);
					}
				}
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
				if (endsSnooze) {
					for (const threadId of threadIds) {
						this.sql.exec("UPDATE threads SET snoozed_until = NULL WHERE id = ?", threadId);
					}
				}
				this.bump();
			});
		}
		return { threads_changed: threadsChanged, messages_changed: changes.length, dry_run: params.dryRun };
	}

	// --- Snooze ---------------------------------------------------------------------------------

	/**
	 * Snoozes threads until `until`: each message gets SNOOZED and loses INBOX, and the thread gets the time.
	 * A thread that is snoozed already gets the new time. The alarm brings each thread back at its time.
	 */
	async snoozeThreads(params: {
		threadIds: string[];
		until: number;
	}): Promise<{ threads_changed: number; until: number } | Refusal> {
		if (params.until <= Date.now()) {
			return { error: { code: "invalid", message: "until must be later than now." } };
		}
		const threadIds = [...new Set(params.threadIds)];
		for (const threadId of threadIds) {
			if (!this.one("SELECT 1 AS found FROM threads WHERE id = ?", threadId)) {
				return { error: { code: "not_found", message: `No thread has the id ${threadId}.` } };
			}
			// Held mail is in no view, so it cannot leave one. A person screens the sender in or out first.
			if (this.one("SELECT 1 AS found FROM messages WHERE thread_id = ? AND screen IS NOT NULL", threadId)) {
				return {
					error: {
						code: "conflict",
						message: `The Screener holds the thread ${threadId}. To snooze the mail, a person first screens the sender in (mail.screen_sender).`,
					},
				};
			}
		}
		let changed = 0;
		this.ctx.storage.transactionSync(() => {
			for (const threadId of threadIds) {
				const written =
					this.sql.exec(
						"INSERT OR IGNORE INTO message_labels (message_seq, label_id) SELECT seq, 'SNOOZED' FROM messages WHERE thread_id = ?",
						threadId,
					).rowsWritten +
					this.sql.exec(
						"DELETE FROM message_labels WHERE label_id = 'INBOX' AND message_seq IN (SELECT seq FROM messages WHERE thread_id = ?)",
						threadId,
					).rowsWritten +
					// A new snooze removes the place of an earlier one: `woke_at` is for a thread that came back only.
					this.sql.exec(
						"UPDATE threads SET snoozed_until = ?, woke_at = NULL WHERE id = ? AND (snoozed_until IS NOT ? OR woke_at IS NOT NULL)",
						params.until,
						threadId,
						params.until,
					).rowsWritten;
				if (written > 0) changed++;
			}
			if (changed > 0) this.bump();
		});
		await this.alarmBy(params.until);
		return { threads_changed: changed, until: params.until };
	}

	/**
	 * Ends the snooze of a thread, if it has one: each message loses SNOOZED and gets INBOX. `wokeAt` is the
	 * time of a snooze that ended at its time, and the thread then has the place of that time in a list. It is
	 * null when new mail ends the snooze: the new message gives the thread its place.
	 */
	private endSnooze(threadId: string, wokeAt: number | null): void {
		if (!this.one("SELECT 1 AS found FROM threads WHERE id = ? AND snoozed_until IS NOT NULL", threadId)) return;
		this.sql.exec(
			"DELETE FROM message_labels WHERE label_id = 'SNOOZED' AND message_seq IN (SELECT seq FROM messages WHERE thread_id = ?)",
			threadId,
		);
		this.sql.exec(
			"INSERT OR IGNORE INTO message_labels (message_seq, label_id) SELECT seq, 'INBOX' FROM messages WHERE thread_id = ?",
			threadId,
		);
		this.sql.exec(
			"UPDATE threads SET snoozed_until = NULL, woke_at = COALESCE(?, woke_at) WHERE id = ?",
			wokeAt,
			threadId,
		);
	}

	/** Brings back each thread whose snooze time came. The watch sockets get the inbox signal. */
	private wakeSnoozed(): void {
		const due = this.all<{ id: string; snoozed_until: number }>(
			"SELECT id, snoozed_until FROM threads WHERE snoozed_until <= ?",
			Date.now(),
		);
		if (due.length === 0) return;
		this.ctx.storage.transactionSync(() => {
			for (const thread of due) this.endSnooze(thread.id, thread.snoozed_until);
			this.bump();
		});
		this.signalInbox();
	}

	// --- Auto labels ------------------------------------------------------------------------------

	/** True when the members of this mailbox turned on auto labels. */
	private autoLabelsOn(): boolean {
		return this.meta(AUTO_LABEL_ENABLED_KEY) === "1";
	}

	/** Removes the Needs reply label from each message of a thread. */
	private clearNeedsReply(threadId: string): void {
		// Only while the auto label is on. A person who turned it off uses the label by hand.
		const row = this.one<{ label_id: string }>(
			"SELECT label_id FROM auto_labels WHERE key = 'needs_reply' AND enabled = 1",
		);
		if (!row) return;
		this.sql.exec(
			"DELETE FROM message_labels WHERE label_id = ? AND message_seq IN (SELECT seq FROM messages WHERE thread_id = ?)",
			row.label_id,
			threadId,
		);
	}

	/** True when the mailbox sent a message in the thread of this message after it arrived. */
	private repliedAfter(seq: number): boolean {
		return (
			this.one(
				`SELECT 1 AS found FROM messages m JOIN messages s ON s.thread_id = m.thread_id
				WHERE m.seq = ? AND s.origin = 'sent' AND s.seq > m.seq LIMIT 1`,
				seq,
			) !== null
		);
	}

	/**
	 * The corrections that a change by a person makes: a removed label that auto labels applied, or an added
	 * label that is an auto label. The sender is the sender of the newest message that arrived in the thread.
	 */
	private correctionsOfChange(
		threadIds: string[],
		add: string[],
		remove: string[],
	): { sender: string; labelKey: string; action: "add" | "remove"; subject: string }[] {
		const out: { sender: string; labelKey: string; action: "add" | "remove"; subject: string }[] = [];
		for (const threadId of threadIds) {
			const latest = this.one<{ from_addr: string | null; subject: string }>(
				`SELECT from_addr, subject FROM messages WHERE thread_id = ? AND origin != 'sent'
				ORDER BY internal_date DESC, seq DESC LIMIT 1`,
				threadId,
			);
			if (!latest?.from_addr) continue;
			for (const label of remove) {
				const auto = autoKeyOfLabel(this.sql, label);
				if (!auto) continue;
				const marked = this.one(
					`SELECT 1 AS found FROM message_labels ml JOIN messages m ON m.seq = ml.message_seq
					WHERE m.thread_id = ? AND ml.label_id = ? AND ml.auto IS NOT NULL LIMIT 1`,
					threadId,
					label,
				);
				if (marked)
					out.push({ sender: latest.from_addr, labelKey: auto.key, action: "remove", subject: latest.subject });
			}
			for (const label of add) {
				const auto = autoKeyOfLabel(this.sql, label);
				if (!auto?.enabled) continue;
				// A label that a person applied to each message before teaches nothing new.
				const missing = this.one(
					`SELECT 1 AS found FROM messages m WHERE m.thread_id = ? AND NOT EXISTS (
						SELECT 1 FROM message_labels ml WHERE ml.message_seq = m.seq AND ml.label_id = ? AND ml.auto IS NULL
					) LIMIT 1`,
					threadId,
					label,
				);
				if (missing) out.push({ sender: latest.from_addr, labelKey: auto.key, action: "add", subject: latest.subject });
			}
		}
		return out;
	}

	/** The rule decision for a stored message, with the facts of `facts`. */
	private decideFor(
		seq: number,
		facts: MailFacts,
		defs: LabelDef[],
	): { decision: Decision; sender: string | null } | null {
		const row = this.one<{ from_addr: string | null; signals_json: string | null }>(
			"SELECT from_addr, signals_json FROM messages WHERE seq = ?",
			seq,
		);
		if (!row) return null;
		return {
			sender: row.from_addr,
			decision: decide({
				signals: readSignals(row.signals_json),
				facts,
				enabled: defs,
				corrections: correctionsOfSender(this.sql, row.from_addr),
				sender: row.from_addr,
			}),
		};
	}

	/**
	 * Adds the auto labels `keys` to one message with the mark `source`, and records that auto labels
	 * examined it. With `mayArchive`, a label that skips the inbox removes INBOX. Returns true when INBOX went.
	 */
	private applyAutoLabelKeys(
		seq: number,
		keys: string[],
		source: "rule" | "sender" | "model",
		defs: LabelDef[],
		archive: boolean,
	): boolean {
		const byKey = new Map(defs.map((def) => [def.key, def]));
		for (const key of keys) {
			const def = byKey.get(key);
			if (!def) continue;
			this.sql.exec(
				"INSERT OR IGNORE INTO message_labels (message_seq, label_id, auto) VALUES (?, ?, ?)",
				seq,
				def.labelId,
				source,
			);
		}
		this.sql.exec("UPDATE messages SET auto_labeled_at = ? WHERE seq = ?", Date.now(), seq);
		if (!archive) return false;
		return (
			this.sql.exec("DELETE FROM message_labels WHERE message_seq = ? AND label_id = 'INBOX'", seq).rowsWritten > 0
		);
	}

	/**
	 * The rule stage for one message, inside the caller's transaction. A final decision applies its labels
	 * at once. An open one puts the message in the classifier outbox. With `mayArchive`, a rule label that
	 * skips the inbox removes INBOX (only for new mail: a run never moves mail).
	 */
	private autoLabelAtDelivery(
		seq: number,
		ownerAddress: string,
		options: { mayArchive: boolean },
	): "none" | "labeled" | "archived" | "queued" {
		const defs = enabledLabelDefs(this.sql);
		const facts = messageFacts(this.sql, seq, ownerAddress);
		if (defs.length === 0 || !facts) return "none";
		const decided = this.decideFor(seq, facts, defs);
		if (!decided) return "none";
		const { decision } = decided;
		if (decision.final) {
			const keys = decision.labels.map((label) => label.key);
			const source = decision.labels.some((label) => label.source === "sender") ? "sender" : "rule";
			// Only mail from a proved sender skips the inbox. A forged sender cannot hide mail there.
			const skip =
				options.mayArchive && facts.authenticated && keys.some((key) => defs.find((def) => def.key === key)?.skipInbox);
			const archived = this.applyAutoLabelKeys(seq, keys, source, defs, skip);
			return archived ? "archived" : keys.length > 0 ? "labeled" : "none";
		}
		// The row keeps `mayArchive`, so the classifier stage of a run does not move mail out of the inbox.
		this.sql.exec(
			"INSERT OR REPLACE INTO autolabel_outbox (message_seq, sends, next_attempt_at, facts_json, may_archive) VALUES (?, 0, ?, ?, ?)",
			seq,
			Date.now(),
			JSON.stringify(facts),
			options.mayArchive ? 1 : 0,
		);
		return "queued";
	}

	/** The auto-label settings of the mailbox. */
	autoLabelSettings(): Pick<AutoLabelSettings, "enabled" | "labels"> {
		return settingsView(this.sql, this.autoLabelsOn());
	}

	/** Runs `change` in one transaction. A refusal that it throws rolls back each write. */
	private changeAutoLabels(mailboxId: string, change: () => void): Refusal | null {
		try {
			this.ctx.storage.transactionSync(() => {
				this.setMeta(AUTO_LABEL_MAILBOX_KEY, mailboxId);
				change();
				this.bump();
			});
			return null;
		} catch (error) {
			if (error instanceof AutoLabelRefusal) return error.refusal;
			throw error;
		}
	}

	updateAutoLabels(
		mailboxId: string,
		patch: {
			enabled?: boolean | undefined;
			labels?:
				| {
						key: string;
						enabled?: boolean | undefined;
						skip_inbox?: boolean | undefined;
						description?: string | undefined;
				  }[]
				| undefined;
		},
	): Pick<AutoLabelSettings, "enabled" | "labels"> | Refusal {
		const refusal = this.changeAutoLabels(mailboxId, () => {
			const now = Date.now();
			const check = (result: StoreRefusal | null) => {
				if (result) throw new AutoLabelRefusal(result);
			};
			if (patch.enabled === true && this.meta(AUTO_LABEL_INITIALIZED_KEY) === null) {
				// The first time, each built-in label is on.
				for (const label of AUTO_LABELS_ORDER) check(enableBuiltin(this.sql, label, now));
				this.setMeta(AUTO_LABEL_INITIALIZED_KEY, "1");
			}
			if (patch.enabled !== undefined) this.setMeta(AUTO_LABEL_ENABLED_KEY, patch.enabled ? "1" : "0");
			for (const entry of patch.labels ?? []) {
				const custom = entry.key.startsWith("alb_");
				const row = this.one<{ kind: string }>("SELECT kind FROM auto_labels WHERE key = ?", entry.key);
				if (custom && row?.kind !== "custom") {
					check({ error: { code: "not_found", message: `No custom auto label has the id ${entry.key}.` } });
				}
				if (!custom && entry.description !== undefined) {
					check({ error: { code: "invalid", message: "A built-in auto label has a fixed description." } });
				}
				if (!custom && entry.enabled === true) check(enableBuiltin(this.sql, entry.key, now));
				else if (entry.enabled !== undefined) {
					this.sql.exec("UPDATE auto_labels SET enabled = ? WHERE key = ?", entry.enabled ? 1 : 0, entry.key);
				}
				if (entry.skip_inbox !== undefined || entry.description !== undefined) {
					if (!this.one("SELECT 1 AS found FROM auto_labels WHERE key = ?", entry.key)) {
						check({ error: { code: "invalid", message: `Turn on the auto label ${entry.key} first.` } });
					}
					if (entry.skip_inbox !== undefined) {
						this.sql.exec("UPDATE auto_labels SET skip_inbox = ? WHERE key = ?", entry.skip_inbox ? 1 : 0, entry.key);
					}
					if (entry.description !== undefined) {
						this.sql.exec("UPDATE auto_labels SET description = ? WHERE key = ?", entry.description, entry.key);
					}
				}
			}
		});
		return refusal ?? this.autoLabelSettings();
	}

	createAutoLabel(
		mailboxId: string,
		input: { name: string; description: string; skipInbox: boolean },
	): Pick<AutoLabelSettings, "enabled" | "labels"> | Refusal {
		const refusal = this.changeAutoLabels(mailboxId, () => {
			const count = this.one<{ n: number }>("SELECT COUNT(*) AS n FROM auto_labels WHERE kind = 'custom'")?.n ?? 0;
			if (count >= AUTO_LABEL_LIMITS.custom) {
				throw new AutoLabelRefusal({
					error: {
						code: "invalid",
						message: `A mailbox can have at most ${AUTO_LABEL_LIMITS.custom} custom auto labels.`,
					},
				});
			}
			const folded = foldLabelName(input.name);
			if (AUTO_LABELS_NAMES.has(folded)) {
				throw new AutoLabelRefusal({
					error: { code: "conflict", message: `"${input.name}" is the name of a built-in auto label.` },
				});
			}
			const ensured = ensureUserLabel(this.sql, input.name, Date.now());
			if ("error" in ensured) throw new AutoLabelRefusal(ensured);
			if (this.one("SELECT 1 AS found FROM auto_labels WHERE label_id = ?", ensured.id)) {
				throw new AutoLabelRefusal({
					error: { code: "conflict", message: `An auto label named "${input.name}" exists.` },
				});
			}
			this.sql.exec(
				"INSERT INTO auto_labels (key, kind, label_id, description, enabled, skip_inbox, created_at) VALUES (?, 'custom', ?, ?, 1, ?, ?)",
				newId("alb"),
				ensured.id,
				input.description,
				input.skipInbox ? 1 : 0,
				Date.now(),
			);
		});
		return refusal ?? this.autoLabelSettings();
	}

	/** Deletes a custom auto label. Its user label and its messages stay, without the auto mark. */
	deleteAutoLabel(mailboxId: string, key: string): { deleted: true } | Refusal {
		const row = this.one<{ label_id: string }>(
			"SELECT label_id FROM auto_labels WHERE key = ? AND kind = 'custom'",
			key,
		);
		if (!row) return { error: { code: "not_found", message: "No custom auto label has that id." } };
		const refusal = this.changeAutoLabels(mailboxId, () => {
			this.sql.exec("DELETE FROM auto_labels WHERE key = ?", key);
			this.sql.exec("UPDATE message_labels SET auto = NULL WHERE label_id = ?", row.label_id);
			this.sql.exec("DELETE FROM label_corrections WHERE label_key = ?", key);
		});
		return refusal ?? { deleted: true };
	}

	/**
	 * Applies auto labels to the newest inbox messages that auto labels did not examine. Rules apply at once,
	 * the rest go to the classifier outbox. A run never removes INBOX.
	 */
	async runAutoLabels(
		mailboxId: string,
		ownerAddress: string,
		limit: number,
		dryRun: boolean,
	): Promise<AutoLabelRun | Refusal> {
		if (!this.autoLabelsOn()) {
			return { error: { code: "conflict", message: "Auto labels are off in this mailbox. Turn them on first." } };
		}
		const seqs = this.all<{ seq: number }>(
			`SELECT m.seq FROM messages m
			JOIN message_labels inbox ON inbox.message_seq = m.seq AND inbox.label_id = 'INBOX'
			WHERE m.origin != 'sent' AND m.auto_labeled_at IS NULL
			AND NOT EXISTS (SELECT 1 FROM autolabel_outbox o WHERE o.message_seq = m.seq)
			AND NOT EXISTS (SELECT 1 FROM message_labels x WHERE x.message_seq = m.seq AND x.label_id IN ('SPAM', 'TRASH'))
			ORDER BY m.internal_date DESC, m.seq DESC LIMIT ?`,
			limit,
		).map((row) => row.seq);
		if (dryRun) return { messages: seqs.length, labeled_by_rules: 0, queued: 0, dry_run: true };
		let labeled = 0;
		let queued = 0;
		this.ctx.storage.transactionSync(() => {
			this.setMeta(AUTO_LABEL_MAILBOX_KEY, mailboxId);
			for (const seq of seqs) {
				const outcome = this.autoLabelAtDelivery(seq, ownerAddress, { mayArchive: false });
				if (outcome === "labeled") labeled++;
				if (outcome === "queued") queued++;
				if (outcome === "none") this.sql.exec("UPDATE messages SET auto_labeled_at = ? WHERE seq = ?", Date.now(), seq);
			}
			this.bump();
		});
		if (queued > 0) await this.alarmBy(Date.now());
		return { messages: seqs.length, labeled_by_rules: labeled, queued, dry_run: false };
	}

	/**
	 * What the classifier needs for one message in the outbox, or null when the message needs no classifier
	 * call: it is not in the outbox, auto labels are off, it moved to spam or trash, or the rules decide now
	 * (for example after a new correction). In the last two cases the message leaves the outbox here.
	 */
	autoLabelJob(messageId: string): AutoLabelContext | null {
		const row = this.one<{
			seq: number;
			from_name: string | null;
			from_addr: string | null;
			subject: string;
			text_body: string | null;
			html_body: string | null;
			attachments_json: string;
			signals_json: string | null;
			facts_json: string;
			may_archive: number;
		}>(
			`SELECT m.seq, m.from_name, m.from_addr, m.subject, m.text_body, m.html_body, m.attachments_json, m.signals_json,
				o.facts_json, o.may_archive
			FROM autolabel_outbox o JOIN messages m ON m.seq = o.message_seq WHERE m.id = ?`,
			messageId,
		);
		if (!row) return null;
		const defs = enabledLabelDefs(this.sql);
		const facts = readFacts(row.facts_json);
		const decided = this.decideFor(row.seq, facts, defs);
		const gone = this.one(
			"SELECT 1 AS found FROM message_labels WHERE message_seq = ? AND label_id IN ('SPAM', 'TRASH')",
			row.seq,
		);
		if (!this.autoLabelsOn() || defs.length === 0 || !decided || gone || decided.decision.final) {
			this.ctx.storage.transactionSync(() => {
				if (decided?.decision.final && this.autoLabelsOn() && !gone) {
					const keys = decided.decision.labels.map((label) => label.key);
					const source = decided.decision.labels.some((label) => label.source === "sender") ? "sender" : "rule";
					this.applyAutoLabelKeys(
						row.seq,
						keys,
						source,
						defs,
						row.may_archive === 1 &&
							facts.authenticated &&
							keys.some((key) => defs.find((d) => d.key === key)?.skipInbox),
					);
				} else {
					this.sql.exec("UPDATE messages SET auto_labeled_at = ? WHERE seq = ?", Date.now(), row.seq);
				}
				this.sql.exec("DELETE FROM autolabel_outbox WHERE message_seq = ?", row.seq);
				this.bump();
			});
			return null;
		}
		// The mailbox answered in the thread after this message, so the message does not need a reply any more.
		const candidates = this.repliedAfter(row.seq)
			? decided.decision.candidates.filter((key) => key !== "needs_reply")
			: decided.decision.candidates;
		if (candidates.length === 0) {
			this.finishAutoLabel(messageId);
			return null;
		}
		const attachments = (JSON.parse(row.attachments_json) as { filename: string; mimeType: string }[]).map((a) => ({
			filename: a.filename,
			mimeType: a.mimeType,
		}));
		return {
			prompt: {
				facts,
				signals: readSignals(row.signals_json),
				from: row.from_addr ? { name: row.from_name, address: row.from_addr } : null,
				subject: row.subject,
				text: row.text_body ?? (row.html_body ? htmlToText(row.html_body) : ""),
				attachments,
				labels: defs.filter((def) => candidates.includes(def.key)),
				corrections: exampleCorrections(this.sql, row.from_addr, PROMPT_CORRECTIONS),
			},
			decision: { candidates, needsReplyStrict: decided.decision.needsReplyStrict },
		};
	}

	/**
	 * Applies the picks of the classifier to a message in the outbox, and takes it out of the outbox. Only
	 * the candidates of the rules count (`resolvePicks`), so an answer can only choose labels that are on in
	 * this mailbox. A second call for the same message does nothing. Returns the label ids that it applied.
	 */
	applyAutoLabels(messageId: string, picks: LabelPick[]): { applied: string[]; archived: boolean } {
		const row = this.one<{ seq: number; facts_json: string; may_archive: number }>(
			`SELECT m.seq, o.facts_json, o.may_archive FROM autolabel_outbox o JOIN messages m ON m.seq = o.message_seq
			WHERE m.id = ?`,
			messageId,
		);
		if (!row) return { applied: [], archived: false };
		const defs = enabledLabelDefs(this.sql);
		// A person can move the message to Spam or Trash while the classifier works. It gets no label then.
		const gone = this.one(
			"SELECT 1 AS found FROM message_labels WHERE message_seq = ? AND label_id IN ('SPAM', 'TRASH')",
			row.seq,
		);
		const facts = readFacts(row.facts_json);
		const decided = this.autoLabelsOn() && !gone ? this.decideFor(row.seq, facts, defs) : null;
		// A reply from the mailbox can come while the classifier works. `send()` removed Needs reply then, and
		// a late answer of the classifier must not add it again.
		const replied = this.repliedAfter(row.seq);
		const resolved =
			decided && !decided.decision.final
				? resolvePicks(
						picks,
						{
							...decided.decision,
							candidates: decided.decision.candidates.filter((key) => !replied || key !== "needs_reply"),
						},
						defs,
					)
				: { keys: decided?.decision.labels.map((label) => label.key) ?? [], skipInbox: false };
		const source = decided && !decided.decision.final ? "model" : "rule";
		let archived = false;
		this.ctx.storage.transactionSync(() => {
			archived = this.applyAutoLabelKeys(
				row.seq,
				resolved.keys,
				source,
				defs,
				row.may_archive === 1 && facts.authenticated && resolved.skipInbox,
			);
			this.sql.exec("DELETE FROM autolabel_outbox WHERE message_seq = ?", row.seq);
			this.bump();
		});
		const byKey = new Map(defs.map((def) => [def.key, def.labelId]));
		return { applied: resolved.keys.flatMap((key) => byKey.get(key) ?? []), archived };
	}

	/**
	 * Turns off auto labels and empties the classifier outbox. The Worker calls it when it deletes the
	 * principal of this mailbox: from then on, `autoLabelJob` gives nothing to a job that waits in the queue,
	 * so no mail of the deleted mailbox goes to the gateway. Only a call that already read its message can
	 * still finish.
	 */
	closeAutoLabels(): void {
		this.ctx.storage.transactionSync(() => {
			this.setMeta(AUTO_LABEL_ENABLED_KEY, "0");
			this.sql.exec("DELETE FROM autolabel_outbox");
		});
	}

	/** Takes a message out of the classifier outbox with no label: AI cannot take the call. */
	finishAutoLabel(messageId: string): void {
		const row = this.one<{ seq: number }>(
			"SELECT m.seq FROM autolabel_outbox o JOIN messages m ON m.seq = o.message_seq WHERE m.id = ?",
			messageId,
		);
		if (!row) return;
		this.ctx.storage.transactionSync(() => {
			this.sql.exec("UPDATE messages SET auto_labeled_at = ? WHERE seq = ?", Date.now(), row.seq);
			this.sql.exec("DELETE FROM autolabel_outbox WHERE message_seq = ?", row.seq);
		});
	}

	/**
	 * Puts the due messages of the classifier outbox on the queue soldock-mail-autolabel, with ids only. A
	 * message whose result does not come is sent again after `AUTOLABEL_RESEND_MS`, up to
	 * `AUTOLABEL_MAX_SENDS` times. Then it leaves the outbox with no label.
	 */
	private async drainAutoLabels(): Promise<void> {
		const now = Date.now();
		const due = this.all<{ message_seq: number; sends: number; id: string | null }>(
			`SELECT o.message_seq, o.sends, m.id FROM autolabel_outbox o LEFT JOIN messages m ON m.seq = o.message_seq
			WHERE o.next_attempt_at <= ? ORDER BY o.next_attempt_at LIMIT ?`,
			now,
			AUTOLABEL_BATCH,
		);
		const mailboxId = this.meta(AUTO_LABEL_MAILBOX_KEY);
		for (const row of due) {
			if (this.meta("delivery_pause")) return;
			if (row.id === null || mailboxId === null || row.sends >= AUTOLABEL_MAX_SENDS) {
				if (row.id !== null && row.sends >= AUTOLABEL_MAX_SENDS) {
					log("warn", "auto label gave up: no result from the classifier", { sends: row.sends });
				}
				this.ctx.storage.transactionSync(() => {
					this.sql.exec("UPDATE messages SET auto_labeled_at = ? WHERE seq = ?", now, row.message_seq);
					this.sql.exec("DELETE FROM autolabel_outbox WHERE message_seq = ?", row.message_seq);
				});
				continue;
			}
			const job: AutoLabelJob = { v: 1, mailboxId, messageId: row.id };
			try {
				await this.env.MAIL_AUTOLABEL.send(job);
				this.sql.exec(
					"UPDATE autolabel_outbox SET sends = sends + 1, next_attempt_at = ? WHERE message_seq = ?",
					Date.now() + AUTOLABEL_RESEND_MS,
					row.message_seq,
				);
			} catch (error) {
				log("warn", "auto label job could not be queued; retrying", {
					error: error instanceof Error ? error.message : String(error),
				});
				this.sql.exec(
					"UPDATE autolabel_outbox SET next_attempt_at = ? WHERE message_seq = ?",
					Date.now() + backoff(row.sends + 1),
					row.message_seq,
				);
			}
		}
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
	async send(input: SendInput): Promise<{ duplicate: boolean; result: SendResult; screenedIn: number } | Refusal> {
		if (this.meta("delivery_pause"))
			return { error: { code: "conflict", message: "This mailbox is paused for a reset." } };
		const now = Date.now();
		const selfDelivery = input.recipients.some((r) => r.self);
		let eventAt: number | null = null;
		let released = 0;
		let screenedIn = 0;
		const result = this.ctx.storage.transactionSync(() => {
			this.sql.exec("DELETE FROM idempotency WHERE created_at < ?", now - IDEMPOTENCY_TTL_MS);
			if (input.idempotencyKey) {
				const earlier = this.idempotentResult(input.idempotencyKey, input.requestHash);
				if (earlier && "error" in earlier) return earlier;
				if (earlier) return { duplicate: true, result: earlier, screenedIn: 0 };
			}
			const selfAddress = input.recipients.find((r) => r.self)?.address;
			const selfTagLabel = selfAddress ? this.tagLabel(addressTag(selfAddress)) : null;
			// A person who writes to a sender that waits wants the mail of that sender. This runs before the
			// message is stored, so a reply to held mail joins its thread. A send by an agent decides nothing, and
			// a send by a person who cannot decide in the Screener decides nothing.
			if (input.mayScreen === true && input.sentBy.kind === "human") {
				const decided = this.screenInRecipients(
					[...input.parsed.to, ...input.parsed.cc, ...input.bcc],
					{ ...input.sentBy, kind: "human" },
					now,
				);
				released = decided.moved;
				screenedIn = decided.senders;
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
				labels: selfDelivery ? ["SENT", "INBOX", ...(selfTagLabel ? [selfTagLabel] : [])] : ["SENT"],
				subjectFallback: true,
				sentBy: input.sentBy,
			});
			this.recordRecipients(
				[...input.parsed.to, ...input.parsed.cc, ...input.bcc],
				input.internalDate,
				input.sentBy.kind === "human",
			);
			// A reply answers the thread, so its Needs reply label goes.
			if (this.autoLabelsOn()) this.clearNeedsReply(stored.threadId);
			// A message to the mailbox itself is new mail in the inbox, so it ends the snooze of its thread, as in
			// deliver(). A different send does not: the time of the snooze decides.
			if (selfDelivery) this.endSnooze(stored.threadId, null);
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
			if (selfDelivery || released > 0) eventAt = this.queueInboxEvent();
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
			return { duplicate: false, result: sendResult, screenedIn };
		});
		if ("error" in result || result.duplicate) return result;
		// Mail to the mailbox itself, or the mail of a sender that the send screened in, is in its inbox now.
		if (selfDelivery || released > 0) this.signalInbox();
		if (input.recipients.some((r) => !r.self)) await this.ctx.storage.setAlarm(now);
		else if (eventAt !== null) await this.alarmBy(eventAt);
		return result;
	}

	/**
	 * Puts the due webhook events on the queue, then drains the outbox: local deliveries go straight to
	 * the recipient's mailbox, external ones to Email Service. A failure is retried with backoff, up to
	 * `OUTBOX_MAX_ATTEMPTS`, then the recipient is marked failed. Delivery is at least once: a crash after
	 * a send and before the outbox row is deleted sends again.
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
		// The snoozes first: they need no network. Then the events: each one is one quick queue send, and a slow
		// outbox must not delay them.
		this.wakeSnoozed();
		await this.drainEvents();
		await this.drainOutbox();
		await this.drainAutoLabels();
		if (this.meta("delivery_pause")) return;
		const next =
			this.one<{ at: number | null }>(
				`SELECT MIN(at) AS at FROM (SELECT MIN(next_attempt_at) AS at FROM outbox
				UNION ALL SELECT MIN(next_attempt_at) FROM event_outbox
				UNION ALL SELECT MIN(next_attempt_at) FROM autolabel_outbox
				UNION ALL SELECT MIN(snoozed_until) FROM threads WHERE snoozed_until IS NOT NULL)`,
			)?.at ?? null;
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
		if (this.hasPendingWork()) await this.ctx.storage.setAlarm(Date.now());
	}

	/**
	 * Cancels the old outbox after the directory reset. The mailbox stays paused. The reset also deleted
	 * the webhooks, so the webhook events stop.
	 */
	cancelDeliveries(token: string): void {
		if (this.meta("delivery_pause") !== token) return;
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(
				"UPDATE delivery SET status = 'failed', error = ?, updated_at = ? WHERE status = 'queued'",
				"The sender account no longer owns this address.",
				Date.now(),
			);
			this.sql.exec("DELETE FROM outbox");
			this.sql.exec("DELETE FROM event_outbox");
			this.sql.exec("DELETE FROM autolabel_outbox");
			// The mail of the old organization never goes to the classifier again.
			this.setMeta(AUTO_LABEL_ENABLED_KEY, "0");
			this.sql.exec("DELETE FROM meta WHERE key IN (?, ?)", EVENTS_MAILBOX_KEY, EVENTS_LAST_KEY);
			this.bump();
		});
	}

	/**
	 * Stops an external delivery when the agent that sent the message cannot reach that address. A
	 * missing agent, an archived agent, or a policy refusal fails the row with no retry.
	 * A human has no policy. Asterra does not check a message that has no sent_by. Each send stores
	 * one. A directory error throws, so the row retries and sends nothing.
	 */
	private async assertAgentMaySend(sentByJson: string | null, address: string): Promise<void> {
		const sentBy = sentByOf(sentByJson);
		if (sentBy?.kind !== "agent") return;
		const principal = await getPrincipal(this.env.DIRECTORY, sentBy.principal_id);
		if (!principal) throw new SenderUnavailable("The agent does not exist, so Asterra does not send this message.");
		if (principal.archived_at !== null) {
			throw new SenderUnavailable("The agent is archived, so Asterra does not send this message.");
		}
		const denied = deniedOutboundAddresses(principal, [address.trim().toLowerCase()]);
		if (denied.length > 0) {
			throw new SenderUnavailable(outboundPolicyDenial(outboundMode(principal), denied), "outbound policy");
		}
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
			sent_by_json: string | null;
		}>(
			`SELECT o.id, o.message_seq, o.kind, o.target, o.address, o.attempts, m.raw_key, m.from_addr, m.sent_by_json
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
					await deliverInternal(this.env, row.target, row.address, raw);
					status = "delivered";
				} else {
					if (!row.from_addr) throw new Error("the message has no sender address");
					// The policy can change after the send is stored. Check it again before the mail leaves.
					await this.assertAgentMaySend(row.sent_by_json, row.address);
					if (this.meta("delivery_pause")) return;
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
				// The delivery row keeps the address. The log keeps the domain and a fixed reason.
				const logged = error instanceof SenderUnavailable && error.logReason !== null ? error.logReason : message;
				log("warn", "outbox delivery failed", {
					kind: row.kind,
					attempts,
					recipientDomain: row.address.split("@").pop(),
					error: logged,
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
