import { CHAT_LIMITS, type ChatActivityKind } from "@asterra/contracts";

// Per-principal Chat state owned by PrincipalDO: activity feed, sidebar sections, saved messages,
// synced drafts, scheduled messages, and reminders.

type Row = Record<string, SqlStorageValue>;

export interface ActivityActor {
	principal_id: string;
	kind: "human" | "agent";
	display_name: string;
}

export interface ActivityRecord {
	id: string;
	kind: ChatActivityKind;
	room_id: string;
	room_name: string | null;
	message_id: string;
	parent_id: string | null;
	seq: number;
	parent_seq: number | null;
	actor: ActivityActor;
	emoji: string | null;
	preview: string;
	untrusted: boolean;
	/** For `member_request`: the account that the actor wants to add to the room. Null for each other kind. */
	subject: ActivityActor | null;
	/** For `share_request`: the item that the actor wants to share with `subject`. Null for each other kind. */
	item: ActivityItemRef | null;
	created_at: number;
	read_at: number | null;
}

/** The Drive item of a `share_request`, with the role of the request. */
export interface ActivityItemRef {
	space_id: string;
	item_id: string;
	name: string;
	role: "editor" | "viewer";
}

export interface ActivityInsert {
	id: string;
	kind: ChatActivityKind;
	room_id: string;
	room_name: string | null;
	message_id: string;
	parent_id: string | null;
	seq: number;
	parent_seq: number | null;
	actor: ActivityActor;
	emoji: string | null;
	preview: string;
	untrusted?: boolean | undefined;
	/** For `member_request` and `share_request`: the account that the actor wants to add, or to share with. */
	subject?: ActivityActor | null | undefined;
	/** For `share_request`: the item that the actor wants to share. */
	item?: ActivityItemRef | null | undefined;
	created_at: number;
}

export interface SectionRecord {
	id: string;
	name: string;
	position: number;
	room_ids: string[];
	created_at: number;
}

export interface SavedRef {
	room_id: string;
	message_id: string;
	saved_at: number;
}

export interface DraftRecord {
	room_id: string;
	parent_id: string | null;
	body_json: string;
	text: string;
	markdown: string;
	updated_at: number;
}

export interface ScheduledRecord {
	id: string;
	principal_id: string;
	actor_json: string;
	room_id: string;
	parent_id: string | null;
	also_in_room: boolean;
	text: string;
	body_json: string;
	markdown: string;
	send_at: number;
	created_at: number;
	status: "pending" | "sent" | "failed";
	sent_message_id: string | null;
	error: string | null;
	credential_binding_json: string | null;
	attempts: number;
	next_attempt_at: number | null;
}

export interface ReminderRecord {
	id: string;
	room_id: string;
	message_id: string;
	seq: number;
	parent_id: string | null;
	parent_seq: number | null;
	note: string;
	preview: string;
	untrusted: boolean;
	remind_at: number;
	created_at: number;
	triggered_at: number | null;
	completed_at: number | null;
}

/**
 * The activity list gets the kind `member_request` and the column `subject_json`. SQLite cannot change the
 * CHECK of a table, so this step makes the table again and copies each row. The new table has no CHECK of
 * the kind: the contracts name the kinds, and only this module writes the table.
 */
export const CHAT_ACTIVITY_SUBJECT_MIGRATION: string[] = [
	`CREATE TABLE chat_activity_next (
		id TEXT PRIMARY KEY,
		kind TEXT NOT NULL,
		room_id TEXT NOT NULL,
		room_name TEXT,
		message_id TEXT NOT NULL,
		parent_id TEXT,
		seq INTEGER NOT NULL,
		parent_seq INTEGER,
		actor_json TEXT NOT NULL,
		emoji TEXT,
		preview TEXT NOT NULL,
		untrusted INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL,
		read_at INTEGER,
		subject_json TEXT
	) WITHOUT ROWID`,
	`INSERT INTO chat_activity_next (id, kind, room_id, room_name, message_id, parent_id, seq, parent_seq,
		actor_json, emoji, preview, untrusted, created_at, read_at)
		SELECT id, kind, room_id, room_name, message_id, parent_id, seq, parent_seq,
			actor_json, emoji, preview, untrusted, created_at, read_at FROM chat_activity`,
	"DROP TABLE chat_activity",
	"ALTER TABLE chat_activity_next RENAME TO chat_activity",
	"CREATE INDEX chat_activity_recent ON chat_activity (created_at DESC, id DESC)",
	"CREATE INDEX chat_activity_room ON chat_activity (room_id)",
	"CREATE INDEX chat_activity_unread ON chat_activity (created_at DESC, id DESC) WHERE read_at IS NULL",
];

