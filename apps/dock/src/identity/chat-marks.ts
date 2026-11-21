export const personalMessageTables = [
	`CREATE TABLE chat_marks (
		position INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, message_id TEXT NOT NULL,
		kind TEXT NOT NULL, at INTEGER NOT NULL, UNIQUE (room_id, message_id, kind)
	)`,
	"CREATE INDEX chat_marks_page ON chat_marks(kind, position)",
];

export type MarkKind = "saved" | "reminder";
export function setPersonalMark(
	sql: SqlStorage,
	kind: MarkKind,
	roomId: string,
	messageId: string,
	at: number | null,
): void {
	if (at === null) {
		sql.exec("DELETE FROM chat_marks WHERE room_id = ? AND message_id = ? AND kind = ?", roomId, messageId, kind);
		return;
	}
	sql.exec(
		`INSERT INTO chat_marks(room_id,message_id,kind,at) VALUES(?,?,?,?)
		ON CONFLICT(room_id,message_id,kind) DO UPDATE SET at = excluded.at WHERE excluded.kind = 'reminder'`,
		roomId,
		messageId,
		kind,
		at,
	);
}

export function personalMarkPage(sql: SqlStorage, kind: MarkKind, before: number, limit: number, due: boolean) {
	return sql
		.exec<{ room_id: string; message_id: string; at: number; position: number }>(
			`SELECT room_id, message_id, at, position FROM chat_marks WHERE kind = ? AND position < ? AND at <= ?
		 ORDER BY position DESC LIMIT ?`,
			kind,
			before,
			due ? Date.now() : Number.MAX_SAFE_INTEGER,
			limit,
		)
		.toArray();
}
