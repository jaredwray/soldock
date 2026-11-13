-- Sign-in with a password and an optional TOTP code replaces sign-in codes by email. This migration
-- adds the password and TOTP columns.
--
-- The deploy applies migrations while the old Worker still runs, so this migration only adds. The old
-- Worker reads `sign_in_email` and writes `sign_in_codes`, so both stay, unused by the new Worker:
-- `sign_in_email` becomes optional, and `sign_in_codes` comes back empty. A later migration removes
-- them, after the new Worker runs everywhere. The triggers that kept sign-in emails outside the mail
-- domains go away, because the new Worker does not set sign-in emails.
--
-- A D1 migration cannot turn off foreign keys, and a deferred check counts each row of a dropped parent
-- table as a violation. So the migration copies `principals` and each table that refers to it into a
-- `_v2` table, drops the old tables (child tables first), and renames the copies. A rename also changes
-- the references in the other tables. A rename fails while a trigger refers to a missing table, so the
-- triggers go first and come back at the end.
DROP TRIGGER IF EXISTS mail_domain_sign_in;
--> statement-breakpoint
DROP TRIGGER IF EXISTS principal_sign_in_domain;
--> statement-breakpoint
DROP TRIGGER IF EXISTS update_sign_in_domain;
--> statement-breakpoint
DROP TRIGGER IF EXISTS mail_domain_in_use;
--> statement-breakpoint
DROP TRIGGER IF EXISTS address_mail_domain;
--> statement-breakpoint
CREATE TABLE principals_v2 (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
	display_name TEXT NOT NULL,
	-- Humans have a role in the organization. Agents have none.
	org_role TEXT CHECK (org_role IN ('owner', 'admin', 'member')),
	-- The accountable human of an agent.
	sponsor_id TEXT REFERENCES principals_v2 (id),
	-- Who an agent can send mail to. Only the sponsor, an owner or an admin can change it.
	outbound_mode TEXT CHECK (outbound_mode IN ('internal-only', 'allowlist', 'any')),
	outbound_allowlist TEXT NOT NULL DEFAULT '[]',
	-- Unused since this migration, and optional. Only the Worker from before this migration reads it.
	sign_in_email TEXT,
	-- The PBKDF2 hash of the password of a human: `pbkdf2-sha256$<iterations>$<salt>$<hash>`. Null until
	-- somebody sets a password. Agents have none.
	password_hash TEXT,
	-- The base32 TOTP secret of a human, after a code confirms it. Null while two-step verification is off.
	totp_secret TEXT,
	-- A new TOTP secret that waits for a code. It does not change sign-in.
	totp_pending_secret TEXT,
	-- The TOTP time step of the last accepted code. A code works one time.
	totp_last_step INTEGER,
	-- Failed sign-ins since the last lock or success. Each attempt adds one before the compare.
	sign_in_failures INTEGER NOT NULL DEFAULT 0,
	-- Sign-in stops until this time after too many failures.
	sign_in_locked_until TEXT,
	created_at TEXT NOT NULL,
	CHECK (
		(kind = 'human' AND org_role IS NOT NULL AND sponsor_id IS NULL AND outbound_mode IS NULL)
		OR (kind = 'agent' AND org_role IS NULL AND sponsor_id IS NOT NULL AND outbound_mode IS NOT NULL
			AND password_hash IS NULL AND totp_secret IS NULL AND totp_pending_secret IS NULL)
	)
);
--> statement-breakpoint
INSERT INTO principals_v2 (id, kind, display_name, org_role, sponsor_id, outbound_mode, outbound_allowlist,
	sign_in_email, created_at)
