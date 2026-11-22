-- Service accounts and the lifetime of API keys. Each new column is nullable or has a default, so the
-- Worker from before this migration still reads and writes the directory while the deploy applies it.
-- The statement markers let a fresh reset replay this file without a SQL parser.

-- A service account is an agent row with `service = 1`. In mail, Drive and Chat it is an agent, so each
-- agent rule applies to it. The Worker shows it as the kind `service`, and gives its tokens less scope.
-- Only an agent row can be a service account.
ALTER TABLE principals ADD COLUMN service INTEGER NOT NULL DEFAULT 0 CHECK (service IN (0, 1) AND (service = 0 OR kind = 'agent'));
--> statement-breakpoint
-- What a service account is for. Null for people and agents.
ALTER TABLE principals ADD COLUMN description TEXT;
--> statement-breakpoint
-- Who created the principal. It is a record only and gives no rights. It has no REFERENCES: a fresh reset
-- drops the principals table, and a reference between two rows of that table would stop the drop.
ALTER TABLE principals ADD COLUMN created_by TEXT;
--> statement-breakpoint
-- When a key stops. Null: the key has no end. An expired key does not authenticate.
ALTER TABLE api_keys ADD COLUMN expires_at TEXT;
--> statement-breakpoint
-- What a key is for. Null when nobody wrote one.
ALTER TABLE api_keys ADD COLUMN description TEXT;
--> statement-breakpoint
-- Who revoked a key. Null for a key that is not revoked, and for a key that a delete of its principal revoked.
ALTER TABLE api_keys ADD COLUMN revoked_by TEXT;
