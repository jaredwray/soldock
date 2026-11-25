import { AUTO_LABELS, type AutoLabelSettings, MAIL_LIMITS } from "@asterra/contracts";
import { newId } from "../../platform/index.ts";
import { type AuthenticationResults, senderVerification } from "../mime/parse.ts";
import { foldLabelName } from "../search.ts";
import { type Correction, FREE_MAIL_DOMAINS, type LabelDef, type MailFacts } from "./rules.ts";
import { domainOfAddress } from "./signals.ts";

/** The migration of the mailbox for auto labels. `mail/mailbox.ts` appends it to its list. */
export const AUTOLABEL_MIGRATION: string[] = [
	// Null: a person, an agent or the system applied the label. 'rule', 'sender' or 'model': auto labels did.
	"ALTER TABLE message_labels ADD COLUMN auto TEXT",
	// The flags of the headers (signals.ts). Null for mail from before auto labels and for sent mail.
	"ALTER TABLE messages ADD COLUMN signals_json TEXT",
	// The time when auto labels examined the message, or null.
	"ALTER TABLE messages ADD COLUMN auto_labeled_at INTEGER",
	// Each built-in auto label that the mailbox turned on once, and each custom auto label.
	`CREATE TABLE auto_labels (
		key TEXT PRIMARY KEY,
		kind TEXT NOT NULL CHECK (kind IN ('builtin', 'custom')),
		label_id TEXT NOT NULL,
		description TEXT NOT NULL DEFAULT '',
		enabled INTEGER NOT NULL DEFAULT 1,
		skip_inbox INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL
	)`,
	// The labels that a person added or removed by hand. The newest 500 stay.
	`CREATE TABLE label_corrections (
		id INTEGER PRIMARY KEY,
		sender TEXT NOT NULL,
		sender_domain TEXT NOT NULL,
		label_key TEXT NOT NULL,
		action TEXT NOT NULL CHECK (action IN ('add', 'remove')),
		subject TEXT NOT NULL,
		created_at INTEGER NOT NULL
	)`,
	"CREATE INDEX label_corrections_sender ON label_corrections (sender, label_key)",
	"CREATE INDEX label_corrections_domain ON label_corrections (sender_domain, label_key)",
	// The messages that wait for the classifier. `facts_json` holds the facts at delivery. `may_archive` is 1
	// for new mail, and 0 for mail of a run: a run never moves mail out of the inbox.
	`CREATE TABLE autolabel_outbox (
		message_seq INTEGER PRIMARY KEY,
		sends INTEGER NOT NULL DEFAULT 0,
		next_attempt_at INTEGER NOT NULL,
		facts_json TEXT NOT NULL,
		may_archive INTEGER NOT NULL DEFAULT 1
	)`,
	"CREATE INDEX autolabel_outbox_due ON autolabel_outbox (next_attempt_at)",
];

/** The meta key whose value "1" turns on auto labels in the mailbox. */
export const AUTO_LABEL_ENABLED_KEY = "auto_label_enabled";
/** The meta key that is set once the built-in labels were turned on the first time. */
export const AUTO_LABEL_INITIALIZED_KEY = "auto_label_initialized";
/** The corrections that the mailbox keeps. */
export const MAX_CORRECTIONS = 500;

type Row = Record<string, SqlStorageValue>;

function one<T extends Row>(sql: SqlStorage, query: string, ...params: SqlStorageValue[]): T | null {
	return (sql.exec<T>(query, ...params).toArray()[0] as T | undefined) ?? null;
}

function all<T extends Row>(sql: SqlStorage, query: string, ...params: SqlStorageValue[]): T[] {
	return sql.exec<T>(query, ...params).toArray();
}

interface AutoLabelRow extends Row {
	key: string;
	kind: string;
	label_id: string;
	description: string;
	enabled: number;
	skip_inbox: number;
	created_at: number;
	name: string | null;
}

export function autoLabelRows(sql: SqlStorage): AutoLabelRow[] {
	return all<AutoLabelRow>(
		sql,
		`SELECT a.key, a.kind, a.label_id, a.description, a.enabled, a.skip_inbox, a.created_at, l.name
		FROM auto_labels a LEFT JOIN labels l ON l.id = a.label_id ORDER BY a.created_at, a.key`,
	);
}

const BUILTIN = new Map<string, (typeof AUTO_LABELS)[number]>(AUTO_LABELS.map((label) => [label.key, label]));

/** The auto labels that are on: the built-in ones in catalog order, then the custom ones by age. */
export function enabledLabelDefs(sql: SqlStorage): LabelDef[] {
	const rows = autoLabelRows(sql).filter((row) => row.enabled === 1 && row.name !== null);
	const builtins = AUTO_LABELS.flatMap((label) => {
		const row = rows.find((entry) => entry.key === label.key);
		return row
			? [
					{
						key: label.key,
						kind: "builtin" as const,
						name: label.name,
						description: label.definition,
						skipInbox: row.skip_inbox === 1,
						labelId: row.label_id,
					},
				]
			: [];
	});
	const custom = rows
		.filter((row) => row.kind === "custom")
		.map((row) => ({
			key: row.key,
			kind: "custom" as const,
			name: row.name ?? "",
			description: row.description,
			skipInbox: row.skip_inbox === 1,
			labelId: row.label_id,
		}));
	return [...builtins, ...custom];
}

