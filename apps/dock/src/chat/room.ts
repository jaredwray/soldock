import { DurableObject } from "cloudflare:workers";
import { CHAT_LIMITS, type RoomKind, type RoomRole } from "@soldock/contracts";
import { log } from "../platform/index.ts";

/** An expected failure, returned instead of thrown, because RPC does not keep error classes. */
export type Refusal = { error: { code: "invalid" | "not_found" | "conflict" | "forbidden"; message: string } };

/** The person or agent of a change, with the name at that time. */
export interface ActorRecord {
	principal_id: string;
	kind: "human" | "agent";
	display_name: string;
}

/**
 * Who calls, and which room they call. The Worker authenticates the caller. The object decides what
 * the caller can do, because the members are in its database.
 */
export interface RoomCall {
	roomId: string;
	actor: ActorRecord;
}

/** A room as one principal sees it. Times are in milliseconds. */
export interface RoomRecord {
	id: string;
	kind: RoomKind;
	name: string | null;
	topic: string;
	peer: ActorRecord | null;
	created_at: number;
	created_by: ActorRecord;
	member_count: number;
	role: RoomRole | null;
	last_seq: number;
	last_message_at: number | null;
	last_read_seq: number;
	unread: boolean;
	version: number;
}

export interface MemberRecord extends ActorRecord {
	role: RoomRole;
	joined_at: number;
}

export interface MessageRecord {
	id: string;
	room_id: string;
	seq: number;
	author: ActorRecord;
	text: string;
	created_at: number;
	edited_at: number | null;
	deleted: boolean;
	version: number;
}

type Row = Record<string, SqlStorageValue>;

interface RoomRow extends Row {
	room_id: string;
	kind: RoomKind;
	name: string | null;
	topic: string;
	created_at: number;
	created_by_json: string;
	last_seq: number;
	last_message_at: number | null;
	version: number;
}

interface MemberRow extends Row {
	principal_id: string;
	actor_json: string;
	role: RoomRole;
	joined_at: number;
	last_read_seq: number;
}

interface MessageRow extends Row {
	seq: number;
	id: string;
	author_id: string;
	author_json: string;
	text: string;
	created_at: number;
	edited_at: number | null;
	deleted_at: number | null;
	version: number;
}

interface OutboxRow extends Row {
	target: string;
	gen: number;
	attempts: number;
}

/** Ordered migrations. Each inner list runs in one transaction. Append only. */
const MIGRATIONS: string[][] = [
	[
		`CREATE TABLE room (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			room_id TEXT NOT NULL,
			kind TEXT NOT NULL CHECK (kind IN ('public', 'private', 'dm')),
			name TEXT,
			topic TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			created_by_json TEXT NOT NULL,
			last_seq INTEGER NOT NULL DEFAULT 0,
			last_message_at INTEGER,
			version INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE TABLE members (
			principal_id TEXT PRIMARY KEY,
			actor_json TEXT NOT NULL,
			role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
			joined_at INTEGER NOT NULL,
			last_read_seq INTEGER NOT NULL
		) WITHOUT ROWID`,
		// AUTOINCREMENT, so a seq is never used two times.
		`CREATE TABLE messages (
			seq INTEGER PRIMARY KEY AUTOINCREMENT,
			id TEXT NOT NULL UNIQUE,
			author_id TEXT NOT NULL,
			author_json TEXT NOT NULL,
			text TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			edited_at INTEGER,
			deleted_at INTEGER,
			version INTEGER NOT NULL
		)`,
		"CREATE INDEX messages_version ON messages (version)",
		// The rows of the index in D1 that are behind this room: `room`, or `member:<principal id>`.
		`CREATE TABLE outbox (
			target TEXT PRIMARY KEY,
			gen INTEGER NOT NULL,
			attempts INTEGER NOT NULL DEFAULT 0,
			next_attempt_at INTEGER NOT NULL,
			last_error TEXT
		) WITHOUT ROWID`,
		`CREATE TABLE idempotency (
			key TEXT PRIMARY KEY,
			request_hash TEXT NOT NULL,
			message_id TEXT NOT NULL,
			created_at INTEGER NOT NULL
		)`,
	],
];

