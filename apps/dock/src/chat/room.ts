import { DurableObject } from "cloudflare:workers";
import {
	CHAT_LIMITS,
	CHAT_SOCKET_CLOSE,
	CHAT_SOCKET_PROTOCOL,
	type ChatBody,
	type ChatMessage,
	type ChatReaction,
	type ChatSocketEvent,
	type ChatWebhookEvent,
	type RoomKind,
	type RoomRole,
} from "@soldock/contracts";
import {
	type ChatRoomState,
	type CredentialCheck,
	type CredentialRef,
	checkCredentials,
	UNREAD_COUNT_MAX,
} from "../identity/index.ts";
import { log, OperationError } from "../platform/index.ts";
import { type ChatWebhookEventJob, chatWebhookBoundary } from "../webhooks/index.ts";
import { bodyMarkdown, type MessageContent, mentionIds, textBody } from "./body.ts";
import { withMentions } from "./mentions.ts";

/** An expected failure, returned instead of thrown, because RPC does not keep error classes. */
export type Refusal = {
	error: {
		code: "invalid" | "not_found" | "conflict" | "forbidden" | "rate_limited" | "payload_too_large";
		message: string;
	};
};

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
	/** The messages of other members after `last_read_seq`, without deleted messages. At most `UNREAD_COUNT_MAX`. */
	unread_count: number;
	/** The messages after `last_read_seq` that mention the principal. At most `UNREAD_COUNT_MAX`. */
	mention_count: number;
	version: number;
	/** True when the principal put its star on the room. False for a principal that is not a member. */
	starred: boolean;
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
	/** The idempotency key of the send of the message, as its author gave it, or null. */
	idempotency_key: string | null;
	reactions: ChatReaction[];
	/** The body. A message from before the bodies, and a deleted message, have the body of their text. */
	body: ChatBody;
}

/**
 * What the Worker tells the room about a new socket, in the `SOCKET_HEADER` of the upgrade request.
 * The Worker authenticated the credential. The room decides if its principal is a member.
 */
export interface SocketOpen {
	roomId: string;
	actor: ActorRecord;
	credential: CredentialRef;
	/**
	 * True for the change feed of an MCP stream. One stream holds many feeds, and the end of one feed
	 * ends the stream. So the room never closes a feed to make room for a new socket.
	 */
	feed: boolean;
}

/** The header with the `SocketOpen` of an upgrade request: JSON, percent-encoded. */
export const SOCKET_HEADER = "x-soldock-chat-socket";

/** The room checks the credential of a socket again when its last check is this old. */
export const SOCKET_RECHECK_MS = 60_000;
/**
 * The longest life of one socket. Then the room closes it, and the client opens a new one, which the
 * Worker authenticates again with all of its checks.
 */
export const SOCKET_MAX_MS = 60 * 60_000;

/** What a socket keeps while the object sleeps. */
interface SocketState {
	credential: CredentialRef;
	feed: boolean;
	openedAt: number;
	/** The time of the last check of the credential. */
	checkedAt: number;
}

/** The tag of each socket of one principal. */
function socketTag(principalId: string): string {
	return `p:${principalId}`;
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
	membership_id: string;
	actor_json: string;
	role: RoomRole;
	joined_at: number;
	last_read_seq: number;
	/** 1 when the member put its star on the room, else 0. */
	starred: number;
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
	idempotency_key: string | null;
	body_json: string | null;
}

interface OutboxRow extends Row {
	target: string;
	gen: number;
	attempts: number;
}

/** Ordered migrations. Each inner list runs in one transaction. Append only. */
/**
 * The rows of `mentions` for the messages from before the table, from their body: each mention node,
 * except a mention of the author. A deleted message has no body. The row of the "type" key of a node
 * finds the node, and its id is beside it, at the path of that row.
 */
export const MENTIONS_BACKFILL = `INSERT OR IGNORE INTO mentions (principal_id, seq)
	SELECT json_extract(messages.body_json, node.path || '.attrs.id'), messages.seq
	FROM messages, json_tree(messages.body_json) AS node
	WHERE messages.body_json IS NOT NULL AND messages.deleted_at IS NULL
		AND node.key = 'type' AND node.atom = 'mention'
		AND json_extract(messages.body_json, node.path || '.attrs.id') IS NOT NULL
		AND json_extract(messages.body_json, node.path || '.attrs.id') <> messages.author_id`;

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
		"CREATE INDEX idempotency_created ON idempotency (created_at)",
	],
	[
		`CREATE TABLE webhook_outbox (
   event_id TEXT PRIMARY KEY, job TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
   next_attempt_at INTEGER NOT NULL
  ) WITHOUT ROWID`,
	],
	[
		"ALTER TABLE members ADD COLUMN membership_id TEXT NOT NULL DEFAULT ''",
		"UPDATE members SET membership_id = lower(hex(randomblob(16)))",
	],
	// The key of the send of a message, so a client finds the message of its send.
	["ALTER TABLE messages ADD COLUMN idempotency_key TEXT"],
	// One row for each reaction: a principal, a message and an emoji. `version` is the version of the
	// room at the reaction, so it gives the order of the reactions, also in one millisecond.
	[
		`CREATE TABLE reactions (
			message_id TEXT NOT NULL,
			emoji TEXT NOT NULL,
			principal_id TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			version INTEGER NOT NULL,
			PRIMARY KEY (message_id, emoji, principal_id)
		) WITHOUT ROWID`,
	],
	// The body of a message, as the JSON of `ChatBody`. A message from before has null: its body is its text.
	["ALTER TABLE messages ADD COLUMN body_json TEXT"],
	// The star of each member. It is part of the member row, so it goes away when the member leaves.
	["ALTER TABLE members ADD COLUMN starred INTEGER NOT NULL DEFAULT 0"],
	// The mentions of each message that stays, for the mention count of each member. The author of a
	// message does not count its own mention. A message from before has no rows.
	[
		`CREATE TABLE mentions (
			principal_id TEXT NOT NULL,
			seq INTEGER NOT NULL,
			PRIMARY KEY (principal_id, seq)
		) WITHOUT ROWID`,
		"CREATE INDEX mentions_seq ON mentions (seq)",
		MENTIONS_BACKFILL,
	],
];

