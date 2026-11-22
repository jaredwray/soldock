import { API_KEY_LIMITS } from "@asterra/contracts";
import { log } from "../platform/index.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The most tokens that one run of the job gives a notice for. The next run continues. */
const NOTICES_PER_RUN = 50;

/** The most owners and admins that get one notice. */
const RECIPIENTS_MAX = 50;

/** A token of a service account that ends soon and has no notice yet. */
export interface DueNotice {
	keyId: string;
	label: string;
	expiresAt: string;
	accountId: string;
	accountName: string;
	accountAddress: string;
}

/** A person who gets the notice: an owner or an admin who is not archived. */
export interface NoticeRecipient {
	id: string;
	displayName: string;
	address: string;
}

/** The conditions of a due token, with `?1` now, `?2` the end of the notice days and `?3` those days. */
const DUE = `k.expires_at IS NOT NULL AND k.revoked_at IS NULL AND k.expiry_notice_at IS NULL
	AND k.expires_at > ?1 AND k.expires_at <= ?2
	AND julianday(k.expires_at) - julianday(k.created_at) > ?3
	AND p.service = 1 AND p.archived_at IS NULL AND p.deleted_at IS NULL`;

function dueParams(now: number): [string, string, number] {
	return [
		new Date(now).toISOString(),
		new Date(now + API_KEY_LIMITS.expiryNoticeDays * DAY_MS).toISOString(),
		API_KEY_LIMITS.expiryNoticeDays,
	];
}

/**
 * The live tokens of live service accounts that end within `API_KEY_LIMITS.expiryNoticeDays` days of
 * `now` and have no notice yet, the soonest first. A token whose whole lifetime was not longer than that
 * gets no notice: its creator knew its end.
 */
export async function dueExpiryNotices(db: D1Database, now: number): Promise<DueNotice[]> {
	const { results } = await db
		.prepare(
			`SELECT k.id AS keyId, k.label, k.expires_at AS expiresAt, p.id AS accountId, p.display_name AS accountName,
				a.address AS accountAddress
			FROM api_keys k
			JOIN principals p ON p.id = k.principal_id
			JOIN addresses a ON a.principal_id = p.id AND a.is_primary = 1
			WHERE ${DUE}
			ORDER BY k.expires_at LIMIT ?4`,
		)
		.bind(...dueParams(now), NOTICES_PER_RUN)
		.all<DueNotice>();
	return results;
}

/**
 * True when the token still needs its notice: an owner or an admin did not revoke it, and did not archive
 * its account, after the job read the due tokens. The job asks just before the mails of a token.
 */
export async function isNoticeDue(db: D1Database, keyId: string, now: number): Promise<boolean> {
	const row = await db
		.prepare(`SELECT 1 AS due FROM api_keys k JOIN principals p ON p.id = k.principal_id WHERE k.id = ?4 AND ${DUE}`)
		.bind(...dueParams(now), keyId)
		.first<{ due: number }>();
	return row !== null;
}

/**
 * The people who get a notice: each owner and admin who is not archived or deleted. The sponsor of the
 * account gets none when the sponsor is a member, because a member has no right to see its tokens.
 */
export async function noticeRecipients(db: D1Database): Promise<NoticeRecipient[]> {
	const { results } = await db
		.prepare(
			`SELECT p.id, p.display_name AS displayName, a.address
			FROM principals p JOIN addresses a ON a.principal_id = p.id AND a.is_primary = 1
			WHERE p.kind = 'human' AND p.org_role IN ('owner', 'admin') AND p.archived_at IS NULL AND p.deleted_at IS NULL
			ORDER BY p.id LIMIT ?`,
		)
		.bind(RECIPIENTS_MAX)
		.all<NoticeRecipient>();
	return results;
}

/** Records the notice of a token. Returns false when a different run recorded it first. */
export async function markExpiryNotice(db: D1Database, keyId: string, now: number): Promise<boolean> {
	const result = await db
		.prepare("UPDATE api_keys SET expiry_notice_at = ? WHERE id = ? AND expiry_notice_at IS NULL")
		.bind(new Date(now).toISOString(), keyId)
		.run();
	return result.meta.changes === 1;
}

/** Adds the entry of a notice to the activity log of the account, with the surface `system`. */
export async function recordExpiryNotice(env: Env, notice: DueNotice, now: number): Promise<void> {
	try {
		await env.PRINCIPAL.get(env.PRINCIPAL.idFromName(notice.accountId)).recordServiceActivity({
			at: now,
			op: "account.token_expiry_notice",
			result: "ok",
			code: null,
			surface: "system",
			keyId: notice.keyId,
			actorId: notice.accountId,
			resourceId: null,
			requestId: null,
		});
	} catch (error) {
		log("warn", "service activity: the record of an expiry notice failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
