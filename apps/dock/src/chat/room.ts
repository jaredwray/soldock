import { DurableObject } from "cloudflare:workers";
import {
	CHAT_LIMITS,
	CHAT_SOCKET_CLOSE,
	CHAT_SOCKET_PROTOCOL,
	type ChatAddressedReason,
	type ChatBody,
	type ChatCard,
	type ChatCardAction,
	type ChatEventReason,
	type ChatFile,
	type ChatForwardedMessage,
	type ChatLinkPreview,
	type ChatMessage,
	type ChatReaction,
	type ChatSocketEvent,
	type ChatWebhookEvent,
	defaultRoomMemberScopes,
	type GroupMention,
	type PostingPolicy,
	ROOM_MEMBER_SCOPES,
	type RoomKind,
	type RoomMemberScope,
	type RoomRole,
} from "@asterra/contracts";
import {
	type ActivityInsert,
	type ChatAddressedState,
	type ChatRoomState,
	type ChatThreadState,
	type CredentialCheck,
	type CredentialRef,
	checkCredentials,
	THREADS_PER_ROOM,
	UNREAD_COUNT_MAX,
} from "../identity/index.ts";
import { log, newId, OperationError } from "../platform/index.ts";
import { type ChatWebhookEventJob, chatWebhookBoundary } from "../webhooks/index.ts";
import { bodyMarkdown, groupMentions, type MessageContent, mentionIds, textBody } from "./body.ts";
import { extractLinks, type LinkFacts, type LinkState, linkPreviews, mergeLinks, parseLinks } from "./links.ts";
import { storedGroups, withMentions } from "./mentions.ts";
import { type ChatPushFanout, enqueuePushFanout } from "./push-fanout.ts";
import {
	HAS_LINK_SQL,
	hasLink,
	highlightRanges,
	indexedText,
	type SearchColumns,
	type SearchFilter,
	searchSql,
} from "./search.ts";
import { type SearchEntry, searchIndex } from "./search-index.ts";

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
	peers?: ActorRecord[];
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
	archived_at?: number | null;
	posting_policy?: PostingPolicy;
	can_post?: boolean;
	retention_days?: number | null;
}

export interface MemberRecord extends ActorRecord {
	role: RoomRole;
	/** What the member can do in the room. The owner has each scope. */
	scopes: RoomMemberScope[];
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
	parent_id: string | null;
	also_in_room: boolean;
	/** The summary of the replies, or null without replies. Times are in milliseconds. */
	thread: { reply_count: number; last_reply_at: number; authors: ActorRecord[] } | null;
	files: ChatFile[];
	link_previews: ChatLinkPreview[];
	pinned: boolean;
	untrusted: boolean;
	forwarded: ChatForwardedMessage | null;
	cards: ChatCard[];
}

export interface PinRecord {
	message: MessageRecord;
	pinned_by: ActorRecord;
	pinned_at: number;
}

/** The job of the queue of link previews: fetch the previews of the links of one message. */
export interface LinkPreviewJob {
	v: 1;
	kind: "link_preview";
	roomId: string;
	messageId: string;
}

/**
 * A file of a message, as the Worker gives it to the room: the facts of the item in the drive of the
 * author at the time of the post. The room stores no bytes.
 */
export interface MessageFile {
	item_id: string;
	space_id: string;
	name: string;
	mime_type: string;
	size: number;
	detected_type: string | null;
	preview: { width: number; height: number } | null;
}

/** The kind of a file that a browser can show, from the type that the server found in its bytes. */
function fileKind(detected: string | null): ChatFile["kind"] {
	if (detected === "image/png" || detected === "image/jpeg" || detected === "image/gif" || detected === "image/webp") {
		return "image";
	}
	if (detected === "video/mp4" || detected === "video/webm") return "video";
	return "file";
}

function toChatFile(file: MessageFile): ChatFile {
	return {
		item_id: file.item_id,
		space_id: file.space_id,
		name: file.name,
		mime_type: file.mime_type,
		size: file.size,
		kind: fileKind(file.detected_type),
		preview: file.preview,
	};
}

/**
 * What the Worker tells the room about a new socket, in the `SOCKET_HEADER` of the upgrade request.
 * The Worker authenticated the credential. The room decides if its principal is a member.
 */
export interface SocketOpen {
	roomId: string;
	actor: ActorRecord;
	credential: CredentialRef;
	canType: boolean;
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
	/** Sockets from an older Worker do not announce typing. */
	canType?: boolean;
	showing?: boolean;
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
	archived_at: number | null;
	deleted_at: number | null;
	posting_policy: PostingPolicy;
	retention_days: number | null;
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
	/** The newest change of the room that is for the member, as the JSON of `ChatAddressedState`, or null. */
	addressed_json: string | null;
	/**
	 * The scopes of the member in the room, as a JSON list. Null: the scopes of its kind
	 * (`defaultRoomMemberScopes`), which a member from before the scopes has too.
	 */
	scopes: string | null;
}

/** A message that a search found, with the found parts of its text. */
export interface SearchHitRecord {
	message: MessageRecord;
	/** For a reply, the seq of the first message of its thread. */
	parentSeq: number | null;
	/**
	 * The rank of the message for the words of the query, from the words of this room only (`bm25`): a
	 * lower number is a better match. 0 for a query without words.
	 */
	score: number;
	highlights: { start: number; end: number }[];
}

/** The room of a search result. */
export interface SearchRoomRecord {
	id: string;
	kind: RoomKind;
	name: string | null;
	peer: ActorRecord | null;
	peers?: ActorRecord[];
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
	/** The id of the message that this message replies to, or null. */
	parent_id: string | null;
	also_in_room: number;
	reply_count: number;
	last_reply_at: number | null;
	reply_authors_json: string | null;
	links_json: string | null;
	/** 1 for a message with a link (`hasLink`), else 0. A search filter reads it. */
	has_link: number;
	untrusted: number;
	forwarded_json: string | null;
	cards_json: string | null;
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
const MENTIONS_BACKFILL = `INSERT OR IGNORE INTO mentions (principal_id, seq)
	SELECT json_extract(messages.body_json, node.path || '.attrs.id'), messages.seq
	FROM messages, json_tree(messages.body_json) AS node
	WHERE messages.body_json IS NOT NULL AND messages.deleted_at IS NULL
		AND node.key = 'type' AND node.atom = 'mention'
		AND json_extract(messages.body_json, node.path || '.attrs.id') IS NOT NULL
		AND json_extract(messages.body_json, node.path || '.attrs.id') <> messages.author_id`;

/**
 * The follows of the threads from before the table: each member that wrote a reply follows, and has read up
 * to its newest reply. Members only, as for a new reply.
 */
const THREAD_FOLLOWS_BACKFILL_REPLIES = `INSERT INTO thread_follows (parent_id, principal_id, following, last_read_seq)
	SELECT replies.parent_id, replies.author_id, 1, MAX(replies.seq)
	FROM messages AS replies JOIN members ON members.principal_id = replies.author_id
	WHERE replies.parent_id IS NOT NULL
	GROUP BY replies.parent_id, replies.author_id`;

/**
 * The author of each message with replies from before the table follows, if it is a member. Its marker goes
 * to the newest reply, so the replies from before the table do not show as new. An author that also wrote a
 * reply has a row already: its marker moves up to the newest reply too.
 */
const THREAD_FOLLOWS_BACKFILL_PARENTS = `INSERT INTO thread_follows (parent_id, principal_id, following, last_read_seq)
	SELECT parents.id, parents.author_id, 1, MAX(replies.seq)
	FROM messages AS parents
		JOIN messages AS replies ON replies.parent_id = parents.id
		JOIN members ON members.principal_id = parents.author_id
	WHERE true
	GROUP BY parents.id
	ON CONFLICT (parent_id, principal_id) DO UPDATE SET
		last_read_seq = MAX(last_read_seq, excluded.last_read_seq)`;

/** The rows of `search_mentions` for the messages from before the table: each mention node of each body. */
const SEARCH_MENTIONS_BACKFILL = `INSERT OR IGNORE INTO search_mentions (principal_id, seq)
	SELECT json_extract(messages.body_json, node.path || '.attrs.id'), messages.seq
	FROM messages, json_tree(messages.body_json) AS node
	WHERE messages.body_json IS NOT NULL AND messages.deleted_at IS NULL
		AND node.key = 'type' AND node.atom = 'mention'
		AND json_extract(messages.body_json, node.path || '.attrs.id') IS NOT NULL`;

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
	// The earlier versions of each message: the content before each edit. A message from before has none.
	[
		`CREATE TABLE message_edits (
			message_id TEXT NOT NULL,
			version INTEGER NOT NULL,
			text TEXT NOT NULL,
			body_json TEXT,
			written_at INTEGER NOT NULL,
			replaced_at INTEGER NOT NULL,
			PRIMARY KEY (message_id, version)
		) WITHOUT ROWID`,
	],
	// Threads: a reply has the id of its parent. The parent keeps the summary of its replies.
	[
		"ALTER TABLE messages ADD COLUMN parent_id TEXT",
		"ALTER TABLE messages ADD COLUMN also_in_room INTEGER NOT NULL DEFAULT 0",
		"ALTER TABLE messages ADD COLUMN reply_count INTEGER NOT NULL DEFAULT 0",
		"ALTER TABLE messages ADD COLUMN last_reply_at INTEGER",
		"ALTER TABLE messages ADD COLUMN reply_authors_json TEXT",
		"CREATE INDEX messages_parent ON messages (parent_id, seq) WHERE parent_id IS NOT NULL",
		// The room list and the unread count read this index, so a long thread adds nothing to their reads.
		"CREATE INDEX messages_room_list ON messages (seq) WHERE parent_id IS NULL OR also_in_room = 1",
	],
	// The state of a thread for each member: the follow (1), a stop (0) or a read marker only (null), and the
	// read marker in the thread. A member that leaves loses its rows.
	[
		`CREATE TABLE thread_follows (
			parent_id TEXT NOT NULL,
			principal_id TEXT NOT NULL,
			following INTEGER,
			last_read_seq INTEGER NOT NULL,
			PRIMARY KEY (parent_id, principal_id)
		) WITHOUT ROWID`,
		"CREATE INDEX thread_follows_principal ON thread_follows (principal_id)",
		THREAD_FOLLOWS_BACKFILL_REPLIES,
		THREAD_FOLLOWS_BACKFILL_PARENTS,
	],
	// The time of the newest reply of the thread on each follow, so the state of a member reads only its 50
	// newest followed threads (`followedThreads`) through one index, also when it follows many threads.
	[
		"ALTER TABLE thread_follows ADD COLUMN last_reply_at INTEGER",
		`UPDATE thread_follows SET last_reply_at =
			(SELECT last_reply_at FROM messages WHERE messages.id = thread_follows.parent_id)`,
		`CREATE INDEX thread_follows_recent ON thread_follows (principal_id, last_reply_at DESC, parent_id DESC)
			WHERE following = 1 AND last_reply_at IS NOT NULL`,
	],
	// The files of each message that stays: the facts of an item of the drive of the author (`MessageFile`).
	// The bytes stay in Drive. A deleted message keeps no file.
	[
		`CREATE TABLE message_files (
			message_id TEXT NOT NULL,
			position INTEGER NOT NULL,
			space_id TEXT NOT NULL,
			item_id TEXT NOT NULL,
			file_json TEXT NOT NULL,
			PRIMARY KEY (message_id, item_id)
		) WITHOUT ROWID`,
		"CREATE INDEX message_files_item ON message_files (space_id, item_id)",
		// The link previews of a message (`LinkState`), which the server fetched. Null without links.
		"ALTER TABLE messages ADD COLUMN links_json TEXT",
		// The messages whose link previews wait for a fetch. The alarm sends each to the queue of previews.
		// `origin` is the origin of the post, so the fetch never asks this deployment.
		`CREATE TABLE link_jobs (
			message_id TEXT PRIMARY KEY,
			origin TEXT NOT NULL,
			attempts INTEGER NOT NULL DEFAULT 0,
			next_attempt_at INTEGER NOT NULL
		) WITHOUT ROWID`,
	],
	// The newest change that is for each member (`ChatAddressedState`), for chat.list_addressed and the
	// resource `chat.addressed`. It is part of the member row, so it goes away when the member leaves.
	["ALTER TABLE members ADD COLUMN addressed_json TEXT"],
	// Search. `messages_fts` has the plain text of each message that stays, with the seq as its rowid.
	// `search_mentions` has each principal that a message mentions, also in a reply and also its author. The
	// messages from before get their rows here. The room becomes a target of the outbox for the index of the
	// organization (`SEARCH_ROOM_TARGET`): the index does not know the room, so the room then sends each
	// stored message (`sendSearch`).
	[
		"ALTER TABLE messages ADD COLUMN has_link INTEGER NOT NULL DEFAULT 0",
		`UPDATE messages SET has_link = 1 WHERE deleted_at IS NULL AND ${HAS_LINK_SQL}`,
		"CREATE VIRTUAL TABLE messages_fts USING fts5 (text, tokenize = 'unicode61 remove_diacritics 2')",
		// A delete removes the words of a message from the word index at once, not at a later merge. So the
		// storage of the room keeps no word of a deleted message, and no word of the text before an edit.
		"INSERT INTO messages_fts (messages_fts, rank) VALUES ('secure-delete', 1)",
		`INSERT INTO messages_fts (rowid, text)
			SELECT seq, replace(replace(text, char(57344), ' '), char(57345), ' ') FROM messages WHERE deleted_at IS NULL`,
		`CREATE TABLE search_mentions (
			principal_id TEXT NOT NULL,
			seq INTEGER NOT NULL,
			PRIMARY KEY (principal_id, seq)
		) WITHOUT ROWID`,
		"CREATE INDEX search_mentions_seq ON search_mentions (seq)",
		SEARCH_MENTIONS_BACKFILL,
		"INSERT OR IGNORE INTO outbox (target, gen, next_attempt_at) VALUES ('search:room', 1, 0)",
	],
	[
		`CREATE TABLE chat_notification_outbox (
		event_id TEXT PRIMARY KEY, job TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
		next_attempt_at INTEGER NOT NULL
	) WITHOUT ROWID`,
		"ALTER TABLE members ADD COLUMN last_typed_at INTEGER",
	],
	// Layer 8: group_dm, archive/delete, posting rules, retention, pins, untrusted, forwarded, cards, card actions, activity outbox.
	[
		`CREATE TABLE room_v2 (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			room_id TEXT NOT NULL,
			kind TEXT NOT NULL CHECK (kind IN ('public', 'private', 'dm', 'group_dm')),
			name TEXT,
			topic TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			created_by_json TEXT NOT NULL,
			last_seq INTEGER NOT NULL DEFAULT 0,
			last_message_at INTEGER,
			version INTEGER NOT NULL DEFAULT 0,
			archived_at INTEGER,
			deleted_at INTEGER,
			posting_policy TEXT NOT NULL DEFAULT 'members' CHECK (posting_policy IN ('members', 'owners_only', 'allowlist')),
			retention_days INTEGER
		)`,
		`INSERT INTO room_v2 (id, room_id, kind, name, topic, created_at, created_by_json, last_seq, last_message_at, version)
			SELECT id, room_id, kind, name, topic, created_at, created_by_json, last_seq, last_message_at, version FROM room`,
		"DROP TABLE room",
		"ALTER TABLE room_v2 RENAME TO room",
		`CREATE TABLE post_allowed (
			principal_id TEXT PRIMARY KEY
		) WITHOUT ROWID`,
		`CREATE TABLE pins (
			message_id TEXT PRIMARY KEY,
			pinned_by_json TEXT NOT NULL,
			pinned_at INTEGER NOT NULL
		) WITHOUT ROWID`,
		`CREATE TABLE card_actions (
			id TEXT PRIMARY KEY,
			message_id TEXT NOT NULL,
			card_id TEXT NOT NULL,
			action_id TEXT NOT NULL,
			value TEXT NOT NULL,
			actor_json TEXT NOT NULL,
			created_at INTEGER NOT NULL
		) WITHOUT ROWID`,
		"CREATE INDEX card_actions_message ON card_actions (message_id, created_at DESC, id DESC)",
		`CREATE TABLE activity_outbox (
			id TEXT PRIMARY KEY,
			target_principal_id TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			attempts INTEGER NOT NULL DEFAULT 0,
			next_attempt_at INTEGER NOT NULL
		) WITHOUT ROWID`,
		"CREATE INDEX activity_outbox_due ON activity_outbox (next_attempt_at)",
		"ALTER TABLE messages ADD COLUMN untrusted INTEGER NOT NULL DEFAULT 0",
		"ALTER TABLE messages ADD COLUMN forwarded_json TEXT",
		"ALTER TABLE messages ADD COLUMN cards_json TEXT",
		"CREATE INDEX IF NOT EXISTS messages_active_created ON messages (created_at) WHERE deleted_at IS NULL",
	],
	// The scopes of each member in the room. Null: the scopes of the kind of the member. `left_scopes` keeps
	// the scopes of a principal that left the room with fewer scopes than its kind, for a later join.
	[
		"ALTER TABLE members ADD COLUMN scopes TEXT",
		"CREATE TABLE IF NOT EXISTS left_scopes (principal_id TEXT PRIMARY KEY, scopes TEXT NOT NULL) WITHOUT ROWID",
	],
];

/**
 * The messages of the room list: the messages of the room, and the replies that also went to the room. The
 * text is the condition of the index `messages_room_list`, so SQLite uses that index.
 */
const IN_ROOM_LIST = "(parent_id IS NULL OR also_in_room = 1)";
/** The most authors that the summary of a thread keeps. */
const THREAD_AUTHORS = 3;

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
 * The start of an outbox target for the grant of the room on a file in Drive:
 * `grant:<space id>:<item id>`. The room wants the grant while a message of the room holds the file.
 */
const GRANT_TARGET = "grant:";
/** The start of an outbox target for the delete of an R2 object of the room: `blob:<key>`. */
const BLOB_TARGET = "blob:";
/**
 * The start of an outbox target for the index of the organization: `search:<seq>` for one message, and
 * `search:room` for the room, so the index knows a room without messages too.
 */
const SEARCH_TARGET = "search:";
const SEARCH_ROOM_TARGET = `${SEARCH_TARGET}room`;
/**
 * The outbox target that tells the index that the room made each stored message a target. Its batch comes
 * after the batches of those messages: the outbox sends the targets in their order, and a letter comes after
 * each digit.
 */
const SEARCH_FILLED_TARGET = `${SEARCH_TARGET}filled`;
const SEARCH_DELETE_TARGET = `${SEARCH_TARGET}delete`;
/** The names of the search tables of a room, for `searchSql`. */
const ROOM_SEARCH: SearchColumns = {
	fts: "messages_fts",
	messages: "messages m",
	rowid: "m.seq",
	author: "m.author_id",
	createdAt: "m.created_at",
	hasLink: "m.has_link = 1",
	hasFile: "EXISTS (SELECT 1 FROM message_files f WHERE f.message_id = m.id)",
	isThread: "(m.parent_id IS NOT NULL OR m.reply_count > 0)",
	mentions: "EXISTS (SELECT 1 FROM search_mentions s WHERE s.seq = m.seq AND s.principal_id = ?)",
};
/**
 * The columns of a result of a query with words: the text with the marks of `highlightRanges` around each
 * found word, and the rank. The rank reads the words of this room only, which each member can read. So the
 * order of the results tells nothing about a different room.
 */
const SEARCH_COLUMNS = "highlight(messages_fts, 0, char(57344), char(57345)) AS marked, bm25(messages_fts) AS score";
/** A message row of a search, with its marked text and its rank. The two are null for a query without words. */
type SearchRow = MessageRow & { marked: string | null; score: number | null };
/** The time after a job of link previews goes to the queue, before the room sends it again. */
const LINK_RESEND_MS = 10 * 60_000;
/** The sends of one job of link previews. After them, each preview that waits gets no preview. */
const LINK_ATTEMPTS = 3;
/**
 * The time that the state for the `PrincipalDO` of a member waits after a change of a different
 * member. The changes of that time go out as one state.
 */
export const MEMBER_DELAY_MS = 500;