/** The activity list gets the column `item_json`, for the kind `share_request`. */
export const CHAT_ACTIVITY_ITEM_MIGRATION: string[] = ["ALTER TABLE chat_activity ADD COLUMN item_json TEXT"];

export const CHAT_PERSONAL_MIGRATION: string[] = [
	`CREATE TABLE chat_activity (
		id TEXT PRIMARY KEY,
		kind TEXT NOT NULL CHECK (kind IN ('mention', 'reply', 'reaction', 'reminder', 'card_action')),
		room_id TEXT NOT NULL,
		room_name TEXT,
		message_id TEXT NOT NULL,
		parent_id TEXT,
		seq INTEGER NOT NULL,
		parent_seq INTEGER,
		actor_json TEXT NOT NULL,
		emoji TEXT,
		preview TEXT NOT NULL,
		untrusted INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL,
		read_at INTEGER
	) WITHOUT ROWID`,
	"CREATE INDEX chat_activity_recent ON chat_activity (created_at DESC, id DESC)",
	"CREATE INDEX chat_activity_room ON chat_activity (room_id)",
	"CREATE INDEX chat_activity_unread ON chat_activity (created_at DESC, id DESC) WHERE read_at IS NULL",
	`CREATE TABLE chat_sections (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		position INTEGER NOT NULL,
		created_at INTEGER NOT NULL
	) WITHOUT ROWID`,
	`CREATE TABLE chat_section_rooms (
		room_id TEXT PRIMARY KEY,
		section_id TEXT NOT NULL REFERENCES chat_sections(id) ON DELETE CASCADE
	) WITHOUT ROWID`,
	"CREATE INDEX chat_section_rooms_section ON chat_section_rooms (section_id)",
	`CREATE TABLE chat_saved_messages (
		room_id TEXT NOT NULL,
		message_id TEXT NOT NULL,
		saved_at INTEGER NOT NULL,
		PRIMARY KEY (room_id, message_id)
	) WITHOUT ROWID`,
	"CREATE INDEX chat_saved_recent ON chat_saved_messages (saved_at DESC, room_id DESC, message_id DESC)",
	`CREATE TABLE chat_drafts (
		draft_key TEXT PRIMARY KEY,
		room_id TEXT NOT NULL,
		parent_id TEXT,
		body_json TEXT NOT NULL,
		text TEXT NOT NULL,
		markdown TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	) WITHOUT ROWID`,
	"CREATE INDEX chat_drafts_recent ON chat_drafts (updated_at DESC)",
	`CREATE TABLE chat_scheduled_messages (
		id TEXT PRIMARY KEY,
		principal_id TEXT NOT NULL,
		actor_json TEXT NOT NULL,
		room_id TEXT NOT NULL,
		parent_id TEXT,
		also_in_room INTEGER NOT NULL DEFAULT 0,
		text TEXT NOT NULL,
		body_json TEXT NOT NULL,
		markdown TEXT NOT NULL,
		send_at INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
		sent_message_id TEXT,
		error TEXT,
		credential_binding_json TEXT,
		attempts INTEGER NOT NULL DEFAULT 0,
		next_attempt_at INTEGER
	) WITHOUT ROWID`,
	"CREATE INDEX chat_scheduled_due ON chat_scheduled_messages (send_at ASC) WHERE status = 'pending'",
	`CREATE TABLE chat_reminders (
		id TEXT PRIMARY KEY,
		room_id TEXT NOT NULL,
		message_id TEXT NOT NULL,
		seq INTEGER NOT NULL,
		parent_id TEXT,
		parent_seq INTEGER,
		note TEXT NOT NULL,
		preview TEXT NOT NULL,
		untrusted INTEGER NOT NULL DEFAULT 0,
		remind_at INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		triggered_at INTEGER,
		completed_at INTEGER
	) WITHOUT ROWID`,
	"CREATE INDEX chat_reminders_due ON chat_reminders (remind_at ASC) WHERE triggered_at IS NULL AND completed_at IS NULL",
];