const OUTBOX_BATCH = 100;
/** The most passes of one drain. A room that changes all the time lets the next drain continue. */
const DRAIN_ROUNDS = 10;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * The time that the object can be without an alarm after a change, if it stops during the write to the
 * index. The end of each write moves or removes this alarm.
 */
const ALARM_GUARD_MS = 30_000;
/** The start of an outbox target for the `PrincipalDO` of a member: `principal:<principal id>`. */
const PRINCIPAL_TARGET = "principal:";
/**
 * The time that the state for the `PrincipalDO` of a member waits after a change of a different
 * member. The changes of that time go out as one state.
 */
export const MEMBER_DELAY_MS = 500;

const NOT_FOUND = "No room has that id, or you have no access to it.";
const NOT_MEMBER = "You are not a member of this room. Join it first with chat.join_room.";
const NO_MESSAGE = "No message has that id in this room.";
const FULL = `A room can have ${CHAT_LIMITS.membersPerRoom} members at most.`;
/**
 * The most message allowances that a room keeps in memory. A room has `membersPerRoom` members at
 * most. The rest is for the members that left a short time before.
 */
const MAX_ALLOWANCES = 2 * CHAT_LIMITS.membersPerRoom;
const TOO_MANY_SOCKETS = `One member can have ${CHAT_LIMITS.socketsPerMember} sockets to a room at most.`;

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

function toMessage(roomId: string, row: MessageRow, reactions: ChatReaction[]): MessageRecord {
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
		idempotency_key: row.idempotency_key,
		reactions,
		body: row.body_json === null ? textBody(row.text) : (JSON.parse(row.body_json) as ChatBody),
	};
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