/** The settings view of the mailbox, for `mail.get_auto_labels` and each change. */
export function settingsView(sql: SqlStorage, enabled: boolean): Pick<AutoLabelSettings, "enabled" | "labels"> {
	const rows = new Map(autoLabelRows(sql).map((row) => [row.key, row]));
	const builtins = AUTO_LABELS.map((label) => {
		const row = rows.get(label.key);
		return {
			key: label.key,
			kind: "builtin" as const,
			name: label.name,
			description: label.summary,
			enabled: row?.enabled === 1,
			skip_inbox: row?.skip_inbox === 1,
			label_id: row?.label_id ?? null,
		};
	});
	const custom = [...rows.values()]
		.filter((row) => row.kind === "custom")
		.map((row) => ({
			key: row.key,
			kind: "custom" as const,
			name: row.name ?? "",
			description: row.description,
			enabled: row.enabled === 1,
			skip_inbox: row.skip_inbox === 1,
			label_id: row.label_id,
		}));
	return { enabled, labels: [...builtins, ...custom] };
}

export type StoreRefusal = { error: { code: "invalid" | "not_found" | "conflict"; message: string } };

/**
 * The user label with this name, or a new one. A user label with the same name (any case) is used, so a
 * person who made "Receipts" before keeps it.
 */
export function ensureUserLabel(sql: SqlStorage, name: string, now: number): { id: string } | StoreRefusal {
	const folded = foldLabelName(name);
	const existing = one<{ id: string; type: string }>(sql, "SELECT id, type FROM labels WHERE name_folded = ?", folded);
	if (existing?.type === "user") return { id: existing.id };
	if (existing) return { error: { code: "conflict", message: `"${name}" is the name of a system label.` } };
	const users = one<{ n: number }>(sql, "SELECT COUNT(*) AS n FROM labels WHERE type = 'user'")?.n ?? 0;
	if (users >= MAIL_LIMITS.userLabels) {
		return { error: { code: "invalid", message: `A mailbox can have at most ${MAIL_LIMITS.userLabels} labels.` } };
	}
	const id = newId("lbl");
	sql.exec(
		"INSERT INTO labels (id, name, name_folded, type, created_at) VALUES (?, ?, ?, 'user', ?)",
		id,
		name,
		folded,
		now,
	);
	return { id };
}

/** Turns on a built-in auto label: its row and its user label. */
export function enableBuiltin(sql: SqlStorage, key: string, now: number): StoreRefusal | null {
	const label = BUILTIN.get(key);
	if (!label) return { error: { code: "not_found", message: `No built-in auto label has the key ${key}.` } };
	const row = one<{ label_id: string }>(sql, "SELECT label_id FROM auto_labels WHERE key = ?", key);
	if (row && one(sql, "SELECT 1 AS found FROM labels WHERE id = ?", row.label_id)) {
		sql.exec("UPDATE auto_labels SET enabled = 1 WHERE key = ?", key);
		return null;
	}
	const ensured = ensureUserLabel(sql, label.name, now);
	if ("error" in ensured) return ensured;
	sql.exec(
		`INSERT INTO auto_labels (key, kind, label_id, enabled, created_at) VALUES (?, 'builtin', ?, 1, ?)
		ON CONFLICT (key) DO UPDATE SET label_id = excluded.label_id, enabled = 1`,
		key,
		ensured.id,
		now,
	);
	return null;
}

/** The key of the auto label that applies this user label, or null. */
export function autoKeyOfLabel(sql: SqlStorage, labelId: string): { key: string; enabled: boolean } | null {
	const row = one<{ key: string; enabled: number }>(
		sql,
		"SELECT key, enabled FROM auto_labels WHERE label_id = ?",
		labelId,
	);
	return row ? { key: row.key, enabled: row.enabled === 1 } : null;
}

/** The address without its `+tag`, in lowercase. */
function baseAddress(address: string): string {
	const lower = address.toLowerCase();
	const at = lower.lastIndexOf("@");
	if (at < 0) return lower;
	const local = lower.slice(0, at);
	const plus = local.indexOf("+");
	return `${plus >= 0 ? local.slice(0, plus) : local}${lower.slice(at)}`;
}

interface FactsRow extends Row {
	seq: number;
	thread_id: string;
	origin: string;
	from_addr: string | null;
	to_json: string;
	cc_json: string;
	auth_json: string | null;
}

/** True when the receiving server recorded a DMARC pass for the message. */
function dmarcPassed(authJson: string | null): boolean {
	if (!authJson) return false;
	try {
		return senderVerification(JSON.parse(authJson) as AuthenticationResults | null) === "verified";
	} catch {
		return false;
	}
}

/** Stored facts, as the rules use them. Facts from before `authenticated` are not authenticated. */
export function readFacts(json: string): MailFacts {
	const facts = JSON.parse(json) as MailFacts;
	return { ...facts, authenticated: facts.authenticated === true };
}

