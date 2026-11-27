-- Calendar sends its changes through MCP Events (and later through webhooks). A subscription of Calendar has
-- the domain `calendar`. The CHECK of `webhook_subscriptions.domain` from 0013 allows only mail, chat and drive,
-- and SQLite cannot change a CHECK, so this migration builds the table again with the same columns, rows,
-- sequences, indexes and triggers.
-- - The mirror triggers of 0013 name `webhook_subscriptions`. A rename fails while a trigger names a missing
--   table, so the triggers go first and come back, unchanged, after the rename.
-- - The rows keep their `sequence`. A new row gets a sequence above the largest row that exists. A sequence of a
--   deleted row above that largest row can come again; a chat or drive boundary from before the migration then
--   can include a new subscription. An MCP Events delivery still skips an event from before its subscription.
-- - An agent that holds calendar.read and mail.webhooks gets calendar.webhooks, as 0038 did for calendar.read.
--   A narrow agent stays narrow. A second run of that statement changes nothing.
-- The previous Worker reads and writes the same columns, so it can run while the deploy applies this migration.
-- The statement markers let a fresh reset replay this file without a SQL parser.
DROP TRIGGER IF EXISTS webhooks_mirror_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS chat_webhooks_mirror_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS webhooks_mirror_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS chat_webhooks_mirror_delete;
--> statement-breakpoint
CREATE TABLE webhook_subscriptions_next (
	sequence INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints (id) ON DELETE CASCADE,
	domain TEXT NOT NULL CHECK (domain IN ('mail', 'chat', 'drive', 'calendar')),
	event_type TEXT NOT NULL,
	target_id TEXT NOT NULL,
	credential_kind TEXT NOT NULL CHECK (credential_kind IN ('session', 'api_key', 'oauth')),
	credential_id TEXT,
	status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
	disabled_reason TEXT CHECK (disabled_reason IN ('access_lost', 'credential_revoked')),
	retry_until TEXT,
	retry_event_id TEXT,
	created_at TEXT NOT NULL,
	expires_at TEXT,
	room_id TEXT,
	chat_filter TEXT NOT NULL DEFAULT 'all' CHECK (chat_filter IN ('all', 'addressed')),
	chat_filter_explicit INTEGER NOT NULL DEFAULT 0 CHECK (chat_filter_explicit IN (0, 1)),
	UNIQUE (endpoint_id, event_type, target_id)
);
--> statement-breakpoint
INSERT INTO webhook_subscriptions_next (
	sequence, id, endpoint_id, domain, event_type, target_id, credential_kind, credential_id, status, disabled_reason,
	retry_until, retry_event_id, created_at, expires_at, room_id, chat_filter, chat_filter_explicit
)
SELECT sequence, id, endpoint_id, domain, event_type, target_id, credential_kind, credential_id, status, disabled_reason,
	retry_until, retry_event_id, created_at, expires_at, room_id, chat_filter, chat_filter_explicit
