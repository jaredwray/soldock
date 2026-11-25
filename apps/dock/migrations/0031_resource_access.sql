-- The membership of a team mailbox, a room or a shared drive decides what an agent or a service account can do
-- there. Its account scopes (`principals.agent_scopes`) no longer limit a membership: they apply to its own
-- mailbox, its own drive and the actions that have no mailbox, room or drive. Nothing writes them after the
-- account is created.
-- Before this migration, a call of an agent in a team mailbox needed the scope in its account and in its
-- membership. So each membership of an agent keeps only the scopes that its account also holds: the agent can do
-- the same things as before, and no more. A list that is not valid JSON counts as empty, so it gives nothing. A
-- membership of a person does not change. The rooms and the shared drives keep their members in their own
-- objects: each object makes the same change when it first wakes after the deploy.
-- The file has one statement, so a fresh reset replays it without a statement marker.
UPDATE team_mailbox_members SET scopes = (
	SELECT COALESCE(json_group_array(member_scope.value), '[]')
	FROM json_each(CASE WHEN json_valid(team_mailbox_members.scopes) THEN team_mailbox_members.scopes ELSE '[]' END) member_scope
	WHERE member_scope.value IN (
		SELECT account_scope.value
		FROM principals p, json_each(CASE WHEN json_valid(p.agent_scopes) THEN p.agent_scopes ELSE '[]' END) account_scope
		WHERE p.id = team_mailbox_members.principal_id
	)
) WHERE principal_id IN (SELECT id FROM principals WHERE kind = 'agent');