function draftKey(roomId: string, parentId: string | null): string {
	return parentId === null ? roomId : `${roomId}/${parentId}`;
}

interface ActivityRow extends Row {
	id: string;
	kind: ChatActivityKind;
	room_id: string;
	room_name: string | null;
	message_id: string;
	parent_id: string | null;
	seq: number;
	parent_seq: number | null;
	actor_json: string;
	emoji: string | null;
	preview: string;
	untrusted: number;
	created_at: number;
	read_at: number | null;
	subject_json: string | null;
	item_json: string | null;
}

interface ScheduledRow extends Row {
	id: string;
	principal_id: string;
	actor_json: string;
	room_id: string;
	parent_id: string | null;
	also_in_room: number;
	text: string;
	body_json: string;
	markdown: string;
	send_at: number;
	created_at: number;
	status: "pending" | "sending" | "sent" | "failed";
	sent_message_id: string | null;
	error: string | null;
	credential_binding_json: string | null;
	attempts: number;
	next_attempt_at: number | null;
}

interface ReminderRow extends Row {
	id: string;
	room_id: string;
	message_id: string;
	seq: number;
	parent_id: string | null;
	parent_seq: number | null;
	note: string;
	preview: string;
	untrusted: number;
	remind_at: number;
	created_at: number;
	triggered_at: number | null;
	completed_at: number | null;
}

function toActivity(row: ActivityRow): ActivityRecord {
	return {
		id: row.id,
		kind: row.kind,
		room_id: row.room_id,
		room_name: row.room_name,
		message_id: row.message_id,
		parent_id: row.parent_id,
		seq: row.seq,
		parent_seq: row.parent_seq,
		actor: JSON.parse(row.actor_json) as ActivityActor,
		emoji: row.emoji,
		preview: row.preview,
		untrusted: row.untrusted === 1,
		subject: row.subject_json == null ? null : (JSON.parse(row.subject_json) as ActivityActor),
		item: row.item_json == null ? null : (JSON.parse(row.item_json) as ActivityItemRef),
		created_at: row.created_at,
		read_at: row.read_at,
	};
}

function toScheduled(row: ScheduledRow): ScheduledRecord {
	return {
		...row,
		status: row.status === "sending" ? "pending" : row.status,
		also_in_room: row.also_in_room === 1,
	};
}

function toReminder(row: ReminderRow): ReminderRecord {
	return { ...row, untrusted: row.untrusted === 1 };
}

export class ChatPersonalStore {
	private readonly sql: SqlStorage;

	constructor(sql: SqlStorage) {
		this.sql = sql;
	}

	// --- Activity ---

	recordActivity(item: ActivityInsert): boolean {
		const inserted = this.sql
			.exec<{ id: string }>(
				`INSERT OR IGNORE INTO chat_activity (
					id, kind, room_id, room_name, message_id, parent_id, seq, parent_seq,
					actor_json, emoji, preview, untrusted, created_at, read_at, subject_json, item_json
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?) RETURNING id`,
				item.id,
				item.kind,
				item.room_id,
				item.room_name,
				item.message_id,
				item.parent_id,
				item.seq,
				item.parent_seq,
				JSON.stringify(item.actor),
				item.emoji,
				item.preview.slice(0, 200),
				item.untrusted ? 1 : 0,
				item.created_at,
				item.subject ? JSON.stringify(item.subject) : null,
				item.item ? JSON.stringify(item.item) : null,
			)
			.toArray();
		if (inserted.length === 0) return false;
		// Keep bounded history.
		this.sql.exec(
			`DELETE FROM chat_activity WHERE id IN (
				SELECT id FROM chat_activity ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?
			)`,
			CHAT_LIMITS.activityItems,
		);
		return true;
	}

