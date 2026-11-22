-- The rotation of an API key secret. Each new column is nullable or has a default, so the Worker from
-- before this migration still reads and writes the directory while the deploy applies it. That Worker
-- knows only `key_hash`, so a secret that a rotation replaced stops at once there.
-- The statement markers let a fresh reset replay this file without a SQL parser.

-- The SHA-256 of the secret before the last rotation. It works until `prev_expires_at`. Null: no overlap.
ALTER TABLE api_keys ADD COLUMN prev_key_hash TEXT;
--> statement-breakpoint
ALTER TABLE api_keys ADD COLUMN prev_expires_at TEXT;
--> statement-breakpoint
-- The number of rotations of the key. A live connection keeps the number of its secret.
ALTER TABLE api_keys ADD COLUMN rotation INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE api_keys ADD COLUMN rotated_at TEXT;
--> statement-breakpoint
ALTER TABLE api_keys ADD COLUMN rotated_by TEXT;
--> statement-breakpoint
-- A request finds a key by its current or its previous secret, so the previous secret has an index too.
CREATE UNIQUE INDEX api_keys_prev_hash ON api_keys (prev_key_hash) WHERE prev_key_hash IS NOT NULL;
