-- OAuth for agents. An MCP client registers itself, a person approves its request for an agent, and the
-- client gets tokens that act as that agent. Only the SHA-256 of a code or a token is stored.
-- The statement markers let a fresh reset replay this file without a SQL parser.

-- MCP clients that registered themselves (RFC 7591). Each one is a public client: it has no secret and
-- uses PKCE. Anybody can register, so a registration without a request or a grant goes after one day.
CREATE TABLE IF NOT EXISTS oauth_clients (
	id TEXT PRIMARY KEY,
	-- The name that the client gave itself. Soldock does not check it.
	name TEXT NOT NULL,
	uri TEXT,
	-- A JSON list of the exact redirect URIs.
	redirect_uris TEXT NOT NULL,
	created_at TEXT NOT NULL
);
--> statement-breakpoint
-- Authorization requests. A request waits for a person until `expires_at`. The approval sets the agent,
-- the scopes and the code. The token request uses the code one time and records the grant that it made,
-- so a second use of the code can revoke that grant. Expired rows go at the next request.
CREATE TABLE IF NOT EXISTS oauth_requests (
	id TEXT PRIMARY KEY,
	client_id TEXT NOT NULL REFERENCES oauth_clients (id),
	redirect_uri TEXT NOT NULL,
	state TEXT,
	-- The PKCE S256 challenge.
	code_challenge TEXT NOT NULL,
	-- A JSON list of the agent scopes that the client asked for.
	scopes TEXT NOT NULL,
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	principal_id TEXT REFERENCES principals (id),
	granted_scopes TEXT,
	approved_by TEXT REFERENCES principals (id),
	code_hash TEXT UNIQUE,
	code_expires_at TEXT,
	-- Set when the person denies the request.
	denied_at TEXT,
	used_at TEXT,
	grant_id TEXT
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS oauth_requests_client ON oauth_requests (client_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS oauth_requests_expires ON oauth_requests (expires_at);
--> statement-breakpoint
-- Approved connections. Each grant has one access token and one refresh token. A refresh replaces both.
-- The refresh token that the client used last also stays valid until the client uses the new one, so a
-- lost response does not end the connection.
CREATE TABLE IF NOT EXISTS oauth_grants (
	id TEXT PRIMARY KEY,
	client_id TEXT NOT NULL REFERENCES oauth_clients (id),
	principal_id TEXT NOT NULL REFERENCES principals (id),
	scopes TEXT NOT NULL,
	created_by TEXT NOT NULL REFERENCES principals (id),
	created_at TEXT NOT NULL,
	last_used_at TEXT,
	revoked_at TEXT,
	access_hash TEXT NOT NULL UNIQUE,
	access_expires_at TEXT NOT NULL,
	refresh_hash TEXT NOT NULL UNIQUE,
	previous_refresh_hash TEXT UNIQUE,
	refresh_expires_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS oauth_grants_principal ON oauth_grants (principal_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS oauth_grants_client ON oauth_grants (client_id);
