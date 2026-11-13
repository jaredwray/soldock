import { DurableObject } from "cloudflare:workers";
import { DRIVE_LIMITS, type DriveRole, type ItemKind } from "@soldock/contracts";
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
 * Who calls, and which drive they call. The Worker authenticates the caller. The object decides what
 * the caller can do with each item, because the grants are in its database.
 */
export interface SpaceCall {
	/** The id of this drive: the id of the principal that owns it. */
	spaceId: string;
	actor: ActorRecord;
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
	kind: "share" | "unshare" | "blob" | "document";
	target: string;
	payload: string;
	attempts: number;
	next_attempt_at: number;
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
];

const OUTBOX_MAX_ATTEMPTS = 8;
const OUTBOX_BATCH = 50;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_INDEXED_CHARS = 100_000;
/** The most folders that an ancestor walk reads. The depth limit keeps real trees far below this. */
const WALK_LIMIT = 64;

const RANK: Record<DriveRole, number> = { viewer: 1, editor: 2, owner: 3 };

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

function refuse(code: Refusal["error"]["code"], message: string): Refusal {
	return { error: { code, message } };
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
 * One drive, keyed by the id of the principal that owns it. It holds the item tree, the versions of
 * each file, the grants, the trash and the search index in its SQLite database. File bytes stay in R2.
 * It also holds the state of its owner as a user: the stars, and the index of the items that others
 * shared. Effects on other objects (the shared index of a different drive, R2 deletes, the content of
 * a deleted doc) go through the outbox and its alarm, in order, with retries.
 */
export class DriveSpaceDO extends DurableObject<Env> {
	private readonly sql: SqlStorage;
	private drainTask: Promise<void> | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		ctx.blockConcurrencyWhile(async () => {
			this.migrate();
			// A change sets the alarm after its transaction commits. If the object stopped between the
			// two, the outbox has rows and no alarm: set one now.
			const pending = this.one<{ n: number }>("SELECT COUNT(*) AS n FROM outbox")?.n ?? 0;
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

	private row(itemId: string): ItemRow | null {
		return this.one<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM items i WHERE i.id = ?`, itemId);
	}

	/**
	 * What the caller can do with an item, or null when the caller has no access. The owner of the
	 * drive is the owner of each item. Each other caller gets the highest role from the grants on the
	 * item and on the folders above it. An item in the trash exists for its owner only.
	 */
	private access(call: SpaceCall, item: ItemRow): Access | null {
		if (this.isOwner(call)) return { role: "owner", parentVisible: true, visibleDepth: WALK_LIMIT };
		if (item.trash_root !== null) return null;
		const grants = this.all<{ role: "editor" | "viewer"; depth: number }>(
			`${UP} SELECT p.role AS role, up.depth AS depth FROM up JOIN permissions p ON p.item_id = up.id WHERE p.principal_id = ?2`,
			item.id,
			call.actor.principal_id,
		);
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
		const access = item ? this.access(call, item) : null;
		if (!item || !access) return refuse("not_found", NOT_FOUND);
		if (RANK[access.role] < RANK[need]) {
			return refuse(
				"forbidden",
				need === "owner"
					? "Only the owner of this item can do this."
					: `You have the ${access.role} role for this item. This needs the ${need} role. Ask the owner of the item.`,
			);
		}
		return { item, access };
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

	about(call: SpaceCall): { used_bytes: number; items_total: number; trash_total: number; version: number } | Refusal {
		this.enter(call);
		if (!this.isOwner(call)) return refuse("forbidden", OWN_DRIVE_ONLY);
		const versions = this.one<{ n: number }>("SELECT COALESCE(SUM(size), 0) AS n FROM versions")?.n ?? 0;
		const native =
			this.one<{ n: number }>("SELECT COALESCE(SUM(size), 0) AS n FROM items WHERE kind IN ('doc', 'sheet')")?.n ?? 0;
		const counts = this.one<{ live: number; trash: number }>(
			"SELECT COUNT(*) FILTER (WHERE trash_root IS NULL) AS live, COUNT(*) FILTER (WHERE trash_root IS NOT NULL) AS trash FROM items",
		);
		return {
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
			if (!this.isOwner(call)) {
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

	/** The views of the own drive that are not a folder: the newest changes, the trash, and a search. */
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
		if (!this.isOwner(call)) return refuse("forbidden", OWN_DRIVE_ONLY);
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
		if (!this.isOwner(call)) return refuse("forbidden", OWN_DRIVE_ONLY);
		const ids = [...new Set(itemIds)];
		const target = this.checkCreate(call, parentId);
		if ("error" in target) return target;
		// The folders from the target up to the root. A folder cannot go into itself or under itself.
		const above = new Set(
			parentId === null ? [] : this.all<{ id: string }>(`${UP} SELECT id FROM up`, parentId).map((row) => row.id),
		);
		for (const id of ids) {
			const item = this.row(id);
			if (!item) return refuse("not_found", `No item has the id ${id}.`);
			if (item.trash_root !== null) return refuse("invalid", `${item.name} is in the trash. Restore it first.`);
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
		if (!this.isOwner(call)) return refuse("forbidden", OWN_DRIVE_ONLY);
		const ids = [...new Set(itemIds)];
		const rows: ItemRow[] = [];
		for (const id of ids) {
			const item = this.row(id);
			if (!item) return refuse("not_found", `No item has the id ${id}.`);
			// An item that is in the trash, or under a folder in the trash, stays as it is.
			if (item.trash_root === null) rows.push(item);
		}
		if (dryRun || rows.length === 0) return { items_changed: rows.length };
		let changed = 0;
		this.ctx.storage.transactionSync(() => {
			const now = Date.now();
			for (const item of this.topDown(rows)) {
				// An earlier item of this call can hold this one. It is then in the trash with that folder.
				if (this.row(item.id)?.trash_root !== null) continue;
				this.sql.exec("UPDATE items SET trashed_at = ?, trash_root = id WHERE id = ?", now, item.id);
				this.sql.exec(
					`${DOWN} UPDATE items SET trash_root = ?1 WHERE trash_root IS NULL AND id IN (SELECT id FROM down)`,
					item.id,
				);
				changed++;
			}
			this.bump();
		});
		return { items_changed: changed };
	}

	/** Takes items out of the trash. An item whose folder is gone or in the trash goes to the root. */
	restore(call: SpaceCall, itemIds: string[]): { items_changed: number } | Refusal {
		this.enter(call);
		if (!this.isOwner(call)) return refuse("forbidden", OWN_DRIVE_ONLY);
		const rows: ItemRow[] = [];
		const wanted = new Set(itemIds);
		for (const id of wanted) {
			const item = this.row(id);
			if (!item) return refuse("not_found", `No item has the id ${id}.`);
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
		if (!this.isOwner(call)) return refuse("forbidden", OWN_DRIVE_ONLY);
		const ids = [...new Set(itemIds)];
		for (const id of ids) {
			const item = this.row(id);
			if (!item) return refuse("not_found", `No item has the id ${id}.`);
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
		if (!this.isOwner(call)) return refuse("forbidden", OWN_DRIVE_ONLY);
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
		const found = this.open(call, itemId, "owner");
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

	/** Removes a grant from an item. The owner removes each grant. A principal removes its own grant. */
	async unshare(call: SpaceCall, itemId: string, principalId: string): Promise<{ removed: boolean } | Refusal> {
		this.enter(call);
		const self = call.actor.principal_id === principalId;
		const found = this.open(call, itemId, self ? "viewer" : "owner");
		if ("error" in found) return found;
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
	 * From the Worker and from the outbox of a `DocumentDO`: the content of a doc or a sheet changed.
	 * A call with a revision that is not newer changes nothing, so a second delivery is safe.
	 */
	applyDocumentChange(change: DocumentChange): void {
		const item = this.one<{ seq: number; content_revision: number }>(
			"SELECT seq, content_revision FROM items WHERE id = ? AND kind IN ('doc', 'sheet')",
			change.itemId,
		);
		if (!item || item.content_revision >= change.revision) return;
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
		this.drainTask = this.drain();
		try {
			await this.drainTask;
		} finally {
			this.drainTask = null;
		}
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
		const payload = JSON.parse(row.payload) as { itemId?: string; role?: string; sharedAt?: number };
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
			case "blob":
				await this.env.BLOBS.delete(row.target);
				return;
			case "document":
				await this.env.DOCUMENT.get(this.env.DOCUMENT.idFromName(row.target)).destroy();
				return;
		}
	}
}
