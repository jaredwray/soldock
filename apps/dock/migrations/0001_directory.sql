-- The directory: principals (humans and agents), their mail addresses, API keys, browser sessions and
-- sign-in codes. D1 applies this file with `wrangler d1 migrations apply DIRECTORY`. Migrations only
-- move forward.

CREATE TABLE principals (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
	display_name TEXT NOT NULL,
	-- Humans have a role in the organization. Agents have none.
	org_role TEXT CHECK (org_role IN ('owner', 'admin', 'member')),
	-- The accountable human of an agent.
	sponsor_id TEXT REFERENCES principals (id),
	-- Who an agent can send mail to. Only the sponsor, an owner or an admin can change it.
	outbound_mode TEXT CHECK (outbound_mode IN ('internal-only', 'allowlist', 'any')),
	outbound_allowlist TEXT NOT NULL DEFAULT '[]',
	-- Where a human gets sign-in codes: an address outside the mail domains, so that the person can read
	-- a code before they sign in. Lowercase. Agents have none.
	sign_in_email TEXT,
	created_at TEXT NOT NULL,
	CHECK (
		(kind = 'human' AND org_role IS NOT NULL AND sponsor_id IS NULL AND outbound_mode IS NULL
			AND sign_in_email IS NOT NULL)
		OR (kind = 'agent' AND org_role IS NULL AND sponsor_id IS NOT NULL AND outbound_mode IS NOT NULL
			AND sign_in_email IS NULL)
	)
);

CREATE INDEX principals_sponsor ON principals (sponsor_id);

CREATE UNIQUE INDEX principals_sign_in_email ON principals (sign_in_email);

-- Lowercase addresses without a +tag. Inbound mail to an address that is not here is rejected.
CREATE TABLE addresses (
	address TEXT PRIMARY KEY,
	principal_id TEXT NOT NULL REFERENCES principals (id),
	is_primary INTEGER NOT NULL CHECK (is_primary IN (0, 1)),
	created_at TEXT NOT NULL
);

CREATE INDEX addresses_principal ON addresses (principal_id);

-- Only the SHA-256 of a key secret is stored.
CREATE TABLE api_keys (
	id TEXT PRIMARY KEY,
	principal_id TEXT NOT NULL REFERENCES principals (id),
	key_hash TEXT NOT NULL UNIQUE,
	label TEXT NOT NULL,
	scopes TEXT NOT NULL,
	created_by TEXT NOT NULL REFERENCES principals (id),
	created_at TEXT NOT NULL,
	last_used_at TEXT,
	revoked_at TEXT
);

CREATE INDEX api_keys_principal ON api_keys (principal_id);

-- Browser sessions of humans. Only the SHA-256 of the cookie value is stored. A human signs in with a
-- code from their sign-in email, so a session holds every human scope and does not depend on an API key.
CREATE TABLE sessions (
	token_hash TEXT PRIMARY KEY,
	principal_id TEXT NOT NULL REFERENCES principals (id),
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL
);

CREATE INDEX sessions_principal ON sessions (principal_id);

-- One-time sign-in codes. Only the SHA-256 of the code id and the code is stored. Only the newest code
-- of a person works. Each guess adds one to attempts before the compare, so parallel guesses cannot
-- go past the limit. A change of the sign-in email marks the codes used. Rows older than one hour are
-- deleted when the person asks for a new code.
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
