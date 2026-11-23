-- AI through Cloudflare AI Gateway. One row of settings for the organization. The API token is a Worker
-- secret (AI_GATEWAY_TOKEN). It is never in the directory.
CREATE TABLE ai_settings (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	enabled INTEGER NOT NULL DEFAULT 0,
	account_id TEXT,
	gateway_id TEXT,
	-- A JSON array of Workers AI model ids.
	allowed_models TEXT NOT NULL DEFAULT '[]',
	monthly_budget_micro_usd INTEGER NOT NULL DEFAULT 10000000,
	auto_label_enabled INTEGER NOT NULL DEFAULT 0,
	auto_label_model TEXT,
	updated_at INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
INSERT INTO ai_settings (id) VALUES (1);
--> statement-breakpoint
-- The usage ledger: one row for each UTC day, feature, model and resource. The resource is a mailbox id,
-- or the id of the person who tested the connection. The cost is an estimate in millionths of a USD.
CREATE TABLE ai_usage (
	day TEXT NOT NULL,
	feature TEXT NOT NULL,
	model TEXT NOT NULL,
	resource_id TEXT NOT NULL,
	requests INTEGER NOT NULL DEFAULT 0,
	failures INTEGER NOT NULL DEFAULT 0,
	input_tokens INTEGER NOT NULL DEFAULT 0,
	output_tokens INTEGER NOT NULL DEFAULT 0,
	cost_micro_usd INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (day, feature, model, resource_id)
) WITHOUT ROWID;
