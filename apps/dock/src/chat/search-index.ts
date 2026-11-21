import { DurableObject } from "cloudflare:workers";
import { type SearchColumns, type SearchFilter, searchSql } from "./search.ts";

// The search index of the organization: one object that finds the messages of many rooms with one query.
// It is a copy that the rooms can build again. Each room sends the search state of its changed messages
// through its outbox (room.ts, `sendSearch`). The index keeps the plain text and the filter values only.
// It has no body, no author name, no reaction and no file, and it returns no text: a hit is a room and a
// seq. The Worker then reads each message from its room, which makes the access check again.

/**
 * The shard of the index. The name of the object has it, so a later change can give a large
 * organization more than one index: it maps each room to a shard, and each room sends its messages again.
 */
const SEARCH_SHARD = "0";

/** The index of the organization. */
export function searchIndex(env: Pick<Env, "CHAT_SEARCH">) {
	return env.CHAT_SEARCH.get(env.CHAT_SEARCH.idFromName(`org:${SEARCH_SHARD}`));
}

/** The search state of one message: its text and its filter values, or null for a message that is deleted. */
export interface SearchEntry {
	seq: number;
	row: {
		author_id: string;
		/** The time of the post, in milliseconds. */
		created_at: number;
		/** The plain text. */
		text: string;
		has_link: boolean;
		has_file: boolean;
		/** True for a reply, and for a message with replies. */
		in_thread: boolean;
		/** The principals that the message mentions. */
		mentions: string[];
	} | null;
}

/** The changed messages of one room. `stamp` grows with each batch of the room. */
export interface SearchBatch {
	roomId: string;
	stamp: number;
	entries: SearchEntry[];
	/** True when the room made each stored message a target for the index, and this batch tells so. */
	filled: boolean;
}

/** A hit: the room and the seq of a message, and its time in milliseconds. */
export interface SearchHit {
	room_id: string;
	seq: number;
	created_at: number;
}

export interface SearchIndexQuery {
	/** The rooms of the caller. The index searches these rooms only. */
	rooms: string[];
	filter: SearchFilter;
	/** The place of the last hit of the page before, or null for the newest hits. */
	after: { createdAt: number; roomId: string; seq: number } | null;
	limit: number;
}

/** The most rooms without a row in the index that one search names. */
const UNKNOWN_MAX = 200;

type Row = Record<string, SqlStorageValue>;

const MIGRATIONS: string[][] = [
	[
		// One row for each room that sent a batch, with the stamp of its newest batch. `filled` is 1 after the
		// room told that it made each stored message a target for this index.
		`CREATE TABLE rooms (
			room_id TEXT PRIMARY KEY,
			stamp INTEGER NOT NULL,
			filled INTEGER NOT NULL DEFAULT 0
		) WITHOUT ROWID`,
		// The filter values of each message that stays. `id` is the rowid of its words in `messages_fts`.
		`CREATE TABLE messages (
			id INTEGER PRIMARY KEY,
			room_id TEXT NOT NULL,
			seq INTEGER NOT NULL,
			author_id TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			has_link INTEGER NOT NULL,
			has_file INTEGER NOT NULL,
			in_thread INTEGER NOT NULL,
			UNIQUE (room_id, seq)
		)`,
		"CREATE INDEX messages_time ON messages (created_at DESC, room_id DESC, seq DESC)",
		// A search with `from:` reads the messages of its authors, not each message of the index.
		"CREATE INDEX messages_author ON messages (author_id, created_at DESC)",
		// The plain text of each message, as the search table of a room has it.
		"CREATE VIRTUAL TABLE messages_fts USING fts5 (text, tokenize = 'unicode61 remove_diacritics 2')",
		// A delete removes the text and the words of a message at once, not at a later merge. So the index
		// keeps no word of a deleted message, and no word of the text before an edit.
		"INSERT INTO messages_fts (messages_fts, rank) VALUES ('secure-delete', 1)",
		`CREATE TABLE mentions (
			principal_id TEXT NOT NULL,
			id INTEGER NOT NULL,
			PRIMARY KEY (principal_id, id)
		) WITHOUT ROWID`,
		"CREATE INDEX mentions_id ON mentions (id)",
	],
];

/** The names of the search tables of the index, for `searchSql`. */
const INDEX_SEARCH: SearchColumns = {
	fts: "messages_fts",
	messages: "messages m",
	rowid: "m.id",
	author: "m.author_id",
	createdAt: "m.created_at",
	hasLink: "m.has_link = 1",
	hasFile: "m.has_file = 1",
	isThread: "m.in_thread = 1",
	mentions: "EXISTS (SELECT 1 FROM mentions s WHERE s.id = m.id AND s.principal_id = ?)",
};

/**
 * The search index of the organization. See the comment at the top of this file, and the `chat` README.
 */
