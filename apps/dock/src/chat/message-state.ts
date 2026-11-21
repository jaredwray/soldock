import type { ChatBody } from "@asterra/contracts";
import type { CredentialBinding } from "../identity/index.ts";

export const roomMessageTables = [
	"ALTER TABLE messages ADD COLUMN forwarded_from_json TEXT",
	`CREATE TABLE message_pins (seq INTEGER PRIMARY KEY)`,
	`CREATE TABLE chat_drafts (
		principal_id TEXT NOT NULL, parent_id TEXT NOT NULL, revision INTEGER NOT NULL, body_json TEXT,
		PRIMARY KEY (principal_id, parent_id)
	) WITHOUT ROWID`,
	`CREATE TABLE scheduled_messages (
		message_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, parent_id TEXT, body_json TEXT NOT NULL,
		binding_json TEXT NOT NULL, origin TEXT NOT NULL, send_at INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL
	) WITHOUT ROWID`,
	"CREATE INDEX scheduled_due ON scheduled_messages (next_attempt_at)",
	"CREATE INDEX scheduled_author ON scheduled_messages (principal_id, send_at)",
	`CREATE TABLE schedule_receipts (
		principal_id TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL, message_id TEXT NOT NULL,
		expires_at INTEGER NOT NULL, PRIMARY KEY (principal_id, key)
	) WITHOUT ROWID`,
	"CREATE INDEX schedule_receipts_expiry ON schedule_receipts (expires_at)",
	`CREATE TRIGGER member_message_cleanup AFTER DELETE ON members BEGIN
		DELETE FROM chat_drafts WHERE principal_id = OLD.principal_id;
		DELETE FROM scheduled_messages WHERE principal_id = OLD.principal_id;
		DELETE FROM schedule_receipts WHERE principal_id = OLD.principal_id;
	END`,
	...["AFTER UPDATE OF deleted_at ON messages WHEN NEW.deleted_at IS NOT NULL", "AFTER DELETE ON messages"].map(
		(event, i) => `CREATE TRIGGER message_tools_cleanup_${i} ${event} BEGIN
			DELETE FROM message_pins WHERE seq = OLD.seq;
			DELETE FROM chat_drafts WHERE parent_id = OLD.id;
			DELETE FROM scheduled_messages WHERE parent_id = OLD.id;
		END`,
	),
];

export interface ScheduledInput {
	id: string;
	key: string;
	hash: string;
	parentId: string | null;
	body: ChatBody;
	binding: CredentialBinding;
	origin: string;
	sendAt: number;
}