const NOT_FOUND = "No room has that id, or you have no access to it.";
const NOT_MEMBER = "You are not a member of this room. Join it first with chat.join_room.";
const NO_MESSAGE = "No message has that id in this room.";
const EMPTY_MESSAGE = "A message needs text or a file.";
const FULL = `A room can have ${CHAT_LIMITS.membersPerRoom} members at most.`;
const NO_WRITE = "Your membership of this room does not have chat.write. The owner of the room can add it.";
const NO_ADD_MEMBERS = "Your membership of this room does not have chat.add_members. The owner of the room can add it.";
/**
 * The most message allowances that a room keeps in memory. A room has `membersPerRoom` members at
 * most. The rest is for the members that left a short time before.
 */
const MAX_ALLOWANCES = 2 * CHAT_LIMITS.membersPerRoom;
const TOO_MANY_SOCKETS = `One member can have ${CHAT_LIMITS.socketsPerMember} sockets to a room at most.`;

/**
 * The row of a mention of a group in the table `mentions`, in place of the id of a principal. The id of a
 * principal starts with "prn_", so the two never meet.
 */
function groupRow(group: GroupMention): string {
	return `group:${group}`;
}

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

function toMessage(
	roomId: string,
	row: MessageRow,
	reactions: ChatReaction[],
	files: ChatFile[],
	pinned = false,
): MessageRecord {
	const deleted = row.deleted_at !== null;
	return {
		id: row.id,
		room_id: roomId,
		seq: row.seq,
		author: JSON.parse(row.author_json) as ActorRecord,
		text: row.text,
		created_at: row.created_at,
		edited_at: row.edited_at,
		deleted,
		version: row.version,
		idempotency_key: row.idempotency_key,
		reactions,
		body: row.body_json === null ? textBody(row.text) : (JSON.parse(row.body_json) as ChatBody),
		parent_id: row.parent_id,
		also_in_room: row.also_in_room === 1,
		thread:
			row.reply_count > 0 && row.last_reply_at !== null
				? {
						reply_count: row.reply_count,
						last_reply_at: row.last_reply_at,
						authors: JSON.parse(row.reply_authors_json ?? "[]") as ActorRecord[],
					}
				: null,
		files,
		link_previews: deleted ? [] : linkPreviews(parseLinks(row.links_json)),
		pinned: deleted ? false : pinned,
		untrusted: row.untrusted === 1,
		forwarded: deleted || row.forwarded_json === null ? null : (JSON.parse(row.forwarded_json) as ChatForwardedMessage),
		cards: deleted || row.cards_json === null ? [] : (JSON.parse(row.cards_json) as ChatCard[]),
	};
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

/**
 * The socket event of a new, changed or deleted message: `message` for a message of the room list, and
 * `reply` for a reply that is not in it. A client from before threads ignores `reply`, so it never puts
 * a reply in its room list.
 */
function messageEvent(record: MessageRecord): ChatSocketEvent {
	const message = messageOutput(record);
	return record.parent_id !== null && !record.also_in_room ? { type: "reply", message } : { type: "message", message };
}

/** The state of a thread for one member. */
export interface ThreadFollowRecord {
	following: boolean;
	lastReadSeq: number;
	unreadCount: number;
}

/** An earlier version of a message. Times are in milliseconds. */
export interface MessageEditRecord {
	version: number;
	text: string;
	body: ChatBody;
	written_at: number;
	replaced_at: number;
}

/** A message as the operations and the socket events return it. */
export function messageOutput(record: MessageRecord): ChatMessage {
	return {
		...record,
		markdown: record.deleted ? "" : bodyMarkdown(record.body),
		mentions: record.deleted ? [] : mentionIds(record.body),
		group_mentions: record.deleted ? [] : groupMentions(record.body),
		thread: record.thread && { ...record.thread, last_reply_at: iso(record.thread.last_reply_at) },
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
 * Members receive message changes on their room sockets. A visible room also receives temporary typing events.
 * Each change to stored messages goes through a room operation.
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
	private socketCheck: Promise<void> | undefined;
	/** The end of the line of sends to the search index of the organization. See `sendSearchRows`. */
	private searchSent: Promise<void> = Promise.resolve();

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
					this.one<{ n: number }>(
						`SELECT (SELECT COUNT(*) FROM outbox) + (SELECT COUNT(*) FROM webhook_outbox)
							+ (SELECT COUNT(*) FROM chat_notification_outbox) + (SELECT COUNT(*) FROM activity_outbox) AS n`,
					)?.n ?? 0;
				const hasRetention = this.room()?.retention_days != null;
				if ((pending > 0 || hasRetention) && (await ctx.storage.getAlarm()) === null) {
					await ctx.storage.setAlarm(Date.now());
				}
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

	/** The raw room row including a deleted room (for outbox draining). */
	private rawRoom(): RoomRow | null {
		return this.hasTables ? this.one<RoomRow>("SELECT * FROM room WHERE id = 1") : null;
	}

	/** The active room, or null for an object that nobody created or that was deleted. */
	private room(): RoomRow | null {
		const row = this.rawRoom();
		return row && row.deleted_at === null ? row : null;
	}

	private ensureNotArchived(room: RoomRow): Refusal | null {
		return room.archived_at !== null ? refuse("conflict", "This room is archived and read-only.") : null;
	}

	private isDmKind(kind: RoomKind): boolean {
		return kind === "dm" || kind === "group_dm";
	}

	/**
	 * The scopes of a member in the room. The owner has each scope. A member without stored scopes has the
	 * scopes of its kind. A stored value that is not a list of scopes gives only `chat.read`, so a bad row
	 * never gives more access.
	 */
	private scopesOf(member: MemberRow): RoomMemberScope[] {
		if (member.role === "owner") return [...ROOM_MEMBER_SCOPES];
		if (member.scopes === null) return defaultRoomMemberScopes((JSON.parse(member.actor_json) as ActorRecord).kind);
		let stored: unknown;
		try {
			stored = JSON.parse(member.scopes);
		} catch {
			stored = null;
		}
		const list = Array.isArray(stored) ? stored : [];
		return ROOM_MEMBER_SCOPES.filter((scope) => scope === "chat.read" || list.includes(scope));
	}

	private hasScope(member: MemberRow, scope: RoomMemberScope): boolean {
		return this.scopesOf(member).includes(scope);
	}

	/**
	 * Keeps the scopes of a member that leaves the room, or that the owner removes, when it has fewer scopes
	 * than its kind. Without this, a member of a public room that the owner limited leaves, joins again and
	 * has the scopes of its kind. The row goes away when the principal is a member again.
	 */
	private keepScopes(member: MemberRow): void {
		const held = this.scopesOf(member);
		const usual = defaultRoomMemberScopes((JSON.parse(member.actor_json) as ActorRecord).kind);
		if (usual.every((scope) => held.includes(scope))) {
			this.sql.exec("DELETE FROM left_scopes WHERE principal_id = ?", member.principal_id);
			return;
		}
		this.sql.exec(
			"INSERT INTO left_scopes (principal_id, scopes) VALUES (?, ?) ON CONFLICT (principal_id) DO UPDATE SET scopes = excluded.scopes",
			member.principal_id,
			JSON.stringify(held),
		);
	}

	/** The scopes that a principal had when it left the room with fewer scopes than its kind, or null. */
	private keptScopes(principalId: string): RoomMemberScope[] | null {
		const row = this.one<{ scopes: string }>("SELECT scopes FROM left_scopes WHERE principal_id = ?", principalId);
		if (!row) return null;
		let stored: unknown;
		try {
			stored = JSON.parse(row.scopes);
		} catch {
			stored = null;
		}
		const list = Array.isArray(stored) ? stored : [];
		return ROOM_MEMBER_SCOPES.filter((scope) => scope === "chat.read" || list.includes(scope));
	}

	private memberRecord(row: MemberRow): MemberRecord {
		return {
			...(JSON.parse(row.actor_json) as ActorRecord),
			role: row.role,
			scopes: this.scopesOf(row),
			joined_at: row.joined_at,
		};
	}

	private canPost(room: RoomRow, member: MemberRow | null): boolean {
		if (!member || room.archived_at !== null) return false;
		if (!this.hasScope(member, "chat.write")) return false;
		if (room.posting_policy === "owners_only") return member.role === "owner";
		if (room.posting_policy === "allowlist") {
			if (member.role === "owner") return true;
			return this.one("SELECT 1 AS found FROM post_allowed WHERE principal_id = ?", member.principal_id) !== null;
		}
		return true;
	}

	private postAllowedIds(): string[] {
		return this.all<{ principal_id: string }>("SELECT principal_id FROM post_allowed ORDER BY principal_id").map(
			(row) => row.principal_id,
		);
	}

	private peersJson(room: RoomRow, principalId: string): string | null {
		if (room.kind !== "group_dm") return null;
		const peers = this.all<{ actor_json: string }>(
			"SELECT actor_json FROM members WHERE principal_id <> ? ORDER BY joined_at, principal_id",
			principalId,
		).map((row) => JSON.parse(row.actor_json) as ActorRecord);
		return JSON.stringify(peers);
	}

	private pinnedIdsOf(messageIds: readonly string[]): Set<string> {
		if (messageIds.length === 0) return new Set();
		const rows = this.all<{ message_id: string }>(
			"SELECT message_id FROM pins JOIN json_each(?) wanted ON wanted.value = message_id",
			JSON.stringify(messageIds),
		);
		return new Set(rows.map((row) => row.message_id));
	}

	private pinCount(): number {
		return this.one<{ n: number }>("SELECT COUNT(*) AS n FROM pins")?.n ?? 0;
	}

	private previewOf(text: string): string {
		return text.replace(/\s+/g, " ").trim().slice(0, 200);
	}

	private queueActivity(targetPrincipalId: string, item: ActivityInsert): void {
		this.sql.exec(
			`INSERT OR IGNORE INTO activity_outbox (id, target_principal_id, payload_json, next_attempt_at)
			VALUES (?, ?, ?, ?)`,
			`${targetPrincipalId}:${item.id}`,
			targetPrincipalId,
			JSON.stringify(item),
			Date.now() + MEMBER_DELAY_MS,
		);
	}

	private queueMessageActivities(
		room: RoomRow,
		messageId: string,
		seq: number,
		author: ActorRecord,
		body: ChatBody,
		text: string,
		parent: MessageRow | null,
		now: number,
		untrusted: boolean,
	): void {
		const preview = this.previewOf(text);
		const mentioned = new Set(mentionIds(body));
		const hasGroup = groupMentions(body).length > 0;
		const notified = new Set<string>();
		const recipients = hasGroup
			? this.all<{ principal_id: string }>(
					"SELECT principal_id FROM members WHERE principal_id <> ? LIMIT 200",
					author.principal_id,
				).map((row) => row.principal_id)
			: [...mentioned].filter((id) => id !== author.principal_id && this.member(id) !== null);
		for (const principalId of recipients) {
			notified.add(principalId);
			this.queueActivity(principalId, {
				id: `act:mention:${messageId}:${principalId}`,
				kind: "mention",
				room_id: room.room_id,
				room_name: room.name,
				message_id: messageId,
				seq,
				parent_id: parent?.id ?? null,
				parent_seq: parent?.seq ?? null,
				actor: author,
				emoji: null,
				preview,
				untrusted,
				created_at: now,
			});
		}
		if (parent !== null) {
			const followers = this.all<{ principal_id: string }>(
				"SELECT principal_id FROM thread_follows WHERE parent_id = ? AND following = 1 AND principal_id <> ? LIMIT 200",
				parent.id,
				author.principal_id,
			).map((row) => row.principal_id);
			for (const principalId of followers) {
				if (notified.has(principalId)) continue;
				this.queueActivity(principalId, {
					id: `act:reply:${messageId}:${principalId}`,
					kind: "reply",
					room_id: room.room_id,
					room_name: room.name,
					message_id: messageId,
					seq,
					parent_id: parent.id,
					parent_seq: parent.seq,
					actor: author,
					emoji: null,
					preview,
					untrusted,
					created_at: now,
				});
			}
		}
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

	/**
	 * The same as `openAsMember`, for a call that changes what the members see in the room: a message, a
	 * reaction, a pin or a card. The membership of the caller needs `chat.write`. A member without it still
	 * sets what it read, its star and the threads that it follows.
	 */
	private openAsWriter(call: RoomCall): { room: RoomRow; member: MemberRow } | Refusal {
		const opened = this.openAsMember(call);
		if ("error" in opened) return opened;
		return this.hasScope(opened.member, "chat.write") ? opened : refuse("forbidden", NO_WRITE);
	}

	/** Verifies the caller is a member of this live room. */
	checkMember(call: RoomCall): { ok: true } | Refusal {
		const opened = this.openAsMember(call);
		if ("error" in opened) return opened;
		return { ok: true };
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
	 * The messages of other members after the read marker of a member, without deleted messages and
	 * without the replies that are not in the room list. The count stops at `UNREAD_COUNT_MAX`, so its
	 * cost has a limit.
	 */
	private unreadCount(member: MemberRow | null): number {
		if (!member) return 0;
		return (
			this.one<{ n: number }>(
				`SELECT COUNT(*) AS n FROM (SELECT 1 FROM messages
				WHERE seq > ? AND author_id <> ? AND deleted_at IS NULL AND ${IN_ROOM_LIST} LIMIT ?)`,
				member.last_read_seq,
				member.principal_id,
				UNREAD_COUNT_MAX,
			)?.n ?? 0
		);
	}

	/**
	 * The messages after the read marker of a member that mention it or a group. A message of the member
	 * does not count. A message with a mention and a mention of a group counts one time. A delete of a
	 * message removes its mentions. The count stops at `UNREAD_COUNT_MAX`.
	 */
	private mentionCount(member: MemberRow | null): number {
		if (!member) return 0;
		return (
			this.one<{ n: number }>(
				`SELECT COUNT(*) AS n FROM (
					SELECT DISTINCT seq FROM mentions
					WHERE seq > ?4 AND (principal_id = ?1 OR (principal_id IN (?2, ?3) AND NOT EXISTS (
						SELECT 1 FROM messages WHERE messages.seq = mentions.seq AND messages.author_id = ?1)))
					LIMIT ?5)`,
				member.principal_id,
				groupRow("here"),
				groupRow("channel"),
				member.last_read_seq,
				UNREAD_COUNT_MAX,
			)?.n ?? 0
		);
	}

	/**
	 * Keeps the mentions of a message: each principal of its body, except its author, and a row for each
	 * group (`groupRow`). A reply that is not in the room list keeps no row: the room counts the messages
	 * of the room list only. A mention in a reply starts a follow of its thread (`followOnReply`).
	 */
	private setMentions(seq: number, authorId: string, body: ChatBody, inRoomList = true): void {
		this.sql.exec("DELETE FROM mentions WHERE seq = ?", seq);
		if (!inRoomList) return;
		const rows = [...mentionIds(body).filter((id) => id !== authorId), ...groupMentions(body).map(groupRow)];
		for (const row of rows) this.sql.exec("INSERT INTO mentions (principal_id, seq) VALUES (?, ?)", row, seq);
	}

	/**
	 * Refuses a new mention of a group in a large room, from a member that is not an owner. A mention of
	 * a group that the message has already (`kept`) stays, so its author can still change its text.
	 */
	private groupMentionRefusal(principalId: string, body: ChatBody, kept: readonly GroupMention[]): Refusal | null {
		const added = groupMentions(body).filter((group) => !kept.includes(group));
		if (added.length === 0 || this.memberCount() <= CHAT_LIMITS.groupMentionMembers) return null;
		if (this.member(principalId)?.role === "owner") return null;
		return refuse(
			"forbidden",
			`In a room with more than ${CHAT_LIMITS.groupMentionMembers} members, only an owner of the room can mention @${added[0]}.`,
		);
	}

	/** The room as one principal sees it. */
	private record(principalId: string): RoomRecord {
		const room = this.room() as RoomRow;
		const member = this.member(principalId);
		const peer = this.peerJson(room, principalId);
		const peers = this.peersJson(room, principalId);
		const unreadCount = this.unreadCount(member);
		return {
			id: room.room_id,
			kind: room.kind,
			name: room.name,
			topic: room.topic,
			peer: peer === null ? null : (JSON.parse(peer) as ActorRecord),
			peers: peers === null ? [] : (JSON.parse(peers) as ActorRecord[]),
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
			archived_at: room.archived_at,
			posting_policy: room.posting_policy,
			can_post: this.canPost(room, member),
			retention_days: room.retention_days,
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
		if (room.deleted_at !== null) return { room_id: room.room_id, stamp, view: null };
		const member = this.member(principalId);
		if (!member) return { room_id: room.room_id, stamp, view: null };
		return {
			room_id: room.room_id,
			stamp,
			membership_id: member.membership_id,
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
				peers_json: this.peersJson(room, principalId),
				version: room.version,
				starred: member.starred === 1,
				archived_at: room.archived_at,
				posting_policy: room.posting_policy,
				can_post: this.canPost(room, member),
				retention_days: room.retention_days,
				threads: this.followedThreads(principalId),
				addressed: member.addressed_json === null ? null : (JSON.parse(member.addressed_json) as ChatAddressedState),
			},
		};
	}

	/**
	 * The threads that a member follows and that have replies, newest reply first, at most
	 * `THREADS_PER_ROOM`, each with its unread count (at most `UNREAD_COUNT_MAX`). The inner query reads the
	 * 50 newest follows from the index `thread_follows_recent`, and only those get a count. So the cost has a
	 * limit, also for a member that follows many threads.
	 */
	private followedThreads(principalId: string): ChatThreadState[] {
		return this.all<{ parent_id: string; last_reply_at: number; unread_count: number }>(
			`SELECT newest.parent_id, newest.last_reply_at,
				(SELECT COUNT(*) FROM (SELECT 1 FROM messages AS replies
					WHERE replies.parent_id = newest.parent_id AND replies.seq > newest.last_read_seq
						AND replies.author_id <> ?1 AND replies.deleted_at IS NULL LIMIT ?2)) AS unread_count
			FROM (SELECT parent_id, last_read_seq, last_reply_at FROM thread_follows
				WHERE principal_id = ?1 AND following = 1 AND last_reply_at IS NOT NULL
				ORDER BY last_reply_at DESC, parent_id DESC LIMIT ?3) AS newest
			ORDER BY newest.last_reply_at DESC, newest.parent_id DESC`,
			principalId,
			UNREAD_COUNT_MAX,
			THREADS_PER_ROOM,
		).map((row) => ({ parent_id: row.parent_id, last_reply_at: row.last_reply_at, unread_count: row.unread_count }));
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

	/** `scopes` null: the member gets the scopes of its kind. */
	private insertMember(
		actor: ActorRecord,
		role: RoomRole,
		now: number,
		lastReadSeq: number,
		scopes: readonly RoomMemberScope[] | null = null,
	): void {
		this.sql.exec(
			"INSERT INTO members (principal_id, actor_json, role, joined_at, last_read_seq, membership_id, scopes) VALUES (?, ?, ?, ?, ?, ?, ?)",
			actor.principal_id,
			JSON.stringify(actor),
			role,
			now,
			lastReadSeq,
			crypto.randomUUID(),
			scopes === null ? null : JSON.stringify(ROOM_MEMBER_SCOPES.filter((scope) => scopes.includes(scope))),
		);
		// The member row has the scopes now, so the scopes from an earlier membership are not necessary.
		this.sql.exec("DELETE FROM left_scopes WHERE principal_id = ?", actor.principal_id);
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
			// A dm or group_dm room has no owner: all members are equal.
			this.insertMember(call.actor, this.isDmKind(kind) ? "member" : "owner", now, 0);
			for (const actor of others) this.insertMember(actor, "member", now, 0);
			this.touch(SEARCH_ROOM_TARGET);
			this.roomChanged(call.actor.principal_id);
		});
	}

	/** Creates a public or a private room. The caller becomes its owner. */
	async create(
		call: RoomCall,
		input: { kind: "public" | "private"; name: string; topic: string; members: ActorRecord[] },
	): Promise<RoomRecord | Refusal> {
		if (this.rawRoom()) return refuse("conflict", "A room with this id exists.");
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

	/** Opens or creates a group direct message room (3 to 9 members). */
	async openGroupDm(call: RoomCall, peers: ActorRecord[]): Promise<{ room: RoomRecord; created: boolean } | Refusal> {
		const existing = this.room();
		if (existing) {
			if (existing.kind !== "group_dm" || !this.member(call.actor.principal_id)) return refuse("not_found", NOT_FOUND);
			return { room: this.record(call.actor.principal_id), created: false };
		}
		const unique = new Map<string, ActorRecord>();
		for (const peer of peers) {
			if (peer.principal_id !== call.actor.principal_id) unique.set(peer.principal_id, peer);
		}
		if (unique.size < 2 || unique.size > CHAT_LIMITS.groupDmOthersMax) {
			return refuse("invalid", `A group direct message needs 2 to ${CHAT_LIMITS.groupDmOthersMax} other members.`);
		}
		this.createRoom(call, "group_dm", null, "", [...unique.values()]);
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

	async get(
		call: RoomCall,
	): Promise<{ room: RoomRecord; members: MemberRecord[]; post_allowed_ids: string[]; pin_count: number } | Refusal> {
		const opened = this.open(call, "visible");
		if ("error" in opened) return opened;
		if (!opened.member && !(await this.inDirectory(opened.room.room_id))) return refuse("not_found", NOT_FOUND);
		const members = this.all<MemberRow>("SELECT * FROM members ORDER BY joined_at, principal_id").map((row) =>
			this.memberRecord(row),
		);
		return {
			room: this.record(call.actor.principal_id),
			members,
			post_allowed_ids: this.postAllowedIds(),
			pin_count: this.pinCount(),
		};
	}

	async update(call: RoomCall, input: { name?: string | undefined; topic?: string | undefined }) {
		const opened = this.openAsMember(call);
		if ("error" in opened) return opened;
		const archived = this.ensureNotArchived(opened.room);
		if (archived) return archived;
		if (this.isDmKind(opened.room.kind)) return refuse("invalid", "A direct message has no name and no topic.");
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
		const archived = this.ensureNotArchived(opened.room);
		if (archived) return archived;
		if (!(await this.inDirectory(opened.room.room_id))) return refuse("not_found", NOT_FOUND);
		// A different call can run during the read of the directory. Read the state of the room again.
		if (this.member(call.actor.principal_id)) return { room: this.record(call.actor.principal_id), joined: false };
		if (this.memberCount() >= CHAT_LIMITS.membersPerRoom) return refuse("conflict", FULL);
		const hasOwner = this.one("SELECT 1 AS found FROM members WHERE role = 'owner' LIMIT 1") !== null;
		const lastSeq = (this.room() as RoomRow).last_seq;
		// A principal that left with fewer scopes than its kind joins with those scopes: only the owner gives more.
		const kept = this.keptScopes(call.actor.principal_id);
		this.ctx.storage.transactionSync(() => {
			this.insertMember(call.actor, hasOwner ? "member" : "owner", Date.now(), lastSeq, kept);
			this.roomChanged(call.actor.principal_id);
		});
		await this.publish({ type: "room" });
		return { room: this.record(call.actor.principal_id), joined: true };
	}

	/**
	 * Refuses a caller that cannot add members to this room. The handler asks this before it reads the
	 * directory, so a caller without access to the room learns nothing about a principal id.
	 */
	checkAddMembers(call: RoomCall, scopes?: readonly RoomMemberScope[]): { ok: true } | Refusal {
		const opened = this.openAsMember(call);
		if ("error" in opened) return opened;
		const archived = this.ensureNotArchived(opened.room);
		if (archived) return archived;
		if (this.isDmKind(opened.room.kind)) {
			return refuse("invalid", "A direct message keeps its members. Create a room for more people.");
		}
		const held = this.scopesOf(opened.member);
		if (!held.includes("chat.add_members")) return refuse("forbidden", NO_ADD_MEMBERS);
		// A member gives only what it has, so a member without a scope cannot give that scope to a different member.
		const missing = (scopes ?? []).filter((scope) => !held.includes(scope));
		if (missing.length > 0) {
			return refuse(
				"forbidden",
				`You cannot give ${missing.join(", ")}: your membership of this room does not have it.`,
			);
		}
		return { ok: true };
	}

	/**
	 * Adds principals as members. A new member starts with each message read, and can read them all. With
	 * `scopes`, each new member gets these scopes. Without them, it gets the scopes of its kind that the
	 * membership of the caller has: a member gives only what it has, also when it names no scopes. The result
	 * has the scopes of each named principal that is a member after the call, also a member from before.
	 */
	async addMembers(
		call: RoomCall,
		actors: ActorRecord[],
		scopes?: readonly RoomMemberScope[],
	): Promise<{ added: string[]; room: RoomRecord; members: MemberRecord[] } | Refusal> {
		const allowed = this.checkAddMembers(call, scopes);
		if ("error" in allowed) return allowed;
		const room = this.room() as RoomRow;
		const held = this.scopesOf(this.member(call.actor.principal_id) as MemberRow);
		/** The scopes to store for a new member. Null: the scopes of its kind. */
		const byOwner = (this.member(call.actor.principal_id) as MemberRow).role === "owner";
		const given = (actor: ActorRecord): readonly RoomMemberScope[] | null => {
			const usual = defaultRoomMemberScopes(actor.kind);
			const allowed = scopes ?? usual.filter((scope) => held.includes(scope));
			// A principal that left with fewer scopes than its kind gets no more from a member: only the owner
			// gives more. So a member cannot undo a limit of the owner with a remove and an add.
			const kept = byOwner ? null : this.keptScopes(actor.principal_id);
			const result = kept ? allowed.filter((scope) => kept.includes(scope)) : allowed;
			return !scopes && result.length === usual.length ? null : result;
		};
		const fresh = new Map<string, ActorRecord>();
		for (const actor of actors) if (!this.member(actor.principal_id)) fresh.set(actor.principal_id, actor);
		if (fresh.size > 0) {
			if (this.memberCount() + fresh.size > CHAT_LIMITS.membersPerRoom) return refuse("conflict", FULL);
			this.ctx.storage.transactionSync(() => {
				const now = Date.now();
				for (const actor of fresh.values()) this.insertMember(actor, "member", now, room.last_seq, given(actor));
				this.roomChanged(call.actor.principal_id);
			});
			await this.publish({ type: "room" });
		}
		return { added: [...fresh.keys()], room: this.record(call.actor.principal_id), members: this.membersNamed(actors) };
	}

	/** The members of the room among these principals, each with its scopes. */
	private membersNamed(actors: readonly ActorRecord[]): MemberRecord[] {
		const ids = new Set(actors.map((actor) => actor.principal_id));
		return [...ids].flatMap((id) => {
			const row = this.member(id);
			return row ? [this.memberRecord(row)] : [];
		});
	}

	/** The members of the room among these principals, for a caller that is a member. */
	membersOf(call: RoomCall, principalIds: readonly string[]): { members: MemberRecord[] } | Refusal {
		const opened = this.openAsMember(call);
		if ("error" in opened) return opened;
		return {
			members: principalIds.flatMap((id) => {
				const row = this.member(id);
				return row ? [this.memberRecord(row)] : [];
			}),
		};
	}

	/**
	 * Sets what one member can do in the room. Only the owner of the room does this, or an owner or an admin
	 * of the organization for a public room (`allowAdmin`). The owner has each scope, and a direct message has
	 * no owner, so both keep their scopes. A call that changes nothing writes nothing.
	 */
	async setMemberScopes(
		call: RoomCall,
		input: { principalId: string; scopes: readonly RoomMemberScope[]; allowAdmin: boolean },
	): Promise<{ member: MemberRecord; changed: boolean } | Refusal> {
		const room = this.room();
		if (!room) return refuse("not_found", NOT_FOUND);
		const member = this.member(call.actor.principal_id);
		if (!member && room.kind !== "public") return refuse("not_found", NOT_FOUND);
		if (this.isDmKind(room.kind)) return refuse("invalid", "The members of a direct message keep their scopes.");
		const canManage = member?.role === "owner" || (input.allowAdmin && room.kind === "public");
		if (!canManage) {
			return refuse(
				"forbidden",
				"Only the owner of the room, or an owner or an admin of the organization for a public room, can change the scopes of a member.",
			);
		}
		const archived = this.ensureNotArchived(room);
		if (archived) return archived;
		const target = this.member(input.principalId);
		if (!target) return refuse("not_found", "No member of this room has that id.");
		if (target.role === "owner") return refuse("invalid", "The owner of a room has each scope.");
		const scopes = ROOM_MEMBER_SCOPES.filter((scope) => scope === "chat.read" || input.scopes.includes(scope));
		const current = this.scopesOf(target);
		if (current.length === scopes.length && scopes.every((scope) => current.includes(scope))) {
			return { member: this.memberRecord(target), changed: false };
		}
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(
				"UPDATE members SET scopes = ? WHERE principal_id = ?",
				JSON.stringify(scopes),
				target.principal_id,
			);
			this.touch(`member:${target.principal_id}`);
			this.roomChanged(call.actor.principal_id);
		});
		await this.publish({ type: "room" });
		return { member: this.memberRecord(this.member(target.principal_id) as MemberRow), changed: true };
	}

	/**
	 * Removes a member. A member removes itself to leave the room. Only the owner removes a different
	 * member. When the owner leaves, the member that joined first becomes the owner.
	 */
	async removeMember(call: RoomCall, principalId: string): Promise<{ removed: boolean } | Refusal> {
		const opened = this.openAsMember(call);
		if ("error" in opened) return opened;
		if (this.isDmKind(opened.room.kind)) return refuse("invalid", "Direct messages keep their members.");
		const self = principalId === call.actor.principal_id;
		if (!self && opened.member.role !== "owner") {
			return refuse("forbidden", "Only the owner of the room can remove a different member.");
		}
		const target = self ? opened.member : this.member(principalId);
		if (!target) return { removed: false };
		if (self && opened.room.kind === "private" && this.memberCount() === 1) {
			return refuse("conflict", "You are the last member of this room, so you cannot leave it.");
		}
		this.ctx.storage.transactionSync(() => {
			this.keepScopes(target);
			this.sql.exec("DELETE FROM members WHERE principal_id = ?", principalId);
			this.sql.exec("DELETE FROM thread_follows WHERE principal_id = ?", principalId);
			this.sql.exec("DELETE FROM post_allowed WHERE principal_id = ?", principalId);
			this.sql.exec("DELETE FROM activity_outbox WHERE target_principal_id = ?", principalId);
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

	/** Archives a room so it becomes read-only. Room owner, or org admin/owner on a public room. */
	async archiveRoom(call: RoomCall, allowAdmin: boolean): Promise<RoomRecord | Refusal> {
		const room = this.room();
		if (!room) return refuse("not_found", NOT_FOUND);
		const member = this.member(call.actor.principal_id);
		if (!member && room.kind !== "public") return refuse("not_found", NOT_FOUND);
		if (this.isDmKind(room.kind)) return refuse("invalid", "Direct messages cannot be archived.");
		const canManage = member?.role === "owner" || (allowAdmin && room.kind === "public");
		if (!canManage) {
			return refuse("forbidden", "Only the room owner or an organization admin can archive this room.");
		}
		if (room.archived_at !== null) return refuse("conflict", "This room is already archived.");
		const now = Date.now();
		this.ctx.storage.transactionSync(() => {
			this.sql.exec("UPDATE room SET archived_at = ?, version = version + 1 WHERE id = 1", now);
			this.roomChanged(call.actor.principal_id);
		});
		await this.publish({ type: "room" });
		return this.record(call.actor.principal_id);
	}

	/** Unarchives a room so members can post again. Room owner, or org admin/owner on a public room. */
	async unarchiveRoom(call: RoomCall, allowAdmin: boolean): Promise<RoomRecord | Refusal> {
		const room = this.room();
		if (!room) return refuse("not_found", NOT_FOUND);
		const member = this.member(call.actor.principal_id);
		if (!member && room.kind !== "public") return refuse("not_found", NOT_FOUND);
		if (this.isDmKind(room.kind)) return refuse("invalid", "Direct messages cannot be archived.");
		const canManage = member?.role === "owner" || (allowAdmin && room.kind === "public");
		if (!canManage) {
			return refuse("forbidden", "Only the room owner or an organization admin can unarchive this room.");
		}
		if (room.archived_at === null) return refuse("conflict", "This room is not archived.");
		this.ctx.storage.transactionSync(() => {
			this.sql.exec("UPDATE room SET archived_at = NULL, version = version + 1 WHERE id = 1");
			this.roomChanged(call.actor.principal_id);
		});
		await this.publish({ type: "room" });
		return this.record(call.actor.principal_id);
	}

	/** Deletes a room and cleans up all messages, pins, grants, blobs, webhooks, search rows, and member views. */
	async deleteRoom(
		call: RoomCall,
		input: { dryRun: boolean; allowAdmin: boolean },
	): Promise<{ deleted: boolean; dry_run: boolean; message_count: number; member_count: number } | Refusal> {
		const room = this.room();
		if (!room) return refuse("not_found", NOT_FOUND);
		const member = this.member(call.actor.principal_id);
		const memberCount = this.memberCount();
		const isOrphanPrivate = room.kind === "private" && memberCount === 0 && input.allowAdmin;
		if (!member && room.kind !== "public" && !isOrphanPrivate) return refuse("not_found", NOT_FOUND);
		if (this.isDmKind(room.kind)) return refuse("invalid", "Direct messages cannot be deleted.");
		const canManage = member?.role === "owner" || (input.allowAdmin && (room.kind === "public" || isOrphanPrivate));
		if (!canManage) {
			return refuse("forbidden", "Only the room owner or an organization admin can delete this room.");
		}
		const messageCount = this.one<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE deleted_at IS NULL")?.n ?? 0;
		if (input.dryRun) {
			return { deleted: false, dry_run: true, message_count: messageCount, member_count: memberCount };
		}
		const now = Date.now();
		const memberIds = this.all<{ principal_id: string }>("SELECT principal_id FROM members").map(
			(row) => row.principal_id,
		);
		const fileTargets = this.all<{ space_id: string; item_id: string }>(
			"SELECT DISTINCT space_id, item_id FROM message_files",
		);
		const linkRows = this.all<{ links_json: string }>("SELECT links_json FROM messages WHERE links_json IS NOT NULL");
		const blobKeys: string[] = [];
		for (const row of linkRows) {
			for (const link of parseLinks(row.links_json)) {
				if (link.state === "ready" && link.image) blobKeys.push(link.image.key);
			}
		}
		this.ctx.storage.transactionSync(() => {
			this.sql.exec("UPDATE room SET deleted_at = ?, version = version + 1 WHERE id = 1", now);
			this.sql.exec("DELETE FROM messages_fts");
			this.sql.exec("DELETE FROM messages");
			this.sql.exec("DELETE FROM reactions");
			this.sql.exec("DELETE FROM mentions");
			this.sql.exec("DELETE FROM search_mentions");
			this.sql.exec("DELETE FROM message_edits");
			this.sql.exec("DELETE FROM thread_follows");
			this.sql.exec("DELETE FROM message_files");
			this.sql.exec("DELETE FROM link_jobs");
			this.sql.exec("DELETE FROM pins");
			this.sql.exec("DELETE FROM post_allowed");
			this.sql.exec("DELETE FROM card_actions");
			this.sql.exec("DELETE FROM activity_outbox");
			this.sql.exec("DELETE FROM members");
			this.sql.exec(`DELETE FROM outbox WHERE substr(target, 1, ${SEARCH_TARGET.length}) = ?`, SEARCH_TARGET);
			this.touch("room");
			this.touch("webhooks");
			for (const id of memberIds) {
				this.touch(`member:${id}`);
				this.touch(`${PRINCIPAL_TARGET}${id}`);
			}
			for (const f of fileTargets) this.touch(`${GRANT_TARGET}${f.space_id}:${f.item_id}`);
			for (const key of blobKeys) this.touch(`${BLOB_TARGET}${key}`);
			this.touch(SEARCH_DELETE_TARGET);
		});
		for (const socket of this.ctx.getWebSockets()) {
			this.end(socket, CHAT_SOCKET_CLOSE.ended, "This room was deleted.");
		}
		await this.flush();
		await this.sendSearchRows();
		return { deleted: true, dry_run: false, message_count: messageCount, member_count: memberCount };
	}

	/** Configures who can post in a public or private room. */
	async setPostingRules(
		call: RoomCall,
		input: { policy: PostingPolicy; allowedIds: string[]; allowAdmin: boolean },
	): Promise<{ room: RoomRecord; post_allowed_ids: string[] } | Refusal> {
		const room = this.room();
		if (!room) return refuse("not_found", NOT_FOUND);
		const member = this.member(call.actor.principal_id);
		if (!member && room.kind !== "public") return refuse("not_found", NOT_FOUND);
		if (this.isDmKind(room.kind)) return refuse("invalid", "Direct messages cannot restrict posting.");
		const canManage = member?.role === "owner" || (input.allowAdmin && room.kind === "public");
		if (!canManage) {
			return refuse("forbidden", "Only the room owner or an organization admin can change posting rules.");
		}
		const archived = this.ensureNotArchived(room);
		if (archived) return archived;
		const allowed = input.policy === "allowlist" ? [...new Set(input.allowedIds)] : [];
		if (allowed.length > CHAT_LIMITS.membersPerRoom) {
			return refuse("invalid", `At most ${CHAT_LIMITS.membersPerRoom} allowed posters can be set.`);
		}
		this.ctx.storage.transactionSync(() => {
			this.sql.exec("UPDATE room SET posting_policy = ?, version = version + 1 WHERE id = 1", input.policy);
			this.sql.exec("DELETE FROM post_allowed");
			for (const id of allowed) {
				this.sql.exec("INSERT OR IGNORE INTO post_allowed (principal_id) VALUES (?)", id);
			}
			this.roomChanged(call.actor.principal_id);
		});
		await this.publish({ type: "room" });
		return { room: this.record(call.actor.principal_id), post_allowed_ids: this.postAllowedIds() };
	}

	/** Deletes messages older than retention_days with full cleanup, socket updates, and webhooks. */
	private async pruneExpiredMessages(now: number, limit = 200): Promise<number> {
		const pruned = await this.ctx.blockConcurrencyWhile(async () => {
			// Wait for the D1 subscription boundary before reading room state and versions so concurrent
			// writes cannot interleave between reading room.version and committing the prune transaction.
			const subscriptionSequence = await chatWebhookBoundary(this.env.DIRECTORY);
			const room = this.room();
			if (!room || room.retention_days === null) return null;
			const cutoff = now - room.retention_days * 86_400_000;
			const expired = this.all<MessageRow>(
				"SELECT * FROM messages WHERE deleted_at IS NULL AND created_at < ? ORDER BY seq LIMIT ?",
				cutoff,
				limit,
			);
			if (expired.length === 0) return null;
			const touchedParents = new Set<string>();
			let version = room.version;
			this.ctx.storage.transactionSync(() => {
				for (const row of expired) {
					version += 1;
					this.sql.exec(
						`UPDATE messages SET text = '', body_json = NULL, idempotency_key = NULL, deleted_at = ?, version = ?,
							has_link = 0, forwarded_json = NULL, cards_json = NULL WHERE id = ?`,
						now,
						version,
						row.id,
					);
					this.indexMessage(row.seq, null);
					this.setFiles(row.id, []);
					this.setLinks(row.id, parseLinks(row.links_json), [], null);
					this.sql.exec("DELETE FROM reactions WHERE message_id = ?", row.id);
					this.sql.exec("DELETE FROM mentions WHERE seq = ?", row.seq);
					this.sql.exec("DELETE FROM message_edits WHERE message_id = ?", row.id);
					this.sql.exec("DELETE FROM pins WHERE message_id = ?", row.id);
					this.sql.exec("DELETE FROM card_actions WHERE message_id = ?", row.id);
					this.sql.exec("DELETE FROM activity_outbox WHERE json_extract(payload_json, '$.message_id') = ?", row.id);
					this.queueChatEvent({
						room,
						eventType: "chat.message.deleted",
						messageId: row.id,
						eventId: `${row.id}:${version}`,
						actorId: "system",
						authorId: row.author_id,
						body: row.body_json === null ? textBody(row.text) : (JSON.parse(row.body_json) as ChatBody),
						version,
						now,
						subscriptionSequence,
						parentId: row.parent_id,
					});
					if (row.parent_id !== null) touchedParents.add(row.parent_id);
				}
				for (const parentId of touchedParents) {
					version += 1;
					this.refreshThread(parentId, version);
					const parent = this.message(parentId);
					if (parent && parent.reply_count === 0) this.touchSearch(parent.seq);
				}
				this.sql.exec("UPDATE room SET version = ? WHERE id = 1", version);
				this.roomChanged("system");
			});
			const deletedRecords: MessageRecord[] = [];
			const parentRecords: MessageRecord[] = [];
			for (const row of expired) {
				const updated = this.message(row.id);
				if (updated) deletedRecords.push(this.messageRecord(room.room_id, updated));
			}
			for (const parentId of touchedParents) {
				const parent = this.message(parentId);
				if (parent) parentRecords.push(this.messageRecord(room.room_id, parent));
			}
			return { count: expired.length, deletedRecords, parentRecords };
		});
		if (!pruned) return 0;
		for (const message of pruned.deletedRecords) {
			await this.publish(messageEvent(message));
		}
		for (const parent of pruned.parentRecords) {
			await this.publish(messageEvent(parent));
		}
		return pruned.count;
	}

	/** Sets or clears message retention for a public or private room, with optional dry-run preview. */
	async setRetention(
		call: RoomCall,
		input: { retentionDays: number | null; dryRun: boolean; allowAdmin: boolean },
	): Promise<{ room: RoomRecord; affected_messages: number; pruned_messages: number; dry_run: boolean } | Refusal> {
		const room = this.room();
		if (!room) return refuse("not_found", NOT_FOUND);
		const member = this.member(call.actor.principal_id);
		if (!member && room.kind !== "public") return refuse("not_found", NOT_FOUND);
		if (this.isDmKind(room.kind)) return refuse("invalid", "Direct messages cannot set message retention.");
		const canManage = member?.role === "owner" || (input.allowAdmin && room.kind === "public");
		if (!canManage) {
			return refuse("forbidden", "Only the room owner or an organization admin can change message retention.");
		}
		const now = Date.now();
		const cutoff = input.retentionDays === null ? null : now - input.retentionDays * 86_400_000;
		const affected =
			cutoff === null
				? 0
				: (this.one<{ n: number }>(
						"SELECT COUNT(*) AS n FROM messages WHERE deleted_at IS NULL AND created_at < ?",
						cutoff,
					)?.n ?? 0);
		if (input.dryRun) {
			return {
				room: this.record(call.actor.principal_id),
				affected_messages: affected,
				pruned_messages: 0,
				dry_run: true,
			};
		}
		this.ctx.storage.transactionSync(() => {
			this.sql.exec("UPDATE room SET retention_days = ?, version = version + 1 WHERE id = 1", input.retentionDays);
			this.roomChanged(call.actor.principal_id);
		});
		const pruned = await this.pruneExpiredMessages(now);
		await this.publish({ type: "room" });
		return {
			room: this.record(call.actor.principal_id),
			affected_messages: affected,
			pruned_messages: pruned,
			dry_run: false,
		};
	}

	/** Admin action: assigns an owner to an ownerless public or private room. */
	async adminAssignOwner(actorId: string, target: ActorRecord): Promise<RoomRecord | Refusal> {
		const room = this.room();
		if (!room) return refuse("not_found", NOT_FOUND);
		if (this.isDmKind(room.kind)) return refuse("invalid", "Direct messages do not have owners.");
		const ownerCount = this.one<{ n: number }>("SELECT COUNT(*) AS n FROM members WHERE role = 'owner'")?.n ?? 0;
		if (ownerCount > 0) {
			return refuse("conflict", "This room already has an owner.");
		}
		const existing = this.member(target.principal_id);
		if (room.kind === "private" && !existing) {
			return refuse("forbidden", "An owner assigned to a private room must already be a member of that room.");
		}
		if (!existing && this.memberCount() >= CHAT_LIMITS.membersPerRoom) return refuse("conflict", FULL);
		this.ctx.storage.transactionSync(() => {
			if (existing) {
				this.sql.exec("UPDATE members SET role = 'owner' WHERE principal_id = ?", target.principal_id);
				this.touch(`member:${target.principal_id}`);
			} else {
				this.insertMember(target, "owner", Date.now(), room.last_seq);
			}
			this.sql.exec("UPDATE room SET version = version + 1 WHERE id = 1");
			this.roomChanged(actorId);
		});
		await this.publish({ type: "room" });
		return this.record(target.principal_id);
	}

	/** Removes a deleted principal from this room, even if last member or in a DM. */
	async forceRemoveMember(principalId: string): Promise<{ removed: boolean }> {
		const room = this.room();
		if (!room) return { removed: false };
		const target = this.member(principalId);
		if (!target) return { removed: false };
		this.ctx.storage.transactionSync(() => {
			this.sql.exec("DELETE FROM members WHERE principal_id = ?", principalId);
			this.sql.exec("DELETE FROM thread_follows WHERE principal_id = ?", principalId);
			this.sql.exec("DELETE FROM post_allowed WHERE principal_id = ?", principalId);
			this.sql.exec("DELETE FROM activity_outbox WHERE target_principal_id = ?", principalId);
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
			this.roomChanged("system");
		});
		for (const socket of this.ctx.getWebSockets(socketTag(principalId))) {
			this.end(socket, CHAT_SOCKET_CLOSE.ended, "The principal was deleted.");
		}
		await this.publish({ type: "room" });
		return { removed: true };
	}

	/** Paginated room export. Org owner may export public rooms and rooms they are a member of. */
	async exportPage(
		call: RoomCall,
		input: { allowNonMemberPublic: boolean; afterSeq: number; limit: number },
	): Promise<
		| {
				room: RoomRecord;
				members: MemberRecord[];
				pins: PinRecord[];
				messages: MessageRecord[];
				nextAfterSeq: number | null;
		  }
		| Refusal
	> {
		const room = this.room();
		if (!room) return refuse("not_found", NOT_FOUND);
		const member = this.member(call.actor.principal_id);
		if (!member) {
			if (!input.allowNonMemberPublic || room.kind !== "public" || !(await this.inDirectory(room.room_id))) {
				return refuse("not_found", NOT_FOUND);
			}
		}
		const members = this.all<MemberRow>("SELECT * FROM members ORDER BY joined_at, principal_id").map((row) =>
			this.memberRecord(row),
		);
		const rows = this.all<MessageRow>(
			"SELECT * FROM messages WHERE seq > ? ORDER BY seq LIMIT ?",
			input.afterSeq,
			input.limit + 1,
		);
		const hasMore = rows.length > input.limit;
		const page = rows.slice(0, input.limit);
		const last = page[page.length - 1];
		const pins = input.afterSeq === 0 ? this.readPins(room.room_id) : [];
		return {
			room: this.record(call.actor.principal_id),
			members,
			pins,
			messages: this.messageRecords(room.room_id, page),
			nextAfterSeq: hasMore && last ? last.seq : null,
		};
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
				`SELECT * FROM messages WHERE version > ? AND ${IN_ROOM_LIST} ORDER BY version LIMIT ?`,
				input.changedAfter,
				input.limit + 1,
			);
		} else if (input.after !== null) {
			rows = this.all<MessageRow>(
				`SELECT * FROM messages WHERE seq > ? AND ${IN_ROOM_LIST} ORDER BY seq LIMIT ?`,
				input.after,
				input.limit + 1,
			);
		} else if (input.before !== null) {
			rows = this.all<MessageRow>(
				`SELECT * FROM messages WHERE seq < ? AND ${IN_ROOM_LIST} ORDER BY seq DESC LIMIT ?`,
				input.before,
				input.limit + 1,
			);
		} else {
			rows = this.all<MessageRow>(
				`SELECT * FROM messages WHERE ${IN_ROOM_LIST} ORDER BY seq DESC LIMIT ?`,
				input.limit + 1,
			);
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

	/** The files of messages, in order, by message id. */
	private filesOf(messageIds: readonly string[]): Map<string, ChatFile[]> {
		const byMessage = new Map<string, ChatFile[]>();
		if (messageIds.length === 0) return byMessage;
		const rows = this.all<{ message_id: string; file_json: string }>(
			`SELECT message_id, file_json FROM message_files JOIN json_each(?) wanted ON wanted.value = message_id
			ORDER BY position`,
			JSON.stringify(messageIds),
		);
		for (const row of rows) {
			const files = byMessage.get(row.message_id) ?? [];
			files.push(toChatFile(JSON.parse(row.file_json) as MessageFile));
			byMessage.set(row.message_id, files);
		}
		return byMessage;
	}

	/** One message with its reactions, its files, and its pin state. */
	private messageRecord(roomId: string, row: MessageRow): MessageRecord {
		return toMessage(
			roomId,
			row,
			this.reactionsOf([row.id]).get(row.id) ?? [],
			this.filesOf([row.id]).get(row.id) ?? [],
			this.pinnedIdsOf([row.id]).has(row.id),
		);
	}

	/**
	 * Replaces the files of a message, in the transaction of the caller. Each file that comes or goes
	 * makes its grant target due, so the grant of the room in Drive follows.
	 */
	private setFiles(messageId: string, files: readonly MessageFile[]): void {
		const before = this.all<{ space_id: string; item_id: string }>(
			"SELECT space_id, item_id FROM message_files WHERE message_id = ?",
			messageId,
		);
		this.sql.exec("DELETE FROM message_files WHERE message_id = ?", messageId);
		files.forEach((file, position) => {
			this.sql.exec(
				"INSERT INTO message_files (message_id, position, space_id, item_id, file_json) VALUES (?, ?, ?, ?, ?)",
				messageId,
				position,
				file.space_id,
				file.item_id,
				JSON.stringify(file),
			);
		});
		const targets = new Set([...before, ...files].map((file) => `${GRANT_TARGET}${file.space_id}:${file.item_id}`));
		for (const target of targets) this.touch(target);
	}

	/**
	 * Stores the link states of a message after a change of its text, in the transaction of the caller. A
	 * new link waits for a fetch: the message gets a job for the queue. The picture of a link that went away
	 * goes from R2 through the outbox.
	 */
	private setLinks(
		messageId: string,
		before: readonly LinkState[],
		urls: readonly string[],
		origin: string | null,
	): void {
		const { links, dropped } = mergeLinks(before, urls);
		this.sql.exec(
			"UPDATE messages SET links_json = ? WHERE id = ?",
			links.length === 0 ? null : JSON.stringify(links),
			messageId,
		);
		for (const key of dropped) this.touch(`${BLOB_TARGET}${key}`);
		if (links.some((link) => link.state === "pending") && origin !== null) {
			this.sql.exec(
				`INSERT INTO link_jobs (message_id, origin, next_attempt_at) VALUES (?, ?, ?)
				ON CONFLICT (message_id) DO UPDATE SET origin = excluded.origin, attempts = 0, next_attempt_at = excluded.next_attempt_at`,
				messageId,
				origin,
				Date.now(),
			);
		} else if (!links.some((link) => link.state === "pending")) {
			this.sql.exec("DELETE FROM link_jobs WHERE message_id = ?", messageId);
		}
	}

	/** The links of a message whose preview waits for a fetch, with the author and the origin of the post. */
	linkJob(messageId: string): { authorId: string; origin: string; urls: string[] } | null {
		if (!this.hasTables) return null;
		const row = this.message(messageId);
		const job = this.one<{ origin: string }>("SELECT origin FROM link_jobs WHERE message_id = ?", messageId);
		if (!row || !job || row.deleted_at !== null) return null;
		const urls = parseLinks(row.links_json)
			.filter((link) => link.state === "pending")
			.map((link) => link.url);
		return urls.length === 0 ? null : { authorId: row.author_id, origin: job.origin, urls };
	}

	/**
	 * Changes the link states of a message with a new version, then sends the message to the sockets.
	 * `change` returns true when it changed a state. The pictures in `orphans` go from R2.
	 */
	private async changeLinks(
		messageId: string,
		change: (links: LinkState[]) => boolean,
		orphans: string[] = [],
	): Promise<void> {
		const row = this.message(messageId);
		const room = this.room();
		const links = row && row.deleted_at === null ? parseLinks(row.links_json) : [];
		const changed = row !== null && room !== null && change(links);
		this.ctx.storage.transactionSync(() => {
			for (const key of orphans) this.touch(`${BLOB_TARGET}${key}`);
			if (!changed || !row || !room) return;
			const version = room.version + 1;
			this.sql.exec(
				"UPDATE messages SET links_json = ?, version = ? WHERE id = ?",
				JSON.stringify(links),
				version,
				messageId,
			);
			this.sql.exec("UPDATE room SET version = ? WHERE id = 1", version);
			if (!links.some((link) => link.state === "pending"))
				this.sql.exec("DELETE FROM link_jobs WHERE message_id = ?", messageId);
			this.roomChanged(row.author_id);
		});
		// The change comes from a post or an edit of the author, or from the author, so the author is its actor.
		if (changed && row && room)
			await this.publish(
				messageEvent(this.messageRecord(room.room_id, this.message(messageId) as MessageRow)),
				row.author_id,
			);
		else await this.flush();
	}

	/**
	 * From the queue of link previews: the result of the fetch of each link. A result for a link that does
	 * not wait now (the author changed the text, or removed the preview, or a second delivery came) changes
	 * nothing, and its picture goes from R2.
	 */
	async setLinkPreviews(messageId: string, results: { url: string; facts: LinkFacts | null }[]): Promise<void> {
		if (!this.hasTables) return;
		const orphans: string[] = [];
		const row = this.message(messageId);
		const waiting = new Set(
			row && row.deleted_at === null
				? parseLinks(row.links_json)
						.filter((link) => link.state === "pending")
						.map((link) => link.url)
				: [],
		);
		for (const result of results) {
			if (!waiting.has(result.url) && result.facts?.image) orphans.push(result.facts.image.key);
		}
		await this.changeLinks(
			messageId,
			(links) => {
				let changed = false;
				for (const result of results) {
					const index = links.findIndex((link) => link.url === result.url && link.state === "pending");
					if (index < 0) continue;
					links[index] = result.facts
						? { url: result.url, state: "ready", ...result.facts }
						: { url: result.url, state: "none" };
					changed = true;
				}
				return changed;
			},
			orphans,
		);
	}

	/** Removes the preview of one link of a message of the caller, or of each link. Only the author can. */
	async removeLinkPreview(
		call: RoomCall,
		messageId: string,
		url: string | null,
	): Promise<{ message: MessageRecord } | Refusal> {
		const opened = this.openAsWriter(call);
		if ("error" in opened) return opened;
		const row = this.message(messageId);
		if (!row) return refuse("not_found", NO_MESSAGE);
		if (row.author_id !== call.actor.principal_id) {
			return refuse("forbidden", "You can remove the preview of a message that you wrote only.");
		}
		const removed: string[] = [];
		await this.changeLinks(messageId, (links) => {
			let changed = false;
			links.forEach((link, index) => {
				if ((url !== null && link.url !== url) || link.state === "removed") return;
				if (link.image) removed.push(link.image.key);
				links[index] = { url: link.url, state: "removed" };
				changed = true;
			});
			return changed;
		});
		if (removed.length > 0) {
			this.ctx.storage.transactionSync(() => {
				for (const key of removed) this.touch(`${BLOB_TARGET}${key}`);
			});
			await this.flush();
		}
		return { message: this.messageRecord(opened.room.room_id, this.message(messageId) as MessageRow) };
	}

	/** The picture of the preview of a link, for a member of the room. */
	linkImage(call: RoomCall, messageId: string, url: string): { key: string; type: string; size: number } | Refusal {
		const room = this.room();
		if (!room || !this.member(call.actor.principal_id)) return refuse("not_found", NOT_FOUND);
		const row = this.message(messageId);
		const link =
			row && row.deleted_at === null ? parseLinks(row.links_json).find((entry) => entry.url === url) : undefined;
		if (link?.state !== "ready" || !link.image) return refuse("not_found", "The link has no picture.");
		return { key: link.image.key, type: link.image.type, size: link.image.size };
	}

	/** Sends the jobs of link previews that are due to the queue. A job without a result after its sends gets no preview. */
	private async sendLinkJobs(roomId: string): Promise<void> {
		const rows = this.all<{ message_id: string; attempts: number }>(
			"SELECT message_id, attempts FROM link_jobs WHERE next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?",
			Date.now(),
			OUTBOX_BATCH,
		);
		for (const row of rows) {
			if (row.attempts >= LINK_ATTEMPTS) {
				await this.changeLinks(row.message_id, (links) => {
					let changed = false;
					links.forEach((link, index) => {
						if (link.state !== "pending") return;
						links[index] = { url: link.url, state: "none" };
						changed = true;
					});
					return changed;
				});
				this.sql.exec("DELETE FROM link_jobs WHERE message_id = ?", row.message_id);
				continue;
			}
			const job: LinkPreviewJob = { v: 1, kind: "link_preview", roomId, messageId: row.message_id };
			let wait = LINK_RESEND_MS;
			try {
				await this.env.CHAT_PREVIEWS.send(job);
			} catch (error) {
				wait = backoff(row.attempts + 1);
				log("warn", "chat link preview queue send failed", {
					messageId: row.message_id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			this.sql.exec(
				"UPDATE link_jobs SET attempts = attempts + 1, next_attempt_at = ? WHERE message_id = ?",
				Date.now() + wait,
				row.message_id,
			);
		}
	}

	/** The stored files of a message, in order. */
	private storedFiles(messageId: string): MessageFile[] {
		return this.all<{ file_json: string }>(
			"SELECT file_json FROM message_files WHERE message_id = ? ORDER BY position",
			messageId,
		).map((row) => JSON.parse(row.file_json) as MessageFile);
	}

	/**
	 * Adds a new reply to the summary of its parent, without a read of the other replies: one more reply,
	 * the time of the reply, and its author first. The parent gets `version`.
	 */
	private addToThread(parent: MessageRow, author: ActorRecord, at: number, version: number): void {
		const earlier = JSON.parse(parent.reply_authors_json ?? "[]") as ActorRecord[];
		const authors = [author, ...earlier.filter((one) => one.principal_id !== author.principal_id)].slice(
			0,
			THREAD_AUTHORS,
		);
		this.sql.exec(
			`UPDATE messages SET reply_count = reply_count + 1, last_reply_at = ?, reply_authors_json = ?, version = ?
			WHERE id = ?`,
			at,
			JSON.stringify(authors),
			version,
			parent.id,
		);
	}

	/**
	 * Writes the summary of the replies of a message again, from its replies: the count and the time of the
	 * newest reply that stays, and the authors of the newest replies. A delete of a reply uses it. The parent
	 * gets `version`, so a client of the room list gets the new summary.
	 */
	private refreshThread(parentId: string, version: number): void {
		const summary = this.one<{ n: number; last: number | null }>(
			"SELECT COUNT(*) AS n, MAX(created_at) AS last FROM messages WHERE parent_id = ? AND deleted_at IS NULL",
			parentId,
		);
		const authors = this.all<{ author_json: string }>(
			`SELECT author_json FROM messages WHERE parent_id = ? AND deleted_at IS NULL
			GROUP BY author_id ORDER BY MAX(seq) DESC LIMIT ?`,
			parentId,
			THREAD_AUTHORS,
		).map((row) => JSON.parse(row.author_json) as ActorRecord);
		this.sql.exec(
			"UPDATE messages SET reply_count = ?, last_reply_at = ?, reply_authors_json = ?, version = ? WHERE id = ?",
			summary?.n ?? 0,
			summary?.last ?? null,
			JSON.stringify(authors),
			version,
			parentId,
		);
		this.sql.exec("UPDATE thread_follows SET last_reply_at = ? WHERE parent_id = ?", summary?.last ?? null, parentId);
	}

	/**
	 * A message and a page of its replies, oldest first: the first replies, the last replies before a seq,
	 * the replies after a seq, or the replies that changed after a version of the room.
	 */
	listReplies(
		call: RoomCall,
		messageId: string,
		input: { before: number | null; after: number | null; changedAfter: number | null; limit: number },
	):
		| { parent: MessageRecord; replies: MessageRecord[]; version: number; hasMore: boolean; follow: ThreadFollowRecord }
		| Refusal {
		const opened = this.openAsMember(call);
		if ("error" in opened) return opened;
		const thread = this.threadParent(messageId);
		if ("error" in thread) return thread;
		const { parent } = thread;
		// One row more than the page tells if more replies exist in the direction of the read.
		const rows =
			input.changedAfter !== null
				? this.all<MessageRow>(
						"SELECT * FROM messages WHERE parent_id = ? AND version > ? ORDER BY version LIMIT ?",
						messageId,
						input.changedAfter,
						input.limit + 1,
					)
				: input.before !== null
					? this.all<MessageRow>(
							"SELECT * FROM messages WHERE parent_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
							messageId,
							input.before,
							input.limit + 1,
						)
					: this.all<MessageRow>(
							"SELECT * FROM messages WHERE parent_id = ? AND seq > ? ORDER BY seq LIMIT ?",
							messageId,
							input.after ?? 0,
							input.limit + 1,
						);
		const page = rows.slice(0, input.limit);
		// The last replies before a seq come newest first from the table. The page has them oldest first.
		if (input.changedAfter === null && input.before !== null) page.reverse();
		return {
			parent: this.messageRecord(opened.room.room_id, parent),
			replies: this.messageRecords(opened.room.room_id, page),
			version: opened.room.version,
			hasMore: rows.length > input.limit,
			follow: this.threadFollow(messageId, call.actor.principal_id),
		};
	}

	/** The first message of a thread, or a refusal for an unknown message and for a reply. */
	private threadParent(messageId: string): { parent: MessageRow } | Refusal {
		const parent = this.message(messageId);
		if (!parent) return refuse("not_found", NO_MESSAGE);
		if (parent.parent_id !== null) {
			return refuse("invalid", "The message is a reply, so it has no replies. Use the first message of the thread.");
		}
		return { parent };
	}

	/** The seq of the newest reply of a message, deleted or not, or 0 when it has none. */
	private newestReplySeq(parentId: string): number {
		return (
			this.one<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM messages WHERE parent_id = ?", parentId)?.seq ?? 0
		);
	}

	/**
	 * The state of a thread for one member: the follow, the read marker, and the replies after the marker
	 * that stay, without the replies of the member. A member with no row has read nothing and does not follow.
	 * The count stops at `UNREAD_COUNT_MAX`, as the counts of the room, so its cost has a limit.
	 */
	private threadFollow(parentId: string, principalId: string): ThreadFollowRecord {
		const row = this.one<{ following: number; last_read_seq: number }>(
			"SELECT following, last_read_seq FROM thread_follows WHERE parent_id = ? AND principal_id = ?",
			parentId,
			principalId,
		);
		const lastReadSeq = row?.last_read_seq ?? 0;
		const unread = this.one<{ n: number }>(
			`SELECT COUNT(*) AS n FROM (SELECT 1 FROM messages
			WHERE parent_id = ? AND seq > ? AND author_id <> ? AND deleted_at IS NULL LIMIT ?)`,
			parentId,
			lastReadSeq,
			principalId,
			UNREAD_COUNT_MAX,
		);
		return { following: row?.following === 1, lastReadSeq, unreadCount: unread?.n ?? 0 };
	}

	/**
	 * The follows that a new reply starts. Only members follow.
	 * - The author of the reply follows, also after a stop, and has read up to its reply.
	 * - Each member that the reply mentions follows, also after a stop. Its marker stays, so the earlier
	 *   replies are new for it: they are the context of the mention.
	 * - The author of the parent follows, unless it stopped. A row with a read marker only is no stop.
	 */
	private followOnReply(parent: MessageRow, authorId: string, seq: number, mentioned: readonly string[]): void {
		this.sql.exec(
			`INSERT INTO thread_follows (parent_id, principal_id, following, last_read_seq) VALUES (?, ?, 1, ?)
			ON CONFLICT (parent_id, principal_id) DO UPDATE SET following = 1,
				last_read_seq = MAX(last_read_seq, excluded.last_read_seq)`,
			parent.id,
			authorId,
			seq,
		);
		for (const principalId of new Set(mentioned)) {
			if (principalId === authorId) continue;
			this.sql.exec(
				`INSERT INTO thread_follows (parent_id, principal_id, following, last_read_seq)
					SELECT ?1, principal_id, 1, 0 FROM members WHERE principal_id = ?2
				ON CONFLICT (parent_id, principal_id) DO UPDATE SET following = 1`,
				parent.id,
				principalId,
			);
		}
		this.sql.exec(
			`INSERT INTO thread_follows (parent_id, principal_id, following, last_read_seq)
				SELECT ?1, principal_id, 1, 0 FROM members WHERE principal_id = ?2
			ON CONFLICT (parent_id, principal_id) DO UPDATE SET following = 1 WHERE following IS NULL`,
			parent.id,
			parent.author_id,
		);
	}

	/**
	 * Starts or stops the follow of a thread by the caller. A first follow starts at the newest reply, so the
	 * replies until now count as read. A stop keeps the marker, and a stop with no row has read nothing. A
	 * follow after such a stop, with nothing read, starts at the newest reply too. A follow that runs already
	 * keeps its marker, so a second call changes nothing. Only the caller sees its follow, so the room sends
	 * no socket event.
	 */
	async followThread(call: RoomCall, messageId: string, following: boolean): Promise<ThreadFollowRecord | Refusal> {
		const opened = this.openAsMember(call);
		if ("error" in opened) return opened;
		const thread = this.threadParent(messageId);
		if ("error" in thread) return thread;
		await this.changeThreadState(call.actor.principal_id, messageId, () =>
			this.sql.exec(
				`INSERT INTO thread_follows (parent_id, principal_id, following, last_read_seq, last_reply_at)
				VALUES (?, ?, ?, ?, ?)
				ON CONFLICT (parent_id, principal_id) DO UPDATE SET following = excluded.following,
					last_read_seq = CASE WHEN excluded.following = 1 AND following = 0 AND last_read_seq = 0
						THEN excluded.last_read_seq ELSE last_read_seq END`,
				messageId,
				call.actor.principal_id,
				following ? 1 : 0,
				following ? this.newestReplySeq(messageId) : 0,
				thread.parent.last_reply_at,
			),
		);
		return this.threadFollow(messageId, call.actor.principal_id);
	}

	/**
	 * Writes a change of the follows or of a read marker of a thread. When the row changed, it records in the
	 * same transaction that the `PrincipalDO` of the caller is behind, and waits for the send. So
	 * `chat.list_threads` has the change when the call returns, as for `chat.mark_read`. A call that changes
	 * nothing sends no state, as for `chat.mark_read` and `chat.star_room`.
	 */
	private async changeThreadState(principalId: string, parentId: string, write: () => void): Promise<void> {
		const read = () =>
			JSON.stringify(
				this.one(
					"SELECT following, last_read_seq FROM thread_follows WHERE parent_id = ? AND principal_id = ?",
					parentId,
					principalId,
				) ?? null,
			);
		let changed = false;
		this.ctx.storage.transactionSync(() => {
			const before = read();
			write();
			changed = read() !== before;
			if (changed) this.touch(`${PRINCIPAL_TARGET}${principalId}`);
		});
		if (changed) await this.flush();
	}

	/**
	 * Sets the read marker of the caller in a thread. Without `seq`, the marker goes to the newest reply. The
	 * follow does not change: a member that does not follow keeps a marker too, with a null follow. A message
	 * with no reply gets no new row, so a loop over the history writes nothing.
	 */
	async markThreadRead(call: RoomCall, messageId: string, seq: number | null): Promise<ThreadFollowRecord | Refusal> {
		const opened = this.openAsMember(call);
		if ("error" in opened) return opened;
		const thread = this.threadParent(messageId);
		if ("error" in thread) return thread;
		const newest = this.newestReplySeq(messageId);
		if (newest === 0) return this.threadFollow(messageId, call.actor.principal_id);
		await this.changeThreadState(call.actor.principal_id, messageId, () =>
			this.sql.exec(
				`INSERT INTO thread_follows (parent_id, principal_id, following, last_read_seq, last_reply_at)
				VALUES (?, ?, NULL, ?, ?)
				ON CONFLICT (parent_id, principal_id) DO UPDATE SET last_read_seq = excluded.last_read_seq`,
				messageId,
				call.actor.principal_id,
				Math.min(seq ?? newest, newest),
				thread.parent.last_reply_at,
			),
		);
		return this.threadFollow(messageId, call.actor.principal_id);
	}

	/** The messages of a page with their reactions, files, and pin state. */
	private messageRecords(roomId: string, rows: readonly MessageRow[]): MessageRecord[] {
		const ids = rows.map((row) => row.id);
		const reactions = this.reactionsOf(ids);
		const files = this.filesOf(ids);
		const pins = this.pinnedIdsOf(ids);
		return rows.map((row) =>
			toMessage(roomId, row, reactions.get(row.id) ?? [], files.get(row.id) ?? [], pins.has(row.id)),
		);
	}

	private readPins(roomId: string): PinRecord[] {
		const rows = this.all<{ message_id: string; pinned_by_json: string; pinned_at: number }>(
			"SELECT message_id, pinned_by_json, pinned_at FROM pins ORDER BY pinned_at DESC, message_id DESC",
		);
		if (rows.length === 0) return [];
		const msgRows = this.all<MessageRow>(
			"SELECT * FROM messages WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL",
			JSON.stringify(rows.map((r) => r.message_id)),
		);
		const byId = new Map(this.messageRecords(roomId, msgRows).map((m) => [m.id, m]));
		const out: PinRecord[] = [];
		for (const row of rows) {
			const message = byId.get(row.message_id);
			if (message) {
				out.push({
					message,
					pinned_by: JSON.parse(row.pinned_by_json) as ActorRecord,
					pinned_at: row.pinned_at,
				});
			}
		}
		return out;
	}

	/** Pins a message in the room. */
	async pinMessage(call: RoomCall, messageId: string): Promise<{ pin: PinRecord; pinned: boolean } | Refusal> {
		const opened = this.openAsWriter(call);
		if ("error" in opened) return opened;
		const archived = this.ensureNotArchived(opened.room);
		if (archived) return archived;
		const row = this.message(messageId);
		if (!row) return refuse("not_found", NO_MESSAGE);
		if (row.deleted_at !== null) return refuse("invalid", "A deleted message cannot be pinned.");
		const existing = this.one<{ pinned_by_json: string; pinned_at: number }>(
			"SELECT pinned_by_json, pinned_at FROM pins WHERE message_id = ?",
			messageId,
		);
		if (existing) {
			return {
				pin: {
					message: this.messageRecord(opened.room.room_id, row),
					pinned_by: JSON.parse(existing.pinned_by_json) as ActorRecord,
					pinned_at: existing.pinned_at,
				},
				pinned: false,
			};
		}
		if (this.pinCount() >= CHAT_LIMITS.pinsPerRoom) {
			return refuse("conflict", `A room can have ${CHAT_LIMITS.pinsPerRoom} pinned messages at most.`);
		}
		const now = Date.now();
		const version = opened.room.version + 1;
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(
				"INSERT INTO pins (message_id, pinned_by_json, pinned_at) VALUES (?, ?, ?)",
				messageId,
				JSON.stringify(call.actor),
				now,
			);
			this.sql.exec("UPDATE messages SET version = ? WHERE id = ?", version, messageId);
			this.sql.exec("UPDATE room SET version = ? WHERE id = 1", version);
			this.roomChanged(call.actor.principal_id);
		});
		const message = this.messageRecord(opened.room.room_id, this.message(messageId) as MessageRow);
		await this.publish(messageEvent(message), call.actor.principal_id);
		return { pin: { message, pinned_by: call.actor, pinned_at: now }, pinned: true };
	}

	/** Unpins a message in the room. */
	async unpinMessage(
		call: RoomCall,
		messageId: string,
	): Promise<{ unpinned: boolean; message: MessageRecord } | Refusal> {
		const opened = this.openAsWriter(call);
		if ("error" in opened) return opened;
		const archived = this.ensureNotArchived(opened.room);
		if (archived) return archived;
		const row = this.message(messageId);
		if (!row) return refuse("not_found", NO_MESSAGE);
		const existing = this.one("SELECT 1 AS found FROM pins WHERE message_id = ?", messageId);
		if (!existing) return { unpinned: false, message: this.messageRecord(opened.room.room_id, row) };
		const version = opened.room.version + 1;
		this.ctx.storage.transactionSync(() => {
			this.sql.exec("DELETE FROM pins WHERE message_id = ?", messageId);
			this.sql.exec("UPDATE messages SET version = ? WHERE id = ?", version, messageId);
			this.sql.exec("UPDATE room SET version = ? WHERE id = 1", version);
			this.roomChanged(call.actor.principal_id);
		});
		const message = this.messageRecord(opened.room.room_id, this.message(messageId) as MessageRow);
		await this.publish(messageEvent(message), call.actor.principal_id);
		return { unpinned: true, message };
	}

	/** Lists pinned messages of the room, newest pin first. */
	listPins(call: RoomCall): { pins: PinRecord[] } | Refusal {
		const opened = this.openAsMember(call);
		if ("error" in opened) return opened;
		return { pins: this.readPins(opened.room.room_id) };
	}

	/** Verifies a message exists and is readable by the caller (for saving or creating reminders). */
	verifyMessageForPersonal(
		call: RoomCall,
		messageId: string,
	):
		| {
				roomId: string;
				roomName: string | null;
				message: MessageRecord;
				parentSeq: number | null;
		  }
		| Refusal {
		const opened = this.openAsMember(call);
		if ("error" in opened) return opened;
		const row = this.message(messageId);
		if (!row || row.deleted_at !== null) return refuse("not_found", NO_MESSAGE);
		const parentSeq =
			row.parent_id === null
				? null
				: (this.one<{ seq: number }>("SELECT seq FROM messages WHERE id = ?", row.parent_id)?.seq ?? null);
		return {
			roomId: opened.room.room_id,
			roomName: opened.room.name,
			message: this.messageRecord(opened.room.room_id, row),
			parentSeq,
		};
	}

	/** Loads live non-deleted messages by ID for a member (used by saved messages). */
	getMessagesByIds(
		call: RoomCall,
		messageIds: readonly string[],
	): { room: SearchRoomRecord; messages: MessageRecord[] } | Refusal {
		const opened = this.openAsMember(call);
		if ("error" in opened) return opened;
		const peer = this.peerJson(opened.room, call.actor.principal_id);
		const peers = this.peersJson(opened.room, call.actor.principal_id);
		const room: SearchRoomRecord = {
			id: opened.room.room_id,
			kind: opened.room.kind,
			name: opened.room.name,
			peer: peer === null ? null : (JSON.parse(peer) as ActorRecord),
			...(peers === null ? {} : { peers: JSON.parse(peers) as ActorRecord[] }),
		};
		if (messageIds.length === 0) return { room, messages: [] };
		const rows = this.all<MessageRow>(
			"SELECT * FROM messages WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL",
			JSON.stringify(messageIds),
		);
		return { room, messages: this.messageRecords(opened.room.room_id, rows) };
	}

	/** Reads a message snapshot for forwarding to another room. */
	messageForForward(call: RoomCall, messageId: string): ChatForwardedMessage | Refusal {
		const opened = this.openAsMember(call);
		if ("error" in opened) return opened;
		const row = this.message(messageId);
		if (!row || row.deleted_at !== null) return refuse("not_found", NO_MESSAGE);
		const inner = row.forwarded_json ? (JSON.parse(row.forwarded_json) as ChatForwardedMessage) : null;
		const cards = row.cards_json ? (JSON.parse(row.cards_json) as ChatCard[]) : [];
		const cardSummary = cards
			.map((card) => (card.text ? `${card.title}: ${card.text}` : card.title))
			.join(" — ")
			.slice(0, 500);
		const text = row.text.trim() !== "" ? row.text : inner?.text || cardSummary;
		return {
			source_room_id: opened.room.room_id,
			source_room_name: opened.room.kind === "public" ? opened.room.name : null,
			source_message_id: row.id,
			author: JSON.parse(row.author_json) as ActorRecord,
			text,
			created_at: iso(row.created_at),
			untrusted: row.untrusted === 1 || inner?.untrusted === true,
		};
	}

	/** Triggers a button action on a message card, recording it and notifying the message author. */
	async triggerCardAction(
		call: RoomCall,
		input: {
			id: string;
			messageId: string;
			cardId: string;
			actionId: string;
			idempotencyKey?: string | undefined;
		},
	): Promise<{ action: ChatCardAction } | Refusal> {
		const opened = this.openAsWriter(call);
		if ("error" in opened) return opened;
		const archived = this.ensureNotArchived(opened.room);
		if (archived) return archived;
		const row = this.message(input.messageId);
		if (!row || row.deleted_at !== null) return refuse("not_found", NO_MESSAGE);
		const cards = row.cards_json ? (JSON.parse(row.cards_json) as ChatCard[]) : [];
		const card = cards.find((c) => c.id === input.cardId);
		const button = card?.actions?.find((a) => a.action_id === input.actionId);
		if (!card || !button) return refuse("not_found", "No card action has that id on this message.");
		const now = Date.now();
		const idempKey = input.idempotencyKey ? `card:${call.actor.principal_id}:${row.id}:${input.idempotencyKey}` : null;
		if (idempKey) {
			const existing = this.one<{ request_hash: string; message_id: string }>(
				"SELECT request_hash, message_id FROM idempotency WHERE key = ? AND created_at > ?",
				idempKey,
				now - IDEMPOTENCY_TTL_MS,
			);
			if (existing) {
				const requestHash = `${card.id}:${button.action_id}`;
				if (existing.request_hash !== requestHash) {
					return refuse("conflict", "That idempotency key was already used for a different card action.");
				}
				const stored = this.one<{
					id: string;
					message_id: string;
					card_id: string;
					action_id: string;
					value: string;
					actor_json: string;
					created_at: number;
				}>(
					"SELECT id, message_id, card_id, action_id, value, actor_json, created_at FROM card_actions WHERE id = ?",
					existing.message_id,
				);
				if (stored) {
					return {
						action: {
							id: stored.id,
							room_id: opened.room.room_id,
							message_id: stored.message_id,
							card_id: stored.card_id,
							action_id: stored.action_id,
							value: stored.value,
							untrusted: row.untrusted === 1,
							actor: JSON.parse(stored.actor_json) as ActorRecord,
							created_at: iso(stored.created_at),
						},
					};
				}
			}
		}
		const value = button.value ?? "";
		const limited = this.spendAllowance(call, now);
		if (limited) return limited;
		const action: ChatCardAction = {
			id: input.id,
			room_id: opened.room.room_id,
			message_id: row.id,
			card_id: card.id,
			action_id: button.action_id,
			value,
			untrusted: row.untrusted === 1,
			actor: call.actor,
			created_at: iso(now),
		};
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(
				`INSERT INTO card_actions (id, message_id, card_id, action_id, value, actor_json, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)`,
				input.id,
				row.id,
				card.id,
				button.action_id,
				value,
				JSON.stringify(call.actor),
				now,
			);
			if (idempKey) {
				this.sql.exec("DELETE FROM idempotency WHERE created_at <= ?", now - IDEMPOTENCY_TTL_MS);
				this.sql.exec(
					"INSERT OR REPLACE INTO idempotency (key, request_hash, message_id, created_at) VALUES (?, ?, ?, ?)",
					idempKey,
					`${card.id}:${button.action_id}`,
					input.id,
					now,
				);
			}
			if (row.author_id !== call.actor.principal_id && this.member(row.author_id)) {
				this.queueActivity(row.author_id, {
					id: `act:card:${input.id}`,
					kind: "card_action",
					room_id: opened.room.room_id,
					room_name: opened.room.name,
					message_id: row.id,
					seq: row.seq,
					parent_id: row.parent_id,
					parent_seq: null,
					actor: call.actor,
					emoji: null,
					preview: `${button.label}${value ? ` (${value})` : ""}`.slice(0, 200),
					untrusted: row.untrusted === 1,
					created_at: now,
				});
			}
		});
		await this.publish({ type: "card_action", action }, call.actor.principal_id);
		return { action };
	}

	/** Lists recorded card button clicks on a message, newest first, with keyset pagination. */
	listCardActions(
		call: RoomCall,
		messageId: string,
		cursor: [number, string] | null = null,
		limit = 50,
	): { actions: ChatCardAction[]; nextCursor: [number, string] | null } | Refusal {
		const opened = this.openAsMember(call);
		if ("error" in opened) return opened;
		const row = this.message(messageId);
		if (!row) return refuse("not_found", NO_MESSAGE);
		const rows = cursor
			? this.all<{
					id: string;
					message_id: string;
					card_id: string;
					action_id: string;
					value: string;
					actor_json: string;
					created_at: number;
				}>(
					`SELECT id, message_id, card_id, action_id, value, actor_json, created_at
					FROM card_actions
					WHERE message_id = ? AND (created_at, id) < (?, ?)
					ORDER BY created_at DESC, id DESC LIMIT ?`,
					messageId,
					cursor[0],
					cursor[1],
					limit + 1,
				)
			: this.all<{
					id: string;
					message_id: string;
					card_id: string;
					action_id: string;
					value: string;
					actor_json: string;
					created_at: number;
				}>(
					`SELECT id, message_id, card_id, action_id, value, actor_json, created_at
					FROM card_actions
					WHERE message_id = ?
					ORDER BY created_at DESC, id DESC LIMIT ?`,
					messageId,
					limit + 1,
				);
		const hasMore = rows.length > limit;
		const page = hasMore ? rows.slice(0, limit) : rows;
		const last = page.at(-1);
		return {
			actions: page.map((r) => ({
				id: r.id,
				room_id: opened.room.room_id,
				message_id: r.message_id,
				card_id: r.card_id,
				action_id: r.action_id,
				value: r.value,
				untrusted: row.untrusted === 1,
				actor: JSON.parse(r.actor_json) as ActorRecord,
				created_at: iso(r.created_at),
			})),
			nextCursor: hasMore && last ? [last.created_at, last.id] : null,
		};
	}

	/**
	 * The ids of the files of a message of the caller, for an edit: the Worker then checks in Drive only
	 * the files that the edit adds.
	 */
	messageFileIds(call: RoomCall, messageId: string): { itemIds: string[] } | Refusal {
		const opened = this.openAsMember(call);
		if ("error" in opened) return opened;
		const row = this.message(messageId);
		if (!row) return refuse("not_found", NO_MESSAGE);
		if (row.author_id !== call.actor.principal_id) {
			return refuse("forbidden", "You can change only a message that you wrote.");
		}
		return { itemIds: this.storedFiles(messageId).map((file) => file.item_id) };
	}

	/**
	 * The drive and the item of a file of a message, for a member of the room. A principal that is not a
	 * member gets not_found, also for a public room: the file is for the members only. A deleted message
	 * holds no file.
	 */
	fileRef(call: RoomCall, messageId: string, itemId: string): { spaceId: string; itemId: string } | Refusal {
		const room = this.room();
		if (!room || !this.member(call.actor.principal_id)) return refuse("not_found", NOT_FOUND);
		const file = this.one<{ space_id: string }>(
			`SELECT f.space_id FROM message_files f JOIN messages m ON m.id = f.message_id
			WHERE f.message_id = ? AND f.item_id = ? AND m.deleted_at IS NULL`,
			messageId,
			itemId,
		);
		if (!file) return refuse("not_found", "The message holds no file with that id.");
		return { spaceId: file.space_id, itemId };
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
		const opened = this.openAsWriter(call);
		if ("error" in opened) return opened;
		const archived = this.ensureNotArchived(opened.room);
		if (archived) return archived;
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
				const now = Date.now();
				this.sql.exec(
					"INSERT INTO reactions (message_id, emoji, principal_id, created_at, version) VALUES (?, ?, ?, ?, ?)",
					messageId,
					emoji,
					principalId,
					now,
					version,
				);
				if (row.author_id !== principalId && this.member(row.author_id)) {
					this.queueActivity(row.author_id, {
						id: `act:react:${messageId}:${emoji}:${principalId}:${version}`,
						kind: "reaction",
						room_id: roomId,
						room_name: opened.room.name,
						message_id: messageId,
						seq: row.seq,
						parent_id: row.parent_id,
						parent_seq: null,
						actor: call.actor,
						preview: this.previewOf(row.text),
						emoji,
						untrusted: row.untrusted === 1,
						created_at: now,
					});
				}
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
		await this.publish(messageEvent(message), principalId);
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

	/**
	 * The message that a call with this idempotency key stored, for a member of the room, or null when the
	 * key is new. A retry of a post with files gets its message here before the files are checked again: the
	 * author can have put a file in the trash after the first post.
	 */
	postedMessage(
		call: RoomCall,
		idempotency: { key: string; requestHash: string },
	): { message: MessageRecord } | Refusal | null {
		const opened = this.openAsMember(call);
		if ("error" in opened) return opened;
		const earlier = this.one<{ request_hash: string; message_id: string }>(
			"SELECT request_hash, message_id FROM idempotency WHERE key = ? AND created_at > ?",
			idempotency.key,
			Date.now() - IDEMPOTENCY_TTL_MS,
		);
		if (!earlier) return null;
		if (earlier.request_hash !== idempotency.requestHash) {
			return refuse("conflict", "The idempotency key was used with a different request.");
		}
		const row = this.message(earlier.message_id);
		return row ? { message: this.messageRecord(opened.room.room_id, row) } : null;
	}

	/**
	 * The name of the folder of the room in the drive of a member, for the files that the member puts in its
	 * messages: the name of the room, or the name of the other member of a direct message. A principal that
	 * is not a member gets not_found, also for a public room.
	 */
	folderName(call: RoomCall): { name: string } | Refusal {
		const room = this.room();
		if (!room || !this.member(call.actor.principal_id)) return refuse("not_found", NOT_FOUND);
		if (room.kind === "dm") {
			const peer = this.peerJson(room, call.actor.principal_id);
			return { name: peer ? (JSON.parse(peer) as ActorRecord).display_name : "Direct message" };
		}
		if (room.kind === "group_dm") {
			const peers = this.peersJson(room, call.actor.principal_id);
			const list = peers ? (JSON.parse(peers) as ActorRecord[]) : [];
			return {
				name: list.length
					? list
							.map((p) => p.display_name)
							.slice(0, 3)
							.join(", ")
					: "Group message",
			};
		}
		return { name: room.name ?? "Room" };
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
			/** The message that this message replies to, or null for a message of the room. */
			parentId: string | null;
			/** True for a reply that also goes to the room list. */
			alsoInRoom: boolean;
			/** The files of the message, which the Worker checked in the drive of the caller. */
			files?: MessageFile[];
			/** The origin of the call. The fetch of a link preview never asks it. */
			linkOrigin?: string;
			/** Optional structured cards attached to the message. */
			cards?: ChatCard[];
			/** Optional forwarded message snapshot. */
			forwarded?: ChatForwardedMessage;
			/** Marks external content as untrusted. */
			untrusted?: boolean;
		},
	): Promise<{ message: MessageRecord; parent: MessageRecord | null; duplicate: boolean } | Refusal> {
		// Hold room calls until the subscription boundary and message commit agree on their order.
		const posted = await this.ctx.blockConcurrencyWhile(async () => {
			const opened = this.openAsMember(call);
			if ("error" in opened) return opened;
			const archived = this.ensureNotArchived(opened.room);
			if (archived) return archived;
			if (!this.hasScope(opened.member, "chat.write")) return refuse("forbidden", NO_WRITE);
			if (!this.canPost(opened.room, opened.member)) {
				return refuse("forbidden", "You do not have permission to post in this room.");
			}
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
					return { message: this.messageRecord(opened.room.room_id, row), parent: null, duplicate: true };
				}
			}
			// A thread has one level, and a deleted message takes no new reply.
			const parent = input.parentId === null ? null : this.message(input.parentId);
			if (input.parentId !== null && !parent)
				return refuse("not_found", "The message to reply to is not in this room.");
			if (parent && parent.parent_id !== null) {
				return refuse("invalid", "A reply cannot have replies. Reply to the first message of the thread.");
			}
			if (parent && parent.deleted_at !== null)
				return refuse("invalid", "The message is deleted, so it takes no reply.");
			const inRoomList = parent === null || input.alsoInRoom;
			const subscriptionSequence = await chatWebhookBoundary(this.env.DIRECTORY);
			// A retry with the same key returned above: it adds no message, so it uses no allowance.
			const limited = this.spendAllowance(call, now);
			if (limited) return limited;
			const content = await this.mentionedContent(opened.room, input.content);
			if ("error" in content) return content;
			const files = input.files ?? [];
			const cards = input.cards ?? [];
			const forwarded = input.forwarded ?? null;
			const untrusted = input.untrusted === true || forwarded?.untrusted === true;
			if (content.text.trim() === "" && files.length === 0 && cards.length === 0 && forwarded === null) {
				return refuse("invalid", EMPTY_MESSAGE);
			}
			const groupRefusal = this.groupMentionRefusal(call.actor.principal_id, content.body, []);
			if (groupRefusal) return groupRefusal;
			// A reply changes its parent too. The parent gets the first version and the reply the next, so a
			// client that gets the two events in that order has each version of the room.
			const version = opened.room.version + (parent ? 2 : 1);
			const bodyJson = JSON.stringify(content.body);
			this.ctx.storage.transactionSync(() => {
				const seq = this.one<{ seq: number }>(
					`INSERT INTO messages (id, author_id, author_json, text, body_json, created_at, version, idempotency_key,
						parent_id, also_in_room, has_link, untrusted, forwarded_json, cards_json)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
					input.id,
					call.actor.principal_id,
					JSON.stringify(call.actor),
					content.text,
					bodyJson,
					now,
					version,
					input.clientKey,
					parent?.id ?? null,
					parent && input.alsoInRoom ? 1 : 0,
					hasLink(content.text, bodyJson) ? 1 : 0,
					untrusted ? 1 : 0,
					forwarded ? JSON.stringify(forwarded) : null,
					cards.length > 0 ? JSON.stringify(cards) : null,
				)?.seq as number;
				this.indexMessage(seq, content);
				// A reply that is not in the room list leaves the room list as it was: its last message, its
				// activity and the read markers.
				if (inRoomList) {
					this.sql.exec("UPDATE room SET last_seq = ?, last_message_at = ? WHERE id = 1", seq, now);
					this.sql.exec("UPDATE members SET last_read_seq = ? WHERE principal_id = ?", seq, call.actor.principal_id);
				}
				this.sql.exec("UPDATE room SET version = ? WHERE id = 1", version);
				if (parent) {
					this.addToThread(parent, call.actor, now, version - 1);
					// The first reply makes the parent a message of a thread, which a search filter reads.
					if (parent.reply_count === 0) this.touchSearch(parent.seq);
					this.followOnReply(parent, call.actor.principal_id, seq, mentionIds(content.body));
					// Each follow of the thread keeps the time of its newest reply, for `followedThreads`.
					this.sql.exec("UPDATE thread_follows SET last_reply_at = ? WHERE parent_id = ?", now, parent.id);
				}
				this.setMentions(seq, call.actor.principal_id, content.body, inRoomList);
				if (files.length > 0) this.setFiles(input.id, files);
				this.setLinks(input.id, [], extractLinks(content.body), input.linkOrigin ?? null);
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
				this.queueMessageActivities(
					opened.room,
					input.id,
					seq,
					call.actor,
					content.body,
					content.text,
					parent,
					now,
					untrusted,
				);
				this.queueChatEvent({
					room: opened.room,
					eventType: "chat.message.created",
					messageId: input.id,
					eventId: input.id,
					actorId: call.actor.principal_id,
					authorId: call.actor.principal_id,
					body: content.body,
					version,
					now,
					subscriptionSequence,
					parentId: parent?.id ?? null,
				});
				this.roomChanged(call.actor.principal_id);
			});
			const message = this.messageRecord(opened.room.room_id, this.message(input.id) as MessageRow);
			const changedParent = parent
				? this.messageRecord(opened.room.room_id, this.message(parent.id) as MessageRow)
				: null;
			return { message, parent: changedParent, duplicate: false };
		});
		if (!("error" in posted) && !posted.duplicate) {
			// The grants of the room on the files come before the event, so a member that gets the event can
			// download the files. A grant that fails here waits in the outbox, and the alarm tries it again.
			if (posted.message.files.length > 0) await this.flush();
			// The parent first: its version comes before the version of the reply.
			if (posted.parent) await this.publish(messageEvent(posted.parent), call.actor.principal_id);
			await this.publish(messageEvent(posted.message), call.actor.principal_id);
		}
		return posted;
	}

	/** Delivers a scheduled message from a member's PrincipalDO alarm (idempotent by scheduledId). */
	async postScheduledMessage(input: {
		roomId: string;
		actor: ActorRecord;
		scheduledId: string;
		text: string;
		bodyJson: string;
		parentId: string | null;
		alsoInRoom: boolean;
	}): Promise<{ messageId: string } | Refusal> {
		const content: MessageContent = { text: input.text, body: JSON.parse(input.bodyJson) as ChatBody };
		const result = await this.postMessage(
			{ roomId: input.roomId, actor: input.actor },
			{
				id: newId("cmsg"),
				content,
				idempotency: { key: `${input.actor.principal_id}:sched:${input.scheduledId}`, requestHash: input.scheduledId },
				clientKey: null,
				parentId: input.parentId,
				alsoInRoom: input.alsoInRoom,
			},
		);
		if ("error" in result) return result;
		return { messageId: result.message.id };
	}

	/** Posts an external untrusted message via an incoming webhook. */
	async postIncomingWebhook(input: {
		roomId: string;
		messageId: string;
		author: ActorRecord;
		text: string;
		cards?: ChatCard[];
		replayKey?: string | undefined;
	}): Promise<{ message: MessageRecord; duplicate: boolean } | Refusal> {
		const posted = await this.ctx.blockConcurrencyWhile(async () => {
			const room = this.room();
			if (!room) return refuse("not_found", NOT_FOUND);
			const archived = this.ensureNotArchived(room);
			if (archived) return archived;
			if (this.isDmKind(room.kind)) return refuse("invalid", "Incoming webhooks cannot post to direct messages.");
			const now = Date.now();
			const idempKey = input.replayKey ? `wh:${input.author.principal_id}:${input.replayKey}` : null;
			if (idempKey) {
				const existing = this.one<{ message_id: string }>(
					"SELECT message_id FROM idempotency WHERE key = ? AND created_at > ?",
					idempKey,
					now - IDEMPOTENCY_TTL_MS,
				);
				if (existing) {
					const existingRow = this.message(existing.message_id);
					if (existingRow) {
						return { message: this.messageRecord(room.room_id, existingRow), duplicate: true };
					}
				}
			}
			const limited = this.spendAllowance({ roomId: input.roomId, actor: input.author }, now);
			if (limited) return limited;
			const cards = input.cards ?? [];
			if (input.text.trim() === "" && cards.length === 0) return refuse("invalid", EMPTY_MESSAGE);
			const subscriptionSequence = await chatWebhookBoundary(this.env.DIRECTORY);
			const content: MessageContent = { text: input.text, body: textBody(input.text) };
			const bodyJson = JSON.stringify(content.body);
			const version = room.version + 1;
			this.ctx.storage.transactionSync(() => {
				const seq = this.one<{ seq: number }>(
					`INSERT INTO messages (id, author_id, author_json, text, body_json, created_at, version, idempotency_key,
						parent_id, also_in_room, has_link, untrusted, forwarded_json, cards_json)
					VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, 1, NULL, ?) RETURNING seq`,
					input.messageId,
					input.author.principal_id,
					JSON.stringify(input.author),
					content.text,
					bodyJson,
					now,
					version,
					hasLink(content.text, bodyJson) ? 1 : 0,
					cards.length > 0 ? JSON.stringify(cards) : null,
				)?.seq as number;
				this.indexMessage(seq, content);
				if (idempKey && input.replayKey) {
					this.sql.exec("DELETE FROM idempotency WHERE created_at <= ?", now - IDEMPOTENCY_TTL_MS);
					this.sql.exec(
						"INSERT OR REPLACE INTO idempotency (key, request_hash, message_id, created_at) VALUES (?, ?, ?, ?)",
						idempKey,
						input.replayKey,
						input.messageId,
						now,
					);
				}
				this.sql.exec("UPDATE room SET last_seq = ?, last_message_at = ?, version = ? WHERE id = 1", seq, now, version);
				this.queueChatEvent({
					room,
					eventType: "chat.message.created",
					messageId: input.messageId,
					eventId: input.messageId,
					actorId: input.author.principal_id,
					authorId: input.author.principal_id,
					body: content.body,
					version,
					now,
					subscriptionSequence,
					parentId: null,
				});
				this.roomChanged(input.author.principal_id);
			});
			return {
				message: this.messageRecord(room.room_id, this.message(input.messageId) as MessageRow),
				duplicate: false,
			};
		});
		if (!("error" in posted) && !posted.duplicate) {
			await this.publish(messageEvent(posted.message), input.author.principal_id);
		}
		return posted;
	}

	/**
	 * Replaces the content of a message, its files, or the two. Only its author can do this. `input` null
	 * keeps the content, and `files` null keeps the files. `files.order` is the new list of item ids:
	 * each one is in `files.added`, which the Worker checked in Drive, or in the message now.
	 */
	async editMessage(
		call: RoomCall,
		messageId: string,
		input: MessageContent | null,
		files: { order: string[]; added: MessageFile[] } | null = null,
		linkOrigin: string | null = null,
		cards: ChatCard[] | null = null,
	): Promise<{ message: MessageRecord; changed: boolean } | Refusal> {
		// Hold other room calls until the new version and the webhook event are stored.
		const edited = await this.ctx.blockConcurrencyWhile(async () => {
			const opened = this.openAsWriter(call);
			if ("error" in opened) return opened;
			const archived = this.ensureNotArchived(opened.room);
			if (archived) return archived;
			const subscriptionSequence = await chatWebhookBoundary(this.env.DIRECTORY);
			const row = this.message(messageId);
			const room = this.room();
			if (!row || !room) return refuse("not_found", NO_MESSAGE);
			if (row.author_id !== call.actor.principal_id) {
				return refuse("forbidden", "You can change only a message that you wrote.");
			}
			if (row.deleted_at !== null) return refuse("invalid", "The message is deleted, so it cannot change.");
			const storedBody = row.body_json ?? JSON.stringify(textBody(row.text));
			const content =
				input === null
					? { text: row.text, body: JSON.parse(storedBody) as ChatBody }
					: await this.mentionedContent(room, input);
			if ("error" in content) return content;
			const bodyJson = JSON.stringify(content.body);
			const stored = this.storedFiles(messageId);
			let nextFiles = stored;
			if (files !== null) {
				const known = new Map([...stored, ...files.added].map((file) => [file.item_id, file]));
				const picked = files.order.map((itemId) => known.get(itemId));
				if (picked.some((file) => file === undefined)) {
					return refuse("conflict", "The files of the message changed during the edit. Try again.");
				}
				nextFiles = picked as MessageFile[];
			}
			const nextCardsJson = cards === null ? row.cards_json : cards.length > 0 ? JSON.stringify(cards) : null;
			const sameFiles =
				nextFiles.length === stored.length && nextFiles.every((file, index) => file.item_id === stored[index]?.item_id);
			const sameCards = nextCardsJson === row.cards_json;
			const same = row.text === content.text && storedBody === bodyJson && sameFiles && sameCards;
			if (same) return { message: this.messageRecord(room.room_id, row), changed: false as const };
			if (
				content.text.trim() === "" &&
				nextFiles.length === 0 &&
				nextCardsJson === null &&
				row.forwarded_json === null
			) {
				return refuse("invalid", EMPTY_MESSAGE);
			}
			const limited = this.spendAllowance(call, Date.now());
			if (limited) return limited;
			const groupRefusal = this.groupMentionRefusal(
				call.actor.principal_id,
				content.body,
				storedGroups(JSON.parse(storedBody) as ChatBody),
			);
			if (groupRefusal) return groupRefusal;
			const version = room.version + 1;
			const now = Date.now();
			this.ctx.storage.transactionSync(() => {
				this.keepEarlierVersion(row, now);
				this.sql.exec(
					"UPDATE messages SET text = ?, body_json = ?, edited_at = ?, version = ?, has_link = ?, cards_json = ? WHERE id = ?",
					content.text,
					bodyJson,
					now,
					version,
					hasLink(content.text, bodyJson) ? 1 : 0,
					nextCardsJson,
					messageId,
				);
				this.indexMessage(row.seq, content);
				this.setMentions(row.seq, row.author_id, content.body, row.parent_id === null || row.also_in_room === 1);
				if (!sameFiles) this.setFiles(messageId, nextFiles);
				if (input !== null)
					this.setLinks(messageId, parseLinks(row.links_json), extractLinks(content.body), linkOrigin);
				this.sql.exec("UPDATE room SET version = ? WHERE id = 1", version);
				this.roomChanged(call.actor.principal_id);
				this.queueChatEvent({
					room,
					eventType: "chat.message.updated",
					messageId,
					eventId: `${messageId}:${version}`,
					actorId: call.actor.principal_id,
					authorId: row.author_id,
					body: content.body,
					version,
					now,
					subscriptionSequence,
					parentId: row.parent_id,
				});
			});
			const message = this.messageRecord(room.room_id, this.message(messageId) as MessageRow);
			return { message, changed: true as const };
		});
		if (!("error" in edited) && edited.changed) {
			// A file that the edit added gets its grant before the event, as for a new message.
			if (files !== null && files.added.length > 0) await this.flush();
			await this.publish(messageEvent(edited.message), call.actor.principal_id);
		}
		return edited;
	}

	/**
	 * Keeps the content of a message before an edit. The room keeps the `CHAT_LIMITS.messageEdits` newest
	 * earlier versions of a message, so an author that edits all the time fills no storage.
	 */
	private keepEarlierVersion(row: MessageRow, now: number): void {
		this.sql.exec(
			// Each change of a message gives it a new version, so the key is always new. A plain insert fails
			// loudly if that ever stops being true, and never writes over an earlier version.
			`INSERT INTO message_edits (message_id, version, text, body_json, written_at, replaced_at)
			VALUES (?, ?, ?, ?, ?, ?)`,
			row.id,
			row.version,
			row.text,
			row.body_json,
			row.edited_at ?? row.created_at,
			now,
		);
		this.sql.exec(
			`DELETE FROM message_edits WHERE message_id = ?1 AND version NOT IN (
				SELECT version FROM message_edits WHERE message_id = ?1 ORDER BY version DESC LIMIT ?2)`,
			row.id,
			CHAT_LIMITS.messageEdits,
		);
	}

	/**
	 * The earlier versions of a message, oldest first, for a caller that can read the room. The handler
	 * checks that the caller is an owner or an admin of the organization.
	 */
	async listEdits(call: RoomCall, messageId: string): Promise<{ edits: MessageEditRecord[] } | Refusal> {
		const opened = this.open(call, "visible");
		if ("error" in opened) return opened;
		// A non-member reads a public room only while the directory has it, as for `get`. A fresh start of
		// the directory leaves old room objects, and they stay closed.
		if (!opened.member && !(await this.inDirectory(opened.room.room_id))) return refuse("not_found", NOT_FOUND);
		if (!this.message(messageId)) return refuse("not_found", NO_MESSAGE);
		const rows = this.sql
			.exec<{ version: number; text: string; body_json: string | null; written_at: number; replaced_at: number }>(
				"SELECT version, text, body_json, written_at, replaced_at FROM message_edits WHERE message_id = ? ORDER BY version",
				messageId,
			)
			.toArray();
		return {
			edits: rows.map((row) => ({
				version: row.version,
				text: row.text,
				body: row.body_json === null ? textBody(row.text) : (JSON.parse(row.body_json) as ChatBody),
				written_at: row.written_at,
				replaced_at: row.replaced_at,
			})),
		};
	}

	/** Deletes the text of a message. Its author and the owner of the room can do this. */
	async deleteMessage(call: RoomCall, messageId: string): Promise<{ deleted: boolean } | Refusal> {
		const deleted = await this.ctx.blockConcurrencyWhile(async () => {
			const opened = this.openAsWriter(call);
			if ("error" in opened) return opened;
			const archived = this.ensureNotArchived(opened.room);
			if (archived) return archived;
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
			// The delete of a reply changes the summary of its parent too, with the next version.
			const version = room.version + 1;
			const now = Date.now();
			this.ctx.storage.transactionSync(() => {
				this.sql.exec(
					// The key goes with the text: an author can make a key from the content of the message.
					`UPDATE messages SET text = '', body_json = NULL, idempotency_key = NULL, deleted_at = ?, version = ?,
						has_link = 0, forwarded_json = NULL, cards_json = NULL WHERE id = ?`,
					now,
					version,
					messageId,
				);
				this.indexMessage(row.seq, null);
				if (row.parent_id !== null) {
					this.refreshThread(row.parent_id, version + 1);
					// A parent without replies is no message of a thread now, which a search filter reads.
					const parent = this.message(row.parent_id);
					if (parent && parent.reply_count === 0) this.touchSearch(parent.seq);
				}
				// A deleted message keeps no reaction, no mention, no file, no link preview, no pin, no card action and no earlier version.
				this.setFiles(messageId, []);
				this.setLinks(messageId, parseLinks(row.links_json), [], null);
				this.sql.exec("DELETE FROM reactions WHERE message_id = ?", messageId);
				this.sql.exec("DELETE FROM mentions WHERE seq = ?", row.seq);
				this.sql.exec("DELETE FROM message_edits WHERE message_id = ?", messageId);
				this.sql.exec("DELETE FROM pins WHERE message_id = ?", messageId);
				this.sql.exec("DELETE FROM card_actions WHERE message_id = ?", messageId);
				this.sql.exec("DELETE FROM activity_outbox WHERE json_extract(payload_json, '$.message_id') = ?", messageId);
				this.sql.exec("UPDATE room SET version = ? WHERE id = 1", row.parent_id === null ? version : version + 1);
				this.roomChanged(call.actor.principal_id);
				this.queueChatEvent({
					room,
					eventType: "chat.message.deleted",
					messageId,
					eventId: `${messageId}:${version}`,
					actorId: call.actor.principal_id,
					authorId: row.author_id,
					// The body from before the delete: the reasons tell who the deleted message was for.
					body: row.body_json === null ? textBody(row.text) : (JSON.parse(row.body_json) as ChatBody),
					version,
					now,
					subscriptionSequence,
					parentId: row.parent_id,
				});
			});
			const message = this.messageRecord(room.room_id, this.message(messageId) as MessageRow);
			const parentRow = row.parent_id === null ? null : this.message(row.parent_id);
			const parent = parentRow ? this.messageRecord(room.room_id, parentRow) : null;
			return { deleted: true as const, message, parent };
		});
		if (!("error" in deleted) && deleted.deleted) {
			await this.publish(messageEvent(deleted.message), call.actor.principal_id);
			if (deleted.parent) await this.publish(messageEvent(deleted.parent), call.actor.principal_id);
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

	// --- Search ---------------------------------------------------------------------------------

	/**
	 * Writes the search rows of a message, in the transaction of its change: the text in `messages_fts` and
	 * the principals that it mentions. `content` null is a deleted message, which keeps no row. The message
	 * becomes a target of the outbox too, so the index of the organization follows.
	 */
	private indexMessage(seq: number, content: MessageContent | null): void {
		this.sql.exec("DELETE FROM messages_fts WHERE rowid = ?", seq);
		this.sql.exec("DELETE FROM search_mentions WHERE seq = ?", seq);
		if (content !== null) {
			this.sql.exec("INSERT INTO messages_fts (rowid, text) VALUES (?, ?)", seq, indexedText(content.text));
			for (const principalId of mentionIds(content.body)) {
				this.sql.exec("INSERT OR IGNORE INTO search_mentions (principal_id, seq) VALUES (?, ?)", principalId, seq);
			}
		}
		this.touchSearch(seq);
	}

	/**
	 * Records that the index of the organization is behind for one message. The row waits `MEMBER_DELAY_MS`,
	 * so the changes of that time go out as one batch. Only the alarm sends these rows (`sendSearchRows`),
	 * so no change of a message waits for the index.
	 */
	private touchSearch(seq: number): void {
		this.sql.exec(
			`INSERT INTO outbox (target, gen, next_attempt_at) VALUES (?, 1, ?)
			ON CONFLICT (target) DO UPDATE SET gen = gen + 1, attempts = 0,
				next_attempt_at = MIN(next_attempt_at, excluded.next_attempt_at)`,
			`${SEARCH_TARGET}${seq}`,
			Date.now() + MEMBER_DELAY_MS,
		);
	}

	/** The rows of a search as results: each message, with the found parts of its text. */
	private searchHitRecords(roomId: string, rows: readonly SearchRow[]) {
		const messages = this.messageRecords(roomId, rows);
		const parentIds = [...new Set(rows.flatMap((row) => (row.parent_id === null ? [] : [row.parent_id])))];
		const parentSeqs = new Map(
			this.all<{ id: string; seq: number }>(
				"SELECT messages.id, messages.seq FROM messages JOIN json_each(?) wanted ON wanted.value = messages.id",
				JSON.stringify(parentIds),
			).map((parent) => [parent.id, parent.seq]),
		);
		return rows.map(
			(row, index): SearchHitRecord => ({
				message: messages[index] as MessageRecord,
				parentSeq: row.parent_id === null ? null : (parentSeqs.get(row.parent_id) ?? null),
				score: row.score ?? 0,
				highlights: row.marked === null ? [] : highlightRanges(row.marked),
			}),
		);
	}

	/**
	 * A page of the messages of the room that a filter finds, for a member: the messages of the room list
	 * and the replies, without deleted messages. `sort: "rank"` gives the best match first, from `offset`.
	 * Each other read gives the newest message first, before the seq `before`. A filter without words has
	 * no rank, so it reads by time.
	 */
	search(
		call: RoomCall,
		filter: SearchFilter,
		input: { sort: "rank" | "time"; before: number | null; offset: number; limit: number },
	): { room: SearchRoomRecord; results: SearchHitRecord[]; hasMore: boolean } | Refusal {
		const opened = this.openAsMember(call);
		if ("error" in opened) return opened;
		const { from, where, params } = searchSql(filter, ROOM_SEARCH);
		where.push("m.deleted_at IS NULL");
		const ranked = input.sort === "rank" && filter.match !== null;
		// With words, the FTS5 table gives its rows in the order of its rowid, which is the seq.
		const seq = filter.match === null ? "m.seq" : "messages_fts.rowid";
		if (!ranked && input.before !== null) {
			where.push(`${seq} < ?`);
			params.push(input.before);
		}
		params.push(input.limit + 1);
		if (ranked) params.push(input.offset);
		const rows = this.all<SearchRow>(
			`SELECT m.*, ${filter.match === null ? "NULL AS marked, NULL AS score" : SEARCH_COLUMNS} FROM ${from}
			WHERE ${where.join(" AND ")}
			ORDER BY ${ranked ? `bm25(messages_fts), ${seq} DESC` : `${seq} DESC`}
			LIMIT ?${ranked ? " OFFSET ?" : ""}`,
			...params,
		);
		const peer = this.peerJson(opened.room, call.actor.principal_id);
		const peers = this.peersJson(opened.room, call.actor.principal_id);
		return {
			room: {
				id: opened.room.room_id,
				kind: opened.room.kind,
				name: opened.room.name,
				peer: peer === null ? null : (JSON.parse(peer) as ActorRecord),
				...(peers === null ? {} : { peers: JSON.parse(peers) as ActorRecord[] }),
			},
			results: this.searchHitRecords(opened.room.room_id, rows.slice(0, input.limit)),
			hasMore: rows.length > input.limit,
		};
	}

	/**
	 * The messages with the seqs of the list that the filter finds now, for a member. The index of the
	 * organization found the seqs. The room makes the access check again, and reads its own tables: so a
	 * deleted message, and a message whose text changed, never show from an index that is behind.
	 */
	searchHits(call: RoomCall, filter: SearchFilter, seqs: readonly number[]): { results: SearchHitRecord[] } | Refusal {
		const opened = this.openAsMember(call);
		if ("error" in opened) return opened;
		const { from, where, params } = searchSql(filter, ROOM_SEARCH);
		where.push("m.deleted_at IS NULL", "m.seq IN (SELECT value FROM json_each(?))");
		params.push(JSON.stringify(seqs));
		const rows = this.all<SearchRow>(
			`SELECT m.*, ${filter.match === null ? "NULL AS marked, NULL AS score" : SEARCH_COLUMNS} FROM ${from}
			WHERE ${where.join(" AND ")}`,
			...params,
		);
		return { results: this.searchHitRecords(opened.room.room_id, rows) };
	}

	/**
	 * Sends a batch to the index of the organization, for a search that found that the index has no row of
	 * this room: a room with no change since the version with search, or an index that lost its rows. The
	 * index answers that it did not know the room, so the room makes each stored message a target
	 * (`sendSearch`). This call sends the first of them, and the alarm sends the rest.
	 */
	async fillSearch(): Promise<void> {
		if (!this.room()) return;
		this.touch(SEARCH_ROOM_TARGET);
		await this.sendSearchRows();
		await this.schedule();
	}

	/**
	 * Sends the outbox rows for the index of the organization that are due, after each send that started
	 * before: one send at a time, so the stamps of the batches reach the index in their order. This line is
	 * not the line of `flush`. So a post, an edit and a delete never wait for the index, also while the
	 * index is slow. The alarm and `fillSearch` call it.
	 */
	private sendSearchRows(): Promise<void> {
		const run = this.searchSent.then(async () => {
			for (let round = 0; round < DRAIN_ROUNDS; round++) {
				const room = this.rawRoom();
				if (!room) return;
				const rows = this.all<OutboxRow>(
					`SELECT target, gen, attempts FROM outbox
					WHERE next_attempt_at <= ? AND substr(target, 1, ${SEARCH_TARGET.length}) = '${SEARCH_TARGET}'
					ORDER BY target LIMIT ?`,
					Date.now(),
					OUTBOX_BATCH,
				);
				if (rows.length === 0 || (await this.sendSearch(room, rows))) return;
			}
		});
		this.searchSent = run.catch((error: unknown) => {
			log("error", "chat search index drain failed", { error: error instanceof Error ? error.message : String(error) });
		});
		return this.searchSent;
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
			canType: open.canType,
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

	/** The runtime answers pings. Each other accepted frame controls only the live view of this room. */
	override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const state = socket.deserializeAttachment() as SocketState | null;
		if (!state || state.feed || (message !== "show" && message !== "hide" && message !== "typing")) {
			this.end(socket, 1008, "Unknown room socket frame.");
			return;
		}
		if (message !== "typing") {
			const showing = message === "show";
			if (Boolean(state.showing) !== showing) socket.serializeAttachment({ ...state, showing } satisfies SocketState);
			return;
		}
		if (!state.showing || !state.canType || socket.readyState !== WebSocket.OPEN) return;

		const now = Date.now();
		if (now - state.openedAt >= SOCKET_MAX_MS) {
			this.end(socket, CHAT_SOCKET_CLOSE.reconnect, "The socket reached its longest life.");
			return;
		}
		if (now - state.checkedAt >= SOCKET_RECHECK_MS) {
			await this.recheckSockets();
			if (!this.checkedSocket(socket)?.showing) return;
		}
		// All sockets of the member share this limit, also after a reconnect or a restart of the room.
		const member = state.credential.principalId;
		// A typing event tells the other members that a message comes. A member without chat.write in its
		// membership cannot post, so its sockets send no such event, also a socket from before the change.
		const row = this.member(member);
		if (!row || !this.hasScope(row, "chat.write")) return;
		const at = Date.now();
		const sent = this.sql.exec(
			`UPDATE members SET last_typed_at = ? WHERE principal_id = ?
			AND (last_typed_at IS NULL OR last_typed_at <= ?)`,
			at,
			member,
			at - CHAT_LIMITS.typingIntervalMs,
		);
		if (sent.rowsWritten === 0) return;
		const event: ChatSocketEvent = {
			type: "typing",
			principal_id: member,
			expires_at: new Date(at + CHAT_LIMITS.typingLifetimeMs).toISOString(),
		};
		// Typing does not change the room version, run the outbox or wake a principal.
		await this.deliver(JSON.stringify(event), socketTag(member), true);
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

	/**
	 * Sends an event to the sockets and writes the index. The sockets do not wait for the index.
	 *
	 * `actorId` is the principal that made the change. A feed of that principal does not get the event,
	 * so an MCP stream gets no notification for a change of its own principal. A socket that is not a
	 * feed gets each event: a tab of a person shows the message that a different tab sent.
	 */
	private async publish(event: ChatSocketEvent, actorId: string | null = null): Promise<void> {
		const text = JSON.stringify(event);
		const quietTag = actorId === null ? null : socketTag(actorId);
		this.announced = this.announced
			.then(() => this.deliver(text, quietTag))
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
	 *
	 * A feed with the tag `quietTag` gets no event, but its credential check runs as for each socket.
	 */
	private async deliver(text: string, quietTag: string | null, typing = false): Promise<void> {
		const now = Date.now();
		const waiting: WebSocket[] = [];
		for (const socket of this.ctx.getWebSockets()) {
			const state = socket.deserializeAttachment() as SocketState | null;
			if (!state || now - state.openedAt >= SOCKET_MAX_MS) {
				this.end(socket, CHAT_SOCKET_CLOSE.reconnect, "The socket reached its longest life. Open a new socket.");
				continue;
			}
			const own = quietTag === socketTag(state.credential.principalId);
			if (typing ? own || state.feed || !state.showing : own && state.feed) continue;
			if (now - state.checkedAt >= SOCKET_RECHECK_MS) waiting.push(socket);
			else this.send(socket, text);
		}
		if (waiting.length === 0) return;
		await this.recheckSockets();
		for (const socket of waiting) {
			const state = this.checkedSocket(socket);
			if (state && (!typing || state.showing)) this.send(socket, text);
		}
	}

	/** A socket can close or hide the room during a directory read. Read its attachment again. */
	private checkedSocket(socket: WebSocket): SocketState | null {
		if (socket.readyState !== WebSocket.OPEN) return null;
		const state = socket.deserializeAttachment() as SocketState | null;
		if (state && Date.now() - state.checkedAt < SOCKET_RECHECK_MS) return state;
		this.end(socket, CHAT_SOCKET_CLOSE.reconnect, "The access check failed. Open a new socket.");
		return null;
	}

	/** Incoming typing frames and outgoing events share one credential check, also when they arrive together. */
	private recheckSockets(): Promise<void> {
		this.socketCheck ??= this.refreshSocketCredentials().finally(() => {
			this.socketCheck = undefined;
		});
		return this.socketCheck;
	}

	private async refreshSocketCredentials(): Promise<void> {
		const open: { socket: WebSocket; credential: CredentialRef }[] = [];
		for (const socket of this.ctx.getWebSockets()) {
			const state = socket.deserializeAttachment() as SocketState | null;
			if (state) open.push({ socket, credential: state.credential });
		}
		let checks: CredentialCheck[];
		try {
			checks = await checkCredentials(
				this.env.DIRECTORY,
				open.map((entry) => entry.credential),
			);
		} catch (error) {
			log("warn", "chat socket credential check failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		const checkedAt = Date.now();
		let ended = 0;
		for (const [index, { socket }] of open.entries()) {
			if (socket.readyState !== WebSocket.OPEN) continue;
			const check = checks[index];
			if (check === "live") {
				const current = socket.deserializeAttachment() as SocketState;
				socket.serializeAttachment({ ...current, checkedAt } satisfies SocketState);
			} else if (check === "renew") {
				ended++;
				this.end(socket, CHAT_SOCKET_CLOSE.reconnect, "Authenticate again: open a new socket.");
			} else if (check === "ended") {
				ended++;
				this.end(socket, CHAT_SOCKET_CLOSE.ended, "The credential stopped.");
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

	/** Sets the alarm to the first row of the outbox or next retention expiry, or removes the alarm when none. */
	private async schedule(): Promise<void> {
		let next =
			this.one<{ at: number | null }>(
				`SELECT MIN(next_attempt_at) AS at FROM (SELECT next_attempt_at FROM outbox
				UNION ALL SELECT next_attempt_at FROM webhook_outbox UNION ALL SELECT next_attempt_at FROM chat_notification_outbox
				UNION ALL SELECT next_attempt_at FROM link_jobs UNION ALL SELECT next_attempt_at FROM activity_outbox)`,
			)?.at ?? null;
		const room = this.room();
		if (room && room.retention_days !== null) {
			const oldest = this.one<{ created_at: number | null }>(
				"SELECT MIN(created_at) AS created_at FROM messages WHERE deleted_at IS NULL",
			)?.created_at;
			if (oldest != null) {
				const expiresAt = oldest + room.retention_days * 86_400_000;
				next = next === null ? expiresAt : Math.min(next, expiresAt);
			}
		}
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

	private async sendEventJobs(table: "webhook_outbox" | "chat_notification_outbox"): Promise<void> {
		const rows = this.all<{ event_id: string; job: string; attempts: number }>(
			`SELECT event_id, job, attempts FROM ${table} WHERE next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?`,
			Date.now(),
			OUTBOX_BATCH,
		);
		for (const row of rows) {
			try {
				if (table === "webhook_outbox") await this.env.WEBHOOKS.send(JSON.parse(row.job) as ChatWebhookEventJob);
				else await enqueuePushFanout(this.env, JSON.parse(row.job) as ChatPushFanout);
				this.sql.exec(`DELETE FROM ${table} WHERE event_id = ?`, row.event_id);
			} catch {
				const attempts = row.attempts + 1;
				this.sql.exec(
					`UPDATE ${table} SET attempts = ?, next_attempt_at = ? WHERE event_id = ?`,
					attempts,
					Date.now() + backoff(attempts),
					row.event_id,
				);
				log("warn", "chat event queue send failed", { table, eventId: row.event_id, attempts });
			}
		}
	}

	override async alarm(): Promise<void> {
		const activeRoom = this.room();
		if (activeRoom && activeRoom.retention_days !== null) {
			const pruned = await this.pruneExpiredMessages(Date.now());
			if (pruned > 0) await this.publish({ type: "room" });
		}
		await this.flush();
		await Promise.all([
			this.sendEventJobs("webhook_outbox"),
			this.sendEventJobs("chat_notification_outbox"),
			this.sendActivities(),
		]);
		const room = this.room();
		if (room) await this.sendLinkJobs(room.room_id);
		await this.sendSearchRows();
		await this.schedule();
	}

	/** Checks current access at the authoritative room before each webhook attempt. */
	canNotifyWebhook(
		principalId: string,
		messageId: string,
		membershipId: string,
		eventType: ChatWebhookEvent = "chat.message.created",
	): boolean {
		const target = this.notificationMessage(principalId, messageId, membershipId);
		if (!target) return false;
		const { message } = target;
		// A delete still goes to the author when another member deleted the message.
		if (eventType === "chat.message.deleted") return message.deleted_at !== null;
		if (message.author_id === principalId) return false;
		return message.deleted_at === null;
	}

	private notificationMessage(
		principalId: string,
		messageId: string,
		membershipId: string,
	): { message: MessageRow; member: MemberRow } | null {
		if (!this.hasTables) return null;
		const member = this.member(principalId);
		if (member?.membership_id !== membershipId) return null;
		const message = this.message(messageId);
		return message ? { message, member } : null;
	}

	/** The position for a push click. Check the same membership and message again on each retry. */
	chatPushMessage(
		principalId: string,
		messageId: string,
		membershipId: string,
	): { seq: number; parent_seq: number | null; unread_count: number } | null {
		const target = this.notificationMessage(principalId, messageId, membershipId);
		if (!target) return null;
		const { message, member } = target;
		if (message.author_id === principalId || message.deleted_at !== null) return null;
		const inRoom = message.parent_id === null || message.also_in_room === 1;
		if (inRoom && message.seq <= member.last_read_seq) return null;
		const parent = message.parent_id
			? this.one<{ seq: number; last_read_seq: number | null }>(
					`SELECT parent.seq, follow.last_read_seq FROM messages parent
					LEFT JOIN thread_follows follow ON follow.parent_id = parent.id AND follow.principal_id = ?
					WHERE parent.id = ?`,
					principalId,
					message.parent_id,
				)
			: null;
		if (message.seq <= (parent?.last_read_seq ?? 0)) return null;
		return { seq: message.seq, parent_seq: parent?.seq ?? null, unread_count: this.unreadCount(member) };
	}

	/**
	 * Why a chat event goes to a member: the first reason of `CHAT_EVENT_REASONS` that is true. `body` is
	 * the body of the message of the event. The room reads the body, not the table `mentions`, because that
	 * table has no row for a reply outside the room list. The author of a message is a recipient only when
	 * a different member deleted the message: its reason is `author`, and never a mention of its own
	 * message. Call this after the follows of a new reply are stored.
	 */
	private chatEventReasons(
		kind: RoomKind,
		body: ChatBody,
		authorId: string,
		parentId: string | null,
	): (principalId: string) => ChatEventReason {
		const mentioned = new Set(mentionIds(body));
		const group = groupMentions(body).length > 0;
		const followers = new Set(
			parentId === null
				? []
				: this.all<{ principal_id: string }>(
						"SELECT principal_id FROM thread_follows WHERE parent_id = ? AND following = 1",
						parentId,
					).map((row) => row.principal_id),
		);
		return (principalId) => {
			if (principalId === authorId) return "author";
			if (group || mentioned.has(principalId)) return "mention";
			if (kind === "dm" || kind === "group_dm") return "dm";
			return followers.has(principalId) ? "thread_reply" : "room";
		};
	}

	/**
	 * Records one chat event for the members except the actor, with the reason of each member. Call this
	 * inside the room transaction, after the change of the message. `version` is the version that the
	 * message got from the change. Each member that the change is for also keeps it in its member row
	 * (`addressed_json`).
	 */
	private queueChatEvent(event: {
		room: RoomRow;
		eventType: ChatWebhookEvent;
		messageId: string;
		eventId: string;
		actorId: string;
		authorId: string;
		body: ChatBody;
		version: number;
		now: number;
		subscriptionSequence: number;
		parentId: string | null;
	}): void {
		const reasonOf = this.chatEventReasons(event.room.kind, event.body, event.authorId, event.parentId);
		const members = this.all<{ principal_id: string; membership_id: string; kind: ActorRecord["kind"] }>(
			"SELECT principal_id, membership_id, json_extract(actor_json, '$.kind') AS kind FROM members WHERE principal_id != ?",
			event.actorId,
		);
		if (members.length === 0) return;
		const recipients: ChatPushFanout["recipients"] = [];
		const people: ChatPushFanout["recipients"] = [];
		const addressed = new Map<ChatAddressedReason, string[]>();
		for (const member of members) {
			const reason = reasonOf(member.principal_id);
			const recipient = { id: member.principal_id, membershipId: member.membership_id, reason };
			recipients.push(recipient);
			if (member.kind === "human") people.push(recipient);
			if (reason !== "room") {
				const ids = addressed.get(reason);
				if (ids) ids.push(recipient.id);
				else addressed.set(reason, [recipient.id]);
			}
		}
		if (event.eventType === "chat.message.created" && people.length > 0) {
			const notification: ChatPushFanout = {
				v: 1,
				kind: "recipients",
				roomId: event.room.room_id,
				messageId: event.messageId,
				occurredAt: event.now,
				recipients: people,
				...(event.parentId === null ? {} : { parentId: event.parentId }),
			};
			this.sql.exec(
				"INSERT INTO chat_notification_outbox (event_id, job, next_attempt_at) VALUES (?, ?, ?)",
				event.eventId,
				JSON.stringify(notification),
				event.now,
			);
		}
		for (const [reason, ids] of addressed) {
			// One statement for each reason, so a mention of a group in a large room makes one write.
			this.sql.exec(
				"UPDATE members SET addressed_json = ?1 WHERE principal_id IN (SELECT value FROM json_each(?2))",
				JSON.stringify({
					event: event.eventType,
					reason,
					message_id: event.messageId,
					parent_id: event.parentId,
					author_id: event.authorId,
					version: event.version,
					at: event.now,
				} satisfies ChatAddressedState),
				JSON.stringify(ids),
			);
		}
		const job: ChatWebhookEventJob = {
			v: 1,
			kind: "chat_event",
			roomId: event.room.room_id,
			eventId: event.eventId,
			occurredAt: event.now,
			subscriptionSequence: event.subscriptionSequence,
			recipients,
			eventType: event.eventType,
			messageId: event.messageId,
			authorId: event.authorId,
			version: event.version,
			...(event.parentId === null ? {} : { parentId: event.parentId }),
		};
		this.sql.exec(
			"INSERT INTO webhook_outbox (event_id, job, next_attempt_at) VALUES (?, ?, ?)",
			event.eventId,
			JSON.stringify(job),
			event.now,
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
	private async sendActivities(): Promise<boolean> {
		const room = this.room();
		if (!room) {
			this.sql.exec("DELETE FROM activity_outbox");
			return false;
		}
		const rows = this.all<{ id: string; target_principal_id: string; payload_json: string; attempts: number }>(
			"SELECT id, target_principal_id, payload_json, attempts FROM activity_outbox WHERE next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?",
			Date.now(),
			OUTBOX_BATCH,
		);
		if (rows.length === 0) return false;
		const grouped = new Map<string, Array<{ row: (typeof rows)[number]; payload: ActivityInsert }>>();
		for (const row of rows) {
			const payload = JSON.parse(row.payload_json) as ActivityInsert;
			const isMember = this.member(row.target_principal_id) !== null;
			const messageLive =
				this.one("SELECT 1 AS found FROM messages WHERE id = ? AND deleted_at IS NULL", payload.message_id) !== null;
			if (!isMember || !messageLive) {
				this.sql.exec("DELETE FROM activity_outbox WHERE id = ?", row.id);
				continue;
			}
			const list = grouped.get(row.target_principal_id);
			if (list) list.push({ row, payload });
			else grouped.set(row.target_principal_id, [{ row, payload }]);
		}
		const entries = [...grouped.entries()];
		if (entries.length === 0) return false;
		const results = await Promise.allSettled(
			entries.map(([principalId, group]) =>
				this.env.PRINCIPAL.get(this.env.PRINCIPAL.idFromName(principalId)).recordChatActivity(
					group.map((g) => g.payload),
				),
			),
		);
		let failed = false;
		results.forEach((res, idx) => {
			const group = entries[idx]?.[1] ?? [];
			if (res.status === "fulfilled") {
				for (const { row } of group) this.sql.exec("DELETE FROM activity_outbox WHERE id = ?", row.id);
			} else {
				failed = true;
				for (const { row } of group) {
					const attempts = row.attempts + 1;
					this.sql.exec(
						"UPDATE activity_outbox SET attempts = ?, next_attempt_at = ? WHERE id = ?",
						attempts,
						Date.now() + backoff(attempts),
						row.id,
					);
				}
			}
		});
		return failed;
	}

	private async drain(): Promise<void> {
		for (let round = 0; round < DRAIN_ROUNDS; round++) {
			const room = this.rawRoom();
			if (!room) return;
			// The rows for the search index are not in this pass: the alarm sends them (`sendSearchRows`).
			const rows = this.all<OutboxRow>(
				`SELECT target, gen, attempts FROM outbox
				WHERE next_attempt_at <= ? AND substr(target, 1, ${SEARCH_TARGET.length}) <> '${SEARCH_TARGET}'
				ORDER BY target LIMIT ?`,
				Date.now(),
				OUTBOX_BATCH,
			);
			const hasActivities =
				(this.one<{ n: number }>("SELECT COUNT(*) AS n FROM activity_outbox WHERE next_attempt_at <= ?", Date.now())
					?.n ?? 0) > 0;
			if (rows.length === 0 && !hasActivities) break;
			const isPrincipal = (row: OutboxRow) => row.target.startsWith(PRINCIPAL_TARGET);
			const isGrant = (row: OutboxRow) => row.target.startsWith(GRANT_TARGET);
			const isBlob = (row: OutboxRow) => row.target.startsWith(BLOB_TARGET);
			const indexRows = rows.filter((row) => !isPrincipal(row) && !isGrant(row) && !isBlob(row));
			const failures = await Promise.all([
				this.writeIndex(room, indexRows),
				this.sendStates(room, rows.filter(isPrincipal)),
				this.sendGrants(room, rows.filter(isGrant)),
				this.deleteBlobs(rows.filter(isBlob)),
			]);
			const activityFailed = await this.sendActivities();
			if (failures.some(Boolean) || activityFailed) break;
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
	 * Sends the current search state of the message of each row to the index of the organization, in one
	 * batch: the plain text and the filter values of a message that stays, or nothing for a deleted one.
	 * So a second delivery changes nothing, and the order of two changes of one message does not matter.
	 * The batch has a stamp that grows with each batch of the room. The index applies a batch only when its
	 * stamp is higher than the stamp that it has for the room, so each batch applies one time, and an older
	 * batch that arrives late changes nothing.
	 *
	 * The index tells when it had no row of the room before this batch (the first batch of a room, or an
	 * index that lost its rows), and when the room did not tell it yet that each stored message is a target.
	 * Each stored message then becomes a target, with `SEARCH_FILLED_TARGET` after them, so the index gets
	 * all of them. The answer of the index is the state of the index, not of one call. So a fill starts
	 * also when the answer to the first batch got lost. Returns true when the send failed.
	 */
	private async sendSearch(room: RoomRow, rows: OutboxRow[]): Promise<boolean> {
		if (rows.length === 0) return false;
		if (room.deleted_at !== null || rows.some((row) => row.target === SEARCH_DELETE_TARGET)) {
			try {
				const res = await searchIndex(this.env).deleteRoom(room.room_id);
				if (!res.done) {
					for (const row of rows) {
						this.sql.exec(
							"UPDATE outbox SET next_attempt_at = ? WHERE target = ? AND gen = ?",
							Date.now(),
							row.target,
							row.gen,
						);
					}
					return true;
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log("warn", "chat search room delete failed", { roomId: room.room_id, error: message });
				for (const row of rows) this.retryLater(row, message);
				return true;
			}
			for (const row of rows) this.done(row);
			return false;
		}
		const entries: SearchEntry[] = [];
		for (const row of rows) {
			if (row.target === SEARCH_ROOM_TARGET || row.target === SEARCH_FILLED_TARGET) continue;
			const seq = Number(row.target.slice(SEARCH_TARGET.length));
			const message = this.one<MessageRow>("SELECT * FROM messages WHERE seq = ? AND deleted_at IS NULL", seq);
			if (!message) {
				entries.push({ seq, row: null });
				continue;
			}
			entries.push({
				seq,
				row: {
					author_id: message.author_id,
					created_at: message.created_at,
					text: indexedText(message.text),
					has_link: message.has_link === 1,
					has_file: this.one("SELECT 1 AS found FROM message_files WHERE message_id = ? LIMIT 1", message.id) !== null,
					in_thread: message.parent_id !== null || message.reply_count > 0,
					mentions: this.all<{ principal_id: string }>(
						"SELECT principal_id FROM search_mentions WHERE seq = ?",
						seq,
					).map((mention) => mention.principal_id),
				},
			});
		}
		const stamp = Number(
			this.one<{ value: string }>(
				`INSERT INTO meta (key, value) VALUES ('search_stamp', '1')
				ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1 RETURNING value`,
			)?.value,
		);
		let answer: { known: boolean; filled: boolean };
		try {
			answer = await searchIndex(this.env).apply({
				roomId: room.room_id,
				stamp,
				entries,
				filled: rows.some((row) => row.target === SEARCH_FILLED_TARGET),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log("warn", "chat search index send failed", { rows: rows.length, error: message });
			for (const row of rows) this.retryLater(row, message);
			return true;
		}
		for (const row of rows) this.done(row);
		// A fill that runs has its last target in the outbox. It does not start again.
		const filling = this.one("SELECT 1 AS found FROM outbox WHERE target = ?", SEARCH_FILLED_TARGET) !== null;
		if (!answer.known || (!answer.filled && !filling)) {
			this.touch(SEARCH_FILLED_TARGET);
			this.sql.exec(
				`INSERT INTO outbox (target, gen, next_attempt_at)
					SELECT ?1 || seq, 1, ?2 FROM messages WHERE deleted_at IS NULL
				ON CONFLICT (target) DO UPDATE SET gen = gen + 1, attempts = 0,
					next_attempt_at = MIN(next_attempt_at, excluded.next_attempt_at)`,
				SEARCH_TARGET,
				Date.now(),
			);
			log("info", "chat search index fill started", { roomId: room.room_id });
		}
		return false;
	}

	/** Deletes the R2 objects of the rows: the pictures of link previews. Returns true when the delete failed. */
	private async deleteBlobs(rows: OutboxRow[]): Promise<boolean> {
		if (rows.length === 0) return false;
		try {
			await this.env.BLOBS.delete(rows.map((row) => row.target.slice(BLOB_TARGET.length)));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log("warn", "chat blob delete failed", { rows: rows.length, error: message });
			for (const row of rows) this.retryLater(row, message);
			return true;
		}
		for (const row of rows) this.done(row);
		return false;
	}

	/**
	 * Brings the grant of the room on each file of the rows to the current state in Drive: a grant while a
	 * message of the room holds the file, else no grant. The author of the newest such message is the
	 * author of the grant. Returns true when a call failed.
	 */
	private async sendGrants(room: RoomRow, rows: OutboxRow[]): Promise<boolean> {
		if (rows.length === 0) return false;
		const results = await Promise.allSettled(
			rows.map((row) => {
				const [spaceId = "", itemId = ""] = row.target.slice(GRANT_TARGET.length).split(":");
				const holder = this.one<{ author_json: string }>(
					`SELECT m.author_json FROM message_files f JOIN messages m ON m.id = f.message_id
					WHERE f.space_id = ? AND f.item_id = ? ORDER BY m.seq DESC LIMIT 1`,
					spaceId,
					itemId,
				);
				return this.env.DRIVE_SPACE.get(this.env.DRIVE_SPACE.idFromName(spaceId)).setRoomGrant({
					spaceId,
					itemId,
					roomId: room.room_id,
					present: holder !== null,
					by: holder === null ? null : (JSON.parse(holder.author_json) as ActorRecord),
				});
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
		if (failed > 0) log("warn", "chat room grant failed", { targets: rows.length, failed });
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
		if (target === "webhooks") {
			return db.prepare("DELETE FROM chat_incoming_webhooks WHERE room_id = ?").bind(room.room_id);
		}
		if (target === "room") {
			if (room.deleted_at !== null) {
				return db.prepare("DELETE FROM chat_rooms WHERE id = ?").bind(room.room_id);
			}
			const creator = (JSON.parse(room.created_by_json) as ActorRecord).principal_id;
			const ownerCount = this.one<{ n: number }>("SELECT COUNT(*) AS n FROM members WHERE role = 'owner'")?.n ?? 0;
			return db
				.prepare(
					`INSERT INTO chat_rooms (id, kind, name, name_key, topic, created_at, created_by_json, member_count,
						last_seq, last_message_at, activity_at, version, archived_at, posting_policy, retention_days, owner_count)
					SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?14, ?15, ?16, ?17
					WHERE EXISTS (SELECT 1 FROM principals WHERE id = ?13)
					ON CONFLICT (id) DO UPDATE SET name = excluded.name, name_key = excluded.name_key,
						topic = excluded.topic, member_count = excluded.member_count, last_seq = excluded.last_seq,
						last_message_at = excluded.last_message_at, activity_at = excluded.activity_at,
						version = excluded.version, archived_at = excluded.archived_at,
						posting_policy = excluded.posting_policy, retention_days = excluded.retention_days,
						owner_count = excluded.owner_count`,
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
					room.archived_at,
					room.posting_policy,
					room.retention_days,
					ownerCount,
				);
		}
		const principalId = target.slice("member:".length);
		const member = room.deleted_at !== null ? null : this.member(principalId);
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
