-- The scopes and the resource limits of a service account are on the account, not on each token. A token
-- is only a credential of its account. Each new column is nullable or has a default, so the Worker from
-- before this migration still reads and writes the directory while the deploy applies it. That Worker
-- reads the scopes and the limits of each token: `api_keys.scopes` and `api_keys.resources` keep their
-- values, and a token from after this migration has no scopes there.
-- The statement markers let a fresh reset replay this file without a SQL parser.

-- The scopes of a service account, as a JSON list. Null for each other principal.
ALTER TABLE principals ADD COLUMN service_scopes TEXT;
--> statement-breakpoint
-- The mailboxes, drives and rooms that a service account is limited to, as JSON. Null: not limited.
ALTER TABLE principals ADD COLUMN service_resources TEXT;
--> statement-breakpoint
-- The number of changes of the scopes and the limits. A live connection keeps the number of its open, and
-- stops when the number changes.
ALTER TABLE principals ADD COLUMN access_version INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
-- An account from before this migration gets each scope that one of its live tokens holds, so no script
-- loses a scope. A revoked token and an expired token give nothing: their access ended. An account without
-- a live token gets no scope: an owner or an admin sets its scopes.
UPDATE principals SET service_scopes = (
	SELECT json_group_array(DISTINCT scope.value) FROM api_keys k, json_each(k.scopes) scope
	WHERE k.principal_id = principals.id AND k.revoked_at IS NULL AND json_valid(k.scopes)
		AND (k.expires_at IS NULL OR k.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) WHERE service = 1;
--> statement-breakpoint
-- An account gets limits only when each of its live tokens had limits: then the limits are each mailbox,
-- drive and room that one of those tokens named. An account with one live token without limits stays
-- without limits, so no script loses a resource. Limits that are not valid JSON name nothing.
UPDATE principals SET service_resources = json_object(
	'mailbox_ids', json((
		SELECT json_group_array(DISTINCT id.value) FROM api_keys k,
			json_each(CASE WHEN json_valid(k.resources) THEN k.resources ELSE '{}' END, '$.mailbox_ids') id
		WHERE k.principal_id = principals.id AND k.revoked_at IS NULL
			AND (k.expires_at IS NULL OR k.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))),
	'drive_ids', json((
		SELECT json_group_array(DISTINCT id.value) FROM api_keys k,
			json_each(CASE WHEN json_valid(k.resources) THEN k.resources ELSE '{}' END, '$.drive_ids') id
		WHERE k.principal_id = principals.id AND k.revoked_at IS NULL
			AND (k.expires_at IS NULL OR k.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))),
	'room_ids', json((
		SELECT json_group_array(DISTINCT id.value) FROM api_keys k,
			json_each(CASE WHEN json_valid(k.resources) THEN k.resources ELSE '{}' END, '$.room_ids') id
		WHERE k.principal_id = principals.id AND k.revoked_at IS NULL
			AND (k.expires_at IS NULL OR k.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))))
) WHERE service = 1
	AND EXISTS (
		SELECT 1 FROM api_keys k WHERE k.principal_id = principals.id AND k.revoked_at IS NULL
			AND (k.expires_at IS NULL OR k.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))
	AND NOT EXISTS (
		SELECT 1 FROM api_keys k WHERE k.principal_id = principals.id AND k.revoked_at IS NULL
			AND (k.expires_at IS NULL OR k.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
			AND k.resources IS NULL);