	activityUnreadCount(): number {
		return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM chat_activity WHERE read_at IS NULL").one().n;
	}

	listActivity(query: {
		filter: "all" | "unread" | ChatActivityKind;
		after: { createdAt: number; id: string } | null;
		limit: number;
	}): { items: ActivityRecord[]; unreadCount: number } {
		const conditions: string[] = [];
		const params: SqlStorageValue[] = [];
		if (query.filter === "unread") {
			conditions.push("read_at IS NULL");
		} else if (query.filter !== "all") {
			conditions.push("kind = ?");
			params.push(query.filter);
		}
		if (query.after) {
			conditions.push("(created_at, id) < (?, ?)");
			params.push(query.after.createdAt, query.after.id);
		}
		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		params.push(query.limit + 1);
		const rows = this.sql
			.exec<ActivityRow>(`SELECT * FROM chat_activity ${where} ORDER BY created_at DESC, id DESC LIMIT ?`, ...params)
			.toArray();
		return {
			items: rows.map(toActivity),
			unreadCount: this.activityUnreadCount(),
		};
	}

	markActivityRead(activityId: string | undefined, now: number): number {
		if (activityId !== undefined) {
			this.sql.exec("UPDATE chat_activity SET read_at = COALESCE(read_at, ?) WHERE id = ?", now, activityId);
		} else {
			this.sql.exec("UPDATE chat_activity SET read_at = ? WHERE read_at IS NULL", now);
		}
		return this.activityUnreadCount();
	}

	deleteActivities(ids: readonly string[]): number {
		if (ids.length === 0) return this.activityUnreadCount();
		for (const id of ids) {
			this.sql.exec("DELETE FROM chat_activity WHERE id = ?", id);
		}
		return this.activityUnreadCount();
	}

	removeRoomPersonalState(roomId: string): void {
		this.sql.exec("DELETE FROM chat_activity WHERE room_id = ?", roomId);
		this.sql.exec("DELETE FROM chat_section_rooms WHERE room_id = ?", roomId);
		this.sql.exec("DELETE FROM chat_saved_messages WHERE room_id = ?", roomId);
		this.sql.exec("DELETE FROM chat_drafts WHERE room_id = ?", roomId);
		this.sql.exec("DELETE FROM chat_reminders WHERE room_id = ?", roomId);
		this.sql.exec("DELETE FROM chat_scheduled_messages WHERE room_id = ? AND status = 'pending'", roomId);
	}

	// --- Sidebar sections ---

	listSections(): SectionRecord[] {
		const sections = this.sql
			.exec<{ id: string; name: string; position: number; created_at: number }>(
				"SELECT id, name, position, created_at FROM chat_sections ORDER BY position ASC, created_at ASC",
			)
			.toArray();
		const links = this.sql
			.exec<{ section_id: string; room_id: string }>(
				`SELECT r.section_id, r.room_id FROM chat_section_rooms r
				JOIN chat_rooms cr ON cr.room_id = r.room_id
				WHERE cr.joined = 1`,
			)
			.toArray();
		const bySection = new Map<string, string[]>();
		for (const link of links) {
			const list = bySection.get(link.section_id);
			if (list) list.push(link.room_id);
			else bySection.set(link.section_id, [link.room_id]);
		}
		return sections.map((section) => ({
			...section,
			room_ids: bySection.get(section.id) ?? [],
		}));
	}

	createSection(id: string, name: string, now: number): SectionRecord | "full" {
		const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM chat_sections").one().n;
		if (count >= CHAT_LIMITS.sectionsPerPrincipal) return "full";
		const maxPos = this.sql.exec<{ m: number | null }>("SELECT MAX(position) AS m FROM chat_sections").one().m ?? -1;
		const position = maxPos + 1;
		this.sql.exec(
			"INSERT INTO chat_sections (id, name, position, created_at) VALUES (?, ?, ?, ?)",
			id,
			name,
			position,
			now,
		);
		return { id, name, position, room_ids: [], created_at: now };
	}

