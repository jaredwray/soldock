import { DurableObject } from "cloudflare:workers";
import { log } from "../platform/index.ts";

/** An expected failure, returned instead of thrown, because RPC does not keep error classes. */
export type DocumentRefusal = { error: { code: "conflict" | "invalid" | "unavailable"; message: string } };

/**
 * The time that an attachment stays after the content stopped to use it. In that time, an undo in an
 * editor can bring it back. The contracts tell callers the same time (24 hours).
 */
export const ATTACHMENT_KEEP_MS = 24 * 60 * 60 * 1000;

/** The R2 key of an attachment of a document. The item id is in it, so a move between drives changes no key. */
export function attachmentKey(itemId: string, attachmentId: string): string {
	return `document/${itemId}/${attachmentId}`;
}

/** A file that belongs to a document, for example an image of a doc. The bytes are in R2. */
export interface AttachmentRecord {
	id: string;
	blobKey: string;
	size: number;
	/** What the owning module knows about the file: JSON text. The object does not read it. */
	meta: string;
	createdAt: number;
	/** The time from which the content does not use the attachment, or null while the content uses it. */
	unusedSince: number | null;
}

export interface AttachmentInput {
	id: string;
	/** The R2 object. The caller wrote it before this call. */
	blobKey: string;
	size: number;
	meta: string;
	/** True for an attachment that the content uses now, for example in a copy of a document. */
	used: boolean;
	/** The most attachments that the document can hold. */
	limit: number;
}

/** The person or agent of a change, with the name at that time. */
export interface DocumentAuthor {
	principal_id: string;
	kind: "human" | "agent";
	display_name: string;
}

export interface DocumentState {
	/** 0 for a document that nobody wrote. Each change adds 1. */
	revision: number;
	/** The content as the owning module stores it: JSON text. The object does not read it. */
	content: string;
	/** The text of the content, for the search index of Drive. */
	text: string;
}

export interface DocumentWrite {
	/** The drive and the item of this document. The object tells that drive about each change. */
	spaceId: string;
	itemId: string;
	content: string;
	text: string;
	/** The revision that the writer read, or null to replace the content in each case. */
	baseRevision: number | null;
	author: DocumentAuthor;
	/**
	 * The ids of the attachments that the new content uses. The write is refused when the document does
	 * not hold one of them. Each other attachment is deleted after `ATTACHMENT_KEEP_MS`. Without this
	 * field, the write does not change the use of the attachments.
	 */
	attachmentIds?: string[];
}

export interface DocumentWriteResult {
	revision: number;
	/** False when the content was the same, so nothing changed. */
	changed: boolean;
	modifiedAt: number;
	/** The bytes of the content, as UTF-8. */
	size: number;
}

interface PendingRow extends Record<string, SqlStorageValue> {
	payload: string;
	attempts: number;
}

interface AttachmentRow extends Record<string, SqlStorageValue> {
	id: string;
	blob_key: string;
	size: number;
	meta: string;
	created_at: number;
	unused_since: number | null;
}

function toAttachment(row: AttachmentRow): AttachmentRecord {
	return {
		id: row.id,
		blobKey: row.blob_key,
		size: row.size,
		meta: row.meta,
		createdAt: row.created_at,
		unusedSince: row.unused_since,
	};
}

/** The keys of one R2 delete call. */
const DELETE_BATCH = 1000;

/** The time before the next attempt to delete bytes from R2, after a failure. */
const SWEEP_RETRY_MS = 5 * 60 * 1000;

const NOTIFY_MAX_ATTEMPTS = 8;

function backoff(attempts: number): number {
	return Math.min(60_000 * 2 ** (attempts - 1), 60 * 60 * 1000);
}

/**
 * The content of one doc or one sheet, keyed by the id of its Drive item. This first layer holds the
 * current content and a revision counter. It has no caller checks: the Worker asks the drive of the
 * item first. After each change, the object tells that drive the new revision, the time, the author
 * and the text for the search index. The message stays in the object until the drive has it, and the
 * alarm sends it again after a failure.
 *
 * A document can hold attachments, for example the images of a doc. The Worker writes the bytes to R2,
 * then records the attachment here. Each write of the content names the attachments that it uses. The
 * alarm deletes an attachment that the content did not use for `ATTACHMENT_KEEP_MS`.
 *
 * An object that nobody wrote has no tables, and `destroy()` deletes all storage. Such an object costs
 * nothing.
 */
