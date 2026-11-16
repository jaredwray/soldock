import { DurableObject } from "cloudflare:workers";
import {
	DRIVE_LIMITS,
	type DriveRole,
	type ItemKind,
	SHARED_DRIVE_LIMITS,
	type SharedDriveRole,
} from "@soldock/contracts";
import { audit, log } from "../platform/index.ts";

/** An expected failure, returned instead of thrown, because RPC does not keep error classes. */
export type Refusal = { error: { code: "invalid" | "not_found" | "conflict" | "forbidden"; message: string } };

/** The person or agent of a change, with the name at that time. */
export interface ActorRecord {
	principal_id: string;
	kind: "human" | "agent";
	display_name: string;
}

/**
 * Who calls, and which drive they call. The Worker authenticates the caller. The object decides what
 * the caller can do with each item, because the grants are in its database.
 */
export interface SpaceCall {
	/** The id of this drive: the id of the principal that owns it, or the id of a shared drive. */
	spaceId: string;
	actor: ActorRecord;
	/**
	 * True when the caller is a person with the owner or the admin role of the organization. It lets the
	 * caller manage the members and the name of a shared drive. It gives no access to an item.
	 */
	admin?: boolean;
}

/** The R2 key of one version of a file. Each object has one owner: the version in its key. */
export function blobKeyFor(spaceId: string, itemId: string, versionId: string): string {
	return `drive/${spaceId}/${itemId}/${versionId}`;
}

/** True for the id of a shared drive. A personal drive has the id of its owner. */
export function isSharedDriveId(spaceId: string): boolean {
	return spaceId.startsWith("drv_");
}

/** One member of a shared drive. Times are in milliseconds. */
export interface MemberRecord {
	principal_id: string;
	role: SharedDriveRole;
	added_by: ActorRecord | null;
	created_at: number;
}

/** A shared drive with its members, as the object returns it. */
export interface SharedDriveRecord {
	id: string;
	name: string;
	created_at: number;
	/** The member role of the caller, or null for an admin who is not a member. */
	role: SharedDriveRole | null;
	members: MemberRecord[];
}

/** A new member, or a new role for a member. The Worker reads the kind from the directory. */
export interface MemberInput {
	principalId: string;
	kind: "human" | "agent";
	role: SharedDriveRole;
}

/** The totals of a drive, with the role of the caller for it. */
export interface AboutRecord {
	kind: "personal" | "shared";
	name: string | null;
	role: DriveRole;
	used_bytes: number;
	items_total: number;
	trash_total: number;
	version: number;
}

/** An item as the object returns it. Times are in milliseconds. */
export interface ItemRecord {
	id: string;
	space_id: string;
	parent_id: string | null;
	kind: ItemKind;
	name: string;
	mime_type: string | null;
	size: number;
	created_at: number;
	modified_at: number;
	modified_by: ActorRecord | null;
	role: DriveRole;
	starred: boolean;
	trashed: boolean;
	trashed_at: number | null;
	shared: boolean;
}

export interface VersionRecord {
	id: string;
	size: number;
	mime_type: string;
	sha256: string;
	created_at: number;
	created_by: ActorRecord | null;
	current: boolean;
}

export interface PermissionRecord {
	principal_id: string;
	role: "editor" | "viewer";
	item_id: string;
	inherited: boolean;
	granted_by: ActorRecord | null;
	created_at: number;
}

/** A pointer to an item in a drive. The stars and the shared index of a principal hold these. */
export interface ItemRef {
	spaceId: string;
	itemId: string;
}

export interface NewVersion {
	id: string;
	blobKey: string;
	size: number;
	sha256: string;
	mimeType: string;
}

export interface CreateInput {
	id: string;
	parentId: string | null;
	kind: ItemKind;
	name: string;
	version?: NewVersion;
	/** The key of the caller and the SHA-256 of the request, so a reused key with another request is a conflict. */
	idempotency?: { key: string; requestHash: string } | undefined;
}

/** The change of a doc or a sheet, from its `DocumentDO`. A change with an old revision is dropped. */
export interface DocumentChange {
	itemId: string;
	revision: number;
	modifiedAt: number;
	modifiedBy: ActorRecord;
	size: number;
	/** The text of the content, for the search index. */
	text: string;
}

/** The input of a move to a different drive. */
export interface MoveOutInput {
	itemIds: string[];
	/** The drive that gets the items. The Worker checked that the caller can add items to it. */
	targetId: string;
	/** A folder of the target, or null for its root. */
	parentId: string | null;
	/** The level that an item gets in that folder: 1 at the root of the target. */
	targetDepth: number;
	dryRun: boolean;
	/** The credential kind and the request id of the call, for the audit line of the move. */
	credential: string;
	requestId: string;
}

/** The answer of a move to a different drive. */
export interface MoveOutResult {
	status: "done" | "moving" | "dry_run";
	/** Each item of the move: the selected items and all that they hold. */
	itemsTotal: number;
	bytes: number;
	/** The principals that keep a direct grant on a moved item. */
	keptShares: string[];
	/** The selected items that are not in a different selected item. */
	topIds: string[];
}

/** One item of a move, as the source drive sends it to the target drive. */
export interface StagedItem {
	id: string;
	/** True for a selected item. It goes into the folder of the move. Each other item keeps its folder. */
	top: boolean;
	parent_id: string | null;
	kind: ItemKind;
	name: string;
	mime_type: string | null;
	size: number;
	head_version_id: string | null;
	content_revision: number;
	created_at: number;
	modified_at: number;
	modified_by_json: string | null;
	trashed_at: number | null;
	trash_root: string | null;
	versions: {
		id: string;
		size: number;
		mime_type: string;
		sha256: string;
		created_at: number;
		created_by_json: string | null;
	}[];
	grants: { principal_id: string; role: "editor" | "viewer"; granted_by_json: string | null; created_at: number }[];
}

export interface Page<T> {
	items: T[];
	nextCursor: string | null;
}

type Row = Record<string, SqlStorageValue>;

interface ItemRow extends Row {
	seq: number;
	id: string;
	parent_id: string | null;
	kind: ItemKind;
	name: string;
	name_key: string;
	mime_type: string | null;
	size: number;
	head_version_id: string | null;
	content_revision: number;
	created_at: number;
	modified_at: number;
	modified_by_json: string | null;
	trashed_at: number | null;
	trash_root: string | null;
	shared: number;
}

interface VersionRow extends Row {
	id: string;
	item_id: string;
	blob_key: string;
	size: number;
	mime_type: string;
	sha256: string;
	created_at: number;
	created_by_json: string | null;
}

interface OutboxRow extends Row {
	id: number;
	kind: "share" | "unshare" | "blob" | "document" | "moved" | "cancel";
	target: string;
	payload: string;
	attempts: number;
	next_attempt_at: number;
}

/** A move to a different drive that is not complete. The state is the next step. */
interface TransferRow extends Row {
	id: string;
	target: string;
	parent_id: string | null;
	/** JSON: the selected ids, in order. A second call with the same ids joins this move. */
	item_ids: string;
	actor_json: string;
	/** JSON: the totals of the answer. */
	totals_json: string;
	state: "stage" | "copy" | "commit" | "refresh" | "finish";
	/** Where the step continues: the last item or version that it handled. */
	cursor: string;
	attempts: number;
	next_attempt_at: number;
}

/** The totals of a move, as the `transfers` row keeps them. */
interface MoveTotals {
	itemsTotal: number;
	bytes: number;
	keptShares: string[];
	topIds: string[];
}

/** The time and the calls that one run of the moves can use. */
interface MoveBudget {
	deadline: number;
	calls: number;
}

/** A row of the index in D1 that is behind this drive: `drive`, or `member:<principal id>`. */
interface IndexRow extends Row {
	target: string;
	gen: number;
	attempts: number;
}

/** The stored facts of a shared drive, in the `drive` row of `meta`. */
interface DriveFacts {
	name: string;
	created_at: number;
	created_by: ActorRecord;
	deleted_at: number | null;
}

/** What a caller can do with one item, and if the caller can read the folder that holds it. */
interface Access {
	role: DriveRole;
	parentVisible: boolean;
	/** The number of folders above the item that the caller can read. */
	visibleDepth: number;
}

/** Ordered migrations. Each inner list runs in one transaction. Append only. */
const MIGRATIONS: string[][] = [
	[
		`CREATE TABLE items (
			seq INTEGER PRIMARY KEY,
			id TEXT NOT NULL UNIQUE,
			parent_id TEXT,
			kind TEXT NOT NULL CHECK (kind IN ('folder', 'file', 'doc', 'sheet')),
			name TEXT NOT NULL,
			name_key TEXT NOT NULL,
			mime_type TEXT,
			size INTEGER NOT NULL DEFAULT 0,
			head_version_id TEXT,
			content_revision INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL,
			modified_at INTEGER NOT NULL,
			modified_by_json TEXT,
			trashed_at INTEGER,
			trash_root TEXT
		)`,
		"CREATE INDEX items_parent ON items (parent_id, name_key)",
		"CREATE INDEX items_modified ON items (modified_at)",
		"CREATE INDEX items_trash ON items (trash_root)",
		`CREATE TABLE versions (
			id TEXT PRIMARY KEY,
			item_id TEXT NOT NULL,
			blob_key TEXT NOT NULL,
			size INTEGER NOT NULL,
			mime_type TEXT NOT NULL,
			sha256 TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			created_by_json TEXT
		)`,
		"CREATE INDEX versions_item ON versions (item_id, created_at)",
		`CREATE TABLE permissions (
			item_id TEXT NOT NULL,
			principal_id TEXT NOT NULL,
			role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
			granted_by_json TEXT,
			created_at INTEGER NOT NULL,
			PRIMARY KEY (item_id, principal_id)
		) WITHOUT ROWID`,
		"CREATE VIRTUAL TABLE items_fts USING fts5 (name, content, tokenize = 'unicode61 remove_diacritics 2')",
		// The state of the owner as a user: the stars and the index of what others shared.
		`CREATE TABLE stars (
			space_id TEXT NOT NULL,
			item_id TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			PRIMARY KEY (space_id, item_id)
		) WITHOUT ROWID`,
		"CREATE INDEX stars_created ON stars (created_at)",
		`CREATE TABLE shared_with_me (
			space_id TEXT NOT NULL,
			item_id TEXT NOT NULL,
			role TEXT NOT NULL,
			shared_at INTEGER NOT NULL,
			PRIMARY KEY (space_id, item_id)
		) WITHOUT ROWID`,
		"CREATE INDEX shared_with_me_time ON shared_with_me (shared_at)",
		`CREATE TABLE outbox (
			id INTEGER PRIMARY KEY,
			kind TEXT NOT NULL CHECK (kind IN ('share', 'unshare', 'blob', 'document')),
			target TEXT NOT NULL,
			payload TEXT NOT NULL,
			attempts INTEGER NOT NULL DEFAULT 0,
			next_attempt_at INTEGER NOT NULL,
			last_error TEXT
		)`,
		`CREATE TABLE idempotency (
			key TEXT PRIMARY KEY,
			request_hash TEXT NOT NULL,
			item_id TEXT NOT NULL,
			created_at INTEGER NOT NULL
		)`,
	],
	[
		// The members of a shared drive. A personal drive has no rows here.
		`CREATE TABLE members (
			principal_id TEXT PRIMARY KEY,
			role TEXT NOT NULL CHECK (role IN ('manager', 'editor', 'viewer')),
			added_by_json TEXT,
			created_at INTEGER NOT NULL
		) WITHOUT ROWID`,
		// The rows of the index in D1 that are behind this shared drive: `drive`, or `member:<principal id>`.
		`CREATE TABLE index_outbox (
			target TEXT PRIMARY KEY,
			gen INTEGER NOT NULL,
			attempts INTEGER NOT NULL DEFAULT 0,
			next_attempt_at INTEGER NOT NULL,
			last_error TEXT
		) WITHOUT ROWID`,
	],
	[
		// A move to a different drive that is not complete. The source drive has the row.
		`CREATE TABLE transfers (
			id TEXT PRIMARY KEY,
			target TEXT NOT NULL,
			parent_id TEXT,
			item_ids TEXT NOT NULL,
			actor_json TEXT NOT NULL,
			totals_json TEXT NOT NULL,
			state TEXT NOT NULL CHECK (state IN ('stage', 'copy', 'commit', 'refresh', 'finish')),
			cursor TEXT NOT NULL DEFAULT '',
			created_at INTEGER NOT NULL,
			attempts INTEGER NOT NULL DEFAULT 0,
			next_attempt_at INTEGER NOT NULL,
			last_error TEXT
		)`,
		// Each item of a move that is not complete. An item with a row here refuses each change.
		`CREATE TABLE transfer_items (
			item_id TEXT PRIMARY KEY,
			transfer_id TEXT NOT NULL,
			top INTEGER NOT NULL
		) WITHOUT ROWID`,
		"CREATE INDEX transfer_items_transfer ON transfer_items (transfer_id)",
		// Where an item went. A call for the item in this drive gets the id of the new drive.
		`CREATE TABLE moved (
			item_id TEXT PRIMARY KEY,
			target TEXT NOT NULL,
			moved_at INTEGER NOT NULL
		) WITHOUT ROWID`,
		// The items that a source drive sent, until the move commits them. The row with seq -1 shows
		// that the move committed.
		`CREATE TABLE imports (
			transfer_id TEXT NOT NULL,
			seq INTEGER NOT NULL,
			payload TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			PRIMARY KEY (transfer_id, seq)
		) WITHOUT ROWID`,
		// SQLite cannot change a CHECK. The outbox gets the `moved` and the `cancel` kinds in a new table
		// with the same rows. A move deletes rows that the alarm can have in delivery. AUTOINCREMENT never
		// gives the id of a deleted row to a new row, so the alarm cannot delete a row that it did not deliver.
		`CREATE TABLE outbox_next (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			kind TEXT NOT NULL CHECK (kind IN ('share', 'unshare', 'blob', 'document', 'moved', 'cancel')),
			target TEXT NOT NULL,
			payload TEXT NOT NULL,
			attempts INTEGER NOT NULL DEFAULT 0,
			next_attempt_at INTEGER NOT NULL,
			last_error TEXT
		)`,
		`INSERT INTO outbox_next (id, kind, target, payload, attempts, next_attempt_at, last_error)
			SELECT id, kind, target, payload, attempts, next_attempt_at, last_error FROM outbox`,
		"DROP TABLE outbox",
		"ALTER TABLE outbox_next RENAME TO outbox",
	],
];

const OUTBOX_MAX_ATTEMPTS = 8;
const OUTBOX_BATCH = 50;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_INDEXED_CHARS = 100_000;
/** The most folders that an ancestor walk reads. The depth limit keeps real trees far below this. */
const WALK_LIMIT = 64;

const INDEX_BATCH = 100;
/** The most passes of one write to the index. The next write continues. */
const INDEX_ROUNDS = 10;
/**
 * The time that the object can be without an alarm after a change, if it stops during the write to the
 * index. The end of each write moves this alarm.
 */
const ALARM_GUARD_MS = 30_000;

/** The wall time of one run of the moves between drives. A call answers `moving` after it. */
const MOVE_BUDGET_MS = 20_000;
/** The calls to R2 and to other objects in one run of the moves. The next alarm continues. */
const MOVE_CALLS = 400;
/** The most items of one message to the target drive. */
const STAGE_BATCH = 25;
/**
 * The most UTF-8 bytes of the items of one message to the target drive. The target stores a message in
 * one row, and a row of a SQLite Durable Object has at most 2 MB.
 */
