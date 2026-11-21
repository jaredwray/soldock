-- Chat layer 8: group DMs, archive, posting policy, retention, owner count, custom emoji,
-- incoming webhooks and slash commands.
-- Statement markers let a fresh reset replay this file without a SQL parser.
CREATE TABLE chat_rooms_v2 (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL CHECK (kind IN ('public', 'private', 'dm', 'group_dm')),
	name TEXT,
	name_key TEXT,
	topic TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	created_by_json TEXT NOT NULL,
	member_count INTEGER NOT NULL,
	last_seq INTEGER NOT NULL,
	last_message_at INTEGER,
	activity_at INTEGER NOT NULL,
	version INTEGER NOT NULL,
	archived_at INTEGER,
	posting_policy TEXT NOT NULL DEFAULT 'members' CHECK (posting_policy IN ('members', 'owners_only', 'allowlist')),
	retention_days INTEGER,
	owner_count INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
INSERT INTO chat_rooms_v2 (
	id, kind, name, name_key, topic, created_at, created_by_json, member_count,
	last_seq, last_message_at, activity_at, version, archived_at, posting_policy, retention_days, owner_count
)
SELECT
	r.id, r.kind, r.name, r.name_key, r.topic, r.created_at, r.created_by_json, r.member_count,
	r.last_seq, r.last_message_at, r.activity_at, r.version, NULL, 'members', NULL,
	(SELECT COUNT(*) FROM chat_members m WHERE m.room_id = r.id AND m.role = 'owner')
FROM chat_rooms r;
--> statement-breakpoint
DROP TABLE chat_rooms;
--> statement-breakpoint
ALTER TABLE chat_rooms_v2 RENAME TO chat_rooms;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS chat_rooms_public ON chat_rooms (name_key, id) WHERE kind = 'public';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS chat_rooms_admin ON chat_rooms (kind, name_key, id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS chat_custom_emoji (
	name TEXT PRIMARY KEY,
	r2_key TEXT NOT NULL,
	mime_type TEXT NOT NULL,
	size INTEGER NOT NULL,
	width INTEGER NOT NULL,
	height INTEGER NOT NULL,
	created_by TEXT NOT NULL,
	created_at INTEGER NOT NULL
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS chat_incoming_webhooks (
	id TEXT PRIMARY KEY,
	room_id TEXT NOT NULL,
	name TEXT NOT NULL,
	signing_secret TEXT NOT NULL,
	created_by TEXT NOT NULL,
	created_at INTEGER NOT NULL
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS chat_incoming_webhooks_room ON chat_incoming_webhooks (room_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS chat_slash_commands (
	id TEXT PRIMARY KEY,
	command TEXT NOT NULL UNIQUE,
	description TEXT NOT NULL,
	usage_hint TEXT NOT NULL DEFAULT '',
	operation TEXT NOT NULL,
	input_template_json TEXT NOT NULL,
	created_by TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
