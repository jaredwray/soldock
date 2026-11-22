-- Chat subscriptions: 1 when the creator set the filter, 0 when the subscription has the default filter.
-- A refresh of MCP Events without `filter` keeps a filter that the creator set. It gives a default filter
-- the default of the caller. So a subscription of an agent from before 0016 gets `addressed` at its next refresh.
-- A row from before this column gets 0, so its filter can change at a refresh. A row with `addressed` gets 1:
-- the default of a person is `all`, so a person set `addressed`, and an agent keeps its default.
-- The previous Worker does not read this column. A row that it inserts gets 0.
-- The statement markers let a fresh reset replay this file without a SQL parser.

ALTER TABLE webhook_subscriptions ADD COLUMN chat_filter_explicit INTEGER NOT NULL DEFAULT 0
	CHECK (chat_filter_explicit IN (0, 1));
--> statement-breakpoint
UPDATE webhook_subscriptions SET chat_filter_explicit = 1 WHERE chat_filter = 'addressed';