SELECT id, kind, display_name, org_role, sponsor_id, outbound_mode, outbound_allowlist, sign_in_email, created_at
FROM principals;
--> statement-breakpoint
CREATE TABLE addresses_v2 (
	address TEXT PRIMARY KEY,
	principal_id TEXT NOT NULL REFERENCES principals_v2 (id),
	is_primary INTEGER NOT NULL CHECK (is_primary IN (0, 1)),
	created_at TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO addresses_v2 (address, principal_id, is_primary, created_at)
SELECT address, principal_id, is_primary, created_at FROM addresses;
--> statement-breakpoint
CREATE TABLE api_keys_v2 (
	id TEXT PRIMARY KEY,
	principal_id TEXT NOT NULL REFERENCES principals_v2 (id),
	key_hash TEXT NOT NULL UNIQUE,
	label TEXT NOT NULL,
	scopes TEXT NOT NULL,
	created_by TEXT NOT NULL REFERENCES principals_v2 (id),
	created_at TEXT NOT NULL,
	last_used_at TEXT,
	revoked_at TEXT
);
--> statement-breakpoint
INSERT INTO api_keys_v2 (id, principal_id, key_hash, label, scopes, created_by, created_at, last_used_at, revoked_at)
SELECT id, principal_id, key_hash, label, scopes, created_by, created_at, last_used_at, revoked_at FROM api_keys;
--> statement-breakpoint
-- Browser sessions of humans. Only the SHA-256 of the cookie value is stored. Sessions from before this
-- migration stay, so a signed-in person can set a password in Settings.
CREATE TABLE sessions_v2 (
	token_hash TEXT PRIMARY KEY,
	principal_id TEXT NOT NULL REFERENCES principals_v2 (id),
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO sessions_v2 (token_hash, principal_id, created_at, expires_at)
SELECT token_hash, principal_id, created_at, expires_at FROM sessions;
--> statement-breakpoint
DROP TABLE IF EXISTS sign_in_codes;
--> statement-breakpoint
DROP TABLE sessions;
--> statement-breakpoint
DROP TABLE api_keys;
--> statement-breakpoint
DROP TABLE addresses;
--> statement-breakpoint
-- Remove the references from agents before SQLite deletes the principals table.
DELETE FROM principals WHERE kind = 'agent';
--> statement-breakpoint
DROP TABLE principals;
--> statement-breakpoint
ALTER TABLE principals_v2 RENAME TO principals;
--> statement-breakpoint
ALTER TABLE addresses_v2 RENAME TO addresses;
--> statement-breakpoint
ALTER TABLE api_keys_v2 RENAME TO api_keys;
--> statement-breakpoint
ALTER TABLE sessions_v2 RENAME TO sessions;
--> statement-breakpoint
CREATE INDEX principals_sponsor ON principals (sponsor_id);
--> statement-breakpoint
CREATE UNIQUE INDEX principals_sign_in_email ON principals (sign_in_email);
--> statement-breakpoint
CREATE INDEX addresses_principal ON addresses (principal_id);
--> statement-breakpoint
CREATE INDEX api_keys_principal ON api_keys (principal_id);
--> statement-breakpoint
CREATE INDEX sessions_principal ON sessions (principal_id);
--> statement-breakpoint
-- Unused since this migration. It stays for the Worker from before this migration, without the old codes.
CREATE TABLE sign_in_codes (
	id TEXT PRIMARY KEY,
	principal_id TEXT NOT NULL REFERENCES principals (id),
	code_hash TEXT NOT NULL,
	attempts INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	used_at TEXT
);
--> statement-breakpoint
CREATE INDEX sign_in_codes_principal ON sign_in_codes (principal_id, created_at);
--> statement-breakpoint
CREATE TRIGGER mail_domain_in_use BEFORE DELETE ON mail_domains
WHEN EXISTS (SELECT 1 FROM addresses WHERE substr(address, instr(address, '@') + 1) = OLD.domain)
BEGIN
	SELECT RAISE(ABORT, 'mail_domain_in_use');
END;
--> statement-breakpoint
CREATE TRIGGER address_mail_domain BEFORE INSERT ON addresses
WHEN NOT EXISTS (SELECT 1 FROM mail_domains WHERE domain = substr(NEW.address, instr(NEW.address, '@') + 1))
BEGIN
	SELECT RAISE(ABORT, 'address_mail_domain');
END;
