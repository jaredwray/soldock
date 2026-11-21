/** Restore the room schema at version 16 so migration tests can open data from older releases. */
export function restoreChatSchema16(sql: SqlStorage): void {
	for (const trigger of [
		"delete_room_hooks",
		"delete_message_actions",
		"activity_unreact",
		"activity_limit",
		"activity_delete",
		"member_message_cleanup",
		"message_tools_cleanup_0",
		"message_tools_cleanup_1",
	])
		sql.exec(`DROP TRIGGER ${trigger}`);
	for (const table of [
		"incoming_hooks",
		"member_activity",
		"message_pins",
		"chat_drafts",
		"scheduled_messages",
		"schedule_receipts",
	]) {
		sql.exec(`DROP TABLE ${table}`);
	}
	sql.exec("DROP INDEX messages_retention");
	for (const column of ["untrusted", "buttons_json", "action_id", "forwarded_from_json"]) {
		sql.exec(`ALTER TABLE messages DROP COLUMN ${column}`);
	}
	for (const column of ["archived", "posting", "retention_days", "deleted"])
		sql.exec(`ALTER TABLE room DROP COLUMN ${column}`);
}
