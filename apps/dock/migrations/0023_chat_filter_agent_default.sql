-- Chat subscriptions of MCP Events for an agent: the default filter of an agent is `addressed` from the deploy.
-- A row from before 0016 has `all`, and its filter is "not set". A refresh gives it `addressed` (0021), but
-- the client sends the refresh on its own schedule. A row of an old OAuth connection or an old URL has no refresh.
-- So such a row sends each message of each joined chat until its end, 24 hours at most after its last refresh.
-- This statement changes it at the deploy.
-- A row with a filter that the creator set does not change. A subscription of a person does not change.
-- A signed webhook has no refresh and keeps its filter (0016). Mail and Drive do not read the filter.
-- A fresh reset replays this file. It has one statement, so it needs no statement marker.

UPDATE webhook_subscriptions SET chat_filter = 'addressed'
WHERE domain = 'chat' AND chat_filter = 'all' AND chat_filter_explicit = 0
	AND endpoint_id IN (SELECT id FROM webhook_endpoints WHERE protocol = 'mcp_events')
	AND target_id IN (SELECT id FROM principals WHERE kind = 'agent');