const OUTBOX_BATCH = 100;
/** The most passes of one drain. A room that changes all the time lets the next drain continue. */
const DRAIN_ROUNDS = 10;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

const NOT_FOUND = "No room has that id, or you have no access to it.";
const NOT_MEMBER = "You are not a member of this room. Join it first with chat.join_room.";
const NO_MESSAGE = "No message has that id in this room.";
const FULL = `A room can have ${CHAT_LIMITS.membersPerRoom} members at most.`;

function refuse(code: Refusal["error"]["code"], message: string): Refusal {
	return { error: { code, message } };
}

function backoff(attempts: number): number {
	return Math.min(60_000 * 2 ** (attempts - 1), 60 * 60 * 1000);
}

/** The form of a room name for the order of a list and for the name filter: NFC, lowercase. */
export function nameKey(name: string): string {
	return name.normalize("NFC").toLowerCase();
}

function toMessage(roomId: string, row: MessageRow): MessageRecord {
	return {
		id: row.id,
		room_id: roomId,
		seq: row.seq,
		author: JSON.parse(row.author_json) as ActorRecord,
		text: row.text,
		created_at: row.created_at,
		edited_at: row.edited_at,
		deleted: row.deleted_at !== null,
		version: row.version,
	};
}

/**
 * One room, keyed by its id. It holds the room, its members with their read markers, and its messages
 * in its SQLite database. It makes each access check in the same step as the read or the change.
 *
 * The lists of rooms come from an index in D1 (`chat_rooms`, `chat_members`). After each change, the
 * object writes the current state of the changed rows to that index. The `outbox` table names the rows
 * that are behind. A write that fails stays there, and the alarm tries it again.
 *
 * An object that nobody created has no tables. Such an object costs nothing, so a call with a random
 * id leaves no data.
 */
export class ChatRoomDO extends DurableObject<Env> {
	private readonly sql: SqlStorage;
	private hasTables: boolean;
	/** The end of the line of index writes. Each write starts after the one before it ends. */
	private flushed: Promise<void> = Promise.resolve();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.hasTables =
			this.sql.exec("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'meta'").toArray().length > 0;
		if (this.hasTables) {
			ctx.blockConcurrencyWhile(async () => {
				this.migrate();
				// A change sets the alarm after its transaction commits. If the object stopped between the
				// two, the outbox has rows and no alarm: set one now.
				const pending = this.one<{ n: number }>("SELECT COUNT(*) AS n FROM outbox")?.n ?? 0;
				if (pending > 0 && (await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now());
			});
		}
	}

