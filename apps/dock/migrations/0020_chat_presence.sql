-- The principal object renews these times from its open sockets. An old value expires on read.
ALTER TABLE principals ADD COLUMN chat_online_until INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE principals ADD COLUMN chat_active_until INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE principals ADD COLUMN chat_status_json TEXT;