	updateSection(id: string, patch: { name?: string | undefined; position?: number | undefined }): SectionRecord | null {
		const existing = this.sql
			.exec<{ id: string; name: string; position: number; created_at: number }>(
				"SELECT id, name, position, created_at FROM chat_sections WHERE id = ?",
				id,
			)
			.toArray()[0];
		if (!existing) return null;
		const name = patch.name ?? existing.name;
		const position = patch.position ?? existing.position;
		this.sql.exec("UPDATE chat_sections SET name = ?, position = ? WHERE id = ?", name, position, id);
		const room_ids = this.sql
			.exec<{ room_id: string }>(
				`SELECT r.room_id FROM chat_section_rooms r
				JOIN chat_rooms cr ON cr.room_id = r.room_id
				WHERE r.section_id = ? AND cr.joined = 1`,
				id,
			)
			.toArray()
			.map((row) => row.room_id);
		return { id, name, position, room_ids, created_at: existing.created_at };
	}

	deleteSection(id: string): boolean {
		this.sql.exec("DELETE FROM chat_section_rooms WHERE section_id = ?", id);
		const removed = this.sql.exec<{ id: string }>("DELETE FROM chat_sections WHERE id = ? RETURNING id", id).toArray();
		return removed.length > 0;
	}

	setRoomSection(roomId: string, sectionId: string | null): "ok" | "no_section" {
		if (sectionId === null) {
			this.sql.exec("DELETE FROM chat_section_rooms WHERE room_id = ?", roomId);
			return "ok";
		}
		const exists = this.sql.exec("SELECT 1 FROM chat_sections WHERE id = ?", sectionId).toArray().length > 0;
		if (!exists) return "no_section";
		this.sql.exec(
			"INSERT INTO chat_section_rooms (room_id, section_id) VALUES (?, ?) ON CONFLICT (room_id) DO UPDATE SET section_id = excluded.section_id",
			roomId,
			sectionId,
		);
		return "ok";
	}

	// --- Saved messages ---

	saveMessage(roomId: string, messageId: string, now: number): { savedAt: number } | "full" {
		const existing = this.sql
			.exec<{ saved_at: number }>(
				"SELECT saved_at FROM chat_saved_messages WHERE room_id = ? AND message_id = ?",
				roomId,
				messageId,
			)
			.toArray()[0];
		if (existing) return { savedAt: existing.saved_at };
		const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM chat_saved_messages").one().n;
		if (count >= CHAT_LIMITS.savedMessages) return "full";
		this.sql.exec(
			"INSERT INTO chat_saved_messages (room_id, message_id, saved_at) VALUES (?, ?, ?)",
			roomId,
			messageId,
			now,
		);
		return { savedAt: now };
	}

	unsaveMessage(roomId: string, messageId: string): boolean {
		const removed = this.sql
			.exec<{ message_id: string }>(
				"DELETE FROM chat_saved_messages WHERE room_id = ? AND message_id = ? RETURNING message_id",
				roomId,
				messageId,
			)
			.toArray();
		return removed.length > 0;
	}

	listSavedMessages(query: {
		after: { savedAt: number; roomId: string; messageId: string } | null;
		limit: number;
	}): SavedRef[] {
		const after = query.after;
		return this.sql
			.exec<SavedRef & Row>(
				`SELECT room_id, message_id, saved_at FROM chat_saved_messages
				${after ? "WHERE (saved_at, room_id, message_id) < (?2, ?3, ?4)" : ""}
				ORDER BY saved_at DESC, room_id DESC, message_id DESC LIMIT ?1`,
				query.limit + 1,
				...(after ? [after.savedAt, after.roomId, after.messageId] : []),
			)
			.toArray();
	}

	// --- Synced drafts ---

