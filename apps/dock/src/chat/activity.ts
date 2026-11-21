import type { ChatActivityEntry } from "@asterra/contracts";

/** The room stores one row per recipient and change. A version identifies one change in a room. */
export type ActivityRow = Pick<
	ChatActivityEntry,
	"version" | "kind" | "actor_name" | "emoji" | "seq" | "parent_seq"
> & {
	at: number;
};

export const activitySchema = [
	`CREATE TABLE member_activity (
		principal_id TEXT NOT NULL REFERENCES members(principal_id) ON DELETE CASCADE,
		version INTEGER NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, actor_name TEXT NOT NULL,
		seq INTEGER NOT NULL REFERENCES messages(seq) ON DELETE CASCADE, parent_seq INTEGER, emoji TEXT,
		PRIMARY KEY (principal_id, version)
	) WITHOUT ROWID`,
	"CREATE INDEX member_activity_message ON member_activity (seq)",
	`CREATE TRIGGER activity_unreact AFTER DELETE ON reactions BEGIN
		DELETE FROM member_activity WHERE seq = (SELECT seq FROM messages WHERE id = OLD.message_id) AND version = OLD.version;
	END`,
	`CREATE TRIGGER activity_limit AFTER INSERT ON member_activity BEGIN
		DELETE FROM member_activity WHERE principal_id = NEW.principal_id AND version <=
		(SELECT version FROM member_activity WHERE principal_id = NEW.principal_id ORDER BY version DESC LIMIT 1 OFFSET 50);
	END`,
	`CREATE TRIGGER activity_delete AFTER UPDATE OF deleted_at ON messages WHEN NEW.deleted_at IS NOT NULL BEGIN
		DELETE FROM member_activity WHERE seq = NEW.seq;
	END`,
];

export function addActivity(sql: SqlStorage, recipients: string[], activity: ActivityRow): void {
	if (recipients.length === 0) return;
	sql.exec(
		`INSERT INTO member_activity (principal_id, version, at, kind, actor_name, seq, parent_seq, emoji)
		 SELECT m.principal_id, ?2, ?3, ?4, ?5, ?6, ?7, ?8 FROM members m JOIN json_each(?1) ids ON ids.value = m.principal_id`,
		JSON.stringify(recipients),
		activity.version,
		activity.at,
		activity.kind,
		activity.actor_name,
		activity.seq,
		activity.parent_seq,
		activity.emoji,
	);
}
