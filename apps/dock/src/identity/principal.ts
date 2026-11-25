import { DurableObject } from "cloudflare:workers";
import {
	CHAT_PRESENCE_LIMITS,
	type ChatActivityKind,
	type ChatAddressedReason,
	type ChatNotificationLevel,
	type ChatRoom,
	type ChatWebhookEvent,
	EVENTS_LIMITS,
	EVENTS_SOCKET_CLOSE,
	EVENTS_SOCKET_PROTOCOL,
	type PostingPolicy,
	type PrincipalEvent,
	type RoomKind,
} from "@asterra/contracts";
import { log } from "../platform/index.ts";
import {
	type CredentialBinding,
	type CredentialCheck,
	type CredentialRef,
	checkCredentials,
	credentialKey,
	credentialState,
} from "./access.ts";
import {
	type ActivityActor,
	type ActivityInsert,
	type ActivityRecord,
	CHAT_ACTIVITY_SUBJECT_MIGRATION,
	CHAT_PERSONAL_MIGRATION,
	ChatPersonalStore,
	type DraftRecord,
	type ReminderRecord,
	type SavedRef,
	type ScheduledRecord,
	type SectionRecord,
} from "./chat-personal.ts";
import {
	ChatNotifications,
	NOTIFICATION_MIGRATION,
	type NotificationUpdate,
	type PushDevice,
	SOUND_WINDOW_MS,
} from "./notifications.ts";
import { SERVICE_ACTIVITY_MIGRATION, type ServiceActivityInput, ServiceActivityStore } from "./service-activity.ts";
import {
	type EventsSocketState,
	listensForSound,
	publishPresence,
	readActivity,
	schedulePresence,
	soundListeners,
	viewsRoom,
} from "./socket-presence.ts";
import { getPrincipal } from "./store.ts";

// Each person, agent and service account has one PrincipalDO. It holds their room state, notification
// settings, registered push devices and events sockets, and the activity log of a service account. Its
// name is the principal id.

type Row = Record<string, SqlStorageValue>;

/** A room as the principal sees it, as the room object sends it. Times are in milliseconds. */
export interface ChatRoomView {
	kind: RoomKind;
	name: string | null;
	/** The NFC lowercase form of the name, for the order and the name filter. */
	name_key: string | null;
	topic: string;
	created_at: number;
	created_by_json: string;
	member_count: number;
	role: "owner" | "member";
	last_seq: number;
	last_message_at: number | null;
	last_read_seq: number;
	/** The messages of other members after `last_read_seq`, without deleted messages. At most `UNREAD_COUNT_MAX`. */
	unread_count: number;
	/** The messages after `last_read_seq` that mention the principal. At most `UNREAD_COUNT_MAX`. */
	mention_count: number;
	/** The other member of a direct message, as JSON. */
	peer_json: string | null;
	/** The other members of a group direct message, as JSON array. */
	peers_json?: string | null | undefined;
	version: number;
	/** True when the principal put its star on the room. */
	starred: boolean;
	archived_at?: number | null | undefined;
	posting_policy?: PostingPolicy | undefined;
	can_post?: boolean | undefined;
	retention_days?: number | null | undefined;
	/**
	 * The threads of the room that the principal follows and that have replies, newest reply first, at most
	 * `THREADS_PER_ROOM`. A state from before threads has none.
	 */
	threads?: readonly ChatThreadState[] | undefined;
	/**
	 * The newest change of the room that is for the principal, or null when the room has none. A state
	 * from before this field has no value.
	 */
	addressed?: ChatAddressedState | null | undefined;
}

/**
 * A change of a room that is for a principal, as the room sends it: the facts of the `data` of a chat
 * webhook POST. `at` is in milliseconds.
 */
export interface ChatAddressedState {
	event: ChatWebhookEvent;
	reason: ChatAddressedReason;
	message_id: string;
	/** For a reply in a thread, the first message of the thread. */
	parent_id: string | null;
	author_id: string;
	/** The version that the message got from the change. It grows with each change of the room. */
	version: number;
	at: number;
}

/** A change for the principal in a list, with the room that it is in. */
export interface ChatAddressedEntry {
	room: ChatRoomEntry;
	change: ChatAddressedState;
}

export interface ChatAddressedQuery {
	/** The place of the last change of the page before. */
	after: { at: number; roomId: string } | null;
	limit: number;
}

/** A thread that the principal follows, as the room sends it. Times are in milliseconds. */
export interface ChatThreadState {
	/** The id of the first message of the thread. */
	parent_id: string;
	/** The time of the newest reply that stays. */
	last_reply_at: number;
	/** The replies of other members after the read marker of the thread. At most `UNREAD_COUNT_MAX`. */
	unread_count: number;
}

/** A followed thread in a list, with the room that it is in. */
export interface ChatThreadEntry {
	room: ChatRoomEntry;
	parent_id: string;
	last_reply_at: number;
	unread_count: number;
}

export interface ChatThreadQuery {
	/** Keep only the threads with unread replies. */
	unread: boolean;
	/** The place of the last thread of the page before. */
	after: { lastReplyAt: number; roomId: string; parentId: string } | null;
	limit: number;
}

/**
 * The state of one room for one principal, from the room object. `stamp` grows with each state that
 * the room makes, so the object keeps the newest state, also when an older state arrives later.
 */
export interface ChatRoomState {
	room_id: string;
	/** The id of this membership. Earlier rooms and states for a removed member omit it. */
	membership_id?: string;
	stamp: number;
	/** Null when the principal is not a member of the room now. */
	view: ChatRoomView | null;
}

/** A joined room in a list, with its id. `activity_at` is the time of the newest message, or the time of the creation. */
export interface ChatRoomEntry extends ChatRoomView {
	room_id: string;
	activity_at: number;
}

/** A joined room, as a search reads it. */
export interface ChatRoomRef {
	room_id: string;
	kind: RoomKind;
	name: string | null;
	name_key: string | null;
	peer_json: string | null;
	peers_json?: string | null;
}

export interface ChatRoomQuery {
	/** Keep the rooms whose `name_key` has this text. */
	nameKey: string | null;
	/** The `activity_at` and the id of the last room of the page before. */
	after: { activityAt: number; roomId: string } | null;
	/** Keep the rooms up to this room, with it. Null for no end. */
	until: { activityAt: number; roomId: string } | null;
	/** Keep only the rooms with the star of the principal. */
	starred: boolean;
	limit: number;
}

/** The largest unread count that a room sends. A room with more unread messages sends this number. */
export const UNREAD_COUNT_MAX = 100;

/** The most followed threads of one room that the room sends to a principal: the threads with the newest replies. */
export const THREADS_PER_ROOM = 50;

/**
 * What the Worker tells the object about a new events socket, in `EVENTS_SOCKET_HEADER` of the upgrade
 * request: JSON, percent-encoded. The Worker authenticated the credential, and opens the object of the
 * principal of that credential only.
 */
export interface EventsSocketOpen {
	credential: CredentialRef;
	/**
	 * True for the change feed of an MCP stream. One stream holds many feeds, and the end of one feed
	 * ends the stream. So the object never closes a feed to make room for a new socket.
	 */
	feed: boolean;
}

export const EVENTS_SOCKET_HEADER = "x-soldock-events-socket";

/** A credential that stopped: a session or a key by its id, or each token of an OAuth connection. */
export type EndedCredential = { kind: CredentialRef["kind"]; id: string } | { grantId: string };

/**
 * Tells the object of a principal that a credential stopped, so its events sockets close at once. A
 * failure does not fail the caller: the check of each socket closes it within `EVENTS_SOCKET_RECHECK_MS`.
 */
