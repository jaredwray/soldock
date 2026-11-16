import { DurableObject } from "cloudflare:workers";

// `PrincipalDO`: one object for each person and each agent, keyed by the principal id. It holds the
// state of the principal that other objects send to it. This version holds the Chat part only: the
// state of each room of the principal. Later parts (settings, the event feed, notifications, agent
// counters) add their own tables.

type Row = Record<string, SqlStorageValue>;

/** A room as the principal sees it, as the room object sends it. Times are in milliseconds. */
export interface ChatRoomView {
	kind: "public" | "private" | "dm";
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
	/** The other member of a direct message, as JSON. */
	peer_json: string | null;
	version: number;
}

/**
 * The state of one room for one principal, from the room object. `stamp` grows with each state that
 * the room makes, so the object keeps the newest state, also when an older state arrives later.
 */
export interface ChatRoomState {
	room_id: string;
	stamp: number;
	/** Null when the principal is not a member of the room now. */
	view: ChatRoomView | null;
}

/** A joined room in a list, with its id. `activity_at` is the time of the newest message, or the time of the creation. */
export interface ChatRoomEntry extends ChatRoomView {
	room_id: string;
	activity_at: number;
}

export interface ChatRoomQuery {
	/** Keep the rooms whose `name_key` has this text. */
	nameKey: string | null;
	/** The `activity_at` and the id of the last room of the page before. */
	after: { activityAt: number; roomId: string } | null;
	/** Keep the rooms up to this room, with it. Null for no end. */
	until: { activityAt: number; roomId: string } | null;
	limit: number;
}

/** The largest unread count that a room sends. A room with more unread messages sends this number. */
export const UNREAD_COUNT_MAX = 100;

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
];

const COLUMNS = `room_id, kind, name, name_key, topic, created_at, created_by_json, member_count, role, last_seq,
	last_message_at, activity_at, last_read_seq, unread_count, peer_json, version`;

export class PrincipalDO extends DurableObject<Env> {
	private readonly sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
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
	 */
	applyChatRoomStates(states: readonly ChatRoomState[]): void {
		this.ctx.storage.transactionSync(() => {
			for (const state of states) {
				const view = state.view;
				this.sql.exec(
					`INSERT INTO chat_rooms (room_id, stamp, joined, kind, name, name_key, topic, created_at, created_by_json,
						member_count, role, last_seq, last_message_at, activity_at, last_read_seq, unread_count, peer_json, version)
					VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
					ON CONFLICT (room_id) DO UPDATE SET stamp = excluded.stamp, joined = excluded.joined, kind = excluded.kind,
						name = excluded.name, name_key = excluded.name_key, topic = excluded.topic,
						created_at = excluded.created_at, created_by_json = excluded.created_by_json,
						member_count = excluded.member_count, role = excluded.role, last_seq = excluded.last_seq,
						last_message_at = excluded.last_message_at, activity_at = excluded.activity_at,
						last_read_seq = excluded.last_read_seq, unread_count = excluded.unread_count,
						peer_json = excluded.peer_json, version = excluded.version
					WHERE excluded.stamp > chat_rooms.stamp`,
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
					view?.version ?? null,
				);
			}
		});
	}

	/**
	 * A page of the joined rooms, with the newest activity first. One row more than `limit` tells that a
	 * next page exists. `seeded` is false until the first fill: see `seedChat`.
	 */
	listChatRooms(query: ChatRoomQuery): { seeded: boolean; rooms: ChatRoomEntry[] } {
		const rooms = this.sql
			.exec<ChatRoomEntry & Row>(
				`SELECT ${COLUMNS} FROM chat_rooms
				WHERE joined = 1
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
			.toArray();
		return { seeded: this.chatSeeded(), rooms };
	}

	/** The joined rooms of the list that this object has. `seeded` is as for `listChatRooms`. */
	chatRoomsOf(roomIds: readonly string[]): { seeded: boolean; rooms: ChatRoomEntry[] } {
		const seeded = this.chatSeeded();
		if (roomIds.length === 0) return { seeded, rooms: [] };
		const rooms = this.sql
			.exec<ChatRoomEntry & Row>(
				`SELECT ${COLUMNS} FROM chat_rooms JOIN json_each(?1) wanted ON wanted.value = chat_rooms.room_id
				WHERE joined = 1`,
				JSON.stringify([...new Set(roomIds)]),
			)
			.toArray();
		return { seeded, rooms };
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
}