const STAGE_BYTES = 512 * 1024;
/** A move that fails this many times before the target has the items is stopped. The items stay. */
const MOVE_MAX_ATTEMPTS = 8;
/** The time that a drive keeps the new place of a moved item. */
const MOVED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * The most drives that a `moved` notice follows from one drive to the next, and the most times that it
 * looks for an item that moved on again.
 */
const MOVED_HOPS = 10;
/** R2 holds the bytes of a file with a neutral type. Nothing serves them from R2 to a browser. */
const STORED_TYPE = { httpMetadata: { contentType: "application/octet-stream" } };

const RANK: Record<DriveRole, number> = { viewer: 1, editor: 2, manager: 3, owner: 4 };

const ITEM_COLUMNS = `i.seq, i.id, i.parent_id, i.kind, i.name, i.name_key, i.mime_type, i.size, i.head_version_id,
	i.content_revision, i.created_at, i.modified_at, i.modified_by_json, i.trashed_at, i.trash_root,
	EXISTS (SELECT 1 FROM permissions p WHERE p.item_id = i.id) AS shared`;

/** The folders from an item up to the root. Depth 0 is the item. */
const UP = `WITH RECURSIVE up (id, parent_id, name, depth) AS (
		SELECT id, parent_id, name, 0 FROM items WHERE id = ?1
		UNION ALL
		SELECT i.id, i.parent_id, i.name, up.depth + 1 FROM items i JOIN up ON i.id = up.parent_id WHERE up.depth < ${WALK_LIMIT}
	)`;

/** An item and all that it holds. Depth 0 is the item. */
const DOWN = `WITH RECURSIVE down (id, depth) AS (
		SELECT id, 0 FROM items WHERE id = ?1
		UNION ALL
		SELECT i.id, down.depth + 1 FROM items i JOIN down ON i.parent_id = down.id WHERE down.depth < ${WALK_LIMIT}
	)`;

const NOT_FOUND = "No item has that id, or you have no access to it.";
const OWN_DRIVE_ONLY = "Only the owner of a drive can do this, in their own drive.";
const IN_TRASH = "The item is in the trash. Restore it first.";
const MOVING = "The item is moving to a different drive. Try again in a moment.";
const NO_DRIVE = "No shared drive has that id, or you are not a member of it.";
const NOT_COMPLETE = "The move did not complete. The items are in the source drive. Try again.";
const LAST_MANAGER =
	"A shared drive needs at least one manager who is a person. Give a different person the manager role first.";

function refuse(code: Refusal["error"]["code"], message: string): Refusal {
	return { error: { code, message } };
}

/**
 * The refusal for a list of members that the rules do not allow, or null. The Worker makes this check
 * before it calls the object of a new drive, and the object makes it again. `first` is true for the
 * members of a new drive: they need a manager, and the limit applies to the list.
 */
export function memberRefusal(members: MemberInput[], first: boolean): Refusal | null {
	if (new Set(members.map((member) => member.principalId)).size !== members.length) {
		return refuse("invalid", "members names a person or an agent two times.");
	}
	if (members.some((member) => member.kind === "agent" && member.role === "manager")) {
		return refuse("invalid", "An agent cannot be a manager of a shared drive. Give it the editor or the viewer role.");
	}
	if (!first) return null;
	if (!members.some((member) => member.role === "manager")) {
		return refuse("invalid", "members must have at least one person with the manager role.");
	}
	if (members.length > SHARED_DRIVE_LIMITS.members) {
		return refuse("invalid", `A shared drive can have at most ${SHARED_DRIVE_LIMITS.members} members.`);
	}
	return null;
}

function backoff(attempts: number): number {
	return Math.min(60_000 * 2 ** (attempts - 1), 60 * 60 * 1000);
}

/** The form of a name for the order of a list: NFC, lowercase, for all scripts. */
function nameKey(name: string): string {
	return name.normalize("NFC").toLowerCase();
}

function parseActor(json: string | null): ActorRecord | null {
	return json === null ? null : (JSON.parse(json) as ActorRecord);
}

