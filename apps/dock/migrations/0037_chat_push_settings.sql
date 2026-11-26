-- The Web Push settings of the organization. One row. An owner or an admin changes it in Admin › Chat.
CREATE TABLE chat_push_settings (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	-- 1: the Worker sends chat notifications to the devices of the members.
	enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
	-- The contact address in each VAPID token: a mailto: address or an https: URL.
	subject TEXT,
	-- The VAPID key pair (ECDSA P-256), in unpadded base64url. The public key is the uncompressed point.
	-- The private key is the JWK "d" value. No answer, log or audit line contains it.
	public_key TEXT,
	private_key TEXT,
	keys_created_at INTEGER,
	updated_at INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
INSERT INTO chat_push_settings (id) VALUES (1);
