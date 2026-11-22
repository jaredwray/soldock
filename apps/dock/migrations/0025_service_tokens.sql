-- The rotation of an API key secret, and the notice before the end of a token. Each new column is
-- nullable or has a default, so the Worker from before this migration still reads and writes the
-- directory while the deploy applies it. That Worker knows only `key_hash`, so a secret that a rotation
-- replaced stops at once there.
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
--> statement-breakpoint
-- When the notice before the end of a token went to the owners and admins. Null: not yet.
ALTER TABLE api_keys ADD COLUMN expiry_notice_at TEXT;
--> statement-breakpoint
-- The hourly job reads the keys that end soon and have no notice yet.
CREATE INDEX api_keys_expiry_due ON api_keys (expires_at)
	WHERE expires_at IS NOT NULL AND revoked_at IS NULL AND expiry_notice_at IS NULL;
