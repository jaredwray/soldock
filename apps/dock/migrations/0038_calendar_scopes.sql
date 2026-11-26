-- Calendar adds two account scopes: calendar.read and calendar.write. They apply only to the own calendar of
-- the account. Nothing writes `principals.agent_scopes` after an account is created, so an agent or a service
-- account from before this migration gets the scopes here:
-- - calendar.read when it holds mail.read.
-- - calendar.write when it holds mail.modify.
-- An account with narrow scopes stays narrow. A list that is not valid JSON, or is not a JSON array, does not
-- change. A second run changes nothing. The Worker from before drops the scopes that it does not know, so it
-- can run while the deploy applies this migration. The statement markers let a fresh reset replay this file
-- without a SQL parser.
UPDATE principals SET agent_scopes = json_insert(agent_scopes, '$[#]', 'calendar.read')
WHERE kind = 'agent'
	AND json_valid(agent_scopes) AND json_type(agent_scopes) = 'array'
	AND EXISTS (SELECT 1 FROM json_each(principals.agent_scopes) WHERE value = 'mail.read')
	AND NOT EXISTS (SELECT 1 FROM json_each(principals.agent_scopes) WHERE value = 'calendar.read');
--> statement-breakpoint
UPDATE principals SET agent_scopes = json_insert(agent_scopes, '$[#]', 'calendar.write')
WHERE kind = 'agent'
	AND json_valid(agent_scopes) AND json_type(agent_scopes) = 'array'
	AND EXISTS (SELECT 1 FROM json_each(principals.agent_scopes) WHERE value = 'mail.modify')
	AND NOT EXISTS (SELECT 1 FROM json_each(principals.agent_scopes) WHERE value = 'calendar.write');
