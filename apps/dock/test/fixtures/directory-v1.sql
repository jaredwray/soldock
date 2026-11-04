
CREATE TABLE principals (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
	display_name TEXT NOT NULL,
	org_role TEXT CHECK (org_role IN ('owner', 'admin', 'member')),
	sponsor_id TEXT REFERENCES principals (id),
	outbound_mode TEXT CHECK (outbound_mode IN ('internal-only', 'allowlist', 'any')),
	outbound_allowlist TEXT NOT NULL DEFAULT '[]',
	created_at TEXT NOT NULL,
	CHECK (
		(kind = 'human' AND org_role IS NOT NULL AND sponsor_id IS NULL AND outbound_mode IS NULL)
		OR (kind = 'agent' AND org_role IS NULL AND sponsor_id IS NOT NULL AND outbound_mode IS NOT NULL)
	)
);

CREATE INDEX principals_sponsor ON principals (sponsor_id);

CREATE TABLE addresses (
	address TEXT PRIMARY KEY,
	principal_id TEXT NOT NULL REFERENCES principals (id),
	is_primary INTEGER NOT NULL CHECK (is_primary IN (0, 1)),
	created_at TEXT NOT NULL
);

CREATE INDEX addresses_principal ON addresses (principal_id);

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

CREATE TABLE sessions (
	token_hash TEXT PRIMARY KEY,
	principal_id TEXT NOT NULL REFERENCES principals (id),
	key_id TEXT NOT NULL REFERENCES api_keys (id),
	scopes TEXT NOT NULL,
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL
);

CREATE INDEX sessions_principal ON sessions (principal_id);

CREATE INDEX sessions_key ON sessions (key_id);
