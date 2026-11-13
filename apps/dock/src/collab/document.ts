import { DurableObject } from "cloudflare:workers";
import { log } from "../platform/index.ts";

/** An expected failure, returned instead of thrown, because RPC does not keep error classes. */
export type DocumentRefusal = { error: { code: "conflict"; message: string } };

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
 * An object that nobody wrote has no tables, and `destroy()` deletes all storage. Such an object costs
 * nothing.
 */
export class DocumentDO extends DurableObject<Env> {
	private readonly sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
	}

	private hasTables(): boolean {
		return (
			this.sql.exec("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'document'").toArray()
				.length > 0
		);
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
		});
		await this.ctx.storage.setAlarm(Date.now());
		return { revision: revision + 1, changed: true, modifiedAt, size };
	}

	/** Deletes the document. The drive calls this after its item is deleted permanently. */
	async destroy(): Promise<void> {
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
	}

	/** Tells the drive of the item about the last change. The drive drops a revision that it has. */
	override async alarm(): Promise<void> {
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
			this.sql.exec("UPDATE pending SET attempts = ? WHERE id = 1 AND payload = ?", attempts, row.payload);
			await this.ctx.storage.setAlarm(Date.now() + backoff(attempts));
			return;
		}
		if (!this.hasTables()) return;
		// A change during the call replaced the message. That one stays, and its own alarm sends it.
		this.sql.exec("DELETE FROM pending WHERE id = 1 AND payload = ?", row.payload);
	}
}
