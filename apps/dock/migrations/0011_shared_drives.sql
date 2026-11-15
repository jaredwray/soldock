-- The index of the shared drives of Drive. The DriveSpaceDO of a shared drive owns the drive, its
-- members and its items. After each change of the name or of the members, it writes the current state
-- of the changed rows here. The Worker reads these rows to list the shared drives of a principal
-- without a call to each drive, and to refuse an id that is not a live shared drive. The rows are a
-- copy: the drive object decides each access. Times are in milliseconds, as in the object.
-- The tables have no reference to principals, so a fresh start can drop and replay them.
-- The statement markers let a fresh reset replay this file without a SQL parser.
CREATE TABLE IF NOT EXISTS shared_drives (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	-- The name in NFC and lowercase, for the order of the list.
	name_key TEXT NOT NULL,
	-- The id of the owner or admin that created the drive.
	created_by TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	member_count INTEGER NOT NULL,
	-- Set when an owner or an admin deleted the drive. No operation opens the drive after that.
	deleted_at INTEGER
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS shared_drives_name ON shared_drives (name_key, id) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS shared_drive_members (
	drive_id TEXT NOT NULL,
	principal_id TEXT NOT NULL,
	role TEXT NOT NULL CHECK (role IN ('manager', 'editor', 'viewer')),
	PRIMARY KEY (drive_id, principal_id)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS shared_drive_members_principal ON shared_drive_members (principal_id);
