-- The invite links of people. An owner or an admin makes a link for a person who has no password yet. The
-- person opens the link, chooses a password, and the Worker signs the person in. A person has at most one
-- link: a new link replaces the earlier one. Only the SHA-256 of the secret is stored. The accept deletes the
-- row, and so do a password change and the deletion of the person. `created_by` is the owner or the admin who
-- made the link. A record only: it gives no rights.
-- The deploy applies the migrations while the Worker from before runs. That Worker does not read the table.
CREATE TABLE invites (
	token_hash TEXT PRIMARY KEY,
	principal_id TEXT NOT NULL UNIQUE REFERENCES principals (id),
	created_by TEXT NOT NULL,
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL
);