export class ChatSearchDO extends DurableObject<Env> {
	private readonly sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		const current = Number(
			this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'").toArray()[0]?.value ?? 0,
		);
		for (let version = current; version < MIGRATIONS.length; version++) {
			ctx.storage.transactionSync(() => {
				for (const statement of MIGRATIONS[version] ?? []) this.sql.exec(statement);
				this.sql.exec(
					"INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
					String(version + 1),
				);
			});
		}
	}

	/**
	 * Applies a batch of one room: each entry replaces the rows of its message, or removes them. A batch
	 * whose stamp is not higher than the stamp of the room changes nothing. So a second delivery, and an
	 * older batch that arrives late, do no harm. A batch without entries makes the room known.
	 *
	 * `known` is false for the first batch of a room: the index had no row of the room. `filled` is false
	 * until a batch of the room told that the room made each stored message a target. The room sends each
	 * of its messages while one of the two is false. So an index that lost its rows gets them again, also
	 * when the answer to the first batch got lost.
	 */
	apply(batch: SearchBatch): { known: boolean; filled: boolean } {
		const before = this.sql
			.exec<{ filled: number }>("SELECT filled FROM rooms WHERE room_id = ?", batch.roomId)
			.toArray()[0];
		let filled = before?.filled === 1;
		this.ctx.storage.transactionSync(() => {
			const newer = this.sql
				.exec(
					`INSERT INTO rooms (room_id, stamp) VALUES (?, ?)
					ON CONFLICT (room_id) DO UPDATE SET stamp = excluded.stamp WHERE excluded.stamp > rooms.stamp
					RETURNING room_id`,
					batch.roomId,
					batch.stamp,
				)
				.toArray();
			if (newer.length === 0) return;
			if (batch.filled) {
				this.sql.exec("UPDATE rooms SET filled = 1 WHERE room_id = ?", batch.roomId);
				filled = true;
			}
			for (const { seq, row } of batch.entries) {
				const kept = this.sql
					.exec<{ id: number }>("SELECT id FROM messages WHERE room_id = ? AND seq = ?", batch.roomId, seq)
					.toArray()[0];
				if (kept) {
					this.sql.exec("DELETE FROM messages_fts WHERE rowid = ?", kept.id);
					this.sql.exec("DELETE FROM mentions WHERE id = ?", kept.id);
					this.sql.exec("DELETE FROM messages WHERE id = ?", kept.id);
				}
				if (row === null) continue;
				const id = this.sql
					.exec<{ id: number }>(
						`INSERT INTO messages (room_id, seq, author_id, created_at, has_link, has_file, in_thread)
						VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
						batch.roomId,
						seq,
						row.author_id,
						row.created_at,
						row.has_link ? 1 : 0,
						row.has_file ? 1 : 0,
						row.in_thread ? 1 : 0,
					)
					.one().id;
				this.sql.exec("INSERT INTO messages_fts (rowid, text) VALUES (?, ?)", id, row.text);
				for (const principalId of new Set(row.mentions)) {
					this.sql.exec("INSERT INTO mentions (principal_id, id) VALUES (?, ?)", principalId, id);
				}
			}
		});
		return { known: before !== undefined, filled };
	}

	/**
	 * A page of the hits of a filter in the rooms of the list, the newest first. One hit more than `limit`
	 * tells that a next page exists. The index gives no rank: `bm25` reads how many rows of the whole table
	 * have a word, so its order would tell a caller about the words of rooms that it cannot read. Each room
	 * ranks its own messages (`searchHits` of the room). `unknown` has the rooms of the list that sent no batch yet, at most `UNKNOWN_MAX`: the
	 * caller asks each of them to send a batch (`fillSearch`).
	 */
	search(query: SearchIndexQuery): { hits: SearchHit[]; unknown: string[] } {
		const rooms = JSON.stringify(query.rooms);
		const unknown = this.sql
			.exec<{ value: string }>(
				`SELECT wanted.value FROM json_each(?) wanted
				WHERE NOT EXISTS (SELECT 1 FROM rooms WHERE room_id = wanted.value) LIMIT ?`,
				rooms,
				UNKNOWN_MAX,
			)
			.toArray()
			.map((row) => row.value);
		const { from, where, params } = searchSql(query.filter, INDEX_SEARCH);
		where.push("m.room_id IN (SELECT value FROM json_each(?))");
		params.push(rooms);
		if (query.after !== null) {
			where.push("(m.created_at, m.room_id, m.seq) < (?, ?, ?)");
			params.push(query.after.createdAt, query.after.roomId, query.after.seq);
		}
		params.push(query.limit + 1);
		const hits = this.sql
			.exec<SearchHit & Row>(
				`SELECT m.room_id, m.seq, m.created_at FROM ${from}
				WHERE ${where.join(" AND ")}
				ORDER BY m.created_at DESC, m.room_id DESC, m.seq DESC
				LIMIT ?`,
				...params,
			)
			.toArray();
		return { hits, unknown };
	}

	/** Removes every indexed message and the room row for a deleted room in bounded chunks. */
	deleteRoom(roomId: string): void {
		const BATCH = 500;
		for (;;) {
			const ids = this.sql
				.exec<{ id: number }>("SELECT id FROM messages WHERE room_id = ? LIMIT ?", roomId, BATCH)
				.toArray()
				.map((r) => r.id);
			if (ids.length === 0) break;
			this.ctx.storage.transactionSync(() => {
				for (const id of ids) {
					this.sql.exec("DELETE FROM messages_fts WHERE rowid = ?", id);
					this.sql.exec("DELETE FROM mentions WHERE id = ?", id);
					this.sql.exec("DELETE FROM messages WHERE id = ?", id);
				}
			});
		}
		this.sql.exec("DELETE FROM rooms WHERE room_id = ?", roomId);
	}
}