	private migrate(): void {
		this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		this.hasTables = true;
		const current = Number(
			this.one<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")?.value ?? 0,
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

	private one<T extends Row>(query: string, ...params: SqlStorageValue[]): T | null {
		return (this.sql.exec<T>(query, ...params).toArray()[0] as T | undefined) ?? null;
	}

	private all<T extends Row>(query: string, ...params: SqlStorageValue[]): T[] {
		return this.sql.exec<T>(query, ...params).toArray();
	}

	// --- Access ---------------------------------------------------------------------------------

	/** The room, or null for an object that nobody created. */
	private room(): RoomRow | null {
		return this.hasTables ? this.one<RoomRow>("SELECT * FROM room WHERE id = 1") : null;
	}

	private member(principalId: string): MemberRow | null {
		return this.one<MemberRow>("SELECT * FROM members WHERE principal_id = ?", principalId);
	}

	private memberCount(): number {
		return this.one<{ n: number }>("SELECT COUNT(*) AS n FROM members")?.n ?? 0;
	}

	/**
	 * The room and the member row of the caller. A private room and a direct message exist for their
	 * members only. A public room exists for each caller, and `need: "member"` refuses a caller that did
	 * not join it.
	 */
	private open(call: RoomCall, need: "visible" | "member"): { room: RoomRow; member: MemberRow | null } | Refusal {
		const room = this.room();
		if (!room) return refuse("not_found", NOT_FOUND);
		const member = this.member(call.actor.principal_id);
		if (!member && room.kind !== "public") return refuse("not_found", NOT_FOUND);
		if (!member && need === "member") return refuse("forbidden", NOT_MEMBER);
		return { room, member };
	}

	/** The same as `open` with `need: "member"`, with a member row that is not null. */
	private openAsMember(call: RoomCall): { room: RoomRow; member: MemberRow } | Refusal {
		const opened = this.open(call, "member");
		if ("error" in opened) return opened;
		return { room: opened.room, member: opened.member as MemberRow };
	}

	/** The room as one principal sees it. */
	private record(principalId: string): RoomRecord {
		const room = this.room() as RoomRow;
		const member = this.member(principalId);
		const peer =
			room.kind === "dm"
				? this.one<{ actor_json: string }>(
						"SELECT actor_json FROM members WHERE principal_id <> ? LIMIT 1",
						principalId,
					)
				: null;
		return {
			id: room.room_id,
			kind: room.kind,
			name: room.name,
			topic: room.topic,
			peer: peer ? (JSON.parse(peer.actor_json) as ActorRecord) : null,
			created_at: room.created_at,
			created_by: JSON.parse(room.created_by_json) as ActorRecord,
			member_count: this.memberCount(),
			role: member?.role ?? null,
			last_seq: room.last_seq,
			last_message_at: room.last_message_at,
			last_read_seq: member?.last_read_seq ?? 0,
			unread: member !== null && room.last_seq > member.last_read_seq,
			version: room.version,
		};
	}

	// --- Rooms and members ----------------------------------------------------------------------

	private insertMember(actor: ActorRecord, role: RoomRole, now: number, lastReadSeq: number): void {
		this.sql.exec(
			"INSERT INTO members (principal_id, actor_json, role, joined_at, last_read_seq) VALUES (?, ?, ?, ?, ?)",
			actor.principal_id,
			JSON.stringify(actor),
			role,
			now,
			lastReadSeq,
		);
		this.touch(`member:${actor.principal_id}`);
	}

	private createRoom(call: RoomCall, kind: RoomKind, name: string | null, topic: string, others: ActorRecord[]): void {
		const now = Date.now();
		this.migrate();
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(
				"INSERT INTO room (id, room_id, kind, name, topic, created_at, created_by_json) VALUES (1, ?, ?, ?, ?, ?, ?)",
				call.roomId,
				kind,
				name,
				topic,
				now,
				JSON.stringify(call.actor),
			);
			// A dm room has no owner: its two members are equal.
			this.insertMember(call.actor, kind === "dm" ? "member" : "owner", now, 0);
			for (const actor of others) this.insertMember(actor, "member", now, 0);
			this.touch("room");
		});
	}

	/** Creates a public or a private room. The caller becomes its owner. */
	async create(
		call: RoomCall,
		input: { kind: "public" | "private"; name: string; topic: string; members: ActorRecord[] },
	): Promise<RoomRecord | Refusal> {
		if (this.room()) return refuse("conflict", "A room with this id exists.");
		const others = new Map(input.members.map((actor) => [actor.principal_id, actor]));
		others.delete(call.actor.principal_id);
		this.createRoom(call, input.kind, input.name, input.topic, [...others.values()]);
		await this.flush();
		return this.record(call.actor.principal_id);
	}

	/** The direct message room of the caller and `peer`. The first call creates it. */
	async openDm(call: RoomCall, peer: ActorRecord): Promise<{ room: RoomRecord; created: boolean } | Refusal> {
		const existing = this.room();
		if (existing) {
			if (existing.kind !== "dm" || !this.member(call.actor.principal_id)) return refuse("not_found", NOT_FOUND);
			return { room: this.record(call.actor.principal_id), created: false };
		}
		this.createRoom(call, "dm", null, "", [peer]);
		await this.flush();
		return { room: this.record(call.actor.principal_id), created: true };
	}

