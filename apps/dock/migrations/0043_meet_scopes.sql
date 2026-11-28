-- Meet adds two account scopes: meet.read and meet.write. They apply only to the meetings that the account hosts.
-- Nothing writes `principals.agent_scopes` after an account is created, so an agent or a service account from
-- before this migration gets the scopes here:
-- - meet.read when it holds calendar.read.
-- - meet.write when it holds calendar.write.
-- An account with narrow scopes stays narrow. A list that is not valid JSON, or is not a JSON array, does not
-- change. A second run changes nothing. The Worker from before drops the scopes that it does not know, so it
-- can run while the deploy applies this migration. The statement markers let a fresh reset replay this file
-- without a SQL parser.
UPDATE principals SET agent_scopes = json_insert(agent_scopes, '$[#]', 'meet.read')
WHERE kind = 'agent'
	AND json_valid(agent_scopes) AND json_type(agent_scopes) = 'array'
	AND EXISTS (SELECT 1 FROM json_each(principals.agent_scopes) WHERE value = 'calendar.read')
	AND NOT EXISTS (SELECT 1 FROM json_each(principals.agent_scopes) WHERE value = 'meet.read');
--> statement-breakpoint
UPDATE principals SET agent_scopes = json_insert(agent_scopes, '$[#]', 'meet.write')
WHERE kind = 'agent'
	AND json_valid(agent_scopes) AND json_type(agent_scopes) = 'array'
	AND EXISTS (SELECT 1 FROM json_each(principals.agent_scopes) WHERE value = 'calendar.write')
	AND NOT EXISTS (SELECT 1 FROM json_each(principals.agent_scopes) WHERE value = 'meet.write');