	saveDraft(input: {
		roomId: string;
		parentId: string | null;
		bodyJson: string;
		text: string;
		markdown: string;
		now: number;
	}): DraftRecord {
		const key = draftKey(input.roomId, input.parentId);
		this.sql.exec(
			`INSERT INTO chat_drafts (draft_key, room_id, parent_id, body_json, text, markdown, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (draft_key) DO UPDATE SET body_json = excluded.body_json, text = excluded.text,
				markdown = excluded.markdown, updated_at = excluded.updated_at`,
			key,
			input.roomId,
			input.parentId,
			input.bodyJson,
			input.text,
			input.markdown,
			input.now,
		);
		this.sql.exec(
			`DELETE FROM chat_drafts WHERE draft_key IN (
				SELECT draft_key FROM chat_drafts ORDER BY updated_at DESC LIMIT -1 OFFSET ?
			)`,
			CHAT_LIMITS.drafts,
		);
		return {
			room_id: input.roomId,
			parent_id: input.parentId,
			body_json: input.bodyJson,
			text: input.text,
			markdown: input.markdown,
			updated_at: input.now,
		};
	}

	deleteDraft(roomId: string, parentId: string | null): boolean {
		const key = draftKey(roomId, parentId);
		const removed = this.sql
			.exec<{ draft_key: string }>("DELETE FROM chat_drafts WHERE draft_key = ? RETURNING draft_key", key)
			.toArray();
		return removed.length > 0;
	}

	listDrafts(roomId?: string): DraftRecord[] {
		if (roomId) {
			return this.sql
				.exec<DraftRecord & Row>(
					"SELECT room_id, parent_id, body_json, text, markdown, updated_at FROM chat_drafts WHERE room_id = ? ORDER BY updated_at DESC",
					roomId,
				)
				.toArray();
		}
		return this.sql
			.exec<DraftRecord & Row>(
				"SELECT room_id, parent_id, body_json, text, markdown, updated_at FROM chat_drafts ORDER BY updated_at DESC",
			)
			.toArray();
	}

	// --- Scheduled messages ---

	createScheduled(input: {
		id: string;
		principalId: string;
		actor: ActivityActor;
		roomId: string;
		parentId: string | null;
		alsoInRoom: boolean;
		text: string;
		bodyJson: string;
		markdown: string;
		sendAt: number;
		now: number;
		credentialBindingJson?: string | null;
	}): ScheduledRecord | "full" {
		const pending = this.sql
			.exec<{ n: number }>("SELECT COUNT(*) AS n FROM chat_scheduled_messages WHERE status = 'pending'")
			.one().n;
		if (pending >= CHAT_LIMITS.scheduledMessages) return "full";
		const actorJson = JSON.stringify(input.actor);
		const bindingJson = input.credentialBindingJson ?? null;
		this.sql.exec(
			`INSERT INTO chat_scheduled_messages (
				id, principal_id, actor_json, room_id, parent_id, also_in_room, text, body_json, markdown,
				send_at, created_at, status, sent_message_id, error, credential_binding_json, attempts, next_attempt_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, 0, NULL)`,
			input.id,
			input.principalId,
			actorJson,
			input.roomId,
			input.parentId,
			input.alsoInRoom ? 1 : 0,
			input.text,
			input.bodyJson,
			input.markdown,
			input.sendAt,
			input.now,
			bindingJson,
		);
		return {
			id: input.id,
			principal_id: input.principalId,
			actor_json: actorJson,
			room_id: input.roomId,
			parent_id: input.parentId,
			also_in_room: input.alsoInRoom,
			text: input.text,
			body_json: input.bodyJson,
			markdown: input.markdown,
			send_at: input.sendAt,
			created_at: input.now,
			status: "pending",
			sent_message_id: null,
			error: null,
			credential_binding_json: bindingJson,
			attempts: 0,
			next_attempt_at: null,
		};
	}

	listScheduled(roomId?: string, status: "pending" | "sent" | "failed" | "all" = "pending"): ScheduledRecord[] {
		const conditions: string[] = [];
		const params: SqlStorageValue[] = [];
		if (roomId) {
			conditions.push("room_id = ?");
			params.push(roomId);
		}
		if (status === "pending") {
			conditions.push("status IN ('pending', 'sending')");
		} else if (status !== "all") {
			conditions.push("status = ?");
			params.push(status);
		}
		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		return this.sql
			.exec<ScheduledRow>(`SELECT * FROM chat_scheduled_messages ${where} ORDER BY send_at ASC, id ASC`, ...params)
			.toArray()
			.map(toScheduled);
	}

