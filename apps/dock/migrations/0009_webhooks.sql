-- Webhooks of the mail module. A webhook sends a signed POST to a URL outside Soldock when new mail
-- arrives in the inbox of a mailbox. The POST holds no mail content.
-- The table is new, so the Worker from before this migration does not read it. The deploy applies
-- the migrations before the new Worker starts, so the old Worker runs on the new schema for a short
-- time. A full key that it creates in that time does not get mail.webhooks (see the last statement).
-- The statement markers let a fresh reset replay this file without a SQL parser.

CREATE TABLE IF NOT EXISTS webhooks (
	id TEXT PRIMARY KEY,
	-- The mailbox that the webhook watches: the id of a principal or of a team mailbox.
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
	-- Set while a failed POST of the event retry_event_id waits for its next attempt. A different event
	-- in that time joins the retry, because a POST holds no content: one success tells the receiver to
	-- read the inbox.
	retry_until TEXT,
	retry_event_id TEXT,
	last_delivery_at TEXT,
	last_failure_at TEXT,
	-- A code that the Worker makes, such as http_500 or timeout. Never the response body.
	last_error TEXT,
	created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS webhooks_mailbox ON webhooks (mailbox_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS webhooks_creator ON webhooks (created_by);
--> statement-breakpoint
-- The new scope mail.webhooks is a human scope. A live key of a person that held each human scope
-- before it keeps each human scope, because some operations need a credential with each human scope,
-- and the setup key of the owner is the recovery credential. Such a key holds account.keys and
-- directory.write already, so this gives it no new power. A narrow key does not change.
UPDATE api_keys SET scopes = json_insert(scopes, '$[#]', 'mail.webhooks')
WHERE revoked_at IS NULL
AND EXISTS (SELECT 1 FROM principals p WHERE p.id = api_keys.principal_id AND p.kind = 'human')
AND NOT EXISTS (SELECT 1 FROM json_each(api_keys.scopes) WHERE value = 'mail.webhooks')
AND (SELECT COUNT(DISTINCT value) FROM json_each(api_keys.scopes) WHERE value IN ('account.read', 'account.keys',
	'directory.read', 'directory.write', 'mail.read', 'mail.modify', 'mail.send', 'drive.read', 'drive.write',
	'drive.share', 'chat.read', 'chat.write')) = 12;
