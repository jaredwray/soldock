-- The scopes and the resource limits of an agent are on the agent, as for a service account since 0026. An
-- API key or an OAuth connection of an agent is only a credential: `api_keys.scopes` and `oauth_grants.scopes`
-- of an agent are not read. A key of a person keeps its own scopes.
-- No Worker from before this migration is kept: the deploy replaces it, and a rollback is not supported. The
-- statement markers let a fresh reset replay this file without a SQL parser.

-- The columns hold the scopes and the limits of each agent now, also of a service account.
ALTER TABLE principals RENAME COLUMN service_scopes TO agent_scopes;
--> statement-breakpoint
ALTER TABLE principals RENAME COLUMN service_resources TO agent_resources;
--> statement-breakpoint
-- An agent from before this migration gets each scope of its live API keys, its live OAuth connections and its
-- approved OAuth codes that a client did not use yet, so no client of the agent loses a scope. A code works for
-- 60 seconds: a new agent of an approval just before this migration has only its code. A revoked or an expired
-- credential gives nothing. An agent without a live credential gets no scope: its sponsor, an owner or an admin
-- sets its scopes. The Worker reads only the agent scopes of the list. An agent from before this migration has
-- no limits.
UPDATE principals SET agent_scopes = (
	SELECT json_group_array(DISTINCT live.scope) FROM (
		SELECT scope.value AS scope FROM api_keys k, json_each(k.scopes) scope
		WHERE k.principal_id = principals.id AND k.revoked_at IS NULL AND json_valid(k.scopes)
			AND (k.expires_at IS NULL OR k.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		UNION
		SELECT scope.value FROM oauth_grants g, json_each(g.scopes) scope
		WHERE g.principal_id = principals.id AND g.revoked_at IS NULL AND json_valid(g.scopes)
			AND g.refresh_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
		UNION
		SELECT scope.value FROM oauth_requests r, json_each(r.granted_scopes) scope
		WHERE r.principal_id = principals.id AND r.code_hash IS NOT NULL AND r.used_at IS NULL
			AND json_valid(r.granted_scopes) AND r.code_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	) live
) WHERE kind = 'agent' AND service = 0;
