import { SERVICE_ACTIVITY_LIMITS, type ServiceActivityEntry } from "@asterra/contracts";

/**
 * The activity log of a service account, in the `PrincipalDO` of that account. Each call of the service
 * account through REST and MCP, and each change that an owner or an admin makes to it, adds one row. The
 * log keeps `SERVICE_ACTIVITY_LIMITS.entries` rows and `SERVICE_ACTIVITY_LIMITS.days` days, at most.
 */
export const SERVICE_ACTIVITY_MIGRATION: string[] = [
	`CREATE TABLE service_activity (
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		at INTEGER NOT NULL,
		op TEXT NOT NULL,
		result TEXT NOT NULL,
		code TEXT,
		surface TEXT NOT NULL,
		key_id TEXT,
		actor_id TEXT NOT NULL,
		resource_id TEXT,
		request_id TEXT
	)`,
	"CREATE INDEX service_activity_key ON service_activity (key_id, seq)",
];

/** One new entry of the log. */
export interface ServiceActivityInput {
	at: number;
	op: string;
	result: ServiceActivityEntry["result"];
	code: string | null;
	surface: ServiceActivityEntry["surface"];
	keyId: string | null;
	actorId: string;
	resourceId: string | null;
	requestId: string | null;
}

interface ActivityRow extends Record<string, SqlStorageValue> {
	seq: number;
	at: number;
	op: string;
	result: string;
	code: string | null;
	surface: string;
	key_id: string | null;
	actor_id: string;
	resource_id: string | null;
	request_id: string | null;
}

/** The log removes old rows after each `PRUNE_EVERY` inserts. */
const PRUNE_EVERY = 100;

const DAY_MS = 24 * 60 * 60 * 1000;

export class ServiceActivityStore {
	private readonly sql: SqlStorage;

	constructor(sql: SqlStorage) {
		this.sql = sql;
	}

	/** Adds one entry. Each `PRUNE_EVERY`th entry also removes the entries above the limits. */
	record(entry: ServiceActivityInput): void {
		const seq = this.sql
			.exec<{ seq: number }>(
				`INSERT INTO service_activity (at, op, result, code, surface, key_id, actor_id, resource_id, request_id)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
				entry.at,
				entry.op,
				entry.result,
				entry.code,
				entry.surface,
				entry.keyId,
				entry.actorId,
				entry.resourceId,
				entry.requestId,
			)
			.one().seq;
		if (seq % PRUNE_EVERY === 0) this.prune(seq, entry.at);
	}

	/** Removes the entries older than the days of the limit, and the entries before the newest `entries`. */
	prune(newestSeq: number, now: number): void {
		this.sql.exec(
			"DELETE FROM service_activity WHERE seq <= ? OR at < ?",
			newestSeq - SERVICE_ACTIVITY_LIMITS.entries,
			now - SERVICE_ACTIVITY_LIMITS.days * DAY_MS,
		);
	}

	/**
	 * One page of the log, with the newest entry first. `before` is the sequence number after the last entry
	 * of the page before. `keyId` keeps the entries of one token. An entry older than the days of the limit
	 * is left out, also before the next prune.
	 */
	list(options: { before: number | null; keyId: string | null; limit: number; now: number }): {
		entries: ServiceActivityEntry[];
		next: number | null;
	} {
		const rows = this.sql
			.exec<ActivityRow>(
				`SELECT seq, at, op, result, code, surface, key_id, actor_id, resource_id, request_id FROM service_activity
				WHERE seq < ?1 AND at >= ?2 AND (?3 IS NULL OR key_id = ?3)
				ORDER BY seq DESC LIMIT ?4`,
				options.before ?? Number.MAX_SAFE_INTEGER,
				options.now - SERVICE_ACTIVITY_LIMITS.days * DAY_MS,
				options.keyId,
				options.limit + 1,
			)
			.toArray();
		const page = rows.slice(0, options.limit);
		const last = page[page.length - 1];
		return {
			entries: page.map((row) => ({
				id: String(row.seq),
				at: new Date(row.at).toISOString(),
				operation: row.op,
				result: row.result as ServiceActivityEntry["result"],
				code: row.code,
				surface: row.surface as ServiceActivityEntry["surface"],
				key_id: row.key_id,
				actor_id: row.actor_id,
				resource_id: row.resource_id,
				request_id: row.request_id,
			})),
			next: rows.length > options.limit && last ? last.seq : null,
		};
	}
}
