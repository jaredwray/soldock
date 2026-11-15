-- The auth key and the custom header of a webhook. Each POST sends the key as Authorization: Bearer,
-- and the header as it is. No result shows the key or the header value after the call that sets it.
-- The columns are nullable, so the Worker from before this migration still reads and writes the table.
-- They are in clear text, as the signing secret is, because each POST needs them.
-- The statement markers let a fresh reset replay this file without a SQL parser.

ALTER TABLE webhooks ADD COLUMN auth_key TEXT;
--> statement-breakpoint
ALTER TABLE webhooks ADD COLUMN header_name TEXT;
--> statement-breakpoint
ALTER TABLE webhooks ADD COLUMN header_value TEXT;
