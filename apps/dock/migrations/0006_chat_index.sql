-- The index of Chat. The ChatRoomDO of a room owns the room, its members and its messages. After each
-- change, it writes the current state of the room and of each changed member here. The Worker reads
-- these rows to list the rooms of a principal and the public rooms without a call to each room. The
-- rows are a copy: the room object decides each access. Times are in milliseconds, as in the object.
-- The tables have no reference to principals, so a fresh start can drop and replay them.
-- The statement markers let a fresh reset replay this file without a SQL parser.
CREATE TABLE IF NOT EXISTS chat_rooms (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL CHECK (kind IN ('public', 'private', 'dm')),
	-- Null for a dm room.
	name TEXT,
	-- The name in NFC and lowercase, for the order of the public list and for the name filter.
	name_key TEXT,
	topic TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	created_by_json TEXT NOT NULL,
	member_count INTEGER NOT NULL,
	last_seq INTEGER NOT NULL,
	last_message_at INTEGER,
	-- The time of the newest message, or of the creation for a room without a message.
	activity_at INTEGER NOT NULL,
	version INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS chat_rooms_public ON chat_rooms (name_key, id) WHERE kind = 'public';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS chat_members (
	principal_id TEXT NOT NULL,
	room_id TEXT NOT NULL,
	role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
	last_read_seq INTEGER NOT NULL,
	-- The other member of a dm room, as JSON. Null for each other kind.
	peer_json TEXT,
	PRIMARY KEY (principal_id, room_id)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS chat_members_room ON chat_members (room_id);