export async function endEventSockets(
	env: Pick<Env, "PRINCIPAL">,
	principalId: string,
	credential: EndedCredential,
): Promise<void> {
	try {
		await env.PRINCIPAL.get(env.PRINCIPAL.idFromName(principalId)).endSockets(credential);
	} catch (error) {
		log("warn", "events sockets: the close of a stopped credential failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/** The object checks the credential of a socket again when its last check is this old. */
export const EVENTS_SOCKET_RECHECK_MS = 60_000;
/** The longest life of one socket. Then the object closes it, and the Worker authenticates the new one. */
export const EVENTS_SOCKET_MAX_MS = 60 * 60_000;

/** A room of the principal as chat.list_rooms returns it. */
export function chatRoomOutput(entry: ChatRoomEntry): ChatRoom {
	const iso = (ms: number) => new Date(ms).toISOString();
	return {
		id: entry.room_id,
		kind: entry.kind,
		name: entry.name,
		topic: entry.topic,
		peer: entry.peer_json === null ? null : JSON.parse(entry.peer_json),
		peers: entry.peers_json ? JSON.parse(entry.peers_json) : [],
		created_at: iso(entry.created_at),
		created_by: JSON.parse(entry.created_by_json),
		member_count: entry.member_count,
		role: entry.role,
		last_seq: entry.last_seq,
		last_message_at: entry.last_message_at === null ? null : iso(entry.last_message_at),
		last_read_seq: entry.last_read_seq,
		unread: entry.unread_count > 0,
		unread_count: entry.unread_count,
		mention_count: entry.mention_count,
		version: entry.version,
		starred: entry.starred,
		archived_at: entry.archived_at == null ? null : iso(entry.archived_at),
		posting_policy: entry.posting_policy ?? "members",
		can_post: entry.can_post ?? true,
		retention_days: entry.retention_days ?? null,
	};
}

const MIGRATIONS: string[][] = [
	[
		// One row for each room that the principal is or was a member of. A room that the principal left
		// keeps its row with `joined = 0` and its stamp, so an older state cannot add the room again.
		`CREATE TABLE chat_rooms (
			room_id TEXT PRIMARY KEY,
			stamp INTEGER NOT NULL,
			joined INTEGER NOT NULL,
			kind TEXT,
			name TEXT,
			name_key TEXT,
			topic TEXT,
			created_at INTEGER,
			created_by_json TEXT,
			member_count INTEGER,
			role TEXT,
			last_seq INTEGER,
			last_message_at INTEGER,
			activity_at INTEGER,
			last_read_seq INTEGER,
			unread_count INTEGER,
			peer_json TEXT,
			version INTEGER
		) WITHOUT ROWID`,
		"CREATE INDEX chat_rooms_activity ON chat_rooms (joined, activity_at DESC, room_id DESC)",
	],
	[
		// The star of the principal, from the room. A room from before has no star.
		"ALTER TABLE chat_rooms ADD COLUMN starred INTEGER NOT NULL DEFAULT 0",
		`CREATE INDEX chat_rooms_starred ON chat_rooms (activity_at DESC, room_id DESC)
			WHERE joined = 1 AND starred = 1`,
	],
	// The mention count of the principal, from the room. A room from before has 0 until its next state.
	["ALTER TABLE chat_rooms ADD COLUMN mention_count INTEGER NOT NULL DEFAULT 0"],
	// The threads that the principal follows, from the state of each room. Each kept state of a room
	// replaces the rows of that room. `threads_known` is 1 for a room that sent its threads: the first
	// chat.list_threads asks each other joined room once (see the `chat` README).
	[
		`CREATE TABLE chat_threads (
			room_id TEXT NOT NULL,
			parent_id TEXT NOT NULL,
			last_reply_at INTEGER NOT NULL,
			unread_count INTEGER NOT NULL,
			PRIMARY KEY (room_id, parent_id)
		) WITHOUT ROWID`,
		"CREATE INDEX chat_threads_recent ON chat_threads (last_reply_at DESC, room_id DESC, parent_id DESC)",
		`CREATE INDEX chat_threads_unread ON chat_threads (last_reply_at DESC, room_id DESC, parent_id DESC)
			WHERE unread_count > 0`,
		"ALTER TABLE chat_rooms ADD COLUMN threads_known INTEGER NOT NULL DEFAULT 0",
	],
	// The newest change of each room that is for the principal, from the state of the room. A room with
	// no such change has no row. `version` shows a newer change, and `at` gives the order of the list.
	[
		`CREATE TABLE chat_addressed (
			room_id TEXT PRIMARY KEY,
			at INTEGER NOT NULL,
			version INTEGER NOT NULL,
			change_json TEXT NOT NULL
		) WITHOUT ROWID`,
		"CREATE INDEX chat_addressed_recent ON chat_addressed (at DESC, room_id DESC)",
	],
	NOTIFICATION_MIGRATION,
	[
		"ALTER TABLE chat_rooms ADD COLUMN membership_id TEXT",
		// A leave and a new join can produce a single room state. The old override ends in both cases.
		`CREATE TRIGGER chat_notification_membership AFTER UPDATE OF joined, membership_id ON chat_rooms
			WHEN NEW.joined = 0 OR (OLD.membership_id IS NOT NULL AND NEW.membership_id != OLD.membership_id) BEGIN
			DELETE FROM chat_notification_levels WHERE room_id = NEW.room_id; END`,
	],
	["ALTER TABLE chat_notification_sounds ADD COLUMN foreground_devices TEXT NOT NULL DEFAULT '[]'"],
	[
		"ALTER TABLE chat_rooms ADD COLUMN peers_json TEXT",
		"ALTER TABLE chat_rooms ADD COLUMN archived_at INTEGER",
		"ALTER TABLE chat_rooms ADD COLUMN posting_policy TEXT NOT NULL DEFAULT 'members'",
		"ALTER TABLE chat_rooms ADD COLUMN can_post INTEGER NOT NULL DEFAULT 1",
		"ALTER TABLE chat_rooms ADD COLUMN retention_days INTEGER",
		...CHAT_PERSONAL_MIGRATION,
	],
	SERVICE_ACTIVITY_MIGRATION,
	CHAT_ACTIVITY_SUBJECT_MIGRATION,
];

const COLUMNS = `room_id, kind, name, name_key, topic, created_at, created_by_json, member_count, role, last_seq,
	last_message_at, activity_at, last_read_seq, unread_count, mention_count, peer_json, peers_json, version, starred,
	archived_at, posting_policy, can_post, retention_days`;

/** A row of `chat_rooms` as SQLite returns it: booleans are 0 or 1. */
type EntryRow = Omit<ChatRoomEntry, "starred" | "can_post"> & { starred: number; can_post: number } & Row;

function toEntry(row: EntryRow): ChatRoomEntry {
	return { ...row, starred: row.starred === 1, can_post: row.can_post !== 0 };
}

/** The columns of `chat_rooms` with the name of the table, for a join. */
const ROOM_COLUMNS = COLUMNS.split(",")
	.map((column) => `chat_rooms.${column.trim()}`)
	.join(", ");

/** A row of the join of `chat_threads` and `chat_rooms`. */
type ThreadRow = EntryRow & { parent_id: string; thread_last_reply_at: number; thread_unread_count: number };

/**
 * One object for each principal. It keeps the state that other objects send to it, and sends each
 * change of that state to the events sockets of the principal (`/ws/events`).
 */
export class PrincipalDO extends DurableObject<Env> {
	private readonly sql: SqlStorage;
	private readonly notifications: ChatNotifications;
	private readonly personal: ChatPersonalStore;
	private readonly activity: ServiceActivityStore;
	/** The end of the line of socket events. Each event goes out after the one before it, so the events keep their order. */
	private announced: Promise<void> = Promise.resolve();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.notifications = new ChatNotifications(this.sql);
		this.personal = new ChatPersonalStore(this.sql);
		this.activity = new ServiceActivityStore(this.sql);
		this.migrate();
	}

	private migrate(): void {
		this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		const current = Number(
			this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'").toArray()[0]?.value ?? 0,
		);
		for (let version = current; version < MIGRATIONS.length; version++) {
			this.ctx.storage.transactionSync(() => {
				for (const statement of MIGRATIONS[version] ?? []) this.sql.exec(statement);
				this.sql.exec(
					"INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
					String(version + 1),
				);
			});
		}
	}

	/**
	 * Keeps the state of each room in the list. A state whose stamp is not higher than the stamp of the
	 * kept state changes nothing. So a second delivery, and an older state that arrives late, do no harm.
	 * Each state that the object keeps goes to the events sockets after the write. The call does not
	 * wait for the sockets, so a change of a room never waits for the credential check of a socket.
	 */
	applyChatRoomStates(states: readonly ChatRoomState[]): void {
		const hasSockets = this.ctx.getWebSockets().length > 0;
		const beforeUnread = hasSockets ? this.notifications.unreadCount() : null;
		const kept: { room_id: string; joined: number }[] = [];
		/** The rooms whose followed threads changed in this call. Each one gets `chat.threads`. */
		const threadRooms: string[] = [];
		/** The changes for the principal that are new in this call. Each one gets `chat.addressed`. */
		const addressed: { room_id: string; change: ChatAddressedState }[] = [];
		/** The rooms that were joined before this call. Only those get `chat.room_removed`. */
		let joinedBefore = new Set<string>();
		this.ctx.storage.transactionSync(() => {
			joinedBefore = new Set(
				this.sql
					.exec<{ room_id: string }>(
						`SELECT room_id FROM chat_rooms JOIN json_each(?1) wanted ON wanted.value = chat_rooms.room_id
						WHERE joined = 1`,
						JSON.stringify(states.map((state) => state.room_id)),
					)
					.toArray()
					.map((row) => row.room_id),
			);
			for (const state of states) {
				const view = state.view;
				const row = this.sql.exec<{ room_id: string; joined: number }>(
					`INSERT INTO chat_rooms (room_id, stamp, joined, kind, name, name_key, topic, created_at, created_by_json,
						member_count, role, last_seq, last_message_at, activity_at, last_read_seq, unread_count, peer_json, peers_json, version,
						starred, mention_count, membership_id, archived_at, posting_policy, can_post, retention_days)
					VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26)
					ON CONFLICT (room_id) DO UPDATE SET stamp = excluded.stamp, joined = excluded.joined, kind = excluded.kind,
						name = excluded.name, name_key = excluded.name_key, topic = excluded.topic,
						created_at = excluded.created_at, created_by_json = excluded.created_by_json,
						member_count = excluded.member_count, role = excluded.role, last_seq = excluded.last_seq,
						last_message_at = excluded.last_message_at, activity_at = excluded.activity_at,
						last_read_seq = excluded.last_read_seq, unread_count = excluded.unread_count,
						peer_json = excluded.peer_json, peers_json = excluded.peers_json, version = excluded.version,
						starred = excluded.starred, mention_count = excluded.mention_count,
						membership_id = CASE WHEN excluded.joined = 1 THEN COALESCE(excluded.membership_id, chat_rooms.membership_id) END,
						archived_at = excluded.archived_at, posting_policy = excluded.posting_policy,
						can_post = excluded.can_post, retention_days = excluded.retention_days
					WHERE excluded.stamp > chat_rooms.stamp
					RETURNING room_id, joined`,
					state.room_id,
					state.stamp,
					view ? 1 : 0,
					view?.kind ?? null,
					view?.name ?? null,
					view?.name_key ?? null,
					view?.topic ?? null,
					view?.created_at ?? null,
					view?.created_by_json ?? null,
					view?.member_count ?? null,
					view?.role ?? null,
					view?.last_seq ?? null,
					view?.last_message_at ?? null,
					view ? (view.last_message_at ?? view.created_at) : null,
					view?.last_read_seq ?? null,
					view?.unread_count ?? null,
					view?.peer_json ?? null,
					view?.peers_json ?? null,
					view?.version ?? null,
					view?.starred ? 1 : 0,
					view?.mention_count ?? 0,
					state.membership_id ?? null,
					view?.archived_at ?? null,
					view?.posting_policy ?? "members",
					view?.can_post === false ? 0 : 1,
					view?.retention_days ?? null,
				);
				const accepted = row.toArray();
				kept.push(...accepted);
				if (accepted.length > 0 && view === null) {
					this.personal.removeRoomPersonalState(state.room_id);
				}
				// A state from a room on an older version has no threads: the rows of the room stay as they were.
				const threads = view === null ? [] : view.threads;
				if (accepted.length > 0 && threads !== undefined) {
					if (view) this.sql.exec("UPDATE chat_rooms SET threads_known = 1 WHERE room_id = ?", state.room_id);
					if (this.replaceThreads(state.room_id, threads)) threadRooms.push(state.room_id);
				}
				if (accepted.length > 0) {
					const change = this.keepAddressed(state.room_id, view === null ? null : view.addressed);
					if (change) addressed.push({ room_id: state.room_id, change });
				}
			}
		});
		if (kept.length === 0 || !hasSockets) return;
		// The events come from the rows after this write. They go out after the events from before, in the
		// order of the writes. A failure of the events never fails the write. The object stays awake until
		// the send ends.
		this.ctx.waitUntil(
			this.publish(() => {
				const joined = new Map(
					this.chatRoomsOf(kept.filter((row) => row.joined === 1).map((row) => row.room_id)).rooms.map((entry) => [
						entry.room_id,
						entry,
					]),
				);
				const events: PrincipalEvent[] = [];
				for (const row of kept) {
					const entry = joined.get(row.room_id);
					if (entry) events.push({ type: "chat.room", room: chatRoomOutput(entry) });
					else if (joinedBefore.has(row.room_id)) events.push({ type: "chat.room_removed", room_id: row.room_id });
				}
				for (const roomId of threadRooms) events.push({ type: "chat.threads", room_id: roomId });
				for (const { room_id, change } of addressed) {
					events.push({ type: "chat.addressed", room_id, ...change, at: new Date(change.at).toISOString() });
				}
				return events;
			}),
		);
		const unread = this.notifications.unreadCount();
		if (unread !== beforeUnread) {
			this.ctx.waitUntil(
				this.enqueue([JSON.stringify({ type: "chat.unread", unread_count: unread } satisfies PrincipalEvent)], null),
			);
		}
	}

	/**
	 * Replaces the followed threads of one room with the threads of its new state. Returns true when they
	 * changed. A room that the principal left sends no view, so its threads go away.
	 */
	private replaceThreads(roomId: string, threads: readonly ChatThreadState[]): boolean {
		const next = threads
			.slice(0, THREADS_PER_ROOM)
			.map((thread) => [thread.parent_id, thread.last_reply_at, thread.unread_count] as const)
			.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
		const before = this.sql
			.exec<{ parent_id: string; last_reply_at: number; unread_count: number }>(
				"SELECT parent_id, last_reply_at, unread_count FROM chat_threads WHERE room_id = ? ORDER BY parent_id",
				roomId,
			)
			.toArray()
			.map((row) => [row.parent_id, row.last_reply_at, row.unread_count] as const);
		// Most states of a room change no thread: those write nothing.
		if (JSON.stringify(next) === JSON.stringify(before)) return false;
		this.sql.exec("DELETE FROM chat_threads WHERE room_id = ?", roomId);
		for (const [parentId, lastReplyAt, unreadCount] of next) {
			this.sql.exec(
				"INSERT OR REPLACE INTO chat_threads (room_id, parent_id, last_reply_at, unread_count) VALUES (?, ?, ?, ?)",
				roomId,
				parentId,
				lastReplyAt,
				unreadCount,
			);
		}
		return true;
	}

	/**
	 * Keeps the newest change of one room that is for the principal. Returns the change when it is newer
	 * than the kept one: only that change sends `chat.addressed`. Each state of a room has its newest
	 * change, so most states have the kept change again, and write nothing. `null` removes the row: the
	 * room has no such change, or the principal left it. A state from a room on an older version has no
	 * value: the row stays as it was.
	 */
	private keepAddressed(roomId: string, next: ChatAddressedState | null | undefined): ChatAddressedState | null {
		if (next === undefined) return null;
		if (next === null) {
			this.sql.exec("DELETE FROM chat_addressed WHERE room_id = ?", roomId);
			return null;
		}
		const kept = this.sql
			.exec<{ version: number }>("SELECT version FROM chat_addressed WHERE room_id = ?", roomId)
			.toArray()[0];
		if (kept && kept.version >= next.version) return null;
		this.sql.exec(
			"INSERT OR REPLACE INTO chat_addressed (room_id, at, version, change_json) VALUES (?, ?, ?, ?)",
			roomId,
			next.at,
			next.version,
			JSON.stringify(next),
		);
		return next;
	}

	/**
	 * A page of the changes for the principal in its joined rooms, one for each room, with the newest
	 * change first. One row more than `limit` tells that a next page exists.
	 */
	listChatAddressed(query: ChatAddressedQuery): { changes: ChatAddressedEntry[] } {
		// The page reads `chat_addressed` first (CROSS JOIN), in the order of the index `chat_addressed_recent`,
		// and seeks to the cursor with the row value.
		const after = query.after;
		const rows = this.sql
			.exec<EntryRow & { change_json: string }>(
				`SELECT chat_addressed.change_json, ${ROOM_COLUMNS}
				FROM chat_addressed CROSS JOIN chat_rooms ON chat_rooms.room_id = chat_addressed.room_id
				WHERE chat_rooms.joined = 1
					${after ? "AND (chat_addressed.at, chat_addressed.room_id) < (?2, ?3)" : ""}
				ORDER BY chat_addressed.at DESC, chat_addressed.room_id DESC
				LIMIT ?1`,
				query.limit + 1,
				...(after ? [after.at, after.roomId] : []),
			)
			.toArray();
		return {
			changes: rows.map(({ change_json, ...room }) => ({
				room: toEntry(room as EntryRow),
				change: JSON.parse(change_json) as ChatAddressedState,
			})),
		};
	}

	/**
	 * The state of the first fill of the threads: `seeded` as for `listChatRooms`, `filled` after each joined
	 * room sent its threads one time, and up to `limit` joined rooms that did not, the newest activity first.
	 */
	threadFill(limit: number): { seeded: boolean; filled: boolean; rooms: string[] } {
		const filled = this.sql.exec("SELECT 1 FROM meta WHERE key = 'chat_threads_filled'").toArray().length > 0;
		const rooms = filled
			? []
			: this.sql
					.exec<{ room_id: string }>(
						`SELECT room_id FROM chat_rooms WHERE joined = 1 AND threads_known = 0
						ORDER BY activity_at DESC, room_id DESC LIMIT ?`,
						limit,
					)
					.toArray()
					.map((row) => row.room_id);
		return { seeded: this.chatSeeded(), filled, rooms };
	}

	/**
	 * Keeps the states of a part of the first fill of the threads. Each room of `answered` counts as known,
	 * also when its state was not newer than the kept one. `done` records that the fill is complete.
	 */
	fillChatThreads(states: readonly ChatRoomState[], answered: readonly string[], done: boolean): void {
		this.applyChatRoomStates(states);
		this.sql.exec(
			"UPDATE chat_rooms SET threads_known = 1 WHERE room_id IN (SELECT value FROM json_each(?))",
			JSON.stringify(answered),
		);
		if (done) this.sql.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('chat_threads_filled', '1')");
	}

	/**
	 * A page of the followed threads of the joined rooms, with the newest reply first. One row more than
	 * `limit` tells that a next page exists. `unreadThreads` counts the threads with unread replies, at most
	 * `UNREAD_COUNT_MAX`.
	 */
	listChatThreads(query: ChatThreadQuery): { threads: ChatThreadEntry[]; unreadThreads: number } {
		// The page reads `chat_threads` first (CROSS JOIN), in the order of an index: `chat_threads_unread` for
		// the filter, else `chat_threads_recent`. The conditions are in the text, so SQLite picks the index and
		// seeks to the cursor with the row value.
		const after = query.after;
		const rows = this.sql
			.exec<ThreadRow>(
				`SELECT chat_threads.parent_id, chat_threads.last_reply_at AS thread_last_reply_at,
					chat_threads.unread_count AS thread_unread_count, ${ROOM_COLUMNS}
				FROM chat_threads CROSS JOIN chat_rooms ON chat_rooms.room_id = chat_threads.room_id
				WHERE chat_rooms.joined = 1 ${query.unread ? "AND chat_threads.unread_count > 0" : ""}
					${after ? "AND (chat_threads.last_reply_at, chat_threads.room_id, chat_threads.parent_id) < (?2, ?3, ?4)" : ""}
				ORDER BY chat_threads.last_reply_at DESC, chat_threads.room_id DESC, chat_threads.parent_id DESC
				LIMIT ?1`,
				query.limit + 1,
				...(after ? [after.lastReplyAt, after.roomId, after.parentId] : []),
			)
			.toArray();
		const unreadThreads = this.sql
			.exec<{ n: number }>(
				`SELECT COUNT(*) AS n FROM (SELECT 1 FROM chat_threads
					CROSS JOIN chat_rooms ON chat_rooms.room_id = chat_threads.room_id
				WHERE chat_rooms.joined = 1 AND chat_threads.unread_count > 0 LIMIT ?)`,
				UNREAD_COUNT_MAX,
			)
			.one().n;
		return {
			threads: rows.map(({ parent_id, thread_last_reply_at, thread_unread_count, ...room }) => ({
				room: toEntry(room as EntryRow),
				parent_id,
				last_reply_at: thread_last_reply_at,
				unread_count: thread_unread_count,
			})),
			unreadThreads,
		};
	}

	/**
	 * A page of the joined rooms, with the newest activity first. One row more than `limit` tells that a
	 * next page exists. `seeded` is false until the first fill: see `seedChat`.
	 */
	listChatRooms(query: ChatRoomQuery): { seeded: boolean; rooms: ChatRoomEntry[] } {
		// The filter of the star is in the text of the query, so SQLite can use the partial index of the stars.
		const rooms = this.sql
			.exec<EntryRow>(
				`SELECT ${COLUMNS} FROM chat_rooms
				WHERE joined = 1 ${query.starred ? "AND starred = 1" : ""}
					AND (?1 IS NULL OR instr(name_key, ?1) > 0)
					AND (?2 IS NULL OR activity_at < ?2 OR (activity_at = ?2 AND room_id < ?3))
					AND (?5 IS NULL OR activity_at > ?5 OR (activity_at = ?5 AND room_id >= ?6))
				ORDER BY activity_at DESC, room_id DESC LIMIT ?4`,
				query.nameKey,
				query.after?.activityAt ?? null,
				query.after?.roomId ?? null,
				query.limit + 1,
				query.until?.activityAt ?? null,
				query.until?.roomId ?? null,
			)
			.toArray()
			.map(toEntry);
		return { seeded: this.chatSeeded(), rooms };
	}

	/** The joined rooms of the list that this object has. `seeded` is as for `listChatRooms`. */
	chatRoomsOf(roomIds: readonly string[]): { seeded: boolean; rooms: ChatRoomEntry[] } {
		const seeded = this.chatSeeded();
		if (roomIds.length === 0) return { seeded, rooms: [] };
		const rooms = this.sql
			.exec<EntryRow>(
				`SELECT ${COLUMNS} FROM chat_rooms JOIN json_each(?1) wanted ON wanted.value = chat_rooms.room_id
				WHERE joined = 1`,
				JSON.stringify([...new Set(roomIds)]),
			)
			.toArray()
			.map(toEntry);
		return { seeded, rooms };
	}

	/**
	 * Each joined room, with what a search needs: the id, and the kind, the name and the other member, which
	 * find the rooms of an `in:` filter. `seeded` is as for `listChatRooms`.
	 */
	chatRoomRefs(): { seeded: boolean; rooms: ChatRoomRef[] } {
		const rooms = this.sql
			.exec<ChatRoomRef & Row>(
				"SELECT room_id, kind, name, name_key, peer_json, peers_json FROM chat_rooms WHERE joined = 1",
			)
			.toArray();
		return { seeded: this.chatSeeded(), rooms };
	}

	/** The rooms of the list that this object has no row for: no state came from them. In the order of the list. */
	unknownChatRooms(roomIds: readonly string[]): string[] {
		if (roomIds.length === 0) return [];
		return this.sql
			.exec<{ value: string }>(
				`SELECT wanted.value FROM json_each(?1) wanted
				WHERE NOT EXISTS (SELECT 1 FROM chat_rooms WHERE room_id = wanted.value) ORDER BY wanted.key`,
				JSON.stringify(roomIds),
			)
			.toArray()
			.map((row) => row.value);
	}

	/**
	 * False until the rooms from before this object got their first state. A principal that joined rooms
	 * before the object existed has those rooms in the index in D1 only. See `chat` README.
	 */
	private chatSeeded(): boolean {
		return this.sql.exec("SELECT 1 FROM meta WHERE key = 'chat_seeded'").toArray().length > 0;
	}

	/** Keeps the states of a part of the first fill. `done` records that the fill is complete. */
	seedChat(states: readonly ChatRoomState[], done: boolean): void {
		this.applyChatRoomStates(states);
		if (done) this.sql.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('chat_seeded', '1')");
	}

	getChatNotificationSettings() {
		return {
			settings: this.notifications.settings(),
			unread_count: this.notifications.unreadCount(),
			unread_complete: this.chatSeeded(),
		};
	}

	updateChatNotificationSettings(input: NotificationUpdate) {
		return this.notifications.update(input);
	}

	setChatNotificationLevel(state: ChatRoomState, level: ChatNotificationLevel | null): boolean {
		this.applyChatRoomStates([state]);
		// A newer state of the same membership still accepts the change. A later join must reject it.
		const member = this.sql
			.exec(
				"SELECT 1 FROM chat_rooms WHERE room_id = ? AND joined = 1 AND (membership_id = ? OR stamp = ?)",
				state.room_id,
				state.membership_id ?? null,
				state.stamp,
			)
			.toArray();
		if (!member.length) return false;
		this.notifications.setRoomLevel(state.room_id, level);
		return true;
	}

	chatNotificationAllowed(
		roomId: string,
		reason: string | undefined,
		occurredAt: number,
		membershipId: string,
	): boolean {
		return this.notifications.policy(roomId, reason, occurredAt, membershipId).allowed;
	}

	async subscribePush(device: PushDevice, credential: CredentialRef): Promise<boolean> {
		if (this.notifications.register(device, credential)) return true;
		// A device can sign out without another message to trigger cleanup.
		const devices = this.notifications.credentials();
		const checks = await checkCredentials(
			this.env.DIRECTORY,
			devices.map(({ ref }) => ref),
		);
		for (const [index, entry] of devices.entries()) {
			if (checks[index] === "ended" || checks[index] === "renew") this.notifications.expire(entry.id);
		}
		return this.notifications.register(device, credential);
	}

	unsubscribePush(endpoint: string): boolean {
		return this.notifications.unsubscribe(endpoint);
	}

	expirePushSubscription(id: string): void {
		this.notifications.expire(id);
	}

	/** The room outbox holds each post until the queue accepts it. A retry keeps the device ids. */
	async chatNotificationDevices(event: {
		principalId: string;
		membershipId: string;
		roomId: string;
		messageId: string;
		parentId: string | null;
		reason: string | undefined;
		occurredAt: number;
	}): Promise<string[]> {
		const { roomId, occurredAt } = event;
		const policy = this.notifications.policy(roomId, event.reason, occurredAt, event.membershipId);
		if (!policy.allowed) return [];
		const now = Date.now();
		const recent = now - occurredAt <= SOUND_WINDOW_MS;
		const listening = recent && policy.sound && soundListeners(this.ctx, occurredAt, now).length > 0;
		const authorized =
			listening &&
			(await this.env.CHAT_ROOM.get(this.env.CHAT_ROOM.idFromName(roomId)).canNotifyWebhook(
				event.principalId,
				event.messageId,
				event.membershipId,
			));
		const devices = viewsRoom(this.ctx, roomId) ? [] : this.notifications.credentials(occurredAt);
		if (authorized) {
			const listeners = new Set(
				soundListeners(this.ctx, occurredAt, Date.now()).map((state) => credentialKey(state.credential)),
			);
			const foregroundDevices = devices.filter(({ ref }) => listeners.has(credentialKey(ref))).map(({ id }) => id);
			if (listeners.size && this.notifications.claimSound(event.messageId, occurredAt, foregroundDevices)) {
				const sound: PrincipalEvent = {
					type: "chat.notification",
					room_id: roomId,
					message_id: event.messageId,
					parent_id: event.parentId,
				};
				this.ctx.waitUntil(this.enqueue([JSON.stringify(sound)], occurredAt));
			}
		}
		return devices.map(({ id }) => id);
	}

	/** Check the current registration and the credential that created it before each outbound push. */
	async pushTarget(
		id: string,
		roomId: string,
		reason: string,
		occurredAt: number,
		roomUnread: number,
		membershipId: string,
		messageId?: string,
	) {
		const device = this.notifications.device(id, occurredAt);
		if (!device) return null;
		const credential = JSON.parse(device.credential) as CredentialRef;
		const [state] = await checkCredentials(this.env.DIRECTORY, [credential]);
		if (state !== "live") {
			this.expirePushSubscription(id);
			return null;
		}
		const { allowed, sound } = this.notifications.policy(roomId, reason, occurredAt, membershipId);
		if (!allowed || viewsRoom(this.ctx, roomId) || !this.notifications.device(id, occurredAt)) return null;
		const projected =
			this.sql
				.exec<{ unread_count: number }>("SELECT unread_count FROM chat_rooms WHERE joined = 1 AND room_id = ?", roomId)
				.toArray()[0]?.unread_count ?? 0;
		const now = Date.now();
		const foreground =
			sound &&
			messageId !== undefined &&
			now - occurredAt <= SOUND_WINDOW_MS &&
			this.notifications.sentForegroundSound(messageId, id) &&
			soundListeners(this.ctx, occurredAt, now).some(
				(socket) => credentialKey(socket.credential) === credentialKey(credential),
			);
		return {
			endpoint: device.endpoint,
			foreground_sound: foreground,
			keys: { p256dh: device.p256dh, auth: device.auth },
			unread_count: this.notifications.unreadCount() - projected + roomUnread,
			sound,
		};
	}

	// --- The events sockets -----------------------------------------------------------------------

	/**
	 * Accepts an events socket of the principal. The Worker authenticated the caller, and sends its
	 * credential in `EVENTS_SOCKET_HEADER`. The object can sleep while its sockets wait. The first event is
	 * `hello`.
	 */
	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			return new Response("This object accepts sockets only.", { status: 426, headers: { upgrade: "websocket" } });
		}
		const open = JSON.parse(
			decodeURIComponent(request.headers.get(EVENTS_SOCKET_HEADER) ?? "null"),
		) as EventsSocketOpen | null;
		if (!open) return new Response("The request does not say who opens the socket.", { status: 400 });

		// At the limit, a new socket closes the oldest socket that is not a feed. A feed is never closed
		// for this, and a new feed is refused: its stream then leaves the resource out.
		const sockets = this.ctx.getWebSockets();
		if (sockets.length >= EVENTS_LIMITS.socketsPerPrincipal) {
			const oldest = open.feed
				? undefined
				: sockets
						.map((socket) => ({ socket, state: socket.deserializeAttachment() as EventsSocketState | null }))
						.filter((entry) => entry.state?.feed !== true)
						.sort((a, b) => (a.state?.openedAt ?? 0) - (b.state?.openedAt ?? 0))[0];
			if (!oldest) return new Response("The principal has too many sockets.", { status: 409 });
			this.end(oldest.socket, EVENTS_SOCKET_CLOSE.replaced, "The principal opened too many sockets.");
		}

		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server);
		// The socket starts without a check. A sign-out or a revoke can come between the check of the
		// Worker and this accept, and `endSockets` then did not see the socket. So an event waits for the
		// first check of the object, which starts now.
		server.serializeAttachment({
			credential: open.credential,
			feed: open.feed === true,
			openedAt: Date.now(),
			checkedAt: 0,
		} satisfies EventsSocketState);
		// The runtime answers a ping by itself, so a client can test its connection and the object stays asleep.
		this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
		this.send(server, JSON.stringify({ type: "hello", protocol: EVENTS_SOCKET_PROTOCOL } satisfies PrincipalEvent));
		this.sql.exec(
			"INSERT OR IGNORE INTO meta (key, value) VALUES ('presence_principal', ?)",
			open.credential.principalId,
		);
		this.ctx.waitUntil(this.enqueue([]));
		await schedulePresence(this.ctx);
		return new Response(null, { status: 101, webSocket: client });
	}

	/**
	 * Adds one entry to the activity log of a service account. The Worker calls it after a call of the
	 * service account, or after a change to it. It checks no access: only the Worker calls it.
	 */
	recordServiceActivity(entry: ServiceActivityInput): void {
		this.activity.record(entry);
	}

	/** One page of the activity log, with the newest entry first. The handler checks the access first. */
	listServiceActivity(options: { before: number | null; keyId: string | null; limit: number }) {
		return this.activity.list({ ...options, now: Date.now() });
	}

	/**
	 * Closes each socket of a credential that stopped, with `ended`: a session that signed out, a
	 * revoked key, or each token of a revoked OAuth connection. Returns the number of closed sockets.
	 */
	endSockets(match: EndedCredential): number {
		let ended = 0;
		for (const socket of this.ctx.getWebSockets()) {
			const credential = (socket.deserializeAttachment() as EventsSocketState | null)?.credential;
			if (!credential) continue;
			const hit =
				"grantId" in match
					? credential.grantId === match.grantId
					: credential.kind === match.kind && credential.id === match.id;
			if (!hit) continue;
			this.end(socket, EVENTS_SOCKET_CLOSE.ended, "The credential stopped.");
			ended += 1;
		}
		if (ended > 0) log("info", "events sockets closed: the credential stopped", { sockets: ended });
		return ended;
	}

	override async alarm(): Promise<void> {
		await this.enqueue([]);
		await publishPresence(this.ctx, this.env.DIRECTORY);
		await this.processDuePersonalWork();
	}

	private async schedulePersonalAlarm(): Promise<void> {
		const next = this.personal.nextAlarmAt();
		if (next === null) return;
		const due = Math.max(Date.now(), next);
		const current = await this.ctx.storage.getAlarm();
		if (current === null || due < current) await this.ctx.storage.setAlarm(due);
	}

	/** Records one or more activity items (idempotent by id) and pushes a live count event. */
	recordChatActivity(items: readonly ActivityInsert[]): void {
		let added = 0;
		const seeded =
			this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'chat_seeded'").toArray()[0]?.value === "1";
		this.ctx.storage.transactionSync(() => {
			for (const item of items) {
				// A request of an agent goes to a person who manages the account of the request. That person is
				// usually not a member of the room, so the check of the membership does not apply to it.
				if (item.kind !== "member_request") {
					const roomRow = this.sql
						.exec<{ joined: number }>("SELECT joined FROM chat_rooms WHERE room_id = ?", item.room_id)
						.toArray()[0];
					if (roomRow ? roomRow.joined !== 1 : seeded) continue;
				}
				if (this.personal.recordActivity(item)) added += 1;
			}
		});
		if (added > 0 && this.ctx.getWebSockets().length > 0) {
			const unread = this.personal.activityUnreadCount();
			this.ctx.waitUntil(this.publish(() => [{ type: "chat.activity", unread_count: unread }]));
		}
	}

	deleteChatActivities(ids: readonly string[]): number {
		return this.personal.deleteActivities(ids);
	}

	listChatActivity(query: {
		filter: "all" | "unread" | ChatActivityKind;
		after: { createdAt: number; id: string } | null;
		limit: number;
	}): { items: ActivityRecord[]; unreadCount: number } {
		return this.personal.listActivity(query);
	}

	markChatActivityRead(activityId?: string): number {
		const unread = this.personal.markActivityRead(activityId, Date.now());
		if (this.ctx.getWebSockets().length > 0) {
			this.ctx.waitUntil(this.publish(() => [{ type: "chat.activity", unread_count: unread }]));
		}
		return unread;
	}

	listChatSections(): SectionRecord[] {
		return this.personal.listSections();
	}

	createChatSection(id: string, name: string): SectionRecord | "full" {
		const created = this.personal.createSection(id, name, Date.now());
		if (created !== "full" && this.ctx.getWebSockets().length > 0) {
			this.ctx.waitUntil(this.publish(() => [{ type: "chat.sections" }]));
		}
		return created;
	}

	updateChatSection(
		id: string,
		patch: { name?: string | undefined; position?: number | undefined },
	): SectionRecord | null {
		const updated = this.personal.updateSection(id, patch);
		if (updated && this.ctx.getWebSockets().length > 0) {
			this.ctx.waitUntil(this.publish(() => [{ type: "chat.sections" }]));
		}
		return updated;
	}

	deleteChatSection(id: string): boolean {
		const deleted = this.personal.deleteSection(id);
		if (deleted && this.ctx.getWebSockets().length > 0) {
			this.ctx.waitUntil(this.publish(() => [{ type: "chat.sections" }]));
		}
		return deleted;
	}

	setChatRoomSection(roomId: string, sectionId: string | null): "ok" | "no_section" {
		const result = this.personal.setRoomSection(roomId, sectionId);
		if (result === "ok" && this.ctx.getWebSockets().length > 0) {
			this.ctx.waitUntil(this.publish(() => [{ type: "chat.sections" }]));
		}
		return result;
	}

	saveChatMessage(roomId: string, messageId: string): { savedAt: number } | "full" {
		return this.personal.saveMessage(roomId, messageId, Date.now());
	}

	unsaveChatMessage(roomId: string, messageId: string): boolean {
		return this.personal.unsaveMessage(roomId, messageId);
	}

	listSavedChatMessages(query: {
		after: { savedAt: number; roomId: string; messageId: string } | null;
		limit: number;
	}): SavedRef[] {
		return this.personal.listSavedMessages(query);
	}

	saveChatDraft(input: {
		roomId: string;
		parentId: string | null;
		bodyJson: string;
		text: string;
		markdown: string;
	}): DraftRecord {
		const saved = this.personal.saveDraft({ ...input, now: Date.now() });
		if (this.ctx.getWebSockets().length > 0) {
			this.ctx.waitUntil(
				this.publish(() => [{ type: "chat.draft", room_id: saved.room_id, parent_id: saved.parent_id }]),
			);
		}
		return saved;
	}

	deleteChatDraft(roomId: string, parentId: string | null): boolean {
		const deleted = this.personal.deleteDraft(roomId, parentId);
		if (deleted && this.ctx.getWebSockets().length > 0) {
			this.ctx.waitUntil(this.publish(() => [{ type: "chat.draft", room_id: roomId, parent_id: parentId }]));
		}
		return deleted;
	}

	listChatDrafts(roomId?: string): DraftRecord[] {
		return this.personal.listDrafts(roomId);
	}

	async scheduleChatMessage(input: {
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
		credentialBindingJson?: string | null;
	}): Promise<ScheduledRecord | "full"> {
		const created = this.personal.createScheduled({ ...input, now: Date.now() });
		if (created !== "full") {
			await this.schedulePersonalAlarm();
			if (this.ctx.getWebSockets().length > 0) {
				this.ctx.waitUntil(
					this.publish(() => [{ type: "chat.scheduled", scheduled_id: created.id, room_id: created.room_id }]),
				);
			}
		}
		return created;
	}

	async listScheduledChatMessages(
		roomId?: string,
		status: "pending" | "sent" | "failed" | "all" = "pending",
	): Promise<ScheduledRecord[]> {
		await this.processDuePersonalWork();
		return this.personal.listScheduled(roomId, status);
	}

	async updateScheduledChatMessage(
		id: string,
		patch: { text?: string; bodyJson?: string; markdown?: string; sendAt?: number },
	): Promise<ScheduledRecord | "not_found" | "not_pending"> {
		const updated = this.personal.updateScheduled(id, patch);
		if (typeof updated === "object") {
			await this.schedulePersonalAlarm();
			if (this.ctx.getWebSockets().length > 0) {
				this.ctx.waitUntil(
					this.publish(() => [{ type: "chat.scheduled", scheduled_id: updated.id, room_id: updated.room_id }]),
				);
			}
		}
		return updated;
	}

	cancelScheduledChatMessage(id: string): boolean {
		return this.personal.cancelScheduled(id);
	}

	async createChatReminder(input: {
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
		actor: ActivityActor;
	}): Promise<ReminderRecord | "full"> {
		this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('self_actor', ?)", JSON.stringify(input.actor));
		const created = this.personal.createReminder({ ...input, now: Date.now() });
		if (created !== "full") await this.schedulePersonalAlarm();
		return created;
	}

	async listChatReminders(includeCompleted: boolean): Promise<ReminderRecord[]> {
		await this.processDuePersonalWork();
		return this.personal.listReminders(includeCompleted);
	}

	completeChatReminder(id: string): ReminderRecord | null {
		return this.personal.completeReminder(id, Date.now());
	}

	deleteChatReminder(id: string): boolean {
		return this.personal.deleteReminder(id);
	}

	/** Fires due reminders and delivers due scheduled messages. Safe to call repeatedly. */
	async processDuePersonalWork(): Promise<void> {
		const now = Date.now();
		const events: PrincipalEvent[] = [];

		// 1. Trigger due reminders.
		const dueRem = this.personal.dueReminders(now);
		if (dueRem.length > 0) {
			const actorRow = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'self_actor'").toArray()[0];
			const selfActor: ActivityActor = actorRow
				? (JSON.parse(actorRow.value) as ActivityActor)
				: { principal_id: "unknown", kind: "human", display_name: "Reminder" };
			for (const reminder of dueRem) {
				const roomRow = this.sql
					.exec<{ name: string | null; joined: number }>(
						"SELECT name, joined FROM chat_rooms WHERE room_id = ?",
						reminder.room_id,
					)
					.toArray()[0];
				const isMember = roomRow?.joined === 1;
				const fired = this.personal.markReminderTriggered(reminder.id, now, selfActor, roomRow?.name ?? null, isMember);
				if (fired) {
					events.push({
						type: "chat.reminder",
						reminder_id: fired.id,
						room_id: fired.room_id,
						message_id: fired.message_id,
						note: isMember ? fired.note || fired.preview : fired.note || "Reminder",
					});
				}
			}
			events.push({ type: "chat.activity", unread_count: this.personal.activityUnreadCount() });
		}

		// 2. Deliver due scheduled messages.
		const MAX_SCHEDULED_ATTEMPTS = 5;
		const dueSched = this.personal.dueScheduled(now);
		for (const item of dueSched) {
			let actor: { principal_id: string; kind: "human" | "agent"; display_name: string } | null = null;
			if (item.credential_binding_json) {
				const binding = JSON.parse(item.credential_binding_json) as CredentialBinding;
				const checked = await credentialState(this.env.DIRECTORY, binding);
				if (checked.state !== "live") {
					if (this.personal.claimScheduledForSend(item.id, item.send_at, item.text, item.body_json, now)) {
						this.personal.markScheduledFailed(
							item.id,
							checked.state === "archived"
								? "Principal is archived."
								: "The credential that scheduled this message is no longer valid.",
						);
						events.push({ type: "chat.scheduled", scheduled_id: item.id, room_id: item.room_id });
					}
					continue;
				}
				// The room checks the membership of the sender when it posts: a member without chat.write gets
				// forbidden, and the message fails.
				actor = {
					principal_id: checked.principal.id,
					kind: checked.principal.kind,
					display_name: checked.principal.display_name,
				};
			} else {
				// A message from before the credential binding. A deleted principal has no record.
				const found = await getPrincipal(this.env.DIRECTORY, item.principal_id);
				const principal = found?.archived_at === null ? found : null;
				if (!principal) {
					if (this.personal.claimScheduledForSend(item.id, item.send_at, item.text, item.body_json, now)) {
						this.personal.markScheduledFailed(item.id, "Principal is archived or deleted.");
						events.push({ type: "chat.scheduled", scheduled_id: item.id, room_id: item.room_id });
					}
					continue;
				}
				actor = { principal_id: principal.id, kind: principal.kind, display_name: principal.display_name };
			}
			// Re-verify and atomically claim after the credential await so a concurrent cancel or edit stops delivery.
			if (!this.personal.claimScheduledForSend(item.id, item.send_at, item.text, item.body_json, now)) {
				continue;
			}
			try {
				const room = this.env.CHAT_ROOM.get(this.env.CHAT_ROOM.idFromName(item.room_id));
				const result = await room.postScheduledMessage({
					roomId: item.room_id,
					actor,
					scheduledId: item.id,
					text: item.text,
					bodyJson: item.body_json,
					parentId: item.parent_id,
					alsoInRoom: item.also_in_room,
				});
				if ("error" in result) {
					if (result.error.code === "rate_limited") {
						const attempts = item.attempts + 1;
						if (attempts >= MAX_SCHEDULED_ATTEMPTS) {
							this.personal.markScheduledFailed(item.id, "Rate limited after maximum delivery attempts.");
							events.push({ type: "chat.scheduled", scheduled_id: item.id, room_id: item.room_id });
						} else {
							this.personal.markScheduledRetry(
								item.id,
								attempts,
								now + 60_000 * 2 ** (attempts - 1),
								result.error.message,
							);
						}
					} else {
						this.personal.markScheduledFailed(item.id, result.error.message);
						events.push({ type: "chat.scheduled", scheduled_id: item.id, room_id: item.room_id });
					}
				} else {
					this.personal.markScheduledSent(item.id, result.messageId);
					events.push({ type: "chat.scheduled", scheduled_id: item.id, room_id: item.room_id });
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const attempts = item.attempts + 1;
				log("warn", "scheduled chat message delivery failed", {
					scheduledId: item.id,
					attempts,
					error: message,
				});
				if (attempts >= MAX_SCHEDULED_ATTEMPTS) {
					this.personal.markScheduledFailed(item.id, `Delivery failed after ${MAX_SCHEDULED_ATTEMPTS} attempts.`);
					events.push({ type: "chat.scheduled", scheduled_id: item.id, room_id: item.room_id });
				} else {
					this.personal.markScheduledRetry(item.id, attempts, now + 60_000 * 2 ** (attempts - 1), message);
				}
			}
		}

		if (events.length > 0 && this.ctx.getWebSockets().length > 0) {
			this.ctx.waitUntil(this.publish(() => events));
		}

		await this.schedulePersonalAlarm();
	}

	override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const activity = readActivity(message);
		if (!activity) {
			this.end(socket, 1008, "Send a chat.activity message or a ping.");
			return;
		}
		let state = socket.deserializeAttachment() as EventsSocketState | null;
		if (!state || state.feed) {
			this.end(socket, 1008, "This feed takes no activity.");
			return;
		}
		if (
			Date.now() - state.checkedAt >= EVENTS_SOCKET_RECHECK_MS ||
			Date.now() - state.openedAt >= EVENTS_SOCKET_MAX_MS
		) {
			await this.enqueue([]);
			if (socket.readyState !== WebSocket.OPEN) return;
			state = socket.deserializeAttachment() as EventsSocketState;
		}
		const now = Date.now();
		const previous = state.activity;
		const changed = previous?.active !== activity.active;
		if (!changed && previous?.room_id === activity.room_id && now - previous.at < CHAT_PRESENCE_LIMITS.heartbeatMs / 2)
			return;
		socket.serializeAttachment({
			...state,
			activity: { active: activity.active, room_id: activity.room_id, at: now },
		} satisfies EventsSocketState);
		if (changed || (previous && now - previous.at >= 2 * CHAT_PRESENCE_LIMITS.heartbeatMs))
			await schedulePresence(this.ctx);
	}

	override webSocketClose(socket: WebSocket, code: number, reason: string): void {
		// Completes the close handshake. The runtime can reply by itself, and a closed socket throws.
		this.end(socket, code, reason);
	}

	override webSocketError(socket: WebSocket): void {
		this.end(socket, 1011, "The connection failed.");
	}

	private end(socket: WebSocket, code: number, reason: string): void {
		try {
			socket.close(code, reason);
		} catch {
			// Closed already, or the code is one that only the runtime can send.
		}
		this.ctx.waitUntil(schedulePresence(this.ctx));
	}

	private send(socket: WebSocket, text: string): void {
		try {
			socket.send(text);
		} catch {
			// The socket closed between the list and the send.
		}
	}

	/**
	 * Sends events to the sockets, after each event that went out before. `build` makes the events at
	 * once, from the rows of the write that calls it.
	 */
	private publish(build: () => PrincipalEvent[]): Promise<void> {
		let texts: string[] = [];
		try {
			texts = build().map((event) => JSON.stringify(event));
		} catch (error) {
			log("error", "events socket event failed", { error: error instanceof Error ? error.message : String(error) });
		}
		if (texts.length === 0) return this.announced;
		return this.enqueue(texts);
	}

	/**
	 * Puts a send behind each send from before. An empty list sends nothing, and checks each socket whose
	 * check is due, as for a send.
	 */
	private enqueue(texts: string[], notificationAt?: number | null): Promise<void> {
		this.announced = this.announced
			.then(() => this.deliver(texts, notificationAt))
			.catch((error: unknown) => {
				log("error", "events socket send failed", { error: error instanceof Error ? error.message : String(error) });
			});
		return this.announced;
	}

	/**
	 * Sends events to each socket. A socket whose credential check is older than
	 * `EVENTS_SOCKET_RECHECK_MS` gets the events only after a new check. That check reads the credentials
	 * of all sockets with one query. A socket whose credential stopped closes. If the check fails, the
	 * sockets that waited for it close, and their clients open new ones, which the Worker authenticates.
	 */
	private async deliver(texts: string[], notificationAt?: number | null): Promise<void> {
		const now = Date.now();
		const open: { socket: WebSocket; state: EventsSocketState; waits: boolean }[] = [];
		for (const socket of this.ctx.getWebSockets()) {
			const state = socket.deserializeAttachment() as EventsSocketState | null;
			if (!state || now - state.openedAt >= EVENTS_SOCKET_MAX_MS) {
				this.end(socket, EVENTS_SOCKET_CLOSE.reconnect, "The socket reached its longest life. Open a new socket.");
				continue;
			}
			if (socket.readyState !== WebSocket.OPEN) continue;
			if (notificationAt === null && (!state.activity || state.feed)) continue;
			if (typeof notificationAt === "number" && !listensForSound(state, notificationAt, now)) continue;
			const waits = now - state.checkedAt >= EVENTS_SOCKET_RECHECK_MS;
			if (!waits) for (const text of texts) this.send(socket, text);
			open.push({ socket, state, waits });
		}
		if (!open.some((entry) => entry.waits)) return;
		let checks: CredentialCheck[] | null = null;
		try {
			checks = await checkCredentials(
				this.env.DIRECTORY,
				open.map((entry) => entry.state.credential),
			);
		} catch (error) {
			log("warn", "events socket credential check failed; the sockets that waited close", {
				sockets: open.filter((entry) => entry.waits).length,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		const checkedAt = Date.now();
		let ended = 0;
		for (const [index, { socket, waits }] of open.entries()) {
			const check = checks?.[index];
			if (check === undefined) {
				if (waits) this.end(socket, EVENTS_SOCKET_CLOSE.reconnect, "The access check failed. Open a new socket.");
			} else if (check === "renew") {
				ended += 1;
				this.end(socket, EVENTS_SOCKET_CLOSE.reconnect, "Authenticate again: open a new socket.");
			} else if (check === "ended") {
				ended += 1;
				this.end(socket, EVENTS_SOCKET_CLOSE.ended, "The credential stopped.");
			} else {
				try {
					const current = socket.deserializeAttachment() as EventsSocketState;
					socket.serializeAttachment({ ...current, checkedAt } satisfies EventsSocketState);
					if (typeof notificationAt === "number" && !listensForSound(current, notificationAt, checkedAt)) continue;
					if (waits) for (const text of texts) this.send(socket, text);
				} catch {
					// Closed during the check.
				}
			}
		}
		if (ended > 0) log("info", "events sockets closed: the credential stopped", { sockets: ended });
	}
}