FROM webhook_subscriptions ORDER BY sequence;
--> statement-breakpoint
DROP TABLE webhook_subscriptions;
--> statement-breakpoint
ALTER TABLE webhook_subscriptions_next RENAME TO webhook_subscriptions;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS webhook_subscriptions_target ON webhook_subscriptions (event_type, target_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS webhook_subscriptions_domain ON webhook_subscriptions (domain, target_id, status);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS webhooks_mirror_update AFTER UPDATE ON webhooks
WHEN OLD.migrated = 1 AND NEW.migrated = 1 BEGIN
	UPDATE webhook_endpoints SET
		label = CASE WHEN NEW.label IS NOT OLD.label THEN NEW.label ELSE label END,
		auth_key = CASE WHEN NEW.auth_key IS NOT OLD.auth_key THEN NEW.auth_key ELSE auth_key END,
		header_name = CASE WHEN NEW.header_name IS NOT OLD.header_name THEN NEW.header_name ELSE header_name END,
		header_value = CASE WHEN NEW.header_value IS NOT OLD.header_value THEN NEW.header_value ELSE header_value END,
		consecutive_failures = CASE WHEN NEW.consecutive_failures IS NOT OLD.consecutive_failures
			THEN NEW.consecutive_failures ELSE consecutive_failures END,
		last_failed_delivery_id = CASE WHEN NEW.last_failed_event_id IS OLD.last_failed_event_id THEN last_failed_delivery_id
			WHEN NEW.last_failed_event_id IS NULL THEN NULL
			ELSE NEW.last_failed_event_id || '_' || NEW.id END,
		last_delivery_at = CASE WHEN NEW.last_delivery_at IS NOT OLD.last_delivery_at THEN NEW.last_delivery_at ELSE last_delivery_at END,
		last_failure_at = CASE WHEN NEW.last_failure_at IS NOT OLD.last_failure_at THEN NEW.last_failure_at ELSE last_failure_at END,
		last_error = CASE WHEN NEW.last_error IS NOT OLD.last_error THEN NEW.last_error ELSE last_error END,
		status = CASE WHEN status = 'disabled' THEN status
			WHEN NEW.disabled_reason = 'access_lost' THEN status
			WHEN NEW.status IS NOT OLD.status THEN NEW.status ELSE status END,
		disabled_reason = CASE WHEN status = 'disabled' THEN disabled_reason
			WHEN NEW.disabled_reason = 'access_lost' THEN disabled_reason
			WHEN NEW.disabled_reason IS NOT OLD.disabled_reason THEN NEW.disabled_reason ELSE disabled_reason END
	WHERE id = 'whe_' || substr(NEW.id, 5);
	UPDATE webhook_subscriptions SET
		retry_until = CASE WHEN NEW.retry_until IS NOT OLD.retry_until THEN NEW.retry_until ELSE retry_until END,
		retry_event_id = CASE WHEN NEW.retry_event_id IS NOT OLD.retry_event_id THEN NEW.retry_event_id ELSE retry_event_id END,
		status = CASE WHEN status = 'disabled' THEN status
			WHEN NEW.disabled_reason = 'access_lost' THEN 'disabled' ELSE status END,
		disabled_reason = CASE WHEN status = 'disabled' THEN disabled_reason
			WHEN NEW.disabled_reason = 'access_lost' THEN 'access_lost' ELSE disabled_reason END
	WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS chat_webhooks_mirror_update AFTER UPDATE ON chat_webhooks
WHEN OLD.migrated = 1 AND NEW.migrated = 1 BEGIN
	UPDATE webhook_endpoints SET
		label = CASE WHEN NEW.label IS NOT OLD.label THEN NEW.label ELSE label END,
		auth_key = CASE WHEN NEW.auth_key IS NOT OLD.auth_key THEN NEW.auth_key ELSE auth_key END,
		header_name = CASE WHEN NEW.header_name IS NOT OLD.header_name THEN NEW.header_name ELSE header_name END,
		header_value = CASE WHEN NEW.header_value IS NOT OLD.header_value THEN NEW.header_value ELSE header_value END,
		consecutive_failures = CASE WHEN NEW.consecutive_failures IS NOT OLD.consecutive_failures
			THEN NEW.consecutive_failures ELSE consecutive_failures END,
		last_failed_delivery_id = CASE WHEN NEW.last_failed_event_id IS OLD.last_failed_event_id THEN last_failed_delivery_id
			WHEN NEW.last_failed_event_id IS NULL THEN NULL
			ELSE NEW.last_failed_event_id || '_' || NEW.id END,
		last_delivery_at = CASE WHEN NEW.last_delivery_at IS NOT OLD.last_delivery_at THEN NEW.last_delivery_at ELSE last_delivery_at END,
		last_failure_at = CASE WHEN NEW.last_failure_at IS NOT OLD.last_failure_at THEN NEW.last_failure_at ELSE last_failure_at END,
		last_error = CASE WHEN NEW.last_error IS NOT OLD.last_error THEN NEW.last_error ELSE last_error END,
		status = CASE WHEN status = 'disabled' THEN status
			WHEN NEW.disabled_reason = 'access_lost' THEN status
			WHEN NEW.status IS NOT OLD.status THEN NEW.status ELSE status END,
		disabled_reason = CASE WHEN status = 'disabled' THEN disabled_reason
			WHEN NEW.disabled_reason = 'access_lost' THEN disabled_reason
			WHEN NEW.disabled_reason IS NOT OLD.disabled_reason THEN NEW.disabled_reason ELSE disabled_reason END
	WHERE id = 'whe_' || substr(NEW.id, 5);
	UPDATE webhook_subscriptions SET
		retry_until = CASE WHEN NEW.retry_until IS NOT OLD.retry_until THEN NEW.retry_until ELSE retry_until END,
		retry_event_id = CASE WHEN NEW.retry_event_id IS NOT OLD.retry_event_id THEN NEW.retry_event_id ELSE retry_event_id END,
		status = CASE WHEN status = 'disabled' THEN status
			WHEN NEW.disabled_reason = 'access_lost' THEN 'disabled' ELSE status END,
		disabled_reason = CASE WHEN status = 'disabled' THEN disabled_reason
			WHEN NEW.disabled_reason = 'access_lost' THEN 'access_lost' ELSE disabled_reason END
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
UPDATE principals SET agent_scopes = json_insert(agent_scopes, '$[#]', 'calendar.webhooks')
WHERE kind = 'agent'
	AND json_valid(agent_scopes) AND json_type(agent_scopes) = 'array'
	AND EXISTS (SELECT 1 FROM json_each(principals.agent_scopes) WHERE value = 'calendar.read')
	AND EXISTS (SELECT 1 FROM json_each(principals.agent_scopes) WHERE value = 'mail.webhooks')
	AND NOT EXISTS (SELECT 1 FROM json_each(principals.agent_scopes) WHERE value = 'calendar.webhooks');