/** A cursor is base64url of the UTF-8 bytes of JSON. A name in a cursor can have characters of each script. */
function encodeCursor(values: (string | number)[]): string {
	const bytes = new TextEncoder().encode(JSON.stringify(values));
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

/** The values of a cursor, or null when the text is not a cursor with these value types. */
function decodeCursor(cursor: string, types: ("string" | "number")[]): (string | number)[] | null {
	try {
		const binary = atob(cursor.replaceAll("-", "+").replaceAll("_", "/"));
		const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
		const values: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
		if (!Array.isArray(values) || values.length !== types.length) return null;
		if (values.some((value, index) => typeof value !== types[index])) return null;
		return values as (string | number)[];
	} catch {
		return null;
	}
}

const BAD_CURSOR = refuse("invalid", "The cursor is not valid. Use next_cursor from the last page of the same list.");

/** An FTS5 query that needs each word of the text. Each word is quoted, so FTS operators in it have no effect. */
function ftsQuery(text: string): string | null {
	const words = text
		.replace(/[\p{Cc}"]/gu, " ")
		.split(/\s+/)
		.filter((word) => /[\p{L}\p{N}]/u.test(word))
		.slice(0, 20);
	return words.length === 0 ? null : words.map((word) => `"${word}"*`).join(" ");
}

/**
 * One drive, keyed by the id of the principal that owns it, or by the id of a shared drive (`drv_…`).
 * A shared drive has members with roles in place of an owner, and it writes its name and its members
 * to an index in D1 for the lists. It holds the item tree, the versions of
 * each file, the grants, the trash and the search index in its SQLite database. File bytes stay in R2.
 * It also holds the state of its owner as a user: the stars, and the index of the items that others
 * shared. Effects on other objects (the shared index of a different drive, R2 deletes, the content of
 * a deleted doc) go through the outbox and its alarm, in order, with retries.
 */
export class DriveSpaceDO extends DurableObject<Env> {
	private readonly sql: SqlStorage;
	private drainTask: Promise<void> | null = null;
	/** The end of the line of index writes. Each write starts after the one before it ends. */
	private flushed: Promise<void> = Promise.resolve();
	/** The run of the moves between drives. One run at a time keeps the steps of a move in order. */
	private moveTask: Promise<Map<string, "done" | Refusal>> | null = null;
	/** The R2 deletes of the outbox that are in progress, by key. */
	private readonly deleting = new Map<string, Promise<unknown>>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		ctx.blockConcurrencyWhile(async () => {
			this.migrate();
			// A change sets the alarm after its transaction commits. If the object stopped between the
			// two, the outbox has rows and no alarm: set one now. A move that is not complete also needs one.
			const pending =
				(this.one<{ n: number }>("SELECT COUNT(*) AS n FROM outbox")?.n ?? 0) +
				(this.one<{ n: number }>("SELECT COUNT(*) AS n FROM transfers")?.n ?? 0) +
				(this.one<{ n: number }>("SELECT COUNT(*) AS n FROM index_outbox")?.n ?? 0);
			if (pending > 0 && (await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now());
		});
	}

	private migrate(): void {
		this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		const current = Number(this.meta("schema_version") ?? 0);
		for (let version = current; version < MIGRATIONS.length; version++) {
			this.ctx.storage.transactionSync(() => {
				for (const statement of MIGRATIONS[version] ?? []) this.sql.exec(statement);
				this.setMeta("schema_version", String(version + 1));
				if (version === 0) this.setMeta("version", "0");
			});
		}
	}

	private meta(key: string): string | null {
		return this.one<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value ?? null;
	}

	private setMeta(key: string, value: string): void {
		this.sql.exec(
			"INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
			key,
			value,
		);
	}

	/** The change counter. Clients compare it to find out if they must get the lists again. */
	private bump(): void {
		this.sql.exec("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'version'");
	}

	private one<T extends Row>(query: string, ...params: SqlStorageValue[]): T | null {
		return (this.sql.exec<T>(query, ...params).toArray()[0] as T | undefined) ?? null;
	}

	private all<T extends Row>(query: string, ...params: SqlStorageValue[]): T[] {
		return this.sql.exec<T>(query, ...params).toArray();
	}

	// --- Access ---------------------------------------------------------------------------------

	private isOwner(call: SpaceCall): boolean {
		return call.actor.principal_id === call.spaceId;
	}

	/** The role of a principal as a member of this shared drive, or null. A personal drive has no member. */
	private memberRole(principalId: string): SharedDriveRole | null {
		return (
			this.one<{ role: SharedDriveRole }>("SELECT role FROM members WHERE principal_id = ?", principalId)?.role ?? null
		);
	}

	/** The highest role of this drive: the owner of a personal drive, a manager of a shared drive. */
	private top(call: SpaceCall): "owner" | "manager" {
		return isSharedDriveId(call.spaceId) ? "manager" : "owner";
	}

	/**
	 * The refusal for a caller that cannot do an action on the drive as a whole, or null. A personal
	 * drive lets only its owner do it. A shared drive lets a member with the `need` role do it. A grant
	 * on an item does not count here.
	 */
	private gate(call: SpaceCall, need: SharedDriveRole): Refusal | null {
		if (!isSharedDriveId(call.spaceId)) return this.isOwner(call) ? null : refuse("forbidden", OWN_DRIVE_ONLY);
		const role = this.memberRole(call.actor.principal_id);
		if (role === null) return refuse("not_found", NO_DRIVE);
		if (RANK[role] < RANK[need]) {
			return refuse(
				"forbidden",
				`You have the ${role} role in this shared drive. This needs the ${need} role. Ask a manager of the drive.`,
			);
		}
		return null;
	}

	private row(itemId: string): ItemRow | null {
		return this.one<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM items i WHERE i.id = ?`, itemId);
	}

	/**
	 * What the caller can do with an item, or null when the caller has no access. The owner of the
	 * drive is the owner of each item. Each other caller gets the highest role from the grants on the
	 * item and on the folders above it. An item in the trash exists for its owner only.
	 *
	 * A shared drive has no owner. A member gets the higher of its member role and its grants. An item in
	 * the trash exists for the members with the editor or the manager role only.
	 */
	private access(call: SpaceCall, item: ItemRow): Access | null {
		if (this.isOwner(call)) return { role: "owner", parentVisible: true, visibleDepth: WALK_LIMIT };
		const member = isSharedDriveId(call.spaceId) ? this.memberRole(call.actor.principal_id) : null;
		if (member === "manager" || member === "editor") {
			return { role: member, parentVisible: true, visibleDepth: WALK_LIMIT };
		}
		if (item.trash_root !== null) return null;
		const grants = this.all<{ role: "editor" | "viewer"; depth: number }>(
			`${UP} SELECT p.role AS role, up.depth AS depth FROM up JOIN permissions p ON p.item_id = up.id WHERE p.principal_id = ?2`,
			item.id,
			call.actor.principal_id,
		);
		// A member with the viewer role reads each item. A grant can make that member an editor of one item.
		if (member !== null) {
			return {
				role: grants.some((grant) => grant.role === "editor") ? "editor" : "viewer",
				parentVisible: true,
				visibleDepth: WALK_LIMIT,
			};
		}
		if (grants.length === 0) return null;
		const visibleDepth = Math.max(...grants.map((grant) => grant.depth));
		return {
			role: grants.some((grant) => grant.role === "editor") ? "editor" : "viewer",
			parentVisible: visibleDepth >= 1,
			visibleDepth,
		};
	}

	/** The item and the access of the caller, or a refusal when the caller has less than the `need` role. */
	private open(call: SpaceCall, itemId: string, need: DriveRole): { item: ItemRow; access: Access } | Refusal {
		const item = this.row(itemId);
		if (!item) return this.missing(call, itemId, NOT_FOUND);
		const access = this.access(call, item);
		if (!access) return refuse("not_found", NOT_FOUND);
		if (RANK[access.role] < RANK[need]) {
			return refuse(
				"forbidden",
				need === "owner"
					? "Only the owner of this item can do this."
					: need === "manager"
						? "Only a manager of this shared drive can do this."
						: `You have the ${access.role} role for this item. This needs the ${need} role. Ask the owner of the item.`,
			);
		}
		if (need !== "viewer" && this.busy(itemId)) return refuse("conflict", MOVING);
		return { item, access };
	}

	/** True for an item of a move to a different drive that is not complete. Such an item refuses each change. */
	private busy(itemId: string): boolean {
		return this.one("SELECT 1 AS found FROM transfer_items WHERE item_id = ?", itemId) !== null;
	}

	/**
	 * The refusal for an id that this drive does not hold. The owner and the members of the drive get
	 * the new drive of an item that moved away. Each other caller gets the usual message.
	 */
	private missing(call: SpaceCall, itemId: string, message: string): Refusal {
		const moved = this.one<{ target: string }>("SELECT target FROM moved WHERE item_id = ?", itemId);
		if (moved && (this.isOwner(call) || this.memberRole(call.actor.principal_id) !== null)) {
			return refuse("not_found", `The item moved to the drive ${moved.target}. Use that space_id.`);
		}
		return refuse("not_found", message);
	}

	private starredIds(itemIds: string[]): Set<string> {
		if (itemIds.length === 0) return new Set();
		const spaceId = this.meta("space_id");
		if (spaceId === null) return new Set();
		const rows = this.all<{ item_id: string }>(
			"SELECT item_id FROM stars WHERE space_id = ? AND item_id IN (SELECT value FROM json_each(?))",
			spaceId,
			JSON.stringify(itemIds),
		);
		return new Set(rows.map((row) => row.item_id));
	}

	private record(call: SpaceCall, item: ItemRow, access: Access, starred: boolean): ItemRecord {
		return {
			id: item.id,
			space_id: call.spaceId,
			// The id of a folder that the caller cannot read tells the caller nothing, so it is left out.
			parent_id: access.parentVisible ? item.parent_id : null,
			kind: item.kind,
			name: item.name,
			mime_type: item.mime_type,
			size: item.size,
			created_at: item.created_at,
			modified_at: item.modified_at,
			modified_by: parseActor(item.modified_by_json),
			role: access.role,
			starred,
			trashed: item.trash_root !== null,
			trashed_at: item.trashed_at,
			shared: item.shared === 1,
		};
	}

	/** The records of rows that the caller can read. The stars are those of the owner of this drive. */
	private records(call: SpaceCall, rows: ItemRow[]): ItemRecord[] {
		const owner = this.isOwner(call);
		const starred = owner ? this.starredIds(rows.map((row) => row.id)) : new Set<string>();
		const records: ItemRecord[] = [];
		for (const row of rows) {
			const access = this.access(call, row);
			if (access) records.push(this.record(call, row, access, starred.has(row.id)));
		}
		return records;
	}

	private recordOf(call: SpaceCall, itemId: string): ItemRecord {
		const item = this.row(itemId) as ItemRow;
		const access = this.access(call, item) as Access;
		return this.record(call, item, access, this.isOwner(call) && this.starredIds([itemId]).has(itemId));
	}

	/**
	 * Each call names the drive. The first call stores the id, and a later call with a different id is a
	 * fault in the Worker: it must never read or change the drive of a different principal.
	 */
	private enter(call: SpaceCall): void {
		const known = this.meta("space_id");
		if (known === null) this.setMeta("space_id", call.spaceId);
		else if (known !== call.spaceId) throw new Error("the call names a different drive than this object holds");
	}

	// --- Read -----------------------------------------------------------------------------------

	about(call: SpaceCall): AboutRecord | Refusal {
		this.enter(call);
		const refused = this.gate(call, "viewer");
		if (refused) return refused;
		const shared = isSharedDriveId(call.spaceId);
		const versions = this.one<{ n: number }>("SELECT COALESCE(SUM(size), 0) AS n FROM versions")?.n ?? 0;
		const native =
			this.one<{ n: number }>("SELECT COALESCE(SUM(size), 0) AS n FROM items WHERE kind IN ('doc', 'sheet')")?.n ?? 0;
		const counts = this.one<{ live: number; trash: number }>(
			"SELECT COUNT(*) FILTER (WHERE trash_root IS NULL) AS live, COUNT(*) FILTER (WHERE trash_root IS NOT NULL) AS trash FROM items",
		);
		return {
			kind: shared ? "shared" : "personal",
			name: shared ? (this.facts()?.name ?? null) : null,
			role: shared ? (this.memberRole(call.actor.principal_id) as SharedDriveRole) : "owner",
			used_bytes: versions + native,
			items_total: counts?.live ?? 0,
			trash_total: counts?.trash ?? 0,
			version: Number(this.meta("version") ?? 0),
		};
	}

	/** The items of one folder, or of the root of the drive for its owner. */
	listFolder(
		call: SpaceCall,
		input: {
			parentId: string | null;
			kind: ItemKind | null;
			order: "name" | "modified";
			cursor: string | null;
			limit: number;
		},
	): Page<ItemRecord> | Refusal {
		this.enter(call);
		if (input.parentId === null) {
			if (isSharedDriveId(call.spaceId)) {
				const refused = this.gate(call, "viewer");
				if (refused) return refused;
			} else if (!this.isOwner(call)) {
				return refuse("forbidden", "You can list the root of your own drive only. Use the shared view.");
			}
		} else {
			const parent = this.open(call, input.parentId, "viewer");
			if ("error" in parent) return parent;
			if (parent.item.kind !== "folder") return refuse("invalid", "The item parent_id is not a folder.");
		}
		const where = ["i.parent_id IS ?1", "i.trash_root IS NULL"];
		const params: SqlStorageValue[] = [input.parentId];
		if (input.kind) {
			params.push(input.kind);
			where.push(`i.kind = ?${params.length}`);
		}
		let order: string;
		if (input.order === "name") {
			if (input.cursor !== null) {
				const values = decodeCursor(input.cursor, ["number", "string", "string"]);
				if (!values) return BAD_CURSOR;
				params.push(...values);
				where.push(
					`((i.kind != 'folder'), i.name_key, i.id) > (?${params.length - 2}, ?${params.length - 1}, ?${params.length})`,
				);
			}
			order = "(i.kind != 'folder'), i.name_key, i.id";
		} else {
			if (input.cursor !== null) {
				const values = decodeCursor(input.cursor, ["number", "string"]);
				if (!values) return BAD_CURSOR;
				params.push(...values);
				where.push(`(i.modified_at, i.id) < (?${params.length - 1}, ?${params.length})`);
			}
			order = "i.modified_at DESC, i.id DESC";
		}
		params.push(input.limit + 1);
		const rows = this.all<ItemRow>(
			`SELECT ${ITEM_COLUMNS} FROM items i WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ?${params.length}`,
			...params,
		);
		const page = rows.slice(0, input.limit);
		const last = page[page.length - 1];
		const nextCursor =
			rows.length > input.limit && last
				? encodeCursor(
						input.order === "name"
							? [last.kind === "folder" ? 0 : 1, last.name_key, last.id]
							: [last.modified_at, last.id],
					)
				: null;
		return { items: this.records(call, page), nextCursor };
	}

	/**
	 * The views of a drive that are not a folder: the newest changes, the trash, and a search. A personal
	 * drive has them for its owner. A shared drive has the search for each member, and the trash for the
	 * members with the editor or the manager role.
	 */
	listView(
		call: SpaceCall,
		input: {
			view: "recent" | "trash" | "search";
			query: string | null;
			kind: ItemKind | null;
			cursor: string | null;
			limit: number;
		},
	): Page<ItemRecord> | Refusal {
		this.enter(call);
		if (isSharedDriveId(call.spaceId) && input.view === "recent") {
			return refuse("invalid", "A shared drive has no recent view.");
		}
		const refused = this.gate(call, input.view === "trash" ? "editor" : "viewer");
		if (refused) return refused;
		const params: SqlStorageValue[] = [];
		const where: string[] = [];
		let from = "items i";
		// The trash view shows what the owner put there, by the time of that. The other views show
		// items outside the trash, by the time of the last change.
		const time = input.view === "trash" ? "i.trashed_at" : "i.modified_at";
		if (input.view === "trash") {
			where.push("i.trash_root = i.id");
		} else {
			where.push("i.trash_root IS NULL");
			if (input.view === "recent") where.push("i.kind != 'folder'");
		}
		if (input.view === "search") {
			const match = ftsQuery(input.query ?? "");
			if (match === null) return { items: [], nextCursor: null };
			from = "items_fts JOIN items i ON i.seq = items_fts.rowid";
			params.push(match);
			where.push(`items_fts MATCH ?${params.length}`);
		}
		if (input.kind) {
			params.push(input.kind);
			where.push(`i.kind = ?${params.length}`);
		}
		if (input.cursor !== null) {
			const values = decodeCursor(input.cursor, ["number", "string"]);
			if (!values) return BAD_CURSOR;
			params.push(...values);
			where.push(`(${time}, i.id) < (?${params.length - 1}, ?${params.length})`);
		}
		params.push(input.limit + 1);
		const rows = this.all<ItemRow>(
			`SELECT ${ITEM_COLUMNS} FROM ${from} WHERE ${where.join(" AND ")} ORDER BY ${time} DESC, i.id DESC LIMIT ?${params.length}`,
			...params,
		);
		const page = rows.slice(0, input.limit);
		const last = page[page.length - 1];
		const lastTime = last ? (input.view === "trash" ? last.trashed_at : last.modified_at) : null;
		return {
			items: this.records(call, page),
			nextCursor: rows.length > input.limit && last && lastTime !== null ? encodeCursor([lastTime, last.id]) : null,
		};
	}

	/** The pointers of one list of the owner as a user: the stars, or what others shared. Newest first. */
	listRefs(
		call: SpaceCall,
		input: { list: "starred" | "shared"; cursor: string | null; limit: number },
	): Page<ItemRef> | Refusal {
		this.enter(call);
		if (!this.isOwner(call)) return refuse("forbidden", OWN_DRIVE_ONLY);
		const [table, time] = input.list === "starred" ? ["stars", "created_at"] : ["shared_with_me", "shared_at"];
		const params: SqlStorageValue[] = [];
		let where = "";
		if (input.cursor !== null) {
			const values = decodeCursor(input.cursor, ["number", "string", "string"]);
			if (!values) return BAD_CURSOR;
			params.push(...values);
			where = `WHERE (${time}, space_id, item_id) < (?1, ?2, ?3)`;
		}
		params.push(input.limit + 1);
		const rows = this.all<{ space_id: string; item_id: string; time: number }>(
			`SELECT space_id, item_id, ${time} AS time FROM ${table} ${where}
			ORDER BY ${time} DESC, space_id DESC, item_id DESC LIMIT ?${params.length}`,
			...params,
		);
		const page = rows.slice(0, input.limit);
		const last = page[page.length - 1];
		return {
			items: page.map((row) => ({ spaceId: row.space_id, itemId: row.item_id })),
			nextCursor: rows.length > input.limit && last ? encodeCursor([last.time, last.space_id, last.item_id]) : null,
		};
	}

	/** The items with these ids that the caller can read, in the order of the ids. Each other id is left out. */
	getItems(call: SpaceCall, itemIds: string[], options: { includeTrashed: boolean }): ItemRecord[] {
		this.enter(call);
		const rows = itemIds
			.map((id) => this.row(id))
			.filter((row): row is ItemRow => row !== null && (options.includeTrashed || row.trash_root === null));
		return this.records(call, rows);
	}

	/** The pointers from the list that have a star of the owner of this drive. */
	starredAmong(call: SpaceCall, refs: ItemRef[]): ItemRef[] | Refusal {
		this.enter(call);
		if (!this.isOwner(call)) return refuse("forbidden", OWN_DRIVE_ONLY);
		return refs.filter(
			(ref) =>
				this.one("SELECT 1 AS found FROM stars WHERE space_id = ? AND item_id = ?", ref.spaceId, ref.itemId) !== null,
		);
	}

	getItem(call: SpaceCall, itemId: string): { item: ItemRecord; path: { id: string; name: string }[] } | Refusal {
		this.enter(call);
		const found = this.open(call, itemId, "viewer");
		if ("error" in found) return found;
		const path = this.all<{ id: string; name: string; depth: number }>(
			`${UP} SELECT id, name, depth FROM up WHERE depth >= 1 AND depth <= ?2 ORDER BY depth DESC`,
			itemId,
			found.access.visibleDepth,
		);
		return {
			item: this.recordOf(call, itemId),
			path: path.map(({ id, name }) => ({ id, name })),
		};
	}

	/**
	 * The item, when the caller has the `need` role for it and it is one of `kinds`. The Worker calls
	 * this before a slow step, for example an upload to R2, and before it reads or writes the content
	 * of a doc or a sheet. A change needs an item outside the trash.
	 */
	checkItem(call: SpaceCall, itemId: string, need: DriveRole, kinds: ItemKind[]): ItemRecord | Refusal {
		this.enter(call);
		const found = this.open(call, itemId, need);
		if ("error" in found) return found;
		if (!kinds.includes(found.item.kind)) {
			return refuse("invalid", `The item is a ${found.item.kind}. This needs a ${kinds.join(" or a ")}.`);
		}
		if (need !== "viewer" && found.item.trash_root !== null) return refuse("invalid", IN_TRASH);
		return this.recordOf(call, itemId);
	}

	/**
	 * Checks that the caller can create an item in a folder, or at the root. Returns the level of the
	 * new item: 1 at the root. The limit is for folders, so a folder at the last level can still hold
	 * files, docs and sheets. The caller checks the level of a new folder with `tooDeep`.
	 */
	checkCreate(call: SpaceCall, parentId: string | null): { depth: number } | Refusal {
		this.enter(call);
		if (parentId === null) {
			if (isSharedDriveId(call.spaceId)) return this.gate(call, "editor") ?? { depth: 1 };
			if (!this.isOwner(call)) return refuse("forbidden", "You can create an item at the root of your own drive only.");
			return { depth: 1 };
		}
		const parent = this.open(call, parentId, "editor");
		if ("error" in parent) return parent;
		if (parent.item.kind !== "folder") return refuse("invalid", "The item parent_id is not a folder.");
		if (parent.item.trash_root !== null) return refuse("invalid", "The folder is in the trash. Restore it first.");
		return { depth: (this.one<{ n: number }>(`${UP} SELECT COUNT(*) AS n FROM up`, parentId)?.n ?? 0) + 1 };
	}

	/** The refusal for a folder at a level over the limit, or null. */
	private tooDeep(folderLevel: number): Refusal | null {
		return folderLevel > DRIVE_LIMITS.depth
			? refuse("invalid", `A drive can have at most ${DRIVE_LIMITS.depth} levels of folders.`)
			: null;
	}

	permissions(call: SpaceCall, itemId: string): { owner_id: string; permissions: PermissionRecord[] } | Refusal {
		this.enter(call);
		const found = this.open(call, itemId, "viewer");
		if ("error" in found) return found;
		const rows = this.all<{
			item_id: string;
			principal_id: string;
			role: "editor" | "viewer";
			granted_by_json: string | null;
			created_at: number;
			depth: number;
		}>(
			`${UP} SELECT p.item_id, p.principal_id, p.role, p.granted_by_json, p.created_at, up.depth
			FROM up JOIN permissions p ON p.item_id = up.id WHERE up.depth <= ?2 ORDER BY up.depth, p.created_at, p.principal_id`,
			itemId,
			found.access.visibleDepth,
		);
		return {
			owner_id: call.spaceId,
			permissions: rows.map((row) => ({
				principal_id: row.principal_id,
				role: row.role,
				item_id: row.item_id,
				inherited: row.depth > 0,
				granted_by: parseActor(row.granted_by_json),
				created_at: row.created_at,
			})),
		};
	}

	private versionRecord(row: VersionRow, headId: string | null): VersionRecord {
		return {
			id: row.id,
			size: row.size,
			mime_type: row.mime_type,
			sha256: row.sha256,
			created_at: row.created_at,
			created_by: parseActor(row.created_by_json),
			current: row.id === headId,
		};
	}

	versions(call: SpaceCall, itemId: string): VersionRecord[] | Refusal {
		this.enter(call);
		const found = this.open(call, itemId, "viewer");
		if ("error" in found) return found;
		if (found.item.kind !== "file") return refuse("invalid", "Only a file has versions.");
		return this.all<VersionRow>(
			"SELECT * FROM versions WHERE item_id = ? ORDER BY created_at DESC, id DESC",
			itemId,
		).map((row) => this.versionRecord(row, found.item.head_version_id));
	}

	/** Where the bytes of a file are: the current version, or the version with `versionId`. */
	fileContent(
		call: SpaceCall,
		itemId: string,
		versionId: string | null,
	): { name: string; version: VersionRecord; blobKey: string } | Refusal {
		this.enter(call);
		const found = this.open(call, itemId, "viewer");
		if ("error" in found) return found;
		if (found.item.kind !== "file") {
			return refuse(
				"invalid",
				`The item is a ${found.item.kind}. It has no file content.${found.item.kind === "doc" ? " Read it with docs.get." : found.item.kind === "sheet" ? " Read it with sheets.get." : ""}`,
			);
		}
		const version = this.one<VersionRow>(
			"SELECT * FROM versions WHERE item_id = ? AND id = ?",
			itemId,
			versionId ?? found.item.head_version_id,
		);
		if (!version) return refuse("not_found", "The file has no version with that id.");
		return {
			name: found.item.name,
			version: this.versionRecord(version, found.item.head_version_id),
			blobKey: version.blob_key,
		};
	}

	/** The item of an idempotency key that was used with the same request, or null when the key is new. */
	idempotentResult(call: SpaceCall, key: string, requestHash: string): ItemRecord | Refusal | null {
		this.enter(call);
		const row = this.one<{ request_hash: string; item_id: string }>(
			"SELECT request_hash, item_id FROM idempotency WHERE key = ? AND created_at > ?",
			key,
			Date.now() - IDEMPOTENCY_TTL_MS,
		);
		if (!row) return null;
		if (row.request_hash !== requestHash) {
			return refuse("conflict", "The idempotency key was used with a different request.");
		}
		const item = this.row(row.item_id);
		const access = item ? this.access(call, item) : null;
		if (!item || !access) return refuse("conflict", "The item of this idempotency key does not exist now.");
		return this.recordOf(call, row.item_id);
	}

	// --- Change ---------------------------------------------------------------------------------

	private enqueue(kind: OutboxRow["kind"], target: string, payload: unknown): void {
		this.sql.exec(
			"INSERT INTO outbox (kind, target, payload, next_attempt_at) VALUES (?, ?, ?, ?)",
			kind,
			target,
			JSON.stringify(payload),
			Date.now(),
		);
	}

	private async schedule(): Promise<void> {
		if (this.one<{ n: number }>("SELECT COUNT(*) AS n FROM outbox")?.n) await this.ctx.storage.setAlarm(Date.now());
	}

	/**
	 * The id that `reserveId` stored for a key with the same request, or null when the key is new. This
	 * call stores nothing.
	 */
	reservedId(call: SpaceCall, key: string, requestHash: string): { id: string } | Refusal | null {
		this.enter(call);
		if (!this.isOwner(call)) return refuse("forbidden", OWN_DRIVE_ONLY);
		const row = this.one<{ request_hash: string; item_id: string }>(
			"SELECT request_hash, item_id FROM idempotency WHERE key = ? AND created_at > ?",
			key,
			Date.now() - IDEMPOTENCY_TTL_MS,
		);
		if (!row) return null;
		return row.request_hash === requestHash
			? { id: row.item_id }
			: refuse("conflict", "The idempotency key was used with a different request.");
	}

	/**
	 * Stores the id of something that a call with an idempotency key creates outside this drive, for
	 * example a shared drive. A second call with the same key and the same request gets the first id.
	 * The key is in the own drive of the caller, with the keys of the items.
	 */
	reserveId(call: SpaceCall, key: string, requestHash: string, id: string): { id: string } | Refusal {
		const earlier = this.reservedId(call, key, requestHash);
		if (earlier) return earlier;
		const now = Date.now();
		this.ctx.storage.transactionSync(() => {
			this.sql.exec("DELETE FROM idempotency WHERE created_at <= ?", now - IDEMPOTENCY_TTL_MS);
			this.sql.exec(
				"INSERT OR REPLACE INTO idempotency (key, request_hash, item_id, created_at) VALUES (?, ?, ?, ?)",
				key,
				requestHash,
				id,
				now,
			);
		});
		return { id };
	}

	/** Creates a folder, a file with its first version, a doc or a sheet. */
	async createItem(call: SpaceCall, input: CreateInput): Promise<{ item: ItemRecord; duplicate: boolean } | Refusal> {
		this.enter(call);
		if (input.idempotency) {
			const earlier = this.idempotentResult(call, input.idempotency.key, input.idempotency.requestHash);
			if (earlier !== null) return "error" in earlier ? earlier : { item: earlier, duplicate: true };
		}
		const allowed = this.checkCreate(call, input.parentId);
		if ("error" in allowed) return allowed;
		const deep = input.kind === "folder" ? this.tooDeep(allowed.depth) : null;
		if (deep) return deep;
		const now = Date.now();
		const actor = JSON.stringify(call.actor);
		this.ctx.storage.transactionSync(() => {
			const seq = this.one<{ seq: number }>(
				`INSERT INTO items (id, parent_id, kind, name, name_key, mime_type, size, head_version_id, created_at, modified_at, modified_by_json)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
				input.id,
				input.parentId,
				input.kind,
				input.name,
				nameKey(input.name),
				input.version?.mimeType ?? null,
				input.version?.size ?? 0,
				input.version?.id ?? null,
				now,
				now,
				actor,
			)?.seq as number;
			this.sql.exec("INSERT INTO items_fts (rowid, name, content) VALUES (?, ?, '')", seq, input.name);
			if (input.version) this.insertVersion(input.id, input.version, now, actor);
			if (input.idempotency) {
				this.sql.exec("DELETE FROM idempotency WHERE created_at <= ?", now - IDEMPOTENCY_TTL_MS);
				this.sql.exec(
					"INSERT OR REPLACE INTO idempotency (key, request_hash, item_id, created_at) VALUES (?, ?, ?, ?)",
					input.idempotency.key,
					input.idempotency.requestHash,
					input.id,
					now,
				);
			}
			this.bump();
		});
		return { item: this.recordOf(call, input.id), duplicate: false };
	}

	private insertVersion(itemId: string, version: NewVersion, now: number, actor: string): void {
		this.sql.exec(
			"INSERT INTO versions (id, item_id, blob_key, size, mime_type, sha256, created_at, created_by_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			version.id,
			itemId,
			version.blobKey,
			version.size,
			version.mimeType,
			version.sha256,
			now,
			actor,
		);
	}

	/** Stores new content for a file. The version over the limit, the oldest, goes away with its bytes. */
	async addVersion(
		call: SpaceCall,
		itemId: string,
		input: Omit<NewVersion, "mimeType"> & { mimeType: string | null },
	): Promise<{ item: ItemRecord; version: VersionRecord } | Refusal> {
		this.enter(call);
		const found = this.open(call, itemId, "editor");
		if ("error" in found) return found;
		if (found.item.kind !== "file") return refuse("invalid", "Only a file has versions.");
		if (found.item.trash_root !== null) return refuse("invalid", IN_TRASH);
		const now = Date.now();
		const actor = JSON.stringify(call.actor);
		const mimeType = input.mimeType ?? found.item.mime_type ?? "application/octet-stream";
		this.ctx.storage.transactionSync(() => {
			this.insertVersion(itemId, { ...input, mimeType }, now, actor);
			this.sql.exec(
				"UPDATE items SET head_version_id = ?, size = ?, mime_type = ?, modified_at = ?, modified_by_json = ? WHERE id = ?",
				input.id,
				input.size,
				mimeType,
				now,
				actor,
				itemId,
			);
			// The new version and the version that was current until now always stay. A person who made an
			// old version current, and then uploads, can still go back to it.
			const keep = found.item.head_version_id === null ? 1 : 2;
			const extra = this.all<VersionRow>(
				`SELECT * FROM versions WHERE item_id = ?1 AND id != ?2 AND id IS NOT ?3
				ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?4`,
				itemId,
				input.id,
				found.item.head_version_id,
				DRIVE_LIMITS.versionsPerFile - keep,
			);
			for (const version of extra) {
				this.sql.exec("DELETE FROM versions WHERE id = ?", version.id);
				this.enqueue("blob", version.blob_key, {});
			}
			this.bump();
		});
		await this.schedule();
		const version = this.one<VersionRow>("SELECT * FROM versions WHERE id = ?", input.id) as VersionRow;
		return { item: this.recordOf(call, itemId), version: this.versionRecord(version, input.id) };
	}

	restoreVersion(
		call: SpaceCall,
		itemId: string,
		versionId: string,
	): { item: ItemRecord; version: VersionRecord } | Refusal {
		this.enter(call);
		const found = this.open(call, itemId, "editor");
		if ("error" in found) return found;
		if (found.item.kind !== "file") return refuse("invalid", "Only a file has versions.");
		if (found.item.trash_root !== null) return refuse("invalid", IN_TRASH);
		const version = this.one<VersionRow>("SELECT * FROM versions WHERE item_id = ? AND id = ?", itemId, versionId);
		if (!version) return refuse("not_found", "The file has no version with that id.");
		if (found.item.head_version_id !== versionId) {
			this.ctx.storage.transactionSync(() => {
				this.sql.exec(
					"UPDATE items SET head_version_id = ?, size = ?, mime_type = ?, modified_at = ?, modified_by_json = ? WHERE id = ?",
					versionId,
					version.size,
					version.mime_type,
					Date.now(),
					JSON.stringify(call.actor),
					itemId,
				);
				this.bump();
			});
		}
		return { item: this.recordOf(call, itemId), version: this.versionRecord(version, versionId) };
	}

	rename(call: SpaceCall, itemId: string, name: string): ItemRecord | Refusal {
		this.enter(call);
		const found = this.open(call, itemId, "editor");
		if ("error" in found) return found;
		if (found.item.trash_root !== null) return refuse("invalid", IN_TRASH);
		if (found.item.name !== name) {
			this.ctx.storage.transactionSync(() => {
				this.sql.exec(
					"UPDATE items SET name = ?, name_key = ?, modified_at = ?, modified_by_json = ? WHERE id = ?",
					name,
					nameKey(name),
					Date.now(),
					JSON.stringify(call.actor),
					itemId,
				);
				this.sql.exec("UPDATE items_fts SET name = ? WHERE rowid = ?", name, found.item.seq);
				this.bump();
			});
		}
		return this.recordOf(call, itemId);
	}

	/** Moves items into a folder, or to the root. The call moves each item or no item. */
	move(call: SpaceCall, itemIds: string[], parentId: string | null): ItemRecord[] | Refusal {
		this.enter(call);
		const refused = this.gate(call, "editor");
		if (refused) return refused;
		const ids = [...new Set(itemIds)];
		const target = this.checkCreate(call, parentId);
		if ("error" in target) return target;
		// The folders from the target up to the root. A folder cannot go into itself or under itself.
		const above = new Set(
			parentId === null ? [] : this.all<{ id: string }>(`${UP} SELECT id FROM up`, parentId).map((row) => row.id),
		);
		for (const id of ids) {
			const item = this.row(id);
			if (!item) return this.missing(call, id, `No item has the id ${id}.`);
			if (item.trash_root !== null) return refuse("invalid", `${item.name} is in the trash. Restore it first.`);
			if (this.busy(id)) return refuse("conflict", MOVING);
			if (above.has(id)) return refuse("invalid", `${item.name} cannot move into itself or into a folder under it.`);
			// The lowest folder in the moved item, counted from the item. Null when the item holds no folder and is none.
			const height = this.one<{ n: number | null }>(
				`${DOWN} SELECT MAX(down.depth) AS n FROM down JOIN items i ON i.id = down.id WHERE i.kind = 'folder'`,
				id,
			)?.n;
			const deep = height === null || height === undefined ? null : this.tooDeep(target.depth + height);
			if (deep) return deep;
		}
		this.ctx.storage.transactionSync(() => {
			let changed = false;
			for (const id of ids) {
				const moved = this.sql.exec(
					"UPDATE items SET parent_id = ?1 WHERE id = ?2 AND parent_id IS NOT ?1",
					parentId,
					id,
				).rowsWritten;
				changed ||= moved > 0;
			}
			if (changed) this.bump();
		});
		return ids.map((id) => this.recordOf(call, id));
	}

	/** Sets or removes the star of the owner of this drive, on items of this drive or of a different one. */
	star(call: SpaceCall, refs: ItemRef[], starred: boolean): { items_changed: number } | Refusal {
		this.enter(call);
		if (!this.isOwner(call)) return refuse("forbidden", OWN_DRIVE_ONLY);
		let changed = 0;
		this.ctx.storage.transactionSync(() => {
			for (const ref of refs) {
				const has =
					this.one("SELECT 1 AS found FROM stars WHERE space_id = ? AND item_id = ?", ref.spaceId, ref.itemId) !== null;
				if (has === starred) continue;
				if (starred) {
					this.sql.exec(
						"INSERT INTO stars (space_id, item_id, created_at) VALUES (?, ?, ?)",
						ref.spaceId,
						ref.itemId,
						Date.now(),
					);
				} else {
					this.sql.exec("DELETE FROM stars WHERE space_id = ? AND item_id = ?", ref.spaceId, ref.itemId);
				}
				changed++;
			}
			if (changed > 0) this.bump();
		});
		return { items_changed: changed };
	}

	/** The rows of a call, folders before the items in them. Thus the result does not depend on the order of the ids. */
	private topDown(rows: ItemRow[]): ItemRow[] {
		const level = new Map(
			rows.map((row) => [row.id, this.one<{ n: number }>(`${UP} SELECT COUNT(*) AS n FROM up`, row.id)?.n ?? 0]),
		);
		return [...rows].sort((a, b) => (level.get(a.id) ?? 0) - (level.get(b.id) ?? 0));
	}

	/** Puts items in the trash. A folder hides all that it holds. Nothing is deleted. */
	trash(call: SpaceCall, itemIds: string[], dryRun: boolean): { items_changed: number } | Refusal {
		this.enter(call);
		const refused = this.gate(call, "editor");
		if (refused) return refused;
		const ids = [...new Set(itemIds)];
		const rows: ItemRow[] = [];
		for (const id of ids) {
			const item = this.row(id);
			if (!item) return this.missing(call, id, `No item has the id ${id}.`);
			// A folder that holds an item of a move stays out of the trash until the move is complete.
			if (this.one(`${DOWN} SELECT 1 AS found FROM down JOIN transfer_items t ON t.item_id = down.id LIMIT 1`, id)) {
				return refuse("conflict", MOVING);
			}
			// An item that is in the trash, or under a folder in the trash, stays as it is.
			if (item.trash_root === null) rows.push(item);
		}
		// An item in a folder of the same call goes to the trash with that folder. It does not count.
		const selected = new Set(rows.map((row) => row.id));
		const changed = rows.filter(
			(row) =>
				!this.all<{ id: string }>(`${UP} SELECT id FROM up WHERE depth >= 1`, row.id).some((above) =>
					selected.has(above.id),
				),
		);
		if (dryRun || changed.length === 0) return { items_changed: changed.length };
		this.ctx.storage.transactionSync(() => {
			const now = Date.now();
			for (const item of changed) {
				this.sql.exec("UPDATE items SET trashed_at = ?, trash_root = id WHERE id = ?", now, item.id);
				this.sql.exec(
					`${DOWN} UPDATE items SET trash_root = ?1 WHERE trash_root IS NULL AND id IN (SELECT id FROM down)`,
					item.id,
				);
			}
			this.bump();
		});
		return { items_changed: changed.length };
	}

	/** Takes items out of the trash. An item whose folder is gone or in the trash goes to the root. */
	restore(call: SpaceCall, itemIds: string[]): { items_changed: number } | Refusal {
		this.enter(call);
		const refused = this.gate(call, "editor");
		if (refused) return refused;
		const rows: ItemRow[] = [];
		const wanted = new Set(itemIds);
		for (const id of wanted) {
			const item = this.row(id);
			if (!item) return this.missing(call, id, `No item has the id ${id}.`);
			if (this.busy(id)) return refuse("conflict", MOVING);
			// An item that went to the trash with its folder comes back with that folder.
			if (item.trash_root !== null && wanted.has(item.trash_root) && item.trash_root !== item.id) continue;
			if (item.trash_root !== null && item.trash_root !== item.id) {
				return refuse("invalid", `${item.name} is in a folder that is in the trash. Restore that folder.`);
			}
			if (item.trash_root !== null) rows.push(item);
		}
		if (rows.length === 0) return { items_changed: 0 };
		this.ctx.storage.transactionSync(() => {
			// A folder comes back before the items in it, so such an item stays in its folder.
			for (const item of this.topDown(rows)) {
				const parent = item.parent_id === null ? null : this.row(item.parent_id);
				const parentId = parent && parent.trash_root === null ? parent.id : null;
				this.sql.exec(
					"UPDATE items SET trashed_at = NULL, trash_root = NULL, parent_id = ? WHERE id = ?",
					parentId,
					item.id,
				);
				this.sql.exec("UPDATE items SET trash_root = NULL WHERE trash_root = ?", item.id);
			}
			this.bump();
		});
		return { items_changed: rows.length };
	}

	/** Deletes items that are in the trash, with all that a folder holds. This cannot be undone. */
	async remove(call: SpaceCall, itemIds: string[], dryRun: boolean): Promise<{ items_changed: number } | Refusal> {
		this.enter(call);
		const refused = this.gate(call, "manager");
		if (refused) return refused;
		const ids = [...new Set(itemIds)];
		for (const id of ids) {
			const item = this.row(id);
			if (!item) return this.missing(call, id, `No item has the id ${id}.`);
			if (this.busy(id)) return refuse("conflict", MOVING);
			if (item.trash_root !== item.id) {
				return refuse("invalid", `${item.name} is not in the trash. Move it to the trash first.`);
			}
		}
		if (dryRun) return { items_changed: ids.length };
		this.ctx.storage.transactionSync(() => {
			for (const id of ids) this.deleteTree(id);
			this.bump();
		});
		await this.schedule();
		return { items_changed: ids.length };
	}

	async emptyTrash(call: SpaceCall, dryRun: boolean): Promise<{ items_changed: number } | Refusal> {
		this.enter(call);
		const refused = this.gate(call, "manager");
		if (refused) return refused;
		const ids = this.all<{ id: string }>("SELECT id FROM items WHERE trash_root = id").map((row) => row.id);
		if (dryRun || ids.length === 0) return { items_changed: ids.length };
		return this.remove(call, ids, false);
	}

	/**
	 * Deletes an item and all that it holds, in the transaction of the caller. The bytes in R2, the
	 * content of each doc and sheet, and the pointers in other drives go away through the outbox.
	 */
	private deleteTree(itemId: string): void {
		const rows = this.all<{ seq: number; id: string; kind: ItemKind }>(
			`${DOWN} SELECT i.seq, i.id, i.kind FROM items i JOIN down ON down.id = i.id`,
			itemId,
		);
		const spaceId = this.meta("space_id") as string;
		for (const row of rows) {
			for (const version of this.all<{ blob_key: string }>("SELECT blob_key FROM versions WHERE item_id = ?", row.id)) {
				this.enqueue("blob", version.blob_key, {});
			}
			for (const grant of this.all<{ principal_id: string }>(
				"SELECT principal_id FROM permissions WHERE item_id = ?",
				row.id,
			)) {
				this.enqueue("unshare", grant.principal_id, { itemId: row.id });
			}
			if (row.kind === "doc" || row.kind === "sheet") this.enqueue("document", row.id, {});
			this.sql.exec("DELETE FROM versions WHERE item_id = ?", row.id);
			this.sql.exec("DELETE FROM permissions WHERE item_id = ?", row.id);
			this.sql.exec("DELETE FROM stars WHERE space_id = ? AND item_id = ?", spaceId, row.id);
			this.sql.exec("DELETE FROM items_fts WHERE rowid = ?", row.seq);
			this.sql.exec("DELETE FROM items WHERE id = ?", row.id);
		}
	}

	// --- Share ----------------------------------------------------------------------------------

	/** Gives a principal a role for an item. A second call for the same principal changes the role. */
	async share(
		call: SpaceCall,
		itemId: string,
		principalId: string,
		role: "editor" | "viewer",
	): Promise<PermissionRecord | Refusal> {
		this.enter(call);
		const found = this.open(call, itemId, this.top(call));
		if ("error" in found) return found;
		if (found.item.trash_root !== null) return refuse("invalid", IN_TRASH);
		if (principalId === call.spaceId) return refuse("invalid", "You own this item. It needs no grant for you.");
		const now = Date.now();
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(
				`INSERT INTO permissions (item_id, principal_id, role, granted_by_json, created_at) VALUES (?, ?, ?, ?, ?)
				ON CONFLICT (item_id, principal_id) DO UPDATE SET role = excluded.role, granted_by_json = excluded.granted_by_json`,
				itemId,
				principalId,
				role,
				JSON.stringify(call.actor),
				now,
			);
			this.enqueue("share", principalId, { itemId, role, sharedAt: now });
			this.bump();
		});
		await this.schedule();
		const row = this.one<{ granted_by_json: string | null; created_at: number }>(
			"SELECT granted_by_json, created_at FROM permissions WHERE item_id = ? AND principal_id = ?",
			itemId,
			principalId,
		);
		return {
			principal_id: principalId,
			role,
			item_id: itemId,
			inherited: false,
			granted_by: parseActor(row?.granted_by_json ?? null),
			created_at: row?.created_at ?? now,
		};
	}

	/**
	 * Removes a grant from an item. The owner of a personal drive, or a manager of a shared drive, removes
	 * each grant. A principal removes its own grant.
	 */
	async unshare(call: SpaceCall, itemId: string, principalId: string): Promise<{ removed: boolean } | Refusal> {
		this.enter(call);
		const self = call.actor.principal_id === principalId;
		const found = this.open(call, itemId, self ? "viewer" : this.top(call));
		if ("error" in found) return found;
		if (this.busy(itemId)) return refuse("conflict", MOVING);
		let removed = false;
		this.ctx.storage.transactionSync(() => {
			removed =
				this.sql.exec("DELETE FROM permissions WHERE item_id = ? AND principal_id = ?", itemId, principalId)
					.rowsWritten > 0;
			if (!removed) return;
			this.enqueue("unshare", principalId, { itemId });
			this.bump();
		});
		await this.schedule();
		return { removed };
	}

	// --- Shared drive ---------------------------------------------------------------------------

	private facts(): DriveFacts | null {
		const json = this.meta("drive");
		return json === null ? null : (JSON.parse(json) as DriveFacts);
	}

	private memberRows(): MemberRecord[] {
		return this.all<{ principal_id: string; role: SharedDriveRole; added_by_json: string | null; created_at: number }>(
			"SELECT principal_id, role, added_by_json, created_at FROM members ORDER BY created_at, principal_id",
		).map((row) => ({
			principal_id: row.principal_id,
			role: row.role,
			added_by: parseActor(row.added_by_json),
			created_at: row.created_at,
		}));
	}

	private driveRecord(call: SpaceCall, facts: DriveFacts): SharedDriveRecord {
		return {
			id: call.spaceId,
			name: facts.name,
			created_at: facts.created_at,
			role: this.memberRole(call.actor.principal_id),
			members: this.memberRows(),
		};
	}

	/**
	 * The facts of this shared drive, when the caller can do an action on its members or its name. `need`
	 * is the least that the caller must be: a member, a manager, or an admin of the organization. An
	 * admin always passes. A caller that is not a member and not an admin gets `not_found`.
	 */
	private manage(call: SpaceCall, need: "member" | "manager" | "admin"): DriveFacts | Refusal {
		const facts = isSharedDriveId(call.spaceId) ? this.facts() : null;
		if (!facts || facts.deleted_at !== null) return refuse("not_found", NO_DRIVE);
		if (call.admin === true) return facts;
		const role = this.memberRole(call.actor.principal_id);
		if (role === null) return refuse("not_found", NO_DRIVE);
		if (need === "admin") return refuse("forbidden", "Only owners and admins of the organization can do this.");
		if (need === "manager" && role !== "manager") {
			return refuse("forbidden", "Only a manager of this shared drive, an owner or an admin can do this.");
		}
		return facts;
	}

	/**
	 * The members of this drive that the directory does not have now. They do not count for the rule
	 * that a drive keeps one manager, and they do not count for the limit of the members. The read of the
	 * directory is not in the step of the change, so a member that a call adds during the read counts.
	 */
	private async goneMembers(): Promise<Set<string>> {
		const members = this.all<{ principal_id: string }>("SELECT principal_id FROM members").map(
			(row) => row.principal_id,
		);
		if (members.length === 0) return new Set();
		const { results } = await this.env.DIRECTORY.prepare(
			"SELECT p.id FROM principals p JOIN json_each(?) wanted ON wanted.value = p.id WHERE p.deleted_at IS NULL",
		)
			.bind(JSON.stringify(members))
			.all<{ id: string }>();
		const live = new Set(results.map((row) => row.id));
		return new Set(members.filter((id) => !live.has(id)));
	}

	/** The number of members that are not in `gone`. */
	private memberCount(gone: Set<string>): number {
		return this.all<{ principal_id: string }>("SELECT principal_id FROM members").filter(
			(row) => !gone.has(row.principal_id),
		).length;
	}

	/** True when the drive has a manager that is not in `gone`. */
	private hasManager(gone: Set<string>): boolean {
		return this.all<{ principal_id: string }>("SELECT principal_id FROM members WHERE role = 'manager'").some(
			(row) => !gone.has(row.principal_id),
		);
	}

	private putMember(member: MemberInput, actor: string, now: number): void {
		const changed = this.sql.exec(
			`INSERT INTO members (principal_id, role, added_by_json, created_at) VALUES (?1, ?2, ?3, ?4)
			ON CONFLICT (principal_id) DO UPDATE SET role = excluded.role WHERE role != excluded.role`,
			member.principalId,
			member.role,
			actor,
			now,
		).rowsWritten;
		if (changed > 0) this.touch(`member:${member.principalId}`);
	}

	/**
	 * The shared drive that an earlier call with the same idempotency key created in this object, or null
	 * when this object is no shared drive yet. The Worker calls this for the id of a used key before it
	 * checks the members of the retry, because the first call checked them.
	 *
	 * The first call can stop before the write to the index, or that write can fail. The rows of the index
	 * then wait for their next attempt. This call makes each row due and writes it, so a retry repairs
	 * the index.
	 */
	async createdSharedDrive(call: SpaceCall): Promise<SharedDriveRecord | Refusal | null> {
		if (!isSharedDriveId(call.spaceId)) throw new Error("the id is not the id of a shared drive");
		if (call.admin !== true) {
			return refuse("forbidden", "Only owners and admins of the organization can create a shared drive.");
		}
		this.enter(call);
		const facts = this.facts();
		if (!facts) return null;
		if (facts.deleted_at !== null) return refuse("conflict", "The shared drive of this call does not exist now.");
		this.sql.exec("UPDATE index_outbox SET next_attempt_at = ?", Date.now());
		await this.flush();
		return this.driveRecord(call, facts);
	}

	/**
	 * Makes this object a shared drive, with its first members. Only an owner or an admin of the
	 * organization can do this. A second call for the same drive changes nothing and returns the drive
	 * as it is now, so a retry of the Worker is safe.
	 */
	async createSharedDrive(
		call: SpaceCall,
		input: { name: string; members: MemberInput[] },
	): Promise<{ drive: SharedDriveRecord; duplicate: boolean } | Refusal> {
		if (!isSharedDriveId(call.spaceId)) throw new Error("the id is not the id of a shared drive");
		if (call.admin !== true) {
			return refuse("forbidden", "Only owners and admins of the organization can create a shared drive.");
		}
		const earlier = await this.createdSharedDrive(call);
		if (earlier) return "error" in earlier ? earlier : { drive: earlier, duplicate: true };
		const bad = memberRefusal(input.members, true);
		if (bad) return bad;
		const now = Date.now();
		const facts: DriveFacts = { name: input.name, created_at: now, created_by: call.actor, deleted_at: null };
		this.ctx.storage.transactionSync(() => {
			this.setMeta("drive", JSON.stringify(facts));
			const actor = JSON.stringify(call.actor);
			for (const member of input.members) this.putMember(member, actor, now);
			this.touch("drive");
			this.bump();
		});
		await this.flush();
		return { drive: this.driveRecord(call, facts), duplicate: false };
	}

	/** The shared drive and its members, for a member, an owner or an admin. */
	sharedDrive(call: SpaceCall): SharedDriveRecord | Refusal {
		this.enter(call);
		const facts = this.manage(call, "member");
		return "error" in facts ? facts : this.driveRecord(call, facts);
	}

	async renameSharedDrive(call: SpaceCall, name: string): Promise<SharedDriveRecord | Refusal> {
		this.enter(call);
		const facts = this.manage(call, "manager");
		if ("error" in facts) return facts;
		if (facts.name === name) return this.driveRecord(call, facts);
		const renamed = { ...facts, name };
		this.ctx.storage.transactionSync(() => {
			this.setMeta("drive", JSON.stringify(renamed));
			this.touch("drive");
			this.bump();
		});
		await this.flush();
		return this.driveRecord(call, renamed);
	}

	/**
	 * Gives each principal of the list a role. A principal that is a member gets the new role. The call
	 * makes each change or no change. `changed` has the principals whose role is new.
	 */
	async setMembers(
		call: SpaceCall,
		members: MemberInput[],
	): Promise<{ drive: SharedDriveRecord; changed: MemberInput[] } | Refusal> {
		this.enter(call);
		const allowed = this.manage(call, "manager");
		if ("error" in allowed) return allowed;
		const bad = memberRefusal(members, false);
		if (bad) return bad;
		const demotes = members.some(
			(member) => member.role !== "manager" && this.memberRole(member.principalId) === "manager",
		);
		const adds = members.filter((member) => this.memberRole(member.principalId) === null).length;
		const full = this.memberCount(new Set()) + adds > SHARED_DRIVE_LIMITS.members;
		// A member that the directory deleted is no manager, and does not count for the limit.
		const gone = demotes || full ? await this.goneMembers() : new Set<string>();
		// The read of the directory let other calls in. Each check from here is in one step with the change.
		const facts = this.manage(call, "manager");
		if ("error" in facts) return facts;
		const changed = members.filter((member) => this.memberRole(member.principalId) !== member.role);
		const added = changed.filter((member) => this.memberRole(member.principalId) === null).length;
		if (this.memberCount(gone) + added > SHARED_DRIVE_LIMITS.members) {
			return refuse("invalid", `A shared drive can have at most ${SHARED_DRIVE_LIMITS.members} members.`);
		}
		// The managers after the change: a new manager counts, and a manager with a lower role does not.
		const demoted = new Set(changed.filter((member) => member.role !== "manager").map((member) => member.principalId));
		if (!changed.some((member) => member.role === "manager") && !this.hasManager(new Set([...gone, ...demoted]))) {
			return refuse("invalid", LAST_MANAGER);
		}
		if (changed.length > 0) {
			this.ctx.storage.transactionSync(() => {
				const actor = JSON.stringify(call.actor);
				const now = Date.now();
				for (const member of changed) this.putMember(member, actor, now);
				this.bump();
			});
		}
		await this.flush();
		return { drive: this.driveRecord(call, facts), changed };
	}

	/**
	 * Removes a member. A manager, an owner or an admin removes each member. A member removes itself.
	 * The last manager stays.
	 */
	async removeMember(call: SpaceCall, principalId: string): Promise<{ removed: boolean } | Refusal> {
		this.enter(call);
		const self = call.actor.principal_id === principalId;
		const allowed = this.manage(call, self ? "member" : "manager");
		if ("error" in allowed) return allowed;
		const gone = this.memberRole(principalId) === "manager" ? await this.goneMembers() : new Set<string>();
		const facts = this.manage(call, self ? "member" : "manager");
		if ("error" in facts) return facts;
		const role = this.memberRole(principalId);
		if (role === null) return { removed: false };
		if (role === "manager" && !this.hasManager(new Set([...gone, principalId]))) {
			return refuse("invalid", LAST_MANAGER);
		}
		this.ctx.storage.transactionSync(() => {
			this.sql.exec("DELETE FROM members WHERE principal_id = ?", principalId);
			this.touch(`member:${principalId}`);
			this.bump();
		});
		await this.flush();
		return { removed: true };
	}

	/**
	 * Deletes this shared drive. Only an owner or an admin of the organization can do this, and only
	 * when the drive holds no item, also in its trash. The members go, and the index gets `deleted_at`.
	 * A second call changes nothing.
	 */
	async deleteSharedDrive(call: SpaceCall): Promise<{ deleted: boolean } | Refusal> {
		this.enter(call);
		const facts = isSharedDriveId(call.spaceId) ? this.facts() : null;
		if (!facts) return refuse("not_found", NO_DRIVE);
		if (call.admin !== true) {
			return refuse("forbidden", "Only owners and admins of the organization can delete a shared drive.");
		}
		if (facts.deleted_at !== null) {
			await this.flush();
			return { deleted: false };
		}
		if ((this.one<{ n: number }>("SELECT COUNT(*) AS n FROM items")?.n ?? 0) > 0) {
			return refuse(
				"invalid",
				"The shared drive holds items. Move them to a different drive, or delete them permanently, also the items in its trash.",
			);
		}
		this.ctx.storage.transactionSync(() => {
			this.setMeta("drive", JSON.stringify({ ...facts, deleted_at: Date.now() }));
			for (const member of this.memberRows()) this.touch(`member:${member.principal_id}`);
			this.sql.exec("DELETE FROM members");
			this.touch("drive");
			this.bump();
		});
		await this.flush();
		return { deleted: true };
	}

	// --- Moves between drives -------------------------------------------------------------------

	/**
	 * Checks that the caller can add items of a move to a folder of this drive, or to its root: the owner
	 * of a personal drive, or a member of a shared drive with the editor role. Returns the level of a new
	 * item there. A grant on a folder is not sufficient.
	 */
	checkImport(call: SpaceCall, parentId: string | null): { depth: number } | Refusal {
		this.enter(call);
		return this.gate(call, "editor") ?? this.checkCreate(call, parentId);
	}

	/** The checks of a move to a different drive, and its totals. Nothing changes. */
	private planMove(call: SpaceCall, input: MoveOutInput, ids: string[]): (MoveTotals & { all: string[] }) | Refusal {
		const selected = new Set(ids);
		const topIds: string[] = [];
		for (const id of ids) {
			const item = this.row(id);
			if (!item) return this.missing(call, id, `No item has the id ${id}.`);
			if (item.trash_root !== null) return refuse("invalid", `${item.name} is in the trash. Restore it first.`);
			// An item in a folder of the same call moves with that folder.
			const inside = this.all<{ id: string }>(`${UP} SELECT id FROM up WHERE depth >= 1`, id).some((above) =>
				selected.has(above.id),
			);
			if (!inside) topIds.push(id);
		}
		let count = 0;
		for (const id of topIds) {
			count += this.one<{ n: number }>(`${DOWN} SELECT COUNT(*) AS n FROM down`, id)?.n ?? 0;
			if (count > SHARED_DRIVE_LIMITS.moveItems) {
				return refuse(
					"invalid",
					`One move can have at most ${SHARED_DRIVE_LIMITS.moveItems} items, with the items in each folder. Move fewer items in each call.`,
				);
			}
			const height = this.one<{ n: number | null }>(
				`${DOWN} SELECT MAX(down.depth) AS n FROM down JOIN items i ON i.id = down.id WHERE i.kind = 'folder'`,
				id,
			)?.n;
			const deep = height === null || height === undefined ? null : this.tooDeep(input.targetDepth + height);
			if (deep) return deep;
		}
		const all = topIds.flatMap((id) =>
			this.all<{ id: string }>(`${DOWN} SELECT id FROM down`, id).map((row) => row.id),
		);
		const list = JSON.stringify(all);
		if (
			this.one("SELECT 1 AS found FROM transfer_items WHERE item_id IN (SELECT value FROM json_each(?)) LIMIT 1", list)
		) {
			return refuse("conflict", MOVING);
		}
		const bytes =
			(this.one<{ n: number }>(
				"SELECT COALESCE(SUM(size), 0) AS n FROM versions WHERE item_id IN (SELECT value FROM json_each(?))",
				list,
			)?.n ?? 0) +
			(this.one<{ n: number }>(
				"SELECT COALESCE(SUM(size), 0) AS n FROM items WHERE kind IN ('doc', 'sheet') AND id IN (SELECT value FROM json_each(?))",
				list,
			)?.n ?? 0);
		// The owner of a personal drive needs no grant, so a grant for the owner of the target goes away.
		const keptShares = this.all<{ principal_id: string }>(
			`SELECT DISTINCT principal_id FROM permissions
			WHERE item_id IN (SELECT value FROM json_each(?1)) AND principal_id != ?2 ORDER BY principal_id`,
			list,
			input.targetId,
		).map((row) => row.principal_id);
		return { itemsTotal: all.length, bytes, keptShares, topIds, all };
	}

	/**
	 * Moves items, with all that they hold, to a different drive. Only the owner of a personal drive, or
	 * a manager of a shared drive, can do this. The Worker checked the target drive. This call locks the
	 * items and records the move in one step. Then it runs the steps of the move until they are complete
	 * or the time budget ends. The alarm continues a move that is not complete.
	 *
	 * A second call with the same input, while the move runs, joins that move.
	 */
	async moveOut(call: SpaceCall, input: MoveOutInput): Promise<MoveOutResult | Refusal> {
		this.enter(call);
		const refused = this.gate(call, "manager");
		if (refused) return refused;
		const ids = [...new Set(input.itemIds)].sort();
		const key = JSON.stringify(ids);
		let transferId: string;
		let totals: MoveTotals;
		const running = this.one<TransferRow>(
			"SELECT * FROM transfers WHERE item_ids = ? AND target = ? AND parent_id IS ?",
			key,
			input.targetId,
			input.parentId,
		);
		if (running) {
			totals = JSON.parse(running.totals_json) as MoveTotals;
			if (input.dryRun) return { status: "dry_run", ...totals };
			transferId = running.id;
		} else {
			const plan = this.planMove(call, input, ids);
			if ("error" in plan) return plan;
			const { all, ...rest } = plan;
			totals = rest;
			if (input.dryRun) return { status: "dry_run", ...totals };
			transferId = crypto.randomUUID();
			const now = Date.now();
			const top = new Set(totals.topIds);
			this.ctx.storage.transactionSync(() => {
				this.sql.exec(
					`INSERT INTO transfers (id, target, parent_id, item_ids, actor_json, totals_json, state, created_at, next_attempt_at)
					VALUES (?, ?, ?, ?, ?, ?, 'stage', ?, ?)`,
					transferId,
					input.targetId,
					input.parentId,
					key,
					JSON.stringify(call.actor),
					JSON.stringify(totals),
					now,
					now,
				);
				for (const id of all) {
					this.sql.exec(
						"INSERT INTO transfer_items (item_id, transfer_id, top) VALUES (?, ?, ?)",
						id,
						transferId,
						top.has(id) ? 1 : 0,
					);
				}
				this.bump();
			});
			// One audit line for each move that started. This object writes it, because the alarm completes
			// the move when the call of the Worker stops. A call that joins a move writes no line.
			audit({
				op: "drive.move_to_drive",
				actor: call.actor.principal_id,
				actorKind: call.actor.kind,
				credential: input.credential,
				target: `${call.spaceId}>${input.targetId}:${ids.join(",")}`,
				...(call.spaceId === call.actor.principal_id ? {} : { space: call.spaceId }),
				result: "ok",
				requestId: input.requestId,
			});
			// The alarm comes first. If the object stops during the steps, the alarm continues the move.
			const set = await this.ctx.storage.getAlarm();
			const guard = now + ALARM_GUARD_MS;
			if (set === null || set > guard) await this.ctx.storage.setAlarm(guard);
		}
		const outcome = await this.settle(transferId, input.targetId, totals.topIds);
		await this.schedule();
		await this.scheduleTransfers();
		if (typeof outcome !== "string") return outcome;
		return { status: outcome, ...totals };
	}

	/** One run of the moves. A second caller gets the run that is in progress, with the budget of that run. */
	private runMoves(budget: MoveBudget): Promise<Map<string, "done" | Refusal>> {
		this.moveTask ??= this.advanceAll(budget).finally(() => {
			this.moveTask = null;
		});
		return this.moveTask;
	}

	/**
	 * Runs the moves until one move is complete, is stopped, must wait, or the budget of the call ends.
	 * The call has one budget of time and of calls for all its runs. The alarm continues the move after it.
	 */
	private async settle(transferId: string, targetId: string, topIds: string[]): Promise<"done" | "moving" | Refusal> {
		const budget: MoveBudget = { deadline: Date.now() + MOVE_BUDGET_MS, calls: 0 };
		for (;;) {
			const outcome = (await this.runMoves(budget)).get(transferId);
			if (outcome) return outcome;
			const row = this.one<{ next_attempt_at: number }>(
				"SELECT next_attempt_at FROM transfers WHERE id = ?",
				transferId,
			);
			if (!row) {
				// A run that this call did not wait for ended the move. The move is complete only when each
				// selected item has the record that it went to the target.
				const moved = this.one<{ n: number }>(
					"SELECT COUNT(*) AS n FROM moved WHERE target = ?1 AND item_id IN (SELECT value FROM json_each(?2))",
					targetId,
					JSON.stringify(topIds),
				)?.n;
				return moved === topIds.length ? "done" : refuse("conflict", NOT_COMPLETE);
			}
			if (row.next_attempt_at > Date.now() || Date.now() >= budget.deadline || budget.calls >= MOVE_CALLS) {
				return "moving";
			}
		}
	}

	/**
	 * Continues each move that is due, the oldest first. A step that fails waits for its next attempt
	 * (1 minute, doubled, at most 1 hour). Before the target has the items, a move that fails 8 times is
	 * stopped: the items stay in this drive. After that point, the move is tried until it is complete.
	 */
	private async advanceAll(budget: MoveBudget): Promise<Map<string, "done" | Refusal>> {
		const outcomes = new Map<string, "done" | Refusal>();
		for (;;) {
			const row = this.one<TransferRow>(
				"SELECT * FROM transfers WHERE next_attempt_at <= ? ORDER BY created_at, id LIMIT 1",
				Date.now(),
			);
			if (!row) break;
			try {
				const outcome = await this.advance(row, budget);
				if (outcome === "more") break;
				outcomes.set(row.id, outcome);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const now = this.one<TransferRow>("SELECT * FROM transfers WHERE id = ?", row.id);
				if (!now) continue;
				const attempts = now.attempts + 1;
				const early = now.state === "stage" || now.state === "copy";
				log(early && attempts >= MOVE_MAX_ATTEMPTS ? "error" : "warn", "drive move step failed", {
					state: now.state,
					attempts,
					error: message,
				});
				if (early && attempts >= MOVE_MAX_ATTEMPTS) {
					this.abandon(now);
					outcomes.set(row.id, refuse("conflict", NOT_COMPLETE));
					continue;
				}
				this.sql.exec(
					"UPDATE transfers SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?",
					attempts,
					Date.now() + backoff(attempts),
					message.slice(0, 500),
					row.id,
				);
			}
		}
		return outcomes;
	}

	/**
	 * The steps of one move, from the state of its row. Each step is safe to run again:
	 *
	 * 1. `stage`: sends the items to the target drive, which holds them apart from its own items.
	 * 2. `copy`: copies the bytes of each version to its key in the target.
	 * 3. `commit`: the target makes the items its own, in one step, or refuses the move.
	 * 4. `refresh`: sends the current state of each doc and sheet, for a write that came during the move.
	 * 5. `finish`: deletes the items here, and records where they went.
	 *
	 * Returns `more` when the budget of the run ends before the move.
	 */
	private async advance(row: TransferRow, budget: MoveBudget): Promise<"done" | "more" | Refusal> {
		const target = this.env.DRIVE_SPACE.get(this.env.DRIVE_SPACE.idFromName(row.target));
		const targetCall: SpaceCall = { spaceId: row.target, actor: JSON.parse(row.actor_json) as ActorRecord };
		let state = row.state;
		let cursor = row.cursor;
		const spent = () => Date.now() >= budget.deadline || budget.calls >= MOVE_CALLS;
		const next = (nextState: TransferRow["state"], nextCursor: string) => {
			// A step that makes progress starts the count of failures again.
			this.sql.exec(
				"UPDATE transfers SET state = ?, cursor = ?, attempts = 0 WHERE id = ?",
				nextState,
				nextCursor,
				row.id,
			);
			state = nextState;
			cursor = nextCursor;
		};

		while (state === "stage") {
			if (spent()) return "more";
			const items = this.all<ItemRow>(
				`SELECT ${ITEM_COLUMNS} FROM items i JOIN transfer_items t ON t.item_id = i.id
				WHERE t.transfer_id = ? AND i.seq > ? ORDER BY i.seq LIMIT ?`,
				row.id,
				Number(cursor || 0),
				STAGE_BATCH,
			);
			// One part has at most STAGE_BYTES, and at least one item.
			const part: StagedItem[] = [];
			let bytes = 0;
			let last = 0;
			for (const item of items) {
				const staged = this.staged(item);
				bytes += new TextEncoder().encode(JSON.stringify(staged)).byteLength;
				if (part.length > 0 && bytes > STAGE_BYTES) break;
				part.push(staged);
				last = item.seq;
			}
			const first = items[0];
			if (!first) {
				next("copy", "");
				break;
			}
			budget.calls++;
			const answer = await target.stageImport(targetCall, { transferId: row.id, seq: first.seq, items: part });
			if ("error" in answer) return this.abandon(row, answer);
			next("stage", String(last));
		}

		while (state === "copy") {
			const versions = this.all<{ id: string; item_id: string; blob_key: string }>(
				`SELECT v.id, v.item_id, v.blob_key FROM versions v JOIN transfer_items t ON t.item_id = v.item_id
				WHERE t.transfer_id = ? AND v.id > ? ORDER BY v.id LIMIT 20`,
				row.id,
				cursor,
			);
			if (versions.length === 0) next("commit", "");
			for (const version of versions) {
				if (spent()) return "more";
				budget.calls += 2;
				const object = await this.env.BLOBS.get(version.blob_key);
				if (object) {
					await this.env.BLOBS.put(blobKeyFor(row.target, version.item_id, version.id), object.body, STORED_TYPE);
				} else {
					// The version has no bytes in this drive. The move cannot repair that, and does not stop for it.
					log("error", "drive move found a version without bytes", { key: version.blob_key });
				}
				next("copy", version.id);
			}
		}

		if (state === "commit") {
			if (spent()) return "more";
			budget.calls++;
			const answer = await target.commitImport(targetCall, {
				transferId: row.id,
				parentId: row.parent_id,
				itemsTotal: (JSON.parse(row.totals_json) as MoveTotals).itemsTotal,
			});
			if ("error" in answer) return this.abandon(row, answer);
			next("refresh", "");
		}

		while (state === "refresh") {
			const docs = this.all<{ id: string }>(
				`SELECT i.id FROM items i JOIN transfer_items t ON t.item_id = i.id
				WHERE t.transfer_id = ? AND i.kind IN ('doc', 'sheet') AND i.content_revision > 0 AND i.id > ?
				ORDER BY i.id LIMIT 20`,
				row.id,
				cursor,
			);
			if (docs.length === 0) next("finish", "");
			for (const doc of docs) {
				if (spent()) return "more";
				// The row as it is now, with the text for the search index. The staged items have no text.
				const item = this.row(doc.id);
				const author = parseActor(item?.modified_by_json ?? null);
				if (item && author) {
					budget.calls++;
					await target.refreshImport({
						itemId: item.id,
						revision: item.content_revision,
						modifiedAt: item.modified_at,
						modifiedBy: author,
						size: item.size,
						text: this.textOf(item.seq),
					});
				}
				next("refresh", doc.id);
			}
		}

		this.finish(row);
		return "done";
	}

	private textOf(seq: number): string {
		return this.one<{ content: string }>("SELECT content FROM items_fts WHERE rowid = ?", seq)?.content ?? "";
	}

	/**
	 * One item of a move, with its versions and its grants, for the target drive. The text of a doc or a
	 * sheet is not here, because it can be large. The `refresh` step sends it.
	 */
	private staged(item: ItemRow): StagedItem {
		return {
			id: item.id,
			top: this.one<{ top: number }>("SELECT top FROM transfer_items WHERE item_id = ?", item.id)?.top === 1,
			parent_id: item.parent_id,
			kind: item.kind,
			name: item.name,
			mime_type: item.mime_type,
			size: item.size,
			head_version_id: item.head_version_id,
			content_revision: item.content_revision,
			created_at: item.created_at,
			modified_at: item.modified_at,
			modified_by_json: item.modified_by_json,
			trashed_at: item.trashed_at,
			trash_root: item.trash_root,
			versions: this.all<StagedItem["versions"][number] & Row>(
				"SELECT id, size, mime_type, sha256, created_at, created_by_json FROM versions WHERE item_id = ? ORDER BY created_at, id",
				item.id,
			),
			grants: this.all<StagedItem["grants"][number] & Row>(
				"SELECT principal_id, role, granted_by_json, created_at FROM permissions WHERE item_id = ?",
				item.id,
			),
		};
	}

	/**
	 * Stops a move that the target refused, or that failed too many times before the target had the
	 * items. The items stay in this drive and accept changes again. The staged items and the copies in the
	 * target have no owner. The target drive owns the deletes of its keys, so this drive only tells the
	 * target, through the outbox (`cancelImport`).
	 */
	private abandon(row: TransferRow, refusal?: Refusal): Refusal {
		this.ctx.storage.transactionSync(() => {
			if (this.one("SELECT 1 AS found FROM transfers WHERE id = ?", row.id)) {
				this.enqueue("cancel", row.target, { transferId: row.id });
			}
			this.sql.exec("DELETE FROM transfer_items WHERE transfer_id = ?", row.id);
			this.sql.exec("DELETE FROM transfers WHERE id = ?", row.id);
			this.bump();
		});
		log("warn", "drive move stopped", { target: row.target, reason: refusal?.error.message ?? "too many failures" });
		return refusal ?? refuse("conflict", NOT_COMPLETE);
	}

	/**
	 * The last step of a move, in one transaction. The target has the items, so this drive deletes its
	 * rows and records where each item went. The old bytes go away through the outbox. Each principal
	 * with a grant in the moved items gets a notice that moves its pointers to the new drive.
	 */
	private finish(row: TransferRow): void {
		const spaceId = this.meta("space_id") as string;
		const actor = JSON.parse(row.actor_json) as ActorRecord;
		const now = Date.now();
		this.ctx.storage.transactionSync(() => {
			const itemIds = this.all<{ item_id: string }>(
				"SELECT item_id FROM transfer_items WHERE transfer_id = ? ORDER BY item_id",
				row.id,
			).map((item) => item.item_id);
			const list = JSON.stringify(itemIds);
			const inList = "(SELECT value FROM json_each(?1))";
			for (const version of this.all<{ blob_key: string }>(
				`SELECT blob_key FROM versions WHERE item_id IN ${inList}`,
				list,
			)) {
				this.enqueue("blob", version.blob_key, {});
			}
			const notified = new Set(
				this.all<{ principal_id: string }>(
					`SELECT DISTINCT principal_id FROM permissions WHERE item_id IN ${inList}`,
					list,
				).map((grant) => grant.principal_id),
			);
			// In a shared drive, the stars of the person who moves the items are in the drive of that person.
			if (actor.principal_id !== spaceId) notified.add(actor.principal_id);
			this.sql.exec(`DELETE FROM versions WHERE item_id IN ${inList}`, list);
			this.sql.exec(`DELETE FROM permissions WHERE item_id IN ${inList}`, list);
			this.sql.exec(`DELETE FROM items_fts WHERE rowid IN (SELECT seq FROM items WHERE id IN ${inList})`, list);
			this.sql.exec(`DELETE FROM items WHERE id IN ${inList}`, list);
			this.sql.exec(
				`INSERT INTO moved (item_id, target, moved_at) SELECT value, ?2, ?3 FROM json_each(?1) WHERE true
				ON CONFLICT (item_id) DO UPDATE SET target = excluded.target, moved_at = excluded.moved_at`,
				list,
				row.target,
				now,
			);
			// The stars of the owner of a personal drive are in this drive.
			this.repoint("stars", spaceId, row.target, list);
			for (const principalId of notified) this.enqueue("moved", principalId, { to: row.target, itemIds });
			this.sql.exec("DELETE FROM transfer_items WHERE transfer_id = ?", row.id);
			this.sql.exec("DELETE FROM transfers WHERE id = ?", row.id);
			this.forget(now);
			this.bump();
		});
	}

	/**
	 * Deletes the records of moves that are older than 30 days. A staged item of that age is from a move
	 * that stopped, and the notice of the source did not arrive. The copies of its bytes go away through
	 * the outbox (`dropStaged`).
	 */
	private forget(now: number): void {
		const before = now - MOVED_TTL_MS;
		this.sql.exec("DELETE FROM moved WHERE moved_at < ?", before);
		for (const old of this.all<{ transfer_id: string }>(
			"SELECT DISTINCT transfer_id FROM imports WHERE seq >= 0 AND created_at < ?",
			before,
		)) {
			this.dropStaged(old.transfer_id);
		}
		this.sql.exec("DELETE FROM imports WHERE created_at < ?", before);
	}

	/** Changes the drive of the pointers to moved items. A pointer that the new drive has stays as it is. */
	private repoint(table: "stars" | "shared_with_me", from: string, to: string, itemList: string): number {
		const columns = table === "stars" ? "item_id, created_at" : "item_id, role, shared_at";
		const copied = this.sql.exec(
			`INSERT OR IGNORE INTO ${table} (space_id, ${columns})
			SELECT ?2, ${columns} FROM ${table} WHERE space_id = ?1 AND item_id IN (SELECT value FROM json_each(?3))`,
			from,
			to,
			itemList,
		).rowsWritten;
		const removed = this.sql.exec(
			`DELETE FROM ${table} WHERE space_id = ?1 AND item_id IN (SELECT value FROM json_each(?2))`,
			from,
			itemList,
		).rowsWritten;
		return copied + removed;
	}

	/** Moves the alarm to the next attempt of a move, when that is before the alarm. */
	private async scheduleTransfers(): Promise<void> {
		const next = this.one<{ at: number | null }>("SELECT MIN(next_attempt_at) AS at FROM transfers")?.at ?? null;
		if (next === null) return;
		const set = await this.ctx.storage.getAlarm();
		if (set === null || set > next) await this.ctx.storage.setAlarm(Math.max(next, Date.now()));
	}

	/**
	 * From a source drive: one part of the items of a move. This drive holds them apart from its own
	 * items until `commitImport`. A second call with the same part replaces it. The caller of the move
	 * must be able to add items here.
	 */
	async stageImport(
		call: SpaceCall,
		input: { transferId: string; seq: number; items: StagedItem[] },
	): Promise<{ staged: number } | Refusal> {
		this.enter(call);
		// The move committed, and this call is a late repeat. The record of the commit must stay.
		if (this.one("SELECT 1 AS found FROM imports WHERE transfer_id = ? AND seq = -1", input.transferId)) {
			return { staged: 0 };
		}
		const refused = this.gate(call, "editor");
		if (refused) {
			// The source stops the move. A late repeat of this call can arrive after the source copied bytes,
			// so this drive also deletes the copies.
			this.ctx.storage.transactionSync(() => this.dropStaged(input.transferId));
			await this.schedule();
			return refused;
		}
		// A delete of a key of these versions can wait in the outbox, from the time that the item left
		// this drive, or from a move that was stopped. The source copies the bytes to that key after this
		// call, so the delete must not run.
		const keys = input.items.flatMap((item) =>
			item.versions.map((version) => blobKeyFor(call.spaceId, item.id, version.id)),
		);
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(
				`INSERT INTO imports (transfer_id, seq, payload, created_at) VALUES (?, ?, ?, ?)
				ON CONFLICT (transfer_id, seq) DO UPDATE SET payload = excluded.payload`,
				input.transferId,
				input.seq,
				JSON.stringify(input.items),
				Date.now(),
			);
			this.sql.exec(
				"DELETE FROM outbox WHERE kind = 'blob' AND target IN (SELECT value FROM json_each(?))",
				JSON.stringify(keys),
			);
		});
		await this.deletesDone(keys);
		return { staged: input.items.length };
	}

	/** Waits for the R2 deletes of these keys that are in progress. */
	private async deletesDone(keys: string[]): Promise<void> {
		await Promise.all(keys.map((key) => this.deleting.get(key)?.catch(() => undefined)));
	}

	/**
	 * Deletes the staged items of a move that did not commit, in the transaction of the caller. The source
	 * can have copied bytes to the keys of this drive for them. This drive owns the deletes of its keys,
	 * so they go into its outbox, where a later move of the same item finds them (`stageImport`).
	 *
	 * A key stays when a version of this drive has it, or when a different move staged its version: that
	 * version owns the key. Each other key of a staged item goes, also when this drive holds the item.
	 */
	private dropStaged(transferId: string): void {
		const spaceId = this.meta("space_id");
		if (spaceId === null) return;
		const parts = this.all<{ payload: string }>(
			"SELECT payload FROM imports WHERE transfer_id = ? AND seq >= 0 ORDER BY seq",
			transferId,
		);
		for (const part of parts) {
			for (const item of JSON.parse(part.payload) as StagedItem[]) {
				if (item.versions.length === 0) continue;
				const kept = new Set(
					this.all<{ id: string }>(
						`SELECT id FROM versions WHERE item_id = ?2
						UNION
						SELECT json_extract(version.value, '$.id') FROM imports i, json_each(i.payload) staged,
							json_each(staged.value, '$.versions') version
						WHERE i.transfer_id != ?1 AND i.seq >= 0 AND json_extract(staged.value, '$.id') = ?2`,
						transferId,
						item.id,
					).map((version) => version.id),
				);
				for (const version of item.versions) {
					if (!kept.has(version.id)) this.enqueue("blob", blobKeyFor(spaceId, item.id, version.id), {});
				}
			}
		}
		this.sql.exec("DELETE FROM imports WHERE transfer_id = ? AND seq >= 0", transferId);
	}

	/**
	 * From the outbox of a source drive: the source stopped a move before this drive committed it. This
	 * drive deletes the staged items and the copies of their bytes. A second call changes nothing. A call
	 * for a move that committed changes nothing.
	 */
	async cancelImport(input: { transferId: string }): Promise<void> {
		if (this.one("SELECT 1 AS found FROM imports WHERE transfer_id = ? AND seq = -1", input.transferId)) return;
		this.ctx.storage.transactionSync(() => this.dropStaged(input.transferId));
		await this.schedule();
	}

	/**
	 * From a source drive: makes the staged items of a move the items of this drive, in one transaction.
	 * The selected items go into the folder `parentId`. Each grant stays, and its principal gets a
	 * pointer through the outbox. A refusal deletes the staged items and the copies of their bytes, and
	 * changes nothing more. A second call after a commit changes nothing. `itemsTotal` is the number of
	 * items that the source sent: with fewer staged items, this drive refuses the move.
	 */
	async commitImport(
		call: SpaceCall,
		input: { transferId: string; parentId: string | null; itemsTotal: number },
	): Promise<{ items: number } | Refusal> {
		this.enter(call);
		if (this.one("SELECT 1 AS found FROM imports WHERE transfer_id = ? AND seq = -1", input.transferId)) {
			return { items: 0 };
		}
		const batches = this.all<{ payload: string }>(
			"SELECT payload FROM imports WHERE transfer_id = ? AND seq >= 0 ORDER BY seq",
			input.transferId,
		);
		const place = this.checkImport(call, input.parentId);
		const staged = batches.reduce((sum, batch) => sum + (JSON.parse(batch.payload) as StagedItem[]).length, 0);
		let refusal: Refusal | null =
			"error" in place
				? place
				: staged !== input.itemsTotal
					? refuse("conflict", "The target drive does not have each item of the move. Try again.")
					: null;
		let count = 0;
		if (!refusal && !("error" in place)) {
			const now = Date.now();
			try {
				this.ctx.storage.transactionSync(() => {
					const tops: string[] = [];
					for (const batch of batches) {
						for (const item of JSON.parse(batch.payload) as StagedItem[]) {
							if (this.row(item.id)) {
								refusal = refuse("conflict", `The target drive already holds the item ${item.id}.`);
								throw new Error("import refused");
							}
							this.importItem(call.spaceId, item, input.parentId);
							if (item.top) tops.push(item.id);
							count++;
						}
					}
					for (const id of tops) {
						const height = this.one<{ n: number | null }>(
							`${DOWN} SELECT MAX(down.depth) AS n FROM down JOIN items i ON i.id = down.id WHERE i.kind = 'folder'`,
							id,
						)?.n;
						refusal = height === null || height === undefined ? null : this.tooDeep(place.depth + height);
						if (refusal) throw new Error("import refused");
					}
					this.sql.exec("DELETE FROM imports WHERE transfer_id = ?", input.transferId);
					this.sql.exec(
						"INSERT INTO imports (transfer_id, seq, payload, created_at) VALUES (?, -1, '', ?)",
						input.transferId,
						now,
					);
					this.forget(now);
					this.bump();
				});
			} catch (error) {
				if (!refusal) throw error;
			}
		}
		if (refusal) this.ctx.storage.transactionSync(() => this.dropStaged(input.transferId));
		await this.schedule();
		return refusal ?? { items: count };
	}

	/** Stores one item of a move in this drive, in the transaction of the caller. */
	private importItem(spaceId: string, item: StagedItem, parentId: string | null): void {
		const seq = this.one<{ seq: number }>(
			`INSERT INTO items (id, parent_id, kind, name, name_key, mime_type, size, head_version_id, content_revision,
				created_at, modified_at, modified_by_json, trashed_at, trash_root)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
			item.id,
			item.top ? parentId : item.parent_id,
			item.kind,
			item.name,
			nameKey(item.name),
			item.mime_type,
			item.size,
			item.head_version_id,
			item.content_revision,
			item.created_at,
			item.modified_at,
			item.modified_by_json,
			item.trashed_at,
			item.trash_root,
		)?.seq as number;
		// The text of a doc or a sheet comes after the commit, with the `refresh` step of the source.
		this.sql.exec("INSERT INTO items_fts (rowid, name, content) VALUES (?, ?, '')", seq, item.name);
		for (const version of item.versions) {
			this.sql.exec(
				"INSERT INTO versions (id, item_id, blob_key, size, mime_type, sha256, created_at, created_by_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				version.id,
				item.id,
				blobKeyFor(spaceId, item.id, version.id),
				version.size,
				version.mime_type,
				version.sha256,
				version.created_at,
				version.created_by_json,
			);
		}
		for (const grant of item.grants) {
			// The owner of a personal drive needs no grant.
			if (grant.principal_id === spaceId) continue;
			this.sql.exec(
				"INSERT INTO permissions (item_id, principal_id, role, granted_by_json, created_at) VALUES (?, ?, ?, ?, ?)",
				item.id,
				grant.principal_id,
				grant.role,
				grant.granted_by_json,
				grant.created_at,
			);
			this.enqueue("share", grant.principal_id, { itemId: item.id, role: grant.role, sharedAt: grant.created_at });
		}
		// The item is here again. The record that it moved away is not correct now.
		this.sql.exec("DELETE FROM moved WHERE item_id = ?", item.id);
	}

	// --- The index in D1 ------------------------------------------------------------------------

	/** Records that a row of the index is behind. `gen` shows a change that came during a write. */
	private touch(target: string): void {
		this.sql.exec(
			`INSERT INTO index_outbox (target, gen, next_attempt_at) VALUES (?, 1, ?)
			ON CONFLICT (target) DO UPDATE SET gen = gen + 1, attempts = 0, next_attempt_at = excluded.next_attempt_at`,
			target,
			Date.now(),
		);
	}

	/** Moves the alarm to the first row of the index that waits, when that is before the alarm. */
	private async scheduleIndex(): Promise<void> {
		const next = this.one<{ at: number | null }>("SELECT MIN(next_attempt_at) AS at FROM index_outbox")?.at ?? null;
		if (next === null) return;
		const set = await this.ctx.storage.getAlarm();
		if (set === null || set > next) await this.ctx.storage.setAlarm(Math.max(next, Date.now()));
	}

	/**
	 * Writes the rows that are behind to the index, after each write that started before. The caller
	 * waits for it, so a list that comes after a change has that change. A failure does not fail the
	 * change: the alarm tries the write again.
	 */
	private async flush(): Promise<void> {
		// No row is due: each row waits for its next attempt, and the alarm of that attempt is set. A write
		// in progress set its own alarm.
		if (!this.one("SELECT 1 AS found FROM index_outbox WHERE next_attempt_at <= ? LIMIT 1", Date.now())) {
			return this.flushed;
		}
		// The alarm comes first. If the object stops during the write, the alarm does the write later.
		const set = await this.ctx.storage.getAlarm();
		const guard = Date.now() + ALARM_GUARD_MS;
		if (set === null || set > guard) await this.ctx.storage.setAlarm(guard);
		const run = this.flushed.then(() => this.writeIndex());
		this.flushed = run.catch((error: unknown) => {
			log("error", "drive index write failed", { error: error instanceof Error ? error.message : String(error) });
		});
		return this.flushed;
	}

	/**
	 * Each write holds the state at the time of the write, not at the time of the change. So a write is
	 * safe to run two times, the order of two writes does not matter, and a row never goes out of use:
	 * a write that fails is tried again until it succeeds (1 minute, doubled, at most 1 hour).
	 */
	private async writeIndex(): Promise<void> {
		for (let round = 0; round < INDEX_ROUNDS; round++) {
			const facts = this.facts();
			const spaceId = this.meta("space_id");
			if (!facts || spaceId === null) return;
			const rows = this.all<IndexRow>(
				"SELECT target, gen, attempts FROM index_outbox WHERE next_attempt_at <= ? ORDER BY target LIMIT ?",
				Date.now(),
				INDEX_BATCH,
			);
			if (rows.length === 0) break;
			try {
				await this.env.DIRECTORY.batch(rows.map((row) => this.indexStatement(spaceId, facts, row.target)));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log("warn", "drive index write failed", { rows: rows.length, error: message });
				for (const row of rows) {
					const attempts = row.attempts + 1;
					this.sql.exec(
						"UPDATE index_outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE target = ? AND gen = ?",
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
			for (const row of rows) {
				this.sql.exec("DELETE FROM index_outbox WHERE target = ? AND gen = ?", row.target, row.gen);
			}
		}
		await this.scheduleIndex();
	}

	/**
	 * The statement that brings one row of the index to the current state. A row is written only while
	 * the directory has its principal: the creator for the drive, the member for a member. After a
	 * fresh start of the directory, the drives from before have no such principal, so they stay out of
	 * the new index.
	 */
	private indexStatement(spaceId: string, facts: DriveFacts, target: string): D1PreparedStatement {
		const db = this.env.DIRECTORY;
		if (target === "drive") {
			return db
				.prepare(
					`INSERT INTO shared_drives (id, name, name_key, created_by, created_at, deleted_at)
					SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM principals WHERE id = ?4)
					ON CONFLICT (id) DO UPDATE SET name = excluded.name, name_key = excluded.name_key,
						deleted_at = excluded.deleted_at`,
				)
				.bind(
					spaceId,
					facts.name,
					nameKey(facts.name),
					facts.created_by.principal_id,
					facts.created_at,
					facts.deleted_at,
				);
		}
		const principalId = target.slice("member:".length);
		const role = this.memberRole(principalId);
		if (role === null) {
			return db
				.prepare("DELETE FROM shared_drive_members WHERE drive_id = ? AND principal_id = ?")
				.bind(spaceId, principalId);
		}
		return db
			.prepare(
				`INSERT INTO shared_drive_members (drive_id, principal_id, role)
				SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM principals WHERE id = ?2)
				ON CONFLICT (drive_id, principal_id) DO UPDATE SET role = excluded.role`,
			)
			.bind(spaceId, principalId, role);
	}

	// --- Calls from other objects ---------------------------------------------------------------

	/** From the outbox of a different drive: its owner shared an item with the owner of this drive. */
	applyShare(input: { spaceId: string; itemId: string; role: string; sharedAt: number }): void {
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(
				`INSERT INTO shared_with_me (space_id, item_id, role, shared_at) VALUES (?, ?, ?, ?)
				ON CONFLICT (space_id, item_id) DO UPDATE SET role = excluded.role`,
				input.spaceId,
				input.itemId,
				input.role,
				input.sharedAt,
			);
			this.bump();
		});
	}

	/** From the outbox of a different drive: the grant, or the item, is gone. */
	removeShare(input: { spaceId: string; itemId: string }): void {
		this.ctx.storage.transactionSync(() => {
			const removed = this.sql.exec(
				"DELETE FROM shared_with_me WHERE space_id = ? AND item_id = ?",
				input.spaceId,
				input.itemId,
			).rowsWritten;
			if (removed > 0) this.bump();
		});
	}

	/**
	 * From the outbox of a different drive: items left the drive `from`. Each entry of `moves` has the
	 * drive that holds its items now. The stars and the shared pointers of the owner of this drive for
	 * the items go from `from` to that drive. A pointer that is not at `from` does not change, so a
	 * second call changes nothing.
	 */
	applyMoved(input: { principalId: string; from: string; moves: { to: string; itemIds: string[] }[] }): void {
		this.ctx.storage.transactionSync(() => {
			let changed = 0;
			for (const move of input.moves) {
				// The items are in the drive `from` again. Its pointers are correct.
				if (move.to === input.from) continue;
				const list = JSON.stringify(move.itemIds);
				changed += this.repoint("stars", input.from, move.to, list);
				if (move.to === input.principalId) {
					// The items are in the own drive of this principal now. An own item has no shared pointer.
					changed += this.sql.exec(
						"DELETE FROM shared_with_me WHERE space_id = ?1 AND item_id IN (SELECT value FROM json_each(?2))",
						input.from,
						list,
					).rowsWritten;
				} else {
					changed += this.repoint("shared_with_me", input.from, move.to, list);
				}
			}
			if (changed > 0) this.bump();
		});
	}

	/**
	 * From a different drive: the next drive of each of these items that left this drive (the `moved`
	 * records, kept 30 days). An item that this drive holds, or that has no record, is not in the answer.
	 */
	movedOn(itemIds: string[]): Record<string, string> {
		const rows = this.all<{ item_id: string; target: string }>(
			`SELECT m.item_id, m.target FROM moved m WHERE m.item_id IN (SELECT value FROM json_each(?))
				AND NOT EXISTS (SELECT 1 FROM items i WHERE i.id = m.item_id)`,
			JSON.stringify(itemIds),
		);
		return Object.fromEntries(rows.map((row) => [row.item_id, row.target]));
	}

	/**
	 * The drive that holds each item now, as a map from a drive to its items. The search starts at the
	 * drive `start` and follows the `moved` records from one drive to the next. It stops at a drive that
	 * holds the item or has no record of it, and after 10 drives.
	 */
	private async located(start: string, itemIds: string[]): Promise<Map<string, string[]>> {
		const spaceId = this.meta("space_id") as string;
		const found = new Map<string, string[]>();
		let open = new Map([[start, itemIds]]);
		for (let hop = 0; open.size > 0; hop++) {
			const next = new Map<string, string[]>();
			for (const [drive, ids] of open) {
				let on: Record<string, string> = {};
				if (hop < MOVED_HOPS) {
					on =
						drive === spaceId
							? this.movedOn(ids)
							: await this.env.DRIVE_SPACE.get(this.env.DRIVE_SPACE.idFromName(drive)).movedOn(ids);
				}
				for (const id of ids) {
					const to = on[id];
					const group = to === undefined ? found : next;
					const key = to ?? drive;
					group.set(key, [...(group.get(key) ?? []), id]);
				}
			}
			open = next;
		}
		return found;
	}

	/**
	 * Delivers a `moved` notice: items left this drive for the drive `to`. The items can have moved on
	 * before this notice goes out, so this drive first finds the drive that holds each item now, and
	 * sends that drive. An item that is in this drive again needs no notice.
	 *
	 * The orders of this notice and of the notice of a later move, for an item that went from this drive
	 * to B and then to C:
	 *
	 * - This notice goes out before the item leaves B. It has B. B makes its notice after that, with C.
	 *   If its notice arrives last, the pointer goes from this drive to B, and then to C.
	 * - The notice of B arrives first, and finds no pointer at B. This notice then has C, because B made
	 *   its record of the move before it sent its notice.
	 * - This notice has B, and the notice of B arrives before it. The pointer then goes to B, where the
	 *   item is not. Thus, after each delivery, this drive looks for the items again. For an item that
	 *   left B, it sends the notice of B again, which is safe to repeat. B made its record before its
	 *   notice, so this drive finds the record.
	 * - An item that leaves B after the last look has a notice of B that arrives after this notice.
	 */
	private async notifyMoved(principalId: string, to: string, itemIds: string[]): Promise<void> {
		const stub = this.env.DRIVE_SPACE.get(this.env.DRIVE_SPACE.idFromName(principalId));
		let open = [{ from: this.meta("space_id") as string, at: to, itemIds }];
		for (let round = 0; round < MOVED_HOPS && open.length > 0; round++) {
			const next: typeof open = [];
			for (const step of open) {
				const moves = [...(await this.located(step.at, step.itemIds))]
					.map(([drive, ids]) => ({ to: drive, itemIds: ids }))
					.filter((move) => move.to !== step.from);
				if (moves.length === 0) continue;
				await stub.applyMoved({ principalId, from: step.from, moves });
				for (const move of moves) next.push({ from: move.to, at: move.to, itemIds: move.itemIds });
			}
			open = next;
		}
	}

	/**
	 * From the Worker and from the outbox of a `DocumentDO`: the content of a doc or a sheet changed.
	 * A call with a revision that is not newer changes nothing, so a second delivery is safe.
	 *
	 * A change can arrive for an item that moved to a different drive, because the writer got its
	 * access before the move. This drive sends such a change on to the drive that holds the item.
	 */
	async applyDocumentChange(change: DocumentChange): Promise<void> {
		this.applyChange(change);
		// Before the commit of a move, the target has no row for the item. The `refresh` step of the move
		// sends the state of this drive then.
		const next =
			this.one<{ target: string }>(
				`SELECT r.target FROM transfer_items t JOIN transfers r ON r.id = t.transfer_id
				WHERE t.item_id = ? AND r.state IN ('refresh', 'finish')`,
				change.itemId,
			) ??
			(this.row(change.itemId)
				? null
				: this.one<{ target: string }>("SELECT target FROM moved WHERE item_id = ?", change.itemId));
		if (next) {
			await this.env.DRIVE_SPACE.get(this.env.DRIVE_SPACE.idFromName(next.target)).applyDocumentChange(change);
		}
	}

	/**
	 * From a source drive, after the commit of a move: the current state of a moved doc or sheet, with
	 * its text for the search index. This drive got the item without its text, so it stores a state with
	 * the revision that it has. It drops an older state. A second call changes nothing.
	 */
	refreshImport(change: DocumentChange): void {
		this.applyChange(change, true);
	}

	/** Stores a change with a newer revision. With `same`, also a change with the revision of the item. */
	private applyChange(change: DocumentChange, same = false): void {
		const item = this.one<{ seq: number; content_revision: number }>(
			"SELECT seq, content_revision FROM items WHERE id = ? AND kind IN ('doc', 'sheet')",
			change.itemId,
		);
		if (!item || item.content_revision > change.revision) return;
		if (item.content_revision === change.revision && !same) return;
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(
				"UPDATE items SET content_revision = ?, size = ?, modified_at = ?, modified_by_json = ? WHERE id = ?",
				change.revision,
				change.size,
				change.modifiedAt,
				JSON.stringify(change.modifiedBy),
				change.itemId,
			);
			this.sql.exec(
				"UPDATE items_fts SET content = ? WHERE rowid = ?",
				change.text.slice(0, MAX_INDEXED_CHARS),
				item.seq,
			);
			this.bump();
		});
	}

	// --- Outbox ---------------------------------------------------------------------------------

	override async alarm(): Promise<void> {
		// The runtime can fire an alarm while one runs. One drain at a time keeps the order.
		if (this.drainTask) return this.drainTask;
		this.drainTask = this.runAlarm();
		try {
			await this.drainTask;
		} finally {
			this.drainTask = null;
		}
	}

	/** The work of one alarm: the writes to the index in D1, then the moves between drives, then the outbox. */
	private async runAlarm(): Promise<void> {
		if (this.one<{ n: number }>("SELECT COUNT(*) AS n FROM index_outbox")?.n) await this.flush();
		if (this.one<{ n: number }>("SELECT COUNT(*) AS n FROM transfers")?.n) {
			await this.runMoves({ deadline: Date.now() + MOVE_BUDGET_MS, calls: 0 });
		}
		this.forget(Date.now());
		await this.drain();
		await this.scheduleIndex();
		await this.scheduleTransfers();
	}

	/**
	 * Delivers the outbox in order. A failed row stops the drain until its next attempt, so an effect
	 * never overtakes an earlier one: a share and the removal of that share arrive in that order. A row
	 * that fails 8 times is dropped. The shared index is then stale, and a read of it repairs nothing:
	 * the Worker checks each pointer against the drive that holds the item.
	 */
	private async drain(): Promise<void> {
		for (let count = 0; count < OUTBOX_BATCH; count++) {
			const row = this.one<OutboxRow>("SELECT * FROM outbox ORDER BY id LIMIT 1");
			if (!row) return;
			if (row.next_attempt_at > Date.now()) {
				await this.ctx.storage.setAlarm(row.next_attempt_at);
				return;
			}
			try {
				await this.deliver(row);
				this.sql.exec("DELETE FROM outbox WHERE id = ?", row.id);
			} catch (error) {
				const attempts = row.attempts + 1;
				const message = error instanceof Error ? error.message : String(error);
				log(attempts >= OUTBOX_MAX_ATTEMPTS ? "error" : "warn", "drive outbox delivery failed", {
					kind: row.kind,
					attempts,
					error: message,
				});
				if (attempts >= OUTBOX_MAX_ATTEMPTS) {
					this.sql.exec("DELETE FROM outbox WHERE id = ?", row.id);
					continue;
				}
				const next = Date.now() + backoff(attempts);
				this.sql.exec(
					"UPDATE outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?",
					attempts,
					next,
					message.slice(0, 500),
					row.id,
				);
				await this.ctx.storage.setAlarm(next);
				return;
			}
		}
		await this.schedule();
	}

	/** One effect on a different object. Each is safe to run two times. */
	private async deliver(row: OutboxRow): Promise<void> {
		const spaceId = this.meta("space_id") as string;
		const payload = JSON.parse(row.payload) as {
			itemId?: string;
			role?: string;
			sharedAt?: number;
			to?: string;
			itemIds?: string[];
			transferId?: string;
		};
		switch (row.kind) {
			case "share":
				await this.env.DRIVE_SPACE.get(this.env.DRIVE_SPACE.idFromName(row.target)).applyShare({
					spaceId,
					itemId: payload.itemId as string,
					role: payload.role as string,
					sharedAt: payload.sharedAt as number,
				});
				return;
			case "unshare":
				await this.env.DRIVE_SPACE.get(this.env.DRIVE_SPACE.idFromName(row.target)).removeShare({
					spaceId,
					itemId: payload.itemId as string,
				});
				return;
			case "blob": {
				// Each `blob` row has a key of this drive. A move into this drive waits for a delete in progress
				// (`stageImport`), before the source writes the same key.
				const done = this.env.BLOBS.delete(row.target);
				this.deleting.set(row.target, done);
				try {
					await done;
				} finally {
					this.deleting.delete(row.target);
				}
				return;
			}
			case "moved":
				await this.notifyMoved(row.target, payload.to as string, payload.itemIds as string[]);
				return;
			case "cancel":
				await this.env.DRIVE_SPACE.get(this.env.DRIVE_SPACE.idFromName(row.target)).cancelImport({
					transferId: payload.transferId as string,
				});
				return;
			case "document":
				await this.env.DOCUMENT.get(this.env.DOCUMENT.idFromName(row.target)).destroy();
				return;
		}
	}
}