	get(call: RoomCall): { room: RoomRecord; members: MemberRecord[] } | Refusal {
		const opened = this.open(call, "visible");
		if ("error" in opened) return opened;
		const members = this.all<MemberRow>("SELECT * FROM members ORDER BY joined_at, principal_id").map((row) => ({
			...(JSON.parse(row.actor_json) as ActorRecord),
			role: row.role,
			joined_at: row.joined_at,
		}));
		return { room: this.record(call.actor.principal_id), members };
	}

	async update(call: RoomCall, input: { name?: string | undefined; topic?: string | undefined }) {
		const opened = this.openAsMember(call);
		if ("error" in opened) return opened;
		if (opened.room.kind === "dm") return refuse("invalid", "A direct message has no name and no topic.");
		if (opened.member.role !== "owner") {
			return refuse("forbidden", "Only the owner of the room can change its name and its topic.");
		}
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(
				"UPDATE room SET name = COALESCE(?, name), topic = COALESCE(?, topic) WHERE id = 1",
				input.name ?? null,
				input.topic ?? null,
			);
			this.touch("room");
		});
		await this.flush();
		return this.record(call.actor.principal_id);
	}

	/** Makes the caller a member of a public room. A room without an owner gets the caller as its owner. */
	async join(call: RoomCall): Promise<RoomRecord | Refusal> {
		const opened = this.open(call, "visible");
		if ("error" in opened) return opened;
		if (opened.member) return this.record(call.actor.principal_id);
		if (this.memberCount() >= CHAT_LIMITS.membersPerRoom) return refuse("conflict", FULL);
		const hasOwner = this.one("SELECT 1 AS found FROM members WHERE role = 'owner' LIMIT 1") !== null;
		this.ctx.storage.transactionSync(() => {
			this.insertMember(call.actor, hasOwner ? "member" : "owner", Date.now(), opened.room.last_seq);
			this.touch("room");
		});
		await this.flush();
		return this.record(call.actor.principal_id);
	}

	/** Adds principals as members. A new member starts with each message read, and can read them all. */
	async addMembers(call: RoomCall, actors: ActorRecord[]): Promise<{ added: number; room: RoomRecord } | Refusal> {
		const opened = this.openAsMember(call);
		if ("error" in opened) return opened;
		if (opened.room.kind === "dm") {
			return refuse("invalid", "A direct message keeps its two members. Create a room for more people.");
		}
		const fresh = new Map<string, ActorRecord>();
		for (const actor of actors) if (!this.member(actor.principal_id)) fresh.set(actor.principal_id, actor);
		if (fresh.size > 0) {
			if (this.memberCount() + fresh.size > CHAT_LIMITS.membersPerRoom) return refuse("conflict", FULL);
			this.ctx.storage.transactionSync(() => {
				const now = Date.now();
				for (const actor of fresh.values()) this.insertMember(actor, "member", now, opened.room.last_seq);
				this.touch("room");
			});
			await this.flush();
		}
		return { added: fresh.size, room: this.record(call.actor.principal_id) };
	}

	/**
	 * Removes a member. A member removes itself to leave the room. Only the owner removes a different
	 * member. When the owner leaves, the member that joined first becomes the owner.
	 */
	async removeMember(call: RoomCall, principalId: string): Promise<{ removed: boolean } | Refusal> {
		const opened = this.openAsMember(call);
		if ("error" in opened) return opened;
		if (opened.room.kind === "dm") return refuse("invalid", "A direct message keeps its two members.");
		const self = principalId === call.actor.principal_id;
		if (!self && opened.member.role !== "owner") {
			return refuse("forbidden", "Only the owner of the room can remove a different member.");
		}
		const target = self ? opened.member : this.member(principalId);
		if (!target) return { removed: false };
		if (self && opened.room.kind === "private" && this.memberCount() === 1) {
			return refuse("conflict", "You are the last member of this private room, so you cannot leave it.");
		}
		this.ctx.storage.transactionSync(() => {
			this.sql.exec("DELETE FROM members WHERE principal_id = ?", principalId);
			this.touch(`member:${principalId}`);
			if (target.role === "owner") {
				const next = this.one<{ principal_id: string }>(
					"SELECT principal_id FROM members ORDER BY joined_at, principal_id LIMIT 1",
				);
				if (next) {
					this.sql.exec("UPDATE members SET role = 'owner' WHERE principal_id = ?", next.principal_id);
					this.touch(`member:${next.principal_id}`);
				}
			}
			this.touch("room");
		});
		await this.flush();
		return { removed: true };
	}

	// --- Messages -------------------------------------------------------------------------------

	/**
	 * A page of the history (newest page, or the page before a seq), or the messages that changed after
	 * a version of the room. The messages of the history are oldest first.
	 */
	listMessages(
		call: RoomCall,
		input: { before: number | null; changedAfter: number | null; limit: number },
	): { messages: MessageRecord[]; version: number; hasMore: boolean } | Refusal {
		const opened = this.openAsMember(call);
		if ("error" in opened) return opened;
		let rows: MessageRow[];
		if (input.changedAfter !== null) {
			rows = this.all<MessageRow>(
				"SELECT * FROM messages WHERE version > ? ORDER BY version LIMIT ?",
				input.changedAfter,
				input.limit + 1,
			);
		} else if (input.before !== null) {
			rows = this.all<MessageRow>(
				"SELECT * FROM messages WHERE seq < ? ORDER BY seq DESC LIMIT ?",
				input.before,
				input.limit + 1,
			);
		} else {
			rows = this.all<MessageRow>("SELECT * FROM messages ORDER BY seq DESC LIMIT ?", input.limit + 1);
		}
		const hasMore = rows.length > input.limit;
		const page = rows.slice(0, input.limit);
		if (input.changedAfter === null) page.reverse();
		return {
			messages: page.map((row) => toMessage(opened.room.room_id, row)),
			version: opened.room.version,
			hasMore,
		};
	}

	private message(messageId: string): MessageRow | null {
		return this.one<MessageRow>("SELECT * FROM messages WHERE id = ?", messageId);
	}

	/** Adds a message. The room is then read for its author. */
	async postMessage(
		call: RoomCall,
		input: { id: string; text: string; idempotency?: { key: string; requestHash: string } | undefined },
	): Promise<{ message: MessageRecord; duplicate: boolean } | Refusal> {
		const opened = this.openAsMember(call);
		if ("error" in opened) return opened;
		const now = Date.now();
		if (input.idempotency) {
			const earlier = this.one<{ request_hash: string; message_id: string }>(
				"SELECT request_hash, message_id FROM idempotency WHERE key = ? AND created_at > ?",
				input.idempotency.key,
				now - IDEMPOTENCY_TTL_MS,
			);
			if (earlier) {
				if (earlier.request_hash !== input.idempotency.requestHash) {
					return refuse("conflict", "The idempotency key was used with a different request.");
				}
				const row = this.message(earlier.message_id) as MessageRow;
				return { message: toMessage(opened.room.room_id, row), duplicate: true };
			}
		}
		const version = opened.room.version + 1;
		this.ctx.storage.transactionSync(() => {
			const seq = this.one<{ seq: number }>(
				`INSERT INTO messages (id, author_id, author_json, text, created_at, version)
				VALUES (?, ?, ?, ?, ?, ?) RETURNING seq`,
				input.id,
				call.actor.principal_id,
				JSON.stringify(call.actor),
				input.text,
				now,
				version,
			)?.seq as number;
			this.sql.exec("UPDATE room SET last_seq = ?, last_message_at = ?, version = ? WHERE id = 1", seq, now, version);
			this.sql.exec("UPDATE members SET last_read_seq = ? WHERE principal_id = ?", seq, call.actor.principal_id);
			if (input.idempotency) {
				this.sql.exec("DELETE FROM idempotency WHERE created_at <= ?", now - IDEMPOTENCY_TTL_MS);
				this.sql.exec(
					"INSERT OR REPLACE INTO idempotency (key, request_hash, message_id, created_at) VALUES (?, ?, ?, ?)",
					input.idempotency.key,
					input.idempotency.requestHash,
					input.id,
					now,
				);
			}
			this.touch("room");
			this.touch(`member:${call.actor.principal_id}`);
		});
		await this.flush();
		return { message: toMessage(opened.room.room_id, this.message(input.id) as MessageRow), duplicate: false };
	}

	/** Replaces the text of a message. Only its author can do this. */
	async editMessage(
		call: RoomCall,
		messageId: string,
		text: string,
	): Promise<{ message: MessageRecord; changed: boolean } | Refusal> {
		const opened = this.openAsMember(call);
		if ("error" in opened) return opened;
		const row = this.message(messageId);
		if (!row) return refuse("not_found", NO_MESSAGE);
		if (row.author_id !== call.actor.principal_id) {
			return refuse("forbidden", "You can change only a message that you wrote.");
		}
		if (row.deleted_at !== null) return refuse("invalid", "The message is deleted, so it cannot change.");
		if (row.text === text) return { message: toMessage(opened.room.room_id, row), changed: false };
		const version = opened.room.version + 1;
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(
				"UPDATE messages SET text = ?, edited_at = ?, version = ? WHERE id = ?",
				text,
				Date.now(),
				version,
				messageId,
			);
			this.sql.exec("UPDATE room SET version = ? WHERE id = 1", version);
			this.touch("room");
		});
		await this.flush();
		return { message: toMessage(opened.room.room_id, this.message(messageId) as MessageRow), changed: true };
	}

	/** Deletes the text of a message. Its author and the owner of the room can do this. */
	async deleteMessage(call: RoomCall, messageId: string): Promise<{ deleted: boolean } | Refusal> {
		const opened = this.openAsMember(call);
		if ("error" in opened) return opened;
		const row = this.message(messageId);
		if (!row) return refuse("not_found", NO_MESSAGE);
		if (row.author_id !== call.actor.principal_id && opened.member.role !== "owner") {
			return refuse(
				"forbidden",
				"You can delete a message that you wrote. The owner of the room can delete each message.",
			);
		}
		if (row.deleted_at !== null) return { deleted: false };
		const version = opened.room.version + 1;
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(
				"UPDATE messages SET text = '', deleted_at = ?, version = ? WHERE id = ?",
				Date.now(),
				version,
				messageId,
			);
			this.sql.exec("UPDATE room SET version = ? WHERE id = 1", version);
			this.touch("room");
		});
		await this.flush();
		return { deleted: true };
	}

	/** Sets the read marker of the caller. Without `seq`, the marker goes to the newest message. */
	async markRead(call: RoomCall, seq: number | null): Promise<{ lastReadSeq: number; unread: boolean } | Refusal> {
		const opened = this.openAsMember(call);
		if ("error" in opened) return opened;
		const lastReadSeq = Math.min(seq ?? opened.room.last_seq, opened.room.last_seq);
		if (lastReadSeq !== opened.member.last_read_seq) {
			this.ctx.storage.transactionSync(() => {
				this.sql.exec(
					"UPDATE members SET last_read_seq = ? WHERE principal_id = ?",
					lastReadSeq,
					call.actor.principal_id,
				);
				this.touch(`member:${call.actor.principal_id}`);
			});
			await this.flush();
		}
		return { lastReadSeq, unread: opened.room.last_seq > lastReadSeq };
	}

	// --- The index in D1 ------------------------------------------------------------------------

	/** Records that a row of the index is behind. `gen` shows a change that came during a write. */
	private touch(target: string): void {
		this.sql.exec(
			`INSERT INTO outbox (target, gen, next_attempt_at) VALUES (?, 1, ?)
			ON CONFLICT (target) DO UPDATE SET gen = gen + 1, attempts = 0, next_attempt_at = excluded.next_attempt_at`,
			target,
			Date.now(),
		);
	}

	/**
	 * Writes the rows that are behind to the index, after each write that started before. The caller
	 * waits for it, so a list that comes after a change has that change. A failure does not fail the
	 * change: the alarm tries the write again.
	 */
	private flush(): Promise<void> {
		const run = this.flushed.then(() => this.drain());
		this.flushed = run.catch((error: unknown) => {
			log("error", "chat index drain failed", { error: error instanceof Error ? error.message : String(error) });
		});
		return this.flushed;
	}

	override async alarm(): Promise<void> {
		await this.flush();
	}

	/**
	 * Each write holds the state at the time of the write, not at the time of the change. So a write is
	 * safe to run two times, the order of two writes does not matter, and a row never goes out of use:
	 * a write that fails is tried again until it succeeds.
	 */
	private async drain(): Promise<void> {
		for (let round = 0; round < DRAIN_ROUNDS; round++) {
			const room = this.room();
			if (!room) return;
			const rows = this.all<OutboxRow>(
				"SELECT target, gen, attempts FROM outbox WHERE next_attempt_at <= ? ORDER BY target LIMIT ?",
				Date.now(),
				OUTBOX_BATCH,
			);
			if (rows.length === 0) break;
			try {
				await this.env.DIRECTORY.batch(rows.map((row) => this.indexStatement(room, row.target)));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log("warn", "chat index write failed", { rows: rows.length, error: message });
				for (const row of rows) {
					const attempts = row.attempts + 1;
					this.sql.exec(
						"UPDATE outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE target = ? AND gen = ?",
						attempts,
						Date.now() + backoff(attempts),
						message.slice(0, 500),
						row.target,
						row.gen,
					);
				}
				break;
			}
			// A row that changed during the write has a new gen. It stays, and the next pass writes it.
			for (const row of rows) this.sql.exec("DELETE FROM outbox WHERE target = ? AND gen = ?", row.target, row.gen);
		}
		const next = this.one<{ at: number | null }>("SELECT MIN(next_attempt_at) AS at FROM outbox")?.at ?? null;
		if (next !== null) await this.ctx.storage.setAlarm(Math.max(next, Date.now()));
	}

	/**
	 * The statement that brings one row of the index to the current state. A row is written only while
	 * its principal is in the directory: the creator for the room, the member for a member. After a
	 * fresh start of the directory, the rooms from before have no such principal, so they stay out of
	 * the new index.
	 */
	private indexStatement(room: RoomRow, target: string): D1PreparedStatement {
		const db = this.env.DIRECTORY;
		if (target === "room") {
			const creator = (JSON.parse(room.created_by_json) as ActorRecord).principal_id;
			return db
				.prepare(
					`INSERT INTO chat_rooms (id, kind, name, name_key, topic, created_at, created_by_json, member_count,
						last_seq, last_message_at, activity_at, version)
					SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
					WHERE EXISTS (SELECT 1 FROM principals WHERE id = ?13)
					ON CONFLICT (id) DO UPDATE SET name = excluded.name, name_key = excluded.name_key,
						topic = excluded.topic, member_count = excluded.member_count, last_seq = excluded.last_seq,
						last_message_at = excluded.last_message_at, activity_at = excluded.activity_at,
						version = excluded.version`,
				)
				.bind(
					room.room_id,
					room.kind,
					room.name,
					room.name === null ? null : nameKey(room.name),
					room.topic,
					room.created_at,
					room.created_by_json,
					this.memberCount(),
					room.last_seq,
					room.last_message_at,
					room.last_message_at ?? room.created_at,
					room.version,
					creator,
				);
		}
		const principalId = target.slice("member:".length);
		const member = this.member(principalId);
		if (!member) {
			return db
				.prepare("DELETE FROM chat_members WHERE principal_id = ? AND room_id = ?")
				.bind(principalId, room.room_id);
		}
		const peer =
			room.kind === "dm"
				? (this.one<{ actor_json: string }>(
						"SELECT actor_json FROM members WHERE principal_id <> ? LIMIT 1",
						principalId,
					)?.actor_json ?? null)
				: null;
		return db
			.prepare(
				`INSERT INTO chat_members (principal_id, room_id, role, last_read_seq, peer_json)
				SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM principals WHERE id = ?1)
				ON CONFLICT (principal_id, room_id) DO UPDATE SET role = excluded.role,
					last_read_seq = excluded.last_read_seq, peer_json = excluded.peer_json`,
			)
			.bind(principalId, room.room_id, member.role, member.last_read_seq, peer);
	}
}