	updateScheduled(
		id: string,
		patch: { text?: string; bodyJson?: string; markdown?: string; sendAt?: number },
	): ScheduledRecord | "not_found" | "not_pending" {
		const row = this.sql.exec<ScheduledRow>("SELECT * FROM chat_scheduled_messages WHERE id = ?", id).toArray()[0];
		if (!row) return "not_found";
		if (row.status !== "pending") return "not_pending";
		const text = patch.text ?? row.text;
		const bodyJson = patch.bodyJson ?? row.body_json;
		const markdown = patch.markdown ?? row.markdown;
		const sendAt = patch.sendAt ?? row.send_at;
		this.sql.exec(
			"UPDATE chat_scheduled_messages SET text = ?, body_json = ?, markdown = ?, send_at = ?, attempts = 0, next_attempt_at = NULL, error = NULL WHERE id = ?",
			text,
			bodyJson,
			markdown,
			sendAt,
			id,
		);
		return toScheduled({
			...row,
			text,
			body_json: bodyJson,
			markdown,
			send_at: sendAt,
			attempts: 0,
			next_attempt_at: null,
			error: null,
		});
	}

	cancelScheduled(id: string): boolean {
		const removed = this.sql
			.exec<{ id: string }>("DELETE FROM chat_scheduled_messages WHERE id = ? AND status = 'pending' RETURNING id", id)
			.toArray();
		return removed.length > 0;
	}

	dueScheduled(now: number): ScheduledRecord[] {
		return this.sql
			.exec<ScheduledRow>(
				`SELECT * FROM chat_scheduled_messages
				WHERE (status = 'pending' AND COALESCE(next_attempt_at, send_at) <= ?)
				   OR (status = 'sending' AND next_attempt_at <= ?)
				ORDER BY COALESCE(next_attempt_at, send_at) ASC LIMIT 25`,
				now,
				now,
			)
			.toArray()
			.map(toScheduled);
	}

	/**
	 * Atomically claims a due scheduled row immediately before posting to `ChatRoomDO` so a
	 * concurrent cancel or edit during preceding awaits stops delivery.
	 */
	claimScheduledForSend(
		id: string,
		expectedSendAt: number,
		expectedText: string,
		expectedBodyJson: string,
		now: number,
	): boolean {
		const claimed = this.sql
			.exec<{ id: string }>(
				`UPDATE chat_scheduled_messages
				SET status = 'sending', next_attempt_at = ?
				WHERE id = ?
				  AND ((status = 'pending' AND COALESCE(next_attempt_at, send_at) <= ?)
				       OR (status = 'sending' AND next_attempt_at <= ?))
				  AND send_at = ? AND text = ? AND body_json = ?
				RETURNING id`,
				now + 60_000,
				id,
				now,
				now,
				expectedSendAt,
				expectedText,
				expectedBodyJson,
			)
			.toArray();
		return claimed.length > 0;
	}

	markScheduledRetry(id: string, attempts: number, nextAttemptAt: number, error: string): void {
		this.sql.exec(
			"UPDATE chat_scheduled_messages SET status = 'pending', attempts = ?, next_attempt_at = ?, error = ? WHERE id = ?",
			attempts,
			nextAttemptAt,
			error.slice(0, 300),
			id,
		);
	}

	markScheduledSent(id: string, messageId: string): void {
		this.sql.exec(
			"UPDATE chat_scheduled_messages SET status = 'sent', sent_message_id = ?, error = NULL, next_attempt_at = NULL WHERE id = ?",
			messageId,
			id,
		);
	}

	markScheduledFailed(id: string, error: string): void {
		this.sql.exec(
			"UPDATE chat_scheduled_messages SET status = 'failed', error = ?, next_attempt_at = NULL WHERE id = ?",
			error.slice(0, 300),
			id,
		);
	}

	// --- Reminders ---