/** A message as the operations and the socket events return it. */
export function messageOutput(record: MessageRecord): ChatMessage {
	return {
		...record,
		markdown: record.deleted ? "" : bodyMarkdown(record.body),
		mentions: record.deleted ? [] : mentionIds(record.body),
		created_at: iso(record.created_at),
		edited_at: record.edited_at === null ? null : iso(record.edited_at),
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
 * A member can hold live sockets to the room. The room sends each change of a message to them. A
 * socket carries events from the room only: each change is a call of a method of this class.
 *
 * An object that nobody created has no tables. Such an object costs nothing, so a call with a random
 * id leaves no data.
 */
export class ChatRoomDO extends DurableObject<Env> {
	private readonly sql: SqlStorage;
	private hasTables: boolean;
	/** The end of the line of index writes. Each write starts after the one before it ends. */
	private flushed: Promise<void> = Promise.resolve();
	/**
	 * The message allowance of each member, by principal id: the messages that the member can send now,
	 * and the time of that count. It is in memory only. A room that sleeps has no member that sends
	 * messages, so a new start with full allowances gives nothing away.
	 */
	private readonly allowances = new Map<string, { messages: number; at: number }>();
	/** The end of the line of socket events. Each event goes out after the one before it, so the events keep their order. */
	private announced: Promise<void> = Promise.resolve();

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
				const pending =
					this.one<{ n: number }>("SELECT (SELECT COUNT(*) FROM outbox) + (SELECT COUNT(*) FROM webhook_outbox) AS n")
						?.n ?? 0;
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

	/** The other member of a direct message, as JSON, or null for each other kind of room. */
	private peerJson(room: RoomRow, principalId: string): string | null {
		if (room.kind !== "dm") return null;
		return (
			this.one<{ actor_json: string }>("SELECT actor_json FROM members WHERE principal_id <> ? LIMIT 1", principalId)
				?.actor_json ?? null
		);
	}

	/**
	 * The messages of other members after the read marker of a member, without deleted messages. The
	 * count stops at `UNREAD_COUNT_MAX`, so its cost has a limit.
	 */
	private unreadCount(member: MemberRow | null): number {
		if (!member) return 0;
		return (
			this.one<{ n: number }>(
				`SELECT COUNT(*) AS n FROM (SELECT 1 FROM messages
				WHERE seq > ? AND author_id <> ? AND deleted_at IS NULL LIMIT ?)`,
				member.last_read_seq,
				member.principal_id,
				UNREAD_COUNT_MAX,
			)?.n ?? 0
		);
	}

	/**
	 * The messages after the read marker of a member that mention it. A delete of a message removes its
	 * mentions. The count stops at `UNREAD_COUNT_MAX`.
	 */
	private mentionCount(member: MemberRow | null): number {
		if (!member) return 0;
		return (
			this.one<{ n: number }>(
				"SELECT COUNT(*) AS n FROM (SELECT 1 FROM mentions WHERE principal_id = ? AND seq > ? LIMIT ?)",
				member.principal_id,
				member.last_read_seq,
				UNREAD_COUNT_MAX,
			)?.n ?? 0
		);
	}

	/** Keeps the mentions of a message: each principal of its body, except its author. */
	private setMentions(seq: number, authorId: string, body: ChatBody): void {
		this.sql.exec("DELETE FROM mentions WHERE seq = ?", seq);
		for (const principalId of mentionIds(body)) {
			if (principalId !== authorId)
				this.sql.exec("INSERT INTO mentions (principal_id, seq) VALUES (?, ?)", principalId, seq);
		}
	}

	/** The room as one principal sees it. */
	private record(principalId: string): RoomRecord {
		const room = this.room() as RoomRow;
		const member = this.member(principalId);
		const peer = this.peerJson(room, principalId);
		const unreadCount = this.unreadCount(member);
		return {
			id: room.room_id,
			kind: room.kind,
			name: room.name,
			topic: room.topic,
			peer: peer === null ? null : (JSON.parse(peer) as ActorRecord),
			created_at: room.created_at,
			created_by: JSON.parse(room.created_by_json) as ActorRecord,
			member_count: this.memberCount(),
			role: member?.role ?? null,
			last_seq: room.last_seq,
			last_message_at: room.last_message_at,
			last_read_seq: member?.last_read_seq ?? 0,
			unread: unreadCount > 0,
			unread_count: unreadCount,
			mention_count: this.mentionCount(member),
			version: room.version,
			starred: member?.starred === 1,
		};
	}

	/**
	 * The state of the room for the `PrincipalDO` of one principal. Each call takes a new stamp, in the
	 * same step as the read. So a state with a higher stamp is always the newer state.
	 */
	private principalState(room: RoomRow, principalId: string, memberCount = this.memberCount()): ChatRoomState {
		const stamp = Number(
			this.one<{ value: string }>(
				`INSERT INTO meta (key, value) VALUES ('principal_stamp', '1')
				ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1 RETURNING value`,
			)?.value,
		);
		const member = this.member(principalId);
		if (!member) return { room_id: room.room_id, stamp, view: null };
		return {
			room_id: room.room_id,
			stamp,
			view: {
				kind: room.kind,
				name: room.name,
				name_key: room.name === null ? null : nameKey(room.name),
				topic: room.topic,
				created_at: room.created_at,
				created_by_json: room.created_by_json,
				member_count: memberCount,
				role: member.role,
				last_seq: room.last_seq,
				last_message_at: room.last_message_at,
				last_read_seq: member.last_read_seq,
				unread_count: this.unreadCount(member),
				mention_count: this.mentionCount(member),
				peer_json: this.peerJson(room, principalId),
				version: room.version,
				starred: member.starred === 1,
			},
		};
	}

	/**
	 * The state of the room for one principal, for the first fill of its `PrincipalDO`. Null for an
	 * object that nobody created.
	 */
	stateFor(principalId: string): ChatRoomState | null {
		const room = this.room();
		return room ? this.principalState(room, principalId) : null;
	}

	// --- Rooms and members ----------------------------------------------------------------------

	private insertMember(actor: ActorRecord, role: RoomRole, now: number, lastReadSeq: number): void {
		this.sql.exec(
			"INSERT INTO members (principal_id, actor_json, role, joined_at, last_read_seq, membership_id) VALUES (?, ?, ?, ?, ?, ?)",
			actor.principal_id,
			JSON.stringify(actor),
			role,
			now,
			lastReadSeq,
			crypto.randomUUID(),
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
			this.roomChanged(call.actor.principal_id);
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

	/**
	 * True while the index of the current directory has this room as a public room. After a fresh start
	 * of the directory, a room from before is not there, so no new account can find it or join it.
	 */
	private async inDirectory(roomId: string): Promise<boolean> {
		const row = await this.env.DIRECTORY.prepare("SELECT 1 AS found FROM chat_rooms WHERE id = ? AND kind = 'public'")
			.bind(roomId)
			.first();
		return row !== null;
	}

	async get(call: RoomCall): Promise<{ room: RoomRecord; members: MemberRecord[] } | Refusal> {
		const opened = this.open(call, "visible");
		if ("error" in opened) return opened;
		if (!opened.member && !(await this.inDirectory(opened.room.room_id))) return refuse("not_found", NOT_FOUND);
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
			this.roomChanged(call.actor.principal_id);
		});
		await this.publish({ type: "room" });
		return this.record(call.actor.principal_id);
	}

	/** Makes the caller a member of a public room. A room without an owner gets the caller as its owner. */
	async join(call: RoomCall): Promise<{ room: RoomRecord; joined: boolean } | Refusal> {
		const opened = this.open(call, "visible");
		if ("error" in opened) return opened;
		if (opened.member) return { room: this.record(call.actor.principal_id), joined: false };
		if (!(await this.inDirectory(opened.room.room_id))) return refuse("not_found", NOT_FOUND);
		// A different call can run during the read of the directory. Read the state of the room again.
		if (this.member(call.actor.principal_id)) return { room: this.record(call.actor.principal_id), joined: false };
		if (this.memberCount() >= CHAT_LIMITS.membersPerRoom) return refuse("conflict", FULL);
		const hasOwner = this.one("SELECT 1 AS found FROM members WHERE role = 'owner' LIMIT 1") !== null;
		const lastSeq = (this.room() as RoomRow).last_seq;
		this.ctx.storage.transactionSync(() => {
			this.insertMember(call.actor, hasOwner ? "member" : "owner", Date.now(), lastSeq);
			this.roomChanged(call.actor.principal_id);
		});
		await this.publish({ type: "room" });
		return { room: this.record(call.actor.principal_id), joined: true };
	}

	/**
	 * Refuses a caller that cannot add members to this room. The handler asks this before it reads the
	 * directory, so a caller without access to the room learns nothing about a principal id.
	 */
	checkAddMembers(call: RoomCall): { ok: true } | Refusal {
		const opened = this.openAsMember(call);
		if ("error" in opened) return opened;
		if (opened.room.kind === "dm") {
			return refuse("invalid", "A direct message keeps its two members. Create a room for more people.");
		}
		return { ok: true };
	}

	/** Adds principals as members. A new member starts with each message read, and can read them all. */
	async addMembers(call: RoomCall, actors: ActorRecord[]): Promise<{ added: string[]; room: RoomRecord } | Refusal> {
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
				this.roomChanged(call.actor.principal_id);
			});
			await this.publish({ type: "room" });
		}
		return { added: [...fresh.keys()], room: this.record(call.actor.principal_id) };
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
			this.touch(`${PRINCIPAL_TARGET}${principalId}`);
			if (target.role === "owner") {
				const next = this.one<{ principal_id: string }>(
					"SELECT principal_id FROM members ORDER BY joined_at, principal_id LIMIT 1",
				);
				if (next) {
					this.sql.exec("UPDATE members SET role = 'owner' WHERE principal_id = ?", next.principal_id);
					this.touch(`member:${next.principal_id}`);
				}
			}
			this.roomChanged(call.actor.principal_id);
		});
		// The sockets of the removed member close in the same step, so no later event reaches them.
		for (const socket of this.ctx.getWebSockets(socketTag(principalId))) {
			this.end(socket, CHAT_SOCKET_CLOSE.ended, "You are not a member of this room now.");
		}
		await this.publish({ type: "room" });
		return { removed: true };
	}

	// --- Messages -------------------------------------------------------------------------------

	/**
	 * A page of the history (the newest page, the page before a seq, or the page after a seq), or the
	 * messages that changed after a version of the room. The messages of the history are oldest first.
	 */
	listMessages(
		call: RoomCall,
		input: { before: number | null; after: number | null; changedAfter: number | null; limit: number },
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
		} else if (input.after !== null) {
			rows = this.all<MessageRow>(
				"SELECT * FROM messages WHERE seq > ? ORDER BY seq LIMIT ?",
				input.after,
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
		// A page of the newest messages, and a page before a message, come newest first from the table.
		if (input.changedAfter === null && input.after === null) page.reverse();
		return {
			messages: this.messageRecords(opened.room.room_id, page),
			version: opened.room.version,
			hasMore,
		};
	}

	/**
	 * Takes one message from the allowance of the caller, or refuses the call when the allowance is
	 * empty. A member starts with `CHAT_LIMITS.messageBurst` messages, and gets one more in each
	 * `CHAT_LIMITS.messageRefillSeconds`, up to that number. Each new and each changed message uses one:
	 * the room sends the two to each socket.
	 *
	 * The room keeps the allowance of a member that leaves, so a member cannot leave and join again to
	 * get a full allowance. It keeps `MAX_ALLOWANCES` at most. At that number, it removes each allowance
	 * that is full again, which is the same as no allowance. If no allowance is full, it refuses a
	 * caller that has none, until one is. Only principals that join, send and leave in large numbers in
	 * some seconds can cause that.
	 */
	private spendAllowance(call: RoomCall, now: number): Refusal | null {
		const refillMs = CHAT_LIMITS.messageRefillSeconds * 1000;
		const fullMs = CHAT_LIMITS.messageBurst * refillMs;
		const limited = (seconds: number, reason: string): Refusal => {
			log("info", "chat message rate limited", { roomId: call.roomId, principalId: call.actor.principal_id });
			return refuse("rate_limited", `${reason} Try again in ${seconds === 1 ? "1 second" : `${seconds} seconds`}.`);
		};
		const earlier = this.allowances.get(call.actor.principal_id);
		if (!earlier && this.allowances.size >= MAX_ALLOWANCES) {
			for (const [principalId, allowance] of this.allowances) {
				if (now - allowance.at >= fullMs) this.allowances.delete(principalId);
			}
			if (this.allowances.size >= MAX_ALLOWANCES) {
				return limited(fullMs / 1000, "Too many people and agents sent messages to this room in a short time.");
			}
		}
		const messages = earlier
			? Math.min(CHAT_LIMITS.messageBurst, earlier.messages + Math.max(0, now - earlier.at) / refillMs)
			: CHAT_LIMITS.messageBurst;
		if (messages < 1) {
			this.allowances.set(call.actor.principal_id, { messages, at: now });
			return limited(Math.ceil(((1 - messages) * refillMs) / 1000), "You sent too many messages to this room.");
		}
		this.allowances.set(call.actor.principal_id, { messages: messages - 1, at: now });
		return null;
	}

	private message(messageId: string): MessageRow | null {
		return this.one<MessageRow>("SELECT * FROM messages WHERE id = ?", messageId);
	}

	/**
	 * The reactions of each message of the list, by message id: one entry for each emoji, in the order
	 * of the first reaction of each emoji, with the principals oldest first.
	 */
	private reactionsOf(messageIds: readonly string[]): Map<string, ChatReaction[]> {
		const byMessage = new Map<string, ChatReaction[]>();
		if (messageIds.length === 0) return byMessage;
		const rows = this.all<{ message_id: string; emoji: string; principal_id: string }>(
			`SELECT message_id, emoji, principal_id FROM reactions JOIN json_each(?) wanted ON wanted.value = message_id
			ORDER BY version`,
			JSON.stringify(messageIds),
		);
		for (const row of rows) {
			const reactions = byMessage.get(row.message_id) ?? [];
			let reaction = reactions.find((entry) => entry.emoji === row.emoji);
			if (!reaction) {
				reaction = { emoji: row.emoji, count: 0, principal_ids: [] };
				reactions.push(reaction);
			}
			reaction.count += 1;
			reaction.principal_ids.push(row.principal_id);
			byMessage.set(row.message_id, reactions);
		}
		return byMessage;
	}

	/** One message with its reactions. */
	private messageRecord(roomId: string, row: MessageRow): MessageRecord {
		return toMessage(roomId, row, this.reactionsOf([row.id]).get(row.id) ?? []);
	}

	/** The messages of a page with their reactions, with one read of the reactions. */
	private messageRecords(roomId: string, rows: readonly MessageRow[]): MessageRecord[] {
		const reactions = this.reactionsOf(rows.map((row) => row.id));
		return rows.map((row) => toMessage(roomId, row, reactions.get(row.id) ?? []));
	}

	/**
	 * Adds or removes the reaction of the caller with one emoji. A call that changes nothing returns the
	 * message, and sends no event. A change gives the message and the room a new version, so a client
	 * gets it with `changed_after`, and the sockets get the message.
	 */
	async react(
		call: RoomCall,
		messageId: string,
		emoji: string,
		add: boolean,
	): Promise<{ message: MessageRecord; changed: boolean } | Refusal> {
		const opened = this.openAsMember(call);
		if ("error" in opened) return opened;
		const row = this.message(messageId);
		if (!row) return refuse("not_found", NO_MESSAGE);
		const roomId = opened.room.room_id;
		const principalId = call.actor.principal_id;
		const has =
			this.one(
				"SELECT 1 AS found FROM reactions WHERE message_id = ? AND emoji = ? AND principal_id = ?",
				messageId,
				emoji,
				principalId,
			) !== null;
		if (add && row.deleted_at !== null) return refuse("invalid", "The message is deleted, so it takes no reaction.");
		if (add === has) return { message: this.messageRecord(roomId, row), changed: false };
		if (add) {
			const emojiCount =
				this.one<{ n: number }>(
					"SELECT COUNT(DISTINCT emoji) AS n FROM reactions WHERE message_id = ? AND emoji <> ?",
					messageId,
					emoji,
				)?.n ?? 0;
			const known =
				this.one("SELECT 1 AS found FROM reactions WHERE message_id = ? AND emoji = ?", messageId, emoji) !== null;
			if (!known && emojiCount >= CHAT_LIMITS.reactionEmoji) {
				return refuse(
					"conflict",
					`A message can have reactions with ${CHAT_LIMITS.reactionEmoji} different emoji at most.`,
				);
			}
		}
		const limited = this.spendAllowance(call, Date.now());
		if (limited) return limited;
		const version = opened.room.version + 1;
		this.ctx.storage.transactionSync(() => {
			if (add) {
				this.sql.exec(
					"INSERT INTO reactions (message_id, emoji, principal_id, created_at, version) VALUES (?, ?, ?, ?, ?)",
					messageId,
					emoji,
					principalId,
					Date.now(),
					version,
				);
			} else {
				this.sql.exec(
					"DELETE FROM reactions WHERE message_id = ? AND emoji = ? AND principal_id = ?",
					messageId,
					emoji,
					principalId,
				);
			}
			this.sql.exec("UPDATE messages SET version = ? WHERE id = ?", version, messageId);
			this.sql.exec("UPDATE room SET version = ? WHERE id = 1", version);
			this.roomChanged(principalId);
		});
		const message = this.messageRecord(roomId, this.message(messageId) as MessageRow);
		await this.publish({ type: "message", message: messageOutput(message) });
		return { message, changed: true };
	}

	/**
	 * The content with its mentions as nodes (`withMentions`), after the checks of access, so a caller
	 * outside the room reads no directory and learns nothing about it. Then each mention of a principal
	 * that cannot see the room is text. Each principal can see a public room. A private room and a direct
	 * message are for their members only. The text stays the same: a mention and its text are "@" and the
	 * label.
	 */
	private async mentionedContent(room: RoomRow, input: MessageContent): Promise<MessageContent | Refusal> {
		const canSee = (principalId: string) => room.kind === "public" || this.member(principalId) !== null;
		try {
			return await withMentions(this.env.DIRECTORY, input, canSee);
		} catch (error) {
			if (error instanceof OperationError && (error.code === "invalid" || error.code === "payload_too_large")) {
				return refuse(error.code, error.detail);
			}
			throw error;
		}
	}

	/** Adds a message. The room is then read for its author. */
	async postMessage(
		call: RoomCall,
		input: {
			id: string;
			content: MessageContent;
			/** The key of the room for a retry: the caller and the key of the client. */
			idempotency?: { key: string; requestHash: string } | undefined;
			/** The key of the client, as the caller gave it. The message keeps it. */
			clientKey: string | null;
		},
	): Promise<{ message: MessageRecord; duplicate: boolean } | Refusal> {
		// Hold room calls until the subscription boundary and message commit agree on their order.
		const posted = await this.ctx.blockConcurrencyWhile(async () => {
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
					return { message: this.messageRecord(opened.room.room_id, row), duplicate: true };
				}
			}
			const subscriptionSequence = await chatWebhookBoundary(this.env.DIRECTORY);
			// A retry with the same key returned above: it adds no message, so it uses no allowance.
			const limited = this.spendAllowance(call, now);
			if (limited) return limited;
			const content = await this.mentionedContent(opened.room, input.content);
			if ("error" in content) return content;
			const version = opened.room.version + 1;
			this.ctx.storage.transactionSync(() => {
				const seq = this.one<{ seq: number }>(
					`INSERT INTO messages (id, author_id, author_json, text, body_json, created_at, version, idempotency_key)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
					input.id,
					call.actor.principal_id,
					JSON.stringify(call.actor),
					content.text,
					JSON.stringify(content.body),
					now,
					version,
					input.clientKey,
				)?.seq as number;
				this.sql.exec("UPDATE room SET last_seq = ?, last_message_at = ?, version = ? WHERE id = 1", seq, now, version);
				this.sql.exec("UPDATE members SET last_read_seq = ? WHERE principal_id = ?", seq, call.actor.principal_id);
				this.setMentions(seq, call.actor.principal_id, content.body);
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
				this.queueChatEvent(
					opened.room.room_id,
					"chat.message.created",
					input.id,
					input.id,
					call.actor.principal_id,
					now,
					subscriptionSequence,
				);
				this.roomChanged(call.actor.principal_id);
			});
			const message = this.messageRecord(opened.room.room_id, this.message(input.id) as MessageRow);
			return { message, duplicate: false };
		});
		if (!("error" in posted) && !posted.duplicate) {
			await this.publish({ type: "message", message: messageOutput(posted.message) });
		}
		return posted;
	}

	/** Replaces the content of a message. Only its author can do this. */
	async editMessage(
		call: RoomCall,
		messageId: string,
		input: MessageContent,
	): Promise<{ message: MessageRecord; changed: boolean } | Refusal> {
		// Hold other room calls until the new version and the webhook event are stored.
		const edited = await this.ctx.blockConcurrencyWhile(async () => {
			const opened = this.openAsMember(call);
			if ("error" in opened) return opened;
			const subscriptionSequence = await chatWebhookBoundary(this.env.DIRECTORY);
			const row = this.message(messageId);
			const room = this.room();
			if (!row || !room) return refuse("not_found", NO_MESSAGE);
			if (row.author_id !== call.actor.principal_id) {
				return refuse("forbidden", "You can change only a message that you wrote.");
			}
			if (row.deleted_at !== null) return refuse("invalid", "The message is deleted, so it cannot change.");
			const content = await this.mentionedContent(room, input);
			if ("error" in content) return content;
			const bodyJson = JSON.stringify(content.body);
			const same = row.text === content.text && (row.body_json ?? JSON.stringify(textBody(row.text))) === bodyJson;
			if (same) return { message: this.messageRecord(room.room_id, row), changed: false as const };
			const limited = this.spendAllowance(call, Date.now());
			if (limited) return limited;
			const version = room.version + 1;
			const now = Date.now();
			this.ctx.storage.transactionSync(() => {
				this.sql.exec(
					"UPDATE messages SET text = ?, body_json = ?, edited_at = ?, version = ? WHERE id = ?",
					content.text,
					bodyJson,
					now,
					version,
					messageId,
				);
				this.setMentions(row.seq, row.author_id, content.body);
				this.sql.exec("UPDATE room SET version = ? WHERE id = 1", version);
				this.roomChanged(call.actor.principal_id);
				this.queueChatEvent(
					room.room_id,
					"chat.message.updated",
					messageId,
					`${messageId}:${version}`,
					call.actor.principal_id,
					now,
					subscriptionSequence,
				);
			});
			const message = this.messageRecord(room.room_id, this.message(messageId) as MessageRow);
			return { message, changed: true as const };
		});
		if (!("error" in edited) && edited.changed) {
			await this.publish({ type: "message", message: messageOutput(edited.message) });
		}
		return edited;
	}

	/** Deletes the text of a message. Its author and the owner of the room can do this. */
	async deleteMessage(call: RoomCall, messageId: string): Promise<{ deleted: boolean } | Refusal> {
		const deleted = await this.ctx.blockConcurrencyWhile(async () => {
			const opened = this.openAsMember(call);
			if ("error" in opened) return opened;
			const subscriptionSequence = await chatWebhookBoundary(this.env.DIRECTORY);
			const row = this.message(messageId);
			const room = this.room();
			if (!row || !room) return refuse("not_found", NO_MESSAGE);
			if (row.author_id !== call.actor.principal_id && opened.member.role !== "owner") {
				return refuse(
					"forbidden",
					"You can delete a message that you wrote. The owner of the room can delete each message.",
				);
			}
			if (row.deleted_at !== null) return { deleted: false as const };
			const version = room.version + 1;
			const now = Date.now();
			this.ctx.storage.transactionSync(() => {
				this.sql.exec(
					// The key goes with the text: an author can make a key from the content of the message.
					"UPDATE messages SET text = '', body_json = NULL, idempotency_key = NULL, deleted_at = ?, version = ? WHERE id = ?",
					now,
					version,
					messageId,
				);
				// A deleted message keeps no reaction and no mention.
				this.sql.exec("DELETE FROM reactions WHERE message_id = ?", messageId);
				this.sql.exec("DELETE FROM mentions WHERE seq = ?", row.seq);
				this.sql.exec("UPDATE room SET version = ? WHERE id = 1", version);
				this.roomChanged(call.actor.principal_id);
				this.queueChatEvent(
					room.room_id,
					"chat.message.deleted",
					messageId,
					`${messageId}:${version}`,
					call.actor.principal_id,
					now,
					subscriptionSequence,
				);
			});
			const message = this.messageRecord(room.room_id, this.message(messageId) as MessageRow);
			return { deleted: true as const, message };
		});
		if (!("error" in deleted) && deleted.deleted) {
			await this.publish({ type: "message", message: messageOutput(deleted.message) });
		}
		if ("error" in deleted) return deleted;
		return { deleted: deleted.deleted };
	}

	/**
	 * Sets the read marker of the caller. Without `seq`, the marker goes to the newest message. The
	 * `PrincipalDO` of the caller has the new state before the call returns, so each device of the
	 * caller gets it with its next list.
	 */
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
				this.touch(`${PRINCIPAL_TARGET}${call.actor.principal_id}`);
			});
			await this.flush();
		}
		return { lastReadSeq, unread: this.unreadCount(this.member(call.actor.principal_id)) > 0 };
	}

	/**
	 * Puts the star of the caller on the room, or removes it. Only the caller sees its star. The star is
	 * part of the member row, so a member that leaves loses it. As for the read marker, the
	 * `PrincipalDO` of the caller has the new state before the call returns, and the room sends no
	 * socket event: the events socket of the caller has the change.
	 */
	async star(call: RoomCall, starred: boolean): Promise<RoomRecord | Refusal> {
		const opened = this.openAsMember(call);
		if ("error" in opened) return opened;
		if ((opened.member.starred === 1) !== starred) {
			this.ctx.storage.transactionSync(() => {
				this.sql.exec(
					"UPDATE members SET starred = ? WHERE principal_id = ?",
					starred ? 1 : 0,
					call.actor.principal_id,
				);
				this.touch(`${PRINCIPAL_TARGET}${call.actor.principal_id}`);
			});
			await this.flush();
		}
		return this.record(call.actor.principal_id);
	}

	// --- Live sockets ---------------------------------------------------------------------------

	/**
	 * Accepts the socket of a member. The Worker authenticated the caller, and sends who it is in
	 * `SOCKET_HEADER`. The object can sleep while its sockets wait. The first event is `hello`, with the
	 * version of the room, so the client knows if it must get changes.
	 */
	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			return new Response("This object accepts sockets only.", { status: 426, headers: { upgrade: "websocket" } });
		}
		const open = JSON.parse(decodeURIComponent(request.headers.get(SOCKET_HEADER) ?? "null")) as SocketOpen | null;
		if (!open) return new Response("The request does not say who opens the socket.", { status: 400 });
		const opened = this.openAsMember({ roomId: open.roomId, actor: open.actor });
		if ("error" in opened) return Response.json(opened, { status: 403 });

		// At the limit, a new socket closes the oldest socket of this member that is not a feed. A feed is
		// never closed for this, and a new feed is refused: its stream then leaves the room out.
		const tag = socketTag(open.actor.principal_id);
		const mine = this.ctx.getWebSockets(tag);
		if (mine.length >= CHAT_LIMITS.socketsPerMember) {
			const oldest = open.feed
				? undefined
				: mine
						.map((socket) => ({ socket, state: socket.deserializeAttachment() as SocketState | null }))
						.filter((entry) => entry.state?.feed !== true)
						.sort((a, b) => (a.state?.openedAt ?? 0) - (b.state?.openedAt ?? 0))[0];
			if (!oldest) return Response.json(refuse("conflict", TOO_MANY_SOCKETS), { status: 409 });
			this.end(oldest.socket, CHAT_SOCKET_CLOSE.replaced, "This member opened too many sockets to the room.");
		}

		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server, [tag]);
		const now = Date.now();
		server.serializeAttachment({
			credential: open.credential,
			feed: open.feed,
			openedAt: now,
			checkedAt: now,
		} satisfies SocketState);
		// The runtime answers a ping by itself, so a client can test its connection and the object stays asleep.
		this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
		this.send(server, {
			type: "hello",
			protocol: CHAT_SOCKET_PROTOCOL,
			room_id: opened.room.room_id,
			version: opened.room.version,
		});
		return new Response(null, { status: 101, webSocket: client });
	}

	/** A client sends nothing but pings, which the runtime answers. Each other message closes the socket. */
	override webSocketMessage(socket: WebSocket): void {
		this.end(socket, 1008, "This socket takes no messages. Use the operations.");
	}

	override webSocketClose(socket: WebSocket, code: number, reason: string): void {
		// Completes the close handshake. The runtime can reply by itself, and a closed socket throws.
		this.end(socket, code, reason);
	}

	private end(socket: WebSocket, code: number, reason: string): void {
		try {
			socket.close(code, reason);
		} catch {
			// Closed already, or the code is one that only the runtime can send.
		}
	}

	private send(socket: WebSocket, event: ChatSocketEvent | string): void {
		try {
			socket.send(typeof event === "string" ? event : JSON.stringify(event));
		} catch {
			// The socket closed between the list and the send.
		}
	}

	/** Sends an event to the sockets and writes the index. The sockets do not wait for the index. */
	private async publish(event: ChatSocketEvent): Promise<void> {
		const text = JSON.stringify(event);
		this.announced = this.announced
			.then(() => this.deliver(text))
			.catch((error: unknown) => {
				log("error", "chat socket event failed", { error: error instanceof Error ? error.message : String(error) });
			});
		const sent = this.announced;
		await this.flush();
		await sent;
	}

	/**
	 * Sends one event to each socket. A socket whose credential check is older than `SOCKET_RECHECK_MS`
	 * gets the event only after a new check. That check reads the credentials of all sockets of the room
	 * with one query, and all of them get the time of the check. So a room makes one read of the
	 * directory in `SOCKET_RECHECK_MS` at most, also when its sockets opened at different times.
	 *
	 * A socket whose credential stopped closes. If the check fails, the sockets that waited for it
	 * close, and their clients open new ones, which the Worker authenticates.
	 */
	private async deliver(text: string): Promise<void> {
		const now = Date.now();
		const open: { socket: WebSocket; state: SocketState; waits: boolean }[] = [];
		for (const socket of this.ctx.getWebSockets()) {
			const state = socket.deserializeAttachment() as SocketState | null;
			if (!state || now - state.openedAt >= SOCKET_MAX_MS) {
				this.end(socket, CHAT_SOCKET_CLOSE.reconnect, "The socket reached its longest life. Open a new socket.");
				continue;
			}
			const waits = now - state.checkedAt >= SOCKET_RECHECK_MS;
			if (!waits) this.send(socket, text);
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
			log("warn", "chat socket credential check failed; the sockets that waited close", {
				sockets: open.filter((entry) => entry.waits).length,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		const checkedAt = Date.now();
		let ended = 0;
		for (const [index, { socket, state, waits }] of open.entries()) {
			const check = checks?.[index];
			if (check === undefined) {
				if (waits) this.end(socket, CHAT_SOCKET_CLOSE.reconnect, "The access check failed. Open a new socket.");
			} else if (check === "renew") {
				ended += 1;
				this.end(socket, CHAT_SOCKET_CLOSE.reconnect, "The access token stopped. Open a new socket with a new token.");
			} else if (check === "ended") {
				ended += 1;
				this.end(socket, CHAT_SOCKET_CLOSE.ended, "The credential stopped.");
			} else {
				// The room can remove a member during the check. Its sockets are closed then: the two calls
				// below do nothing for a closed socket.
				try {
					socket.serializeAttachment({ ...state, checkedAt } satisfies SocketState);
				} catch {
					// Closed during the check.
				}
				if (waits) this.send(socket, text);
			}
		}
		if (ended > 0) log("info", "chat sockets closed: the credential stopped", { sockets: ended });
	}

	// --- The index in D1 ------------------------------------------------------------------------

	/**
	 * Records that a target is behind: a row of the index, or the `PrincipalDO` of a principal. `gen`
	 * shows a change that came during a write. A target that waits for a retry is due at once again.
	 */
	private touch(target: string): void {
		this.sql.exec(
			`INSERT INTO outbox (target, gen, next_attempt_at) VALUES (?, 1, ?)
			ON CONFLICT (target) DO UPDATE SET gen = gen + 1, attempts = 0, next_attempt_at = excluded.next_attempt_at`,
			target,
			Date.now(),
		);
	}

	/**
	 * Records a change that each member sees in its list: the room row of the index, and the
	 * `PrincipalDO` of each member. Call it after the change to the members, in the same transaction.
	 *
	 * The `PrincipalDO` of the actor is due at once, so the call returns after its write. The objects of
	 * the other members wait `MEMBER_DELAY_MS`, and the alarm sends them. So a call does not wait for
	 * the objects of all members, and the changes of that time go out as one state for each member. A
	 * target that waits already keeps its earlier time.
	 */
	private roomChanged(actorId: string): void {
		this.touch("room");
		const now = Date.now();
		this.sql.exec(
			`INSERT INTO outbox (target, gen, next_attempt_at)
				SELECT ?1 || principal_id, 1, CASE WHEN principal_id = ?2 THEN ?3 ELSE ?4 END FROM members WHERE true
			ON CONFLICT (target) DO UPDATE SET gen = gen + 1, attempts = 0,
				next_attempt_at = MIN(next_attempt_at, excluded.next_attempt_at)`,
			PRINCIPAL_TARGET,
			actorId,
			now,
			now + MEMBER_DELAY_MS,
		);
	}

	/** Sets the alarm to the first row of the outbox, or removes the alarm when the outbox is empty. */
	private async schedule(): Promise<void> {
		const next =
			this.one<{ at: number | null }>(
				"SELECT MIN(next_attempt_at) AS at FROM (SELECT next_attempt_at FROM outbox UNION ALL SELECT next_attempt_at FROM webhook_outbox)",
			)?.at ?? null;
		if (next === null) await this.ctx.storage.deleteAlarm();
		else await this.ctx.storage.setAlarm(Math.max(next, Date.now()));
	}

	/**
	 * Writes the rows that are behind to the index, after each write that started before. The caller
	 * waits for it, so a list that comes after a change has that change. A failure does not fail the
	 * change: the alarm tries the write again.
	 */
	private async flush(): Promise<void> {
		// The alarm comes first. If the object stops during the write, the alarm does the write later.
		await this.ctx.storage.setAlarm(Date.now() + ALARM_GUARD_MS);
		const run = this.flushed.then(() => this.drain());
		this.flushed = run.catch((error: unknown) => {
			log("error", "chat index drain failed", { error: error instanceof Error ? error.message : String(error) });
		});
		return this.flushed;
	}

	override async alarm(): Promise<void> {
		await this.flush();
		const rows = this.all<{ event_id: string; job: string; attempts: number }>(
			"SELECT event_id, job, attempts FROM webhook_outbox WHERE next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?",
			Date.now(),
			OUTBOX_BATCH,
		);
		for (const row of rows) {
			try {
				await this.env.WEBHOOKS.send(JSON.parse(row.job) as ChatWebhookEventJob);
				this.sql.exec("DELETE FROM webhook_outbox WHERE event_id = ?", row.event_id);
			} catch {
				const attempts = row.attempts + 1;
				this.sql.exec(
					"UPDATE webhook_outbox SET attempts = ?, next_attempt_at = ? WHERE event_id = ?",
					attempts,
					Date.now() + backoff(attempts),
					row.event_id,
				);
				log("warn", "chat webhook queue send failed", { eventId: row.event_id, attempts });
			}
		}
		await this.schedule();
	}

	/** Checks current access at the authoritative room before each webhook attempt. */
	canNotifyWebhook(
		principalId: string,
		messageId: string,
		membershipId: string,
		eventType: ChatWebhookEvent = "chat.message.created",
	): boolean {
		if (!this.hasTables) return false;
		const member = this.one<MemberRow>("SELECT * FROM members WHERE principal_id = ?", principalId);
		const message = this.message(messageId);
		if (member?.membership_id !== membershipId || message === null) return false;
		// A delete still goes to the author when another member deleted the message.
		if (eventType === "chat.message.deleted") return message.deleted_at !== null;
		if (message.author_id === principalId) return false;
		return message.deleted_at === null;
	}

	/** Records one chat event for the members except the actor. Call this inside the room transaction. */
	private queueChatEvent(
		roomId: string,
		eventType: ChatWebhookEvent,
		messageId: string,
		eventId: string,
		actorId: string,
		now: number,
		subscriptionSequence: number,
	): void {
		const recipients = this.all<{ principal_id: string; membership_id: string }>(
			"SELECT principal_id, membership_id FROM members WHERE principal_id != ?",
			actorId,
		).map((member) => ({ id: member.principal_id, membershipId: member.membership_id }));
		if (recipients.length === 0) return;
		const job: ChatWebhookEventJob = {
			v: 1,
			kind: "chat_event",
			roomId,
			eventId,
			occurredAt: now,
			subscriptionSequence,
			recipients,
			eventType,
			messageId,
		};
		this.sql.exec(
			"INSERT INTO webhook_outbox (event_id, job, next_attempt_at) VALUES (?, ?, ?)",
			eventId,
			JSON.stringify(job),
			now,
		);
	}

	/**
	 * Each write holds the state at the time of the write, not at the time of the change. So a write is
	 * safe to run two times, the order of two writes does not matter, and a row never goes out of use:
	 * a write that fails is tried again until it succeeds.
	 *
	 * A pass writes the rows of the index in one D1 batch, and sends the state of the room to each
	 * `PrincipalDO` that is behind, with one call for each. A failure of one target does not stop the
	 * others.
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
			const indexRows = rows.filter((row) => !row.target.startsWith(PRINCIPAL_TARGET));
			const principalRows = rows.filter((row) => row.target.startsWith(PRINCIPAL_TARGET));
			const [indexFailed, principalsFailed] = await Promise.all([
				this.writeIndex(room, indexRows),
				this.sendStates(room, principalRows),
			]);
			if (indexFailed || principalsFailed) break;
		}
		await this.schedule();
	}

	/** Removes a row that the write brought to the current state. A row that changed during the write has a new gen, and stays. */
	private done(row: OutboxRow): void {
		this.sql.exec("DELETE FROM outbox WHERE target = ? AND gen = ?", row.target, row.gen);
	}

	/** Gives a row that failed its next attempt, later with each failure. */
	private retryLater(row: OutboxRow, error: string): void {
		const attempts = row.attempts + 1;
		this.sql.exec(
			"UPDATE outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE target = ? AND gen = ?",
			attempts,
			Date.now() + backoff(attempts),
			error.slice(0, 500),
			row.target,
			row.gen,
		);
	}

	/** Writes the rows of the index in one batch. Returns true when the batch failed. */
	private async writeIndex(room: RoomRow, rows: OutboxRow[]): Promise<boolean> {
		if (rows.length === 0) return false;
		try {
			await this.env.DIRECTORY.batch(rows.map((row) => this.indexStatement(room, row.target)));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log("warn", "chat index write failed", { rows: rows.length, error: message });
			for (const row of rows) this.retryLater(row, message);
			return true;
		}
		for (const row of rows) this.done(row);
		return false;
	}

	/** Sends the current state of the room to the `PrincipalDO` of each row. Returns true when a send failed. */
	private async sendStates(room: RoomRow, rows: OutboxRow[]): Promise<boolean> {
		if (rows.length === 0) return false;
		const memberCount = this.memberCount();
		const results = await Promise.allSettled(
			rows.map((row) => {
				const principalId = row.target.slice(PRINCIPAL_TARGET.length);
				const state = this.principalState(room, principalId, memberCount);
				return this.env.PRINCIPAL.get(this.env.PRINCIPAL.idFromName(principalId)).applyChatRoomStates([state]);
			}),
		);
		let failed = 0;
		results.forEach((result, index) => {
			const row = rows[index] as OutboxRow;
			if (result.status === "fulfilled") {
				this.done(row);
				return;
			}
			failed += 1;
			const reason = result.reason as unknown;
			this.retryLater(row, reason instanceof Error ? reason.message : String(reason));
		});
		if (failed > 0) log("warn", "chat principal state send failed", { targets: rows.length, failed });
		return failed > 0;
	}

	/**
	 * The statement that brings one row of the index to the current state. A row is written only while
	 * its principal is in the directory and not deleted: the creator for the room, the member for a
	 * member. After a fresh start of the directory, the rooms from before have no such principal, so
	 * they stay out of the new index.
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
					WHERE EXISTS (SELECT 1 FROM principals WHERE id = ?13 AND deleted_at IS NULL)
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
				SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM principals WHERE id = ?1 AND deleted_at IS NULL)
				ON CONFLICT (principal_id, room_id) DO UPDATE SET role = excluded.role,
					last_read_seq = excluded.last_read_seq, peer_json = excluded.peer_json`,
			)
			.bind(principalId, room.room_id, member.role, member.last_read_seq, peer);
	}
}
