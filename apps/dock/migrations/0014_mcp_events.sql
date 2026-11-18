-- MCP Events: a subscription that an MCP client creates with events/subscribe.
-- Such a subscription is one endpoint and one subscription. The client gives the URL and the secret.
-- The previous Worker does not read these columns. It sends a `webhook` row as before.
-- The statement markers let a fresh reset replay this file without a SQL parser.

-- `mcp_events`: the POST has the body and the headers of MCP Events. The webhook operations do not show the row.
ALTER TABLE webhook_endpoints ADD COLUMN protocol TEXT NOT NULL DEFAULT 'webhook'
	CHECK (protocol IN ('webhook', 'mcp_events'));
--> statement-breakpoint
-- The secret that a refresh replaced. Each POST has the two signatures until `previous_secret_until`.
ALTER TABLE webhook_endpoints ADD COLUMN previous_secret TEXT;
--> statement-breakpoint
ALTER TABLE webhook_endpoints ADD COLUMN previous_secret_until TEXT;
--> statement-breakpoint
-- The time of the last callback verification that the receiver passed.
ALTER TABLE webhook_endpoints ADD COLUMN verified_at TEXT;
--> statement-breakpoint
-- Null: the subscription does not expire. After this time, the subscription sends nothing.
ALTER TABLE webhook_subscriptions ADD COLUMN expires_at TEXT;
--> statement-breakpoint
-- Chat only. Null: each room of the target sends the event. Else only this room sends it.
ALTER TABLE webhook_subscriptions ADD COLUMN room_id TEXT;