	createReminder(input: {
		id: string;
		roomId: string;
		messageId: string;
		seq: number;
		parentId: string | null;
		parentSeq: number | null;
		note: string;
		preview: string;
		untrusted?: boolean | undefined;
		remindAt: number;
		now: number;
	}): ReminderRecord | "full" {
		const active = this.sql
			.exec<{ n: number }>("SELECT COUNT(*) AS n FROM chat_reminders WHERE completed_at IS NULL")
			.one().n;
		if (active >= CHAT_LIMITS.reminders) return "full";
		const untrusted = input.untrusted === true;
		this.sql.exec(
			`INSERT INTO chat_reminders (
				id, room_id, message_id, seq, parent_id, parent_seq, note, preview, untrusted, remind_at, created_at, triggered_at, completed_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
			input.id,
			input.roomId,
			input.messageId,
			input.seq,
			input.parentId,
			input.parentSeq,
			input.note,
			input.preview.slice(0, 200),
			untrusted ? 1 : 0,
			input.remindAt,
			input.now,
		);
		return {
			id: input.id,
			room_id: input.roomId,
			message_id: input.messageId,
			seq: input.seq,
			parent_id: input.parentId,
			parent_seq: input.parentSeq,
			note: input.note,
			preview: input.preview.slice(0, 200),
			untrusted,
			remind_at: input.remindAt,
			created_at: input.now,
			triggered_at: null,
			completed_at: null,
		};
	}

	listReminders(includeCompleted: boolean): ReminderRecord[] {
		const where = includeCompleted ? "" : "WHERE completed_at IS NULL";
		return this.sql
			.exec<ReminderRow>(`SELECT * FROM chat_reminders ${where} ORDER BY remind_at ASC, id ASC`)
			.toArray()
			.map(toReminder);
	}

	completeReminder(id: string, now: number): ReminderRecord | null {
		const row = this.sql
			.exec<ReminderRow>(
				"UPDATE chat_reminders SET completed_at = COALESCE(completed_at, ?) WHERE id = ? RETURNING *",
				now,
				id,
			)
			.toArray()[0];
		return row ? toReminder(row) : null;
	}

	deleteReminder(id: string): boolean {
		const removed = this.sql.exec<{ id: string }>("DELETE FROM chat_reminders WHERE id = ? RETURNING id", id).toArray();
		return removed.length > 0;
	}

	dueReminders(now: number): ReminderRecord[] {
		return this.sql
			.exec<ReminderRow>(
				"SELECT * FROM chat_reminders WHERE triggered_at IS NULL AND completed_at IS NULL AND remind_at <= ? ORDER BY remind_at ASC LIMIT 25",
				now,
			)
			.toArray()
			.map(toReminder);
	}

	markReminderTriggered(
		id: string,
		now: number,
		actor: ActivityActor,
		roomName: string | null,
		isMember = true,
	): ReminderRecord | null {
		const row = this.sql
			.exec<ReminderRow>(
				"UPDATE chat_reminders SET triggered_at = ? WHERE id = ? AND triggered_at IS NULL RETURNING *",
				now,
				id,
			)
			.toArray()[0];
		if (!row) return null;
		// Never surface a message preview after the principal left the room.
		const preview = isMember ? row.note || row.preview : row.note || "Reminder";
		const untrusted = isMember && row.untrusted === 1;
		this.recordActivity({
			id: `reminder:${row.id}`,
			kind: "reminder",
			room_id: row.room_id,
			room_name: isMember ? roomName : null,
			message_id: row.message_id,
			parent_id: row.parent_id,
			seq: row.seq,
			parent_seq: row.parent_seq,
			actor,
			emoji: null,
			preview,
			untrusted,
			created_at: now,
		});
		return toReminder(row);
	}

	nextAlarmAt(): number | null {
		const sched = this.sql
			.exec<{ t: number | null }>(
				"SELECT MIN(COALESCE(next_attempt_at, send_at)) AS t FROM chat_scheduled_messages WHERE status IN ('pending', 'sending')",
			)
			.one().t;
		const rem = this.sql
			.exec<{ t: number | null }>(
				"SELECT MIN(remind_at) AS t FROM chat_reminders WHERE triggered_at IS NULL AND completed_at IS NULL",
			)
			.one().t;
		if (sched === null) return rem;
		if (rem === null) return sched;
		return Math.min(sched, rem);
	}
}
