// Copies webhook rows that the previous Worker inserts after migration 0013.
// The migration itself copies the rows that already exist, and it keeps their chat sequence.

const COUNT =
	"SELECT (SELECT COUNT(*) FROM webhooks WHERE migrated = 0) + (SELECT COUNT(*) FROM chat_webhooks WHERE migrated = 0) AS n";

const ENDPOINT_INSERT = `INSERT OR IGNORE INTO webhook_endpoints (
	id, created_by, credential_kind, credential_id, url, label, secret, auth_key, header_name, header_value,
	status, disabled_reason, consecutive_failures, last_failed_delivery_id, last_delivery_at, last_failure_at,
	last_error, created_at)
SELECT 'whe_' || substr(id, 5), created_by, credential_kind, credential_id, url, label, secret,
	auth_key, header_name, header_value,
	CASE WHEN disabled_reason = 'access_lost' THEN 'active' ELSE status END,
	CASE WHEN disabled_reason = 'access_lost' THEN NULL ELSE disabled_reason END,
	consecutive_failures,
	CASE WHEN last_failed_event_id IS NULL THEN NULL ELSE last_failed_event_id || '_' || id END,
	last_delivery_at, last_failure_at, last_error, created_at
FROM `;

const SUBSCRIPTION_INSERT = `INSERT OR IGNORE INTO webhook_subscriptions (
	id, endpoint_id, domain, event_type, target_id, credential_kind, credential_id, status, disabled_reason,
	retry_until, retry_event_id, created_at)
SELECT id, 'whe_' || substr(id, 5), ?, ?, mailbox_id, credential_kind, credential_id,
	CASE WHEN disabled_reason = 'access_lost' THEN 'disabled' ELSE 'active' END,
	CASE WHEN disabled_reason = 'access_lost' THEN 'access_lost' END,
	retry_until, retry_event_id, created_at
FROM `;

function adoptionStatements(db: D1Database): D1PreparedStatement[] {
	return [
		db.prepare(`${ENDPOINT_INSERT} chat_webhooks WHERE migrated = 0`),
		db.prepare(`${ENDPOINT_INSERT} webhooks WHERE migrated = 0`),
		db.prepare(`${SUBSCRIPTION_INSERT} chat_webhooks WHERE migrated = 0`).bind("chat", "chat.message.created"),
		db.prepare(`${SUBSCRIPTION_INSERT} webhooks WHERE migrated = 0`).bind("mail", "mail.inbox.updated"),
		db.prepare("UPDATE chat_webhooks SET migrated = 1 WHERE migrated = 0"),
		db.prepare("UPDATE webhooks SET migrated = 1 WHERE migrated = 0"),
	];
}

/** Copies legacy rows that are not migrated yet. A second call changes nothing. */
export async function adoptLegacyWebhooks(db: D1Database): Promise<void> {
	const pending = await db.prepare(COUNT).first<number>("n");
	if (!pending) return;
	await db.batch(adoptionStatements(db));
}

/**
 * Copies old rows and reads the chat boundary in one batch.
 * A row that commits after this batch gets a later sequence.
 */
export async function adoptChatBoundary(db: D1Database): Promise<number> {
	const results = await db.batch<{ boundary: number }>([
		...adoptionStatements(db),
		db.prepare("SELECT COALESCE(MAX(sequence), 0) AS boundary FROM webhook_subscriptions WHERE domain = 'chat'"),
	]);
	return results.at(-1)?.results[0]?.boundary ?? 0;
}

/** The number of legacy rows that are not copied yet. Fan-out reads this with its own query. */
export function unmigratedCount(db: D1Database): D1PreparedStatement {
	return db.prepare(COUNT);
}
