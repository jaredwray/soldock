-- Sign-in with a one-time code that goes to the sign-in email of a person. It replaces sign-in with an
-- API key. Migrations only move forward.

-- The sign-in email of a human: an address outside the mail domains, so that the person can read a
-- code before they sign in. Lowercase. Agents have none.
ALTER TABLE principals ADD COLUMN sign_in_email TEXT;

CREATE UNIQUE INDEX principals_sign_in_email ON principals (sign_in_email);

-- A session no longer comes from an API key, so it has no key and no key scopes. A session holds every
-- human scope. This migration ends the sessions that API keys created: each person signs in again.
DROP TABLE sessions;

CREATE TABLE sessions (
	token_hash TEXT PRIMARY KEY,
	principal_id TEXT NOT NULL REFERENCES principals (id),
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL
);

CREATE INDEX sessions_principal ON sessions (principal_id);

-- One-time sign-in codes. Only the SHA-256 of the code id and the code is stored. Only the newest code
-- of a person works. Each guess adds one to attempts before the compare, so parallel guesses cannot
-- go past the limit. Rows older than one hour are deleted when the person asks for a new code.
CREATE TABLE sign_in_codes (
	id TEXT PRIMARY KEY,
	principal_id TEXT NOT NULL REFERENCES principals (id),
	code_hash TEXT NOT NULL,
	attempts INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	used_at TEXT
);

CREATE INDEX sign_in_codes_principal ON sign_in_codes (principal_id, created_at);
