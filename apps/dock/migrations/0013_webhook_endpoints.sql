-- Webhook endpoints and the subscriptions that choose their events.
-- An old webhook row becomes one endpoint and one subscription. The subscription keeps the old id.
-- The old tables stay, so the previous Worker can still write them. A later change drops them.
-- The statement markers let a fresh reset replay this file without a SQL parser.

CREATE TABLE IF NOT EXISTS webhook_endpoints (
	id TEXT PRIMARY KEY,
	created_by TEXT NOT NULL REFERENCES principals (id),
	credential_kind TEXT NOT NULL CHECK (credential_kind IN ('session', 'api_key', 'oauth')),
	credential_id TEXT,
	url TEXT NOT NULL,
	label TEXT NOT NULL,
	secret TEXT NOT NULL,
	auth_key TEXT,
	header_name TEXT,
	header_value TEXT,
	status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
	disabled_reason TEXT CHECK (disabled_reason IN ('failures', 'gone', 'credential_revoked', 'policy_denied')),
	consecutive_failures INTEGER NOT NULL DEFAULT 0,
	last_failed_delivery_id TEXT,
	last_delivery_at TEXT,
	last_failure_at TEXT,
	last_error TEXT,
	created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS webhook_endpoints_creator ON webhook_endpoints (created_by);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
	sequence INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints (id) ON DELETE CASCADE,
	domain TEXT NOT NULL CHECK (domain IN ('mail', 'chat', 'drive')),
	event_type TEXT NOT NULL,
	target_id TEXT NOT NULL,
	credential_kind TEXT NOT NULL CHECK (credential_kind IN ('session', 'api_key', 'oauth')),
	credential_id TEXT,
	status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
	disabled_reason TEXT CHECK (disabled_reason IN ('access_lost', 'credential_revoked')),
	retry_until TEXT,
	retry_event_id TEXT,
	created_at TEXT NOT NULL,
	UNIQUE (endpoint_id, event_type, target_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS webhook_subscriptions_target ON webhook_subscriptions (event_type, target_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS webhook_subscriptions_domain ON webhook_subscriptions (domain, target_id, status);
--> statement-breakpoint
ALTER TABLE webhooks ADD COLUMN migrated INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE chat_webhooks ADD COLUMN migrated INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS webhooks_unmigrated ON webhooks (id) WHERE migrated = 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS chat_webhooks_unmigrated ON chat_webhooks (id) WHERE migrated = 0;
--> statement-breakpoint
INSERT OR IGNORE INTO webhook_endpoints (
	id, created_by, credential_kind, credential_id, url, label, secret, auth_key, header_name, header_value,
	status, disabled_reason, consecutive_failures, last_failed_delivery_id, last_delivery_at, last_failure_at,
	last_error, created_at
)
SELECT 'whe_' || substr(id, 5), created_by, credential_kind, credential_id, url, label, secret,
	auth_key, header_name, header_value,
	CASE WHEN disabled_reason = 'access_lost' THEN 'active' ELSE status END,
	CASE WHEN disabled_reason = 'access_lost' THEN NULL ELSE disabled_reason END,
	consecutive_failures,
	CASE WHEN last_failed_event_id IS NULL THEN NULL ELSE last_failed_event_id || '_' || id END,
	last_delivery_at, last_failure_at, last_error, created_at
FROM chat_webhooks WHERE migrated = 0;
--> statement-breakpoint
INSERT OR IGNORE INTO webhook_endpoints (
	id, created_by, credential_kind, credential_id, url, label, secret, auth_key, header_name, header_value,
	status, disabled_reason, consecutive_failures, last_failed_delivery_id, last_delivery_at, last_failure_at,
	last_error, created_at
)
SELECT 'whe_' || substr(id, 5), created_by, credential_kind, credential_id, url, label, secret,
	auth_key, header_name, header_value,
	CASE WHEN disabled_reason = 'access_lost' THEN 'active' ELSE status END,
	CASE WHEN disabled_reason = 'access_lost' THEN NULL ELSE disabled_reason END,
	consecutive_failures,
	CASE WHEN last_failed_event_id IS NULL THEN NULL ELSE last_failed_event_id || '_' || id END,
	last_delivery_at, last_failure_at, last_error, created_at
FROM webhooks WHERE migrated = 0;
--> statement-breakpoint
INSERT OR IGNORE INTO webhook_subscriptions (
	sequence, id, endpoint_id, domain, event_type, target_id, credential_kind, credential_id, status,
	disabled_reason, retry_until, retry_event_id, created_at
)
SELECT sequence, id, 'whe_' || substr(id, 5), 'chat', 'chat.message.created', mailbox_id, credential_kind,
	credential_id,
	CASE WHEN disabled_reason = 'access_lost' THEN 'disabled' ELSE 'active' END,
	CASE WHEN disabled_reason = 'access_lost' THEN 'access_lost' END,
	retry_until, retry_event_id, created_at
FROM chat_webhooks WHERE migrated = 0 ORDER BY sequence;
--> statement-breakpoint
INSERT OR IGNORE INTO webhook_subscriptions (
	id, endpoint_id, domain, event_type, target_id, credential_kind, credential_id, status, disabled_reason,
	retry_until, retry_event_id, created_at
)
SELECT id, 'whe_' || substr(id, 5), 'mail', 'mail.inbox.updated', mailbox_id, credential_kind, credential_id,
	CASE WHEN disabled_reason = 'access_lost' THEN 'disabled' ELSE 'active' END,
	CASE WHEN disabled_reason = 'access_lost' THEN 'access_lost' END,
	retry_until, retry_event_id, created_at
FROM webhooks WHERE migrated = 0 ORDER BY created_at, id;
--> statement-breakpoint
UPDATE chat_webhooks SET migrated = 1 WHERE migrated = 0;
--> statement-breakpoint
UPDATE webhooks SET migrated = 1 WHERE migrated = 0;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS webhooks_mirror_update AFTER UPDATE ON webhooks
WHEN OLD.migrated = 1 AND NEW.migrated = 1 BEGIN
	UPDATE webhook_endpoints SET label = NEW.label, auth_key = NEW.auth_key, header_name = NEW.header_name,
		header_value = NEW.header_value, consecutive_failures = NEW.consecutive_failures,
		last_failed_delivery_id = CASE WHEN NEW.last_failed_event_id IS NULL THEN NULL
			ELSE NEW.last_failed_event_id || '_' || NEW.id END,
		last_delivery_at = NEW.last_delivery_at, last_failure_at = NEW.last_failure_at, last_error = NEW.last_error,
		status = CASE WHEN NEW.disabled_reason = 'access_lost' THEN status ELSE NEW.status END,
		disabled_reason = CASE WHEN NEW.disabled_reason = 'access_lost' THEN disabled_reason ELSE NEW.disabled_reason END
	WHERE id = 'whe_' || substr(NEW.id, 5);
	UPDATE webhook_subscriptions SET retry_until = NEW.retry_until, retry_event_id = NEW.retry_event_id,
		status = CASE WHEN NEW.disabled_reason = 'access_lost' THEN 'disabled' ELSE status END,
		disabled_reason = CASE WHEN NEW.disabled_reason = 'access_lost' THEN 'access_lost' ELSE disabled_reason END
	WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS chat_webhooks_mirror_update AFTER UPDATE ON chat_webhooks
WHEN OLD.migrated = 1 AND NEW.migrated = 1 BEGIN
	UPDATE webhook_endpoints SET label = NEW.label, auth_key = NEW.auth_key, header_name = NEW.header_name,
		header_value = NEW.header_value, consecutive_failures = NEW.consecutive_failures,
		last_failed_delivery_id = CASE WHEN NEW.last_failed_event_id IS NULL THEN NULL
			ELSE NEW.last_failed_event_id || '_' || NEW.id END,
		last_delivery_at = NEW.last_delivery_at, last_failure_at = NEW.last_failure_at, last_error = NEW.last_error,
		status = CASE WHEN NEW.disabled_reason = 'access_lost' THEN status ELSE NEW.status END,
		disabled_reason = CASE WHEN NEW.disabled_reason = 'access_lost' THEN disabled_reason ELSE NEW.disabled_reason END
	WHERE id = 'whe_' || substr(NEW.id, 5);
	UPDATE webhook_subscriptions SET retry_until = NEW.retry_until, retry_event_id = NEW.retry_event_id,
		status = CASE WHEN NEW.disabled_reason = 'access_lost' THEN 'disabled' ELSE status END,
		disabled_reason = CASE WHEN NEW.disabled_reason = 'access_lost' THEN 'access_lost' ELSE disabled_reason END
	WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS webhooks_mirror_delete AFTER DELETE ON webhooks BEGIN
	DELETE FROM webhook_subscriptions WHERE id = OLD.id;
	DELETE FROM webhook_endpoints WHERE id = 'whe_' || substr(OLD.id, 5) AND changes() = 1
		AND NOT EXISTS (SELECT 1 FROM webhook_subscriptions WHERE endpoint_id = 'whe_' || substr(OLD.id, 5));
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS chat_webhooks_mirror_delete AFTER DELETE ON chat_webhooks BEGIN
	DELETE FROM webhook_subscriptions WHERE id = OLD.id;
	DELETE FROM webhook_endpoints WHERE id = 'whe_' || substr(OLD.id, 5) AND changes() = 1
		AND NOT EXISTS (SELECT 1 FROM webhook_subscriptions WHERE endpoint_id = 'whe_' || substr(OLD.id, 5));
END;
--> statement-breakpoint
UPDATE api_keys SET scopes = json_insert(scopes, '$[#]', 'drive.webhooks')
WHERE revoked_at IS NULL
AND EXISTS (SELECT 1 FROM principals p WHERE p.id = api_keys.principal_id AND p.kind = 'human')
AND NOT EXISTS (SELECT 1 FROM json_each(api_keys.scopes) WHERE value = 'drive.webhooks')
AND (SELECT COUNT(DISTINCT value) FROM json_each(api_keys.scopes) WHERE value IN ('account.read', 'account.keys',
	'directory.read', 'directory.write', 'mail.read', 'mail.modify', 'mail.send', 'mail.webhooks', 'drive.read',
	'drive.write', 'drive.share', 'chat.read', 'chat.write', 'chat.webhooks')) = 14;
