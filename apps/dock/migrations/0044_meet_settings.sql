-- The Cloudflare Realtime values of Meet. One row. An owner or an admin changes it in Admin › Meet. Each pair (the SFU
-- app, the TURN key) applies only when both of its values are set. A pair that is not set here comes from the Worker
-- secrets (REALTIME_APP_ID and REALTIME_APP_SECRET, REALTIME_TURN_KEY_ID and REALTIME_TURN_KEY_TOKEN).
CREATE TABLE meet_settings (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	-- The App ID of the Realtime SFU app.
	app_id TEXT,
	-- The App Secret of the SFU app. Sealed with ENCRYPTION_KEY when it is set. No answer, log or audit line
	-- contains it.
	app_secret TEXT,
	-- The Key ID of the Realtime TURN key.
	turn_key_id TEXT,
	-- The API token of the TURN key. Sealed as app_secret.
	turn_key_token TEXT,
	updated_at INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
INSERT INTO meet_settings (id) VALUES (1);