export class DocumentDO extends DurableObject<Env> {
	private readonly sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
	}

	private hasTable(name: string): boolean {
		return (
			this.sql.exec("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0
		);
	}

	private hasTables(): boolean {
		return this.hasTable("document");
	}

	private createTables(): void {
		this.sql.exec(
			`CREATE TABLE IF NOT EXISTS document (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				revision INTEGER NOT NULL,
				content TEXT NOT NULL,
				text TEXT NOT NULL,
				modified_at INTEGER NOT NULL
			)`,
		);
		// The message for the drive of the item. A new change replaces a message that waits.
		this.sql.exec(
			`CREATE TABLE IF NOT EXISTS pending (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				payload TEXT NOT NULL,
				attempts INTEGER NOT NULL DEFAULT 0
			)`,
		);
		// An object from before the attachments has the two tables above only, so each change makes these.
		this.sql.exec(
			`CREATE TABLE IF NOT EXISTS attachments (
				id TEXT PRIMARY KEY,
				blob_key TEXT NOT NULL,
				size INTEGER NOT NULL,
				meta TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				unused_since INTEGER
			)`,
		);
		// The R2 keys of deleted attachments. A key stays here until R2 does not have its object.
		this.sql.exec("CREATE TABLE IF NOT EXISTS attachment_deletes (blob_key TEXT PRIMARY KEY)");
	}

	/** The current content, or null for a document that nobody wrote. */
	read(): DocumentState | null {
		if (!this.hasTables()) return null;
		const row = this.sql
			.exec<{ revision: number; content: string; text: string }>(
				"SELECT revision, content, text FROM document WHERE id = 1",
			)
			.toArray()[0];
		return row ? { revision: row.revision, content: row.content, text: row.text } : null;
	}

	/**
	 * Replaces the content. With `baseRevision`, the write is refused when the document is at a
	 * different revision, so two writers cannot lose the change of each other.
	 */
	async write(input: DocumentWrite): Promise<DocumentWriteResult | DocumentRefusal> {
		const current = this.read();
		const revision = current?.revision ?? 0;
		if (input.baseRevision !== null && input.baseRevision !== revision) {
			return {
				error: {
					code: "conflict",
					message: `The content changed: it is at revision ${revision}, not ${input.baseRevision}. Read it again, then make the change again.`,
				},
			};
		}
		const used = input.attachmentIds === undefined ? null : [...new Set(input.attachmentIds)];
		if (used !== null && used.length > 0) {
			const held = new Set(this.attachments().map((attachment) => attachment.id));
			const missing = used.filter((id) => !held.has(id));
			if (missing.length > 0) {
				return {
					error: {
						code: "invalid",
						message: `The document does not hold the attachment ${missing.slice(0, 5).join(", ")}.`,
					},
				};
			}
		}
		const size = new TextEncoder().encode(input.content).byteLength;
		if (current && current.content === input.content) {
			const modifiedAt = this.sql
				.exec<{ modified_at: number }>("SELECT modified_at FROM document WHERE id = 1")
				.one().modified_at;
			return { revision, changed: false, modifiedAt, size };
		}
		const modifiedAt = Date.now();
		this.ctx.storage.transactionSync(() => {
			this.createTables();
			this.sql.exec(
				`INSERT INTO document (id, revision, content, text, modified_at) VALUES (1, ?, ?, ?, ?)
				ON CONFLICT (id) DO UPDATE SET revision = excluded.revision, content = excluded.content,
					text = excluded.text, modified_at = excluded.modified_at`,
				revision + 1,
				input.content,
				input.text,
				modifiedAt,
			);
			this.sql.exec(
				`INSERT INTO pending (id, payload, attempts) VALUES (1, ?, 0)
				ON CONFLICT (id) DO UPDATE SET payload = excluded.payload, attempts = 0`,
				JSON.stringify({
					spaceId: input.spaceId,
					itemId: input.itemId,
					revision: revision + 1,
					modifiedAt,
					modifiedBy: input.author,
					size,
					text: input.text,
				}),
			);
			if (used !== null) {
				const ids = JSON.stringify(used);
				this.sql.exec(
					"UPDATE attachments SET unused_since = NULL WHERE unused_since IS NOT NULL AND id IN (SELECT value FROM json_each(?))",
					ids,
				);
				this.sql.exec(
					"UPDATE attachments SET unused_since = ? WHERE unused_since IS NULL AND id NOT IN (SELECT value FROM json_each(?))",
					modifiedAt,
					ids,
				);
			}
		});
		// The alarm tells the drive now. After that, it sets the time of the next delete of attachments.
		await this.ctx.storage.setAlarm(Date.now());
		return { revision: revision + 1, changed: true, modifiedAt, size };
	}

	/** The attachments of the document, oldest first. */
	attachments(): AttachmentRecord[] {
		if (!this.hasTable("attachments")) return [];
		return this.sql
			.exec<AttachmentRow>("SELECT * FROM attachments ORDER BY created_at, id")
			.toArray()
			.map(toAttachment);
	}

	/** One attachment, or null when the document does not hold it. */
	attachment(id: string): AttachmentRecord | null {
		if (!this.hasTable("attachments")) return null;
		const row = this.sql.exec<AttachmentRow>("SELECT * FROM attachments WHERE id = ?", id).toArray()[0];
		return row ? toAttachment(row) : null;
	}

	/**
	 * Records an attachment whose bytes the caller wrote to R2. A second call with an id that the
	 * document holds changes nothing and returns the first attachment, so a retry of a copy is safe.
	 * After a refusal, the caller deletes the R2 object when its key is new.
	 */
	async addAttachment(input: AttachmentInput): Promise<AttachmentRecord | DocumentRefusal> {
		this.createTables();
		const existing = this.attachment(input.id);
		if (existing) return existing;
		// The delete of this key from R2 is in progress, and it can end after the write of the caller.
		if (this.sql.exec("SELECT 1 AS found FROM attachment_deletes WHERE blob_key = ?", input.blobKey).toArray().length) {
			return {
				error: { code: "unavailable", message: "The document deletes this attachment now. Try again later." },
			};
		}
		const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM attachments").one().n;
		if (count >= input.limit) {
			return {
				error: { code: "invalid", message: `The document can hold at most ${input.limit} attachments.` },
			};
		}
		const now = Date.now();
		this.sql.exec(
			"INSERT INTO attachments (id, blob_key, size, meta, created_at, unused_since) VALUES (?, ?, ?, ?, ?, ?)",
			input.id,
			input.blobKey,
			input.size,
			input.meta,
			now,
			input.used ? null : now,
		);
		await this.scheduleSweep();
		return this.attachment(input.id) as AttachmentRecord;
	}

	/**
	 * Deletes the document and the bytes of its attachments. The drive calls this after its item is
	 * deleted permanently. A failed R2 delete throws, and the outbox of the drive calls again.
	 */
	async destroy(): Promise<void> {
		if (this.hasTable("attachments")) {
			const keys = this.sql
				.exec<{ blob_key: string }>(
					"SELECT blob_key FROM attachments UNION SELECT blob_key FROM attachment_deletes ORDER BY blob_key",
				)
				.toArray()
				.map((row) => row.blob_key);
			for (let start = 0; start < keys.length; start += DELETE_BATCH) {
				await this.env.BLOBS.delete(keys.slice(start, start + DELETE_BATCH));
			}
			// A caller writes the bytes before it records the attachment. When it stopped between the two,
			// R2 has an object without a row. Each key of a document has one prefix, so a list finds it.
			const first = keys[0];
			const prefix = first?.slice(0, first.lastIndexOf("/") + 1);
			for (let cursor: string | undefined; prefix; ) {
				const listed = await this.env.BLOBS.list({ prefix, limit: DELETE_BATCH, ...(cursor ? { cursor } : {}) });
				if (listed.objects.length > 0) await this.env.BLOBS.delete(listed.objects.map((object) => object.key));
				if (!listed.truncated) break;
				cursor = listed.cursor;
			}
		}
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
	}

	/**
	 * Sets the alarm for the next delete of attachments, when no earlier alarm waits. An earlier alarm
	 * (a message for the drive) calls this again after its work.
	 */
	private async scheduleSweep(retryAt: number | null = null): Promise<void> {
		if (!this.hasTable("attachments")) return;
		const oldest = this.sql
			.exec<{ at: number | null }>("SELECT MIN(unused_since) AS at FROM attachments WHERE unused_since IS NOT NULL")
			.one().at;
		const waits = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM attachment_deletes").one().n > 0;
		const times = [oldest === null ? null : oldest + ATTACHMENT_KEEP_MS, waits ? retryAt : null].filter(
			(time): time is number => time !== null,
		);
		if (times.length === 0) return;
		const next = Math.min(...times);
		const current = await this.ctx.storage.getAlarm();
		if (current === null || current > next) await this.ctx.storage.setAlarm(next);
	}

	/**
	 * Deletes each attachment that the content did not use for `ATTACHMENT_KEEP_MS`. The rows go first,
	 * with their keys into `attachment_deletes`, in one transaction. Thus a write that uses an attachment
	 * again is refused, and never gets an attachment without bytes. Then R2 deletes the bytes.
	 */
	private async sweep(): Promise<void> {
		if (!this.hasTable("attachments")) return;
		const before = Date.now() - ATTACHMENT_KEEP_MS;
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(
				`INSERT OR IGNORE INTO attachment_deletes (blob_key)
					SELECT blob_key FROM attachments WHERE unused_since IS NOT NULL AND unused_since <= ?`,
				before,
			);
			this.sql.exec("DELETE FROM attachments WHERE unused_since IS NOT NULL AND unused_since <= ?", before);
		});
		let failed = false;
		for (;;) {
			const keys = this.sql
				.exec<{ blob_key: string }>("SELECT blob_key FROM attachment_deletes ORDER BY blob_key LIMIT ?", DELETE_BATCH)
				.toArray()
				.map((row) => row.blob_key);
			if (keys.length === 0) break;
			try {
				await this.env.BLOBS.delete(keys);
			} catch (error) {
				failed = true;
				log("warn", "attachments of a document did not leave R2", {
					keys: keys.length,
					error: error instanceof Error ? error.message : String(error),
				});
				break;
			}
			// `destroy()` can run while the call waits. The tables are then gone.
			if (!this.hasTable("attachment_deletes")) return;
			this.sql.exec(
				"DELETE FROM attachment_deletes WHERE blob_key IN (SELECT value FROM json_each(?))",
				JSON.stringify(keys),
			);
		}
		await this.scheduleSweep(failed ? Date.now() + SWEEP_RETRY_MS : null);
	}

	/** The work of one alarm: the message for the drive, then the attachments that nothing uses. */
	override async alarm(): Promise<void> {
		await this.notifyDrive();
		await this.sweep();
	}

	/** Tells the drive of the item about the last change. The drive drops a revision that it has. */
	private async notifyDrive(): Promise<void> {
		if (!this.hasTables()) return;
		const row = this.sql.exec<PendingRow>("SELECT payload, attempts FROM pending WHERE id = 1").toArray()[0];
		if (!row) return;
		const payload = JSON.parse(row.payload) as {
			spaceId: string;
			itemId: string;
			revision: number;
			modifiedAt: number;
			modifiedBy: DocumentAuthor;
			size: number;
			text: string;
		};
		try {
			const { spaceId, ...change } = payload;
			await this.env.DRIVE_SPACE.get(this.env.DRIVE_SPACE.idFromName(spaceId)).applyDocumentChange(change);
		} catch (error) {
			// `destroy()` can run while the call waits. The message and its table are then gone.
			if (!this.hasTables()) return;
			const attempts = row.attempts + 1;
			log(attempts >= NOTIFY_MAX_ATTEMPTS ? "error" : "warn", "document change did not reach its drive", {
				attempts,
				error: error instanceof Error ? error.message : String(error),
			});
			if (attempts >= NOTIFY_MAX_ATTEMPTS) {
				// The next change of the document sends its own message, with the newer state.
				this.sql.exec("DELETE FROM pending WHERE id = 1 AND payload = ?", row.payload);
				return;
			}
			const same = this.sql.exec(
				"UPDATE pending SET attempts = ? WHERE id = 1 AND payload = ?",
				attempts,
				row.payload,
			).rowsWritten;
			// A change during the call replaced the message and set its own alarm. That alarm stays.
			if (same > 0) await this.ctx.storage.setAlarm(Date.now() + backoff(attempts));
			return;
		}
		if (!this.hasTables()) return;
		// A change during the call replaced the message. That one stays, and its own alarm sends it.
		this.sql.exec("DELETE FROM pending WHERE id = 1 AND payload = ?", row.payload);
	}
}
