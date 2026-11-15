CREATE TABLE IF NOT EXISTS chat_webhooks (
	id TEXT PRIMARY KEY,
	-- The principal whose joined chats the webhook watches. The shared store uses the column name mailbox_id.
	mailbox_id TEXT NOT NULL,
	-- The principal that created the webhook. Before each POST, the Worker checks its access again.
	created_by TEXT NOT NULL REFERENCES principals (id),
	-- The credential of the create. The webhook stops when the API key or the OAuth grant stops. A session
	-- has no id: the webhook then stops only with its creator.
	credential_kind TEXT NOT NULL CHECK (credential_kind IN ('session', 'api_key', 'oauth')),
	credential_id TEXT,
	url TEXT NOT NULL,
	label TEXT NOT NULL,
	-- The signing secret (whsec_ and base64). The HMAC needs it in clear text, as TOTP needs its secret.
	secret TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
	disabled_reason TEXT,
	-- The events in a row whose last attempt failed. An event counts one time, also when its jobs repeat.
	consecutive_failures INTEGER NOT NULL DEFAULT 0,
	last_failed_event_id TEXT,
	-- Shared delivery status. Chat events keep independent retries; no event joins another retry.
	retry_until TEXT,
	retry_event_id TEXT,
	last_delivery_at TEXT,
	last_failure_at TEXT,
	-- A code that the Worker makes, such as http_500 or timeout. Never the response body.
	last_error TEXT,
	auth_key TEXT,
	header_name TEXT,
	header_value TEXT,
	created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS chat_webhooks_mailbox ON chat_webhooks (mailbox_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS chat_webhooks_creator ON chat_webhooks (created_by);
--> statement-breakpoint
-- Full human recovery keys retain all human scopes. Narrow keys and OAuth grants keep their scopes.
UPDATE api_keys SET scopes = json_insert(scopes, '$[#]', 'chat.webhooks')
WHERE revoked_at IS NULL
AND EXISTS (SELECT 1 FROM principals p WHERE p.id = api_keys.principal_id AND p.kind = 'human')
AND NOT EXISTS (SELECT 1 FROM json_each(api_keys.scopes) WHERE value = 'chat.webhooks')
AND (SELECT COUNT(DISTINCT value) FROM json_each(api_keys.scopes) WHERE value IN ('account.read', 'account.keys',
	'directory.read', 'directory.write', 'mail.read', 'mail.modify', 'mail.send', 'mail.webhooks', 'drive.read', 'drive.write',
	'drive.share', 'chat.read', 'chat.write')) = 13;