/** The facts of one message, from the mailbox: never from the content. */
export function messageFacts(sql: SqlStorage, seq: number, ownerAddress: string): MailFacts | null {
	const row = one<FactsRow>(
		sql,
		"SELECT seq, thread_id, origin, from_addr, to_json, cc_json, auth_json FROM messages WHERE seq = ?",
		seq,
	);
	if (!row) return null;
	const owner = baseAddress(ownerAddress);
	const to = (JSON.parse(row.to_json) as { address: string }[]).map((a) => baseAddress(a.address));
	const cc = (JSON.parse(row.cc_json) as { address: string }[]).map((a) => baseAddress(a.address));
	const sender = row.from_addr?.toLowerCase() ?? null;
	const domain = domainOfAddress(sender);
	const knownSender =
		sender !== null && one(sql, "SELECT 1 AS found FROM recipients WHERE address_key = ?", sender) !== null;
	const knownDomain =
		domain !== null &&
		!FREE_MAIL_DOMAINS.has(domain) &&
		one(
			sql,
			"SELECT 1 AS found FROM recipients WHERE address_key LIKE ? ESCAPE '\\' LIMIT 1",
			`%@${domain.replace(/[\\%_]/g, (c) => `\\${c}`)}`,
		) !== null;
	const thread = one<{ sent: number; earlier: number }>(
		sql,
		`SELECT
			(SELECT COUNT(*) FROM messages WHERE thread_id = ? AND origin = 'sent') AS sent,
			(SELECT COUNT(*) FROM messages WHERE thread_id = ? AND seq < ?) AS earlier`,
		row.thread_id,
		row.thread_id,
		seq,
	);
	return {
		origin: row.origin === "internal" ? "internal" : "external",
		ownerPosition: to.includes(owner) ? "to" : cc.includes(owner) ? "cc" : "none",
		recipientCount: to.length + cc.length,
		knownSender,
		knownDomain,
		threadHasSent: (thread?.sent ?? 0) > 0,
		threadMessages: thread?.earlier ?? 0,
		ownerAddress,
		authenticated: row.origin === "internal" || dmarcPassed(row.auth_json),
	};
}

interface CorrectionRow extends Row {
	sender: string;
	sender_domain: string;
	label_key: string;
	action: string;
	subject: string;
	created_at: number;
}

function toCorrection(row: CorrectionRow): Correction {
	return {
		sender: row.sender,
		senderDomain: row.sender_domain,
		labelKey: row.label_key,
		action: row.action === "add" ? "add" : "remove",
		subject: row.subject,
		createdAt: row.created_at,
	};
}

/** The corrections for mail from this sender or its domain, newest first. They feed the sender rules. */
export function correctionsOfSender(sql: SqlStorage, sender: string | null): Correction[] {
	if (!sender) return [];
	const address = sender.toLowerCase();
	const domain = domainOfAddress(address) ?? "";
	return all<CorrectionRow>(
		sql,
		`SELECT sender, sender_domain, label_key, action, subject, created_at FROM label_corrections
		WHERE sender = ? OR sender_domain = ? ORDER BY created_at DESC, id DESC LIMIT 200`,
		address,
		domain,
	).map(toCorrection);
}

/**
 * Examples for the prompt: the corrections of the same sender first, then of the same domain. Corrections
 * of other senders stay out, so the subject of one sender never goes in the prompt for mail of a different
 * sender. A free-mail domain is not a relation between senders, so only the address counts there.
 */
export function exampleCorrections(sql: SqlStorage, sender: string | null, limit: number): Correction[] {
	if (!sender) return [];
	const address = sender.toLowerCase();
	const own = domainOfAddress(address);
	const domain = own && !FREE_MAIL_DOMAINS.has(own) ? own : "";
	return all<CorrectionRow>(
		sql,
		`SELECT sender, sender_domain, label_key, action, subject, created_at FROM label_corrections
		WHERE sender = ? OR (? != '' AND sender_domain = ?)
		ORDER BY CASE WHEN sender = ? THEN 0 ELSE 1 END, created_at DESC, id DESC LIMIT ?`,
		address,
		domain,
		domain,
		address,
		limit,
	).map(toCorrection);
}

/** Records one correction and keeps the newest `MAX_CORRECTIONS`. */
export function recordCorrection(
	sql: SqlStorage,
	correction: { sender: string; labelKey: string; action: "add" | "remove"; subject: string; now: number },
): void {
	const sender = correction.sender.toLowerCase();
	sql.exec(
		"INSERT INTO label_corrections (sender, sender_domain, label_key, action, subject, created_at) VALUES (?, ?, ?, ?, ?, ?)",
		sender,
		domainOfAddress(sender) ?? "",
		correction.labelKey,
		correction.action,
		correction.subject
			.replace(/[\p{Cc}\s]+/gu, " ")
			.trim()
			.slice(0, 120),
		correction.now,
	);
	sql.exec(
		"DELETE FROM label_corrections WHERE id NOT IN (SELECT id FROM label_corrections ORDER BY id DESC LIMIT ?)",
		MAX_CORRECTIONS,
	);
}
