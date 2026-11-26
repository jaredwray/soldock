import { DurableObject } from "cloudflare:workers";
import { CALENDAR_LIMITS } from "@asterra/contracts";

// Each person, agent and service account has one CalendarDO. Its name is the principal id. It holds the
// events of the calendar of that principal in its SQLite database. It has no outbox and no alarm: a change
// of a calendar has no effect on a different object.

type Row = Record<string, SqlStorageValue>;

/** An expected failure, as a value: an error that a Durable Object throws loses its class over RPC. */
export type Refusal = { error: { code: "invalid" | "not_found" | "conflict"; message: string } };

function refuse(code: Refusal["error"]["code"], message: string): Refusal {
	return { error: { code, message } };
}

const NOT_FOUND = "Your calendar has no event with that id.";

/** The caller of the object. Only the owner reaches the calendar now: sharing comes in a later layer. */
export interface CalendarCall {
	/** The principal that owns the calendar. The handler opens the object of this principal. */
	ownerId: string;
	/** The principal of the call. */
	actorId: string;
}

/**
 * The time of an event, as the object stores it. `start_at` and `end_at` are UTC ms. For an all-day event they
 * are the widest bounds of its days in each time zone (`allDayBounds`), so the range query can use them.
 */
export interface EventTime {
	all_day: boolean;
	start_at: number;
	end_at: number;
	/** All-day only, YYYY-MM-DD. */
	start_date: string | null;
	/** All-day only, YYYY-MM-DD, the day after the last day. */
	end_date: string | null;
	/** Timed only, an IANA name. */
	time_zone: string | null;
}

export interface EventFields extends EventTime {
	title: string;
	description: string;
	location: string;
}

export interface EventRecord extends EventFields {
	id: string;
	revision: number;
	created_at: number;
	updated_at: number;
}

/** The range of a list. The handler computes the dates and the lower bound from the time zone of the call. */
export interface ListQuery {
	/** The range, in UTC ms. `max` is not in the range. */
	min: number;
	max: number;
	/** The date of `min` in the time zone of the call. An all-day event that ends after it can be in the range. */
	minDate: string;
	/** The first date that starts at `max` or later in the time zone of the call. */
	maxDate: string;
	/** No event in the range starts before this instant. It keeps the scan on the index. */
	lowerBound: number;
	/** The sort key of the last event of the page before. */
	after: { start_at: number; id: string } | null;
	limit: number;
}

export interface CreateInput {
	id: string;
	fields: EventFields;
	idempotency?: { key: string; requestHash: string } | undefined;
}

/** A key works for 24 hours, as in Drive. */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

const MIGRATIONS: readonly (readonly string[])[] = [
	[
		`CREATE TABLE events (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			description TEXT NOT NULL,
			location TEXT NOT NULL,
			all_day INTEGER NOT NULL CHECK (all_day IN (0, 1)),
			start_at INTEGER NOT NULL,
			end_at INTEGER NOT NULL,
			start_date TEXT,
			end_date TEXT,
			time_zone TEXT,
			revision INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		) WITHOUT ROWID`,
		"CREATE INDEX events_start ON events (start_at, id)",
		`CREATE TABLE idempotency (
			key TEXT PRIMARY KEY,
			request_hash TEXT NOT NULL,
			event_id TEXT NOT NULL,
			created_at INTEGER NOT NULL
		)`,
	],
];

const COLUMNS =
	"id, title, description, location, all_day, start_at, end_at, start_date, end_date, time_zone, revision, created_at, updated_at";

function toRecord(row: Row): EventRecord {
	return {
		id: row.id as string,
		title: row.title as string,
		description: row.description as string,
		location: row.location as string,
		all_day: row.all_day === 1,
		start_at: row.start_at as number,
		end_at: row.end_at as number,
		start_date: (row.start_date as string | null) ?? null,
		end_date: (row.end_date as string | null) ?? null,
		time_zone: (row.time_zone as string | null) ?? null,
		revision: row.revision as number,
		created_at: row.created_at as number,
		updated_at: row.updated_at as number,
	};
}

const FIELD_KEYS = [
	"title",
	"description",
	"location",
	"all_day",
	"start_at",
	"end_at",
	"start_date",
	"end_date",
	"time_zone",
] as const satisfies readonly (keyof EventFields)[];

export class CalendarDO extends DurableObject<Env> {
	private readonly sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.migrate();
	}

	private migrate(): void {
		this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		const current = Number(this.meta("schema_version") ?? 0);
		for (let version = current; version < MIGRATIONS.length; version++) {
			this.ctx.storage.transactionSync(() => {
				for (const statement of MIGRATIONS[version] ?? []) this.sql.exec(statement);
				this.setMeta("schema_version", String(version + 1));
				if (version === 0) this.setMeta("event_count", "0");
			});
		}
	}

	private meta(key: string): string | null {
		return this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0]?.value ?? null;
	}

	private setMeta(key: string, value: string): void {
		this.sql.exec(
			"INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
			key,
			value,
		);
	}

	/**
	 * Checks the caller. The first call keeps the owner, so a handler that opens the object of a different
	 * principal gets a refusal, never the events. Only the owner reaches the calendar in this layer.
	 */
	private enter(call: CalendarCall): Refusal | null {
		const owner = this.meta("owner_id");
		if (owner === null) this.setMeta("owner_id", call.ownerId);
		else if (owner !== call.ownerId) return refuse("not_found", NOT_FOUND);
		if (call.actorId !== call.ownerId) return refuse("not_found", NOT_FOUND);
		return null;
	}

	private row(id: string): EventRecord | null {
		const row = this.sql.exec<Row>(`SELECT ${COLUMNS} FROM events WHERE id = ?`, id).toArray()[0];
		return row ? toRecord(row) : null;
	}

	/** The events of a range, first start first, and true when more follow. */
	list(call: CalendarCall, query: ListQuery): { events: EventRecord[]; more: boolean } | Refusal {
		const refused = this.enter(call);
		if (refused) return refused;
		const bindings: SqlStorageValue[] = [query.max, query.lowerBound, query.min, query.maxDate, query.minDate];
		let after = "";
		if (query.after) {
			after = "AND (start_at, id) > (?, ?)";
			bindings.push(query.after.start_at, query.after.id);
		}
		bindings.push(query.limit + 1);
		const rows = this.sql
			.exec<Row>(
				`SELECT ${COLUMNS} FROM events
				WHERE start_at < ? AND start_at >= ?
					AND ((all_day = 0 AND end_at > ?) OR (all_day = 1 AND start_date < ? AND end_date > ?))
					${after}
				ORDER BY start_at, id
				LIMIT ?`,
				...bindings,
			)
			.toArray();
		const more = rows.length > query.limit;
		return { events: rows.slice(0, query.limit).map(toRecord), more };
	}

	get(call: CalendarCall, eventId: string): EventRecord | Refusal {
		const refused = this.enter(call);
		if (refused) return refused;
		return this.row(eventId) ?? refuse("not_found", NOT_FOUND);
	}

	/**
	 * Adds an event. With an idempotency key that a call with the same request used, it returns that event and
	 * adds nothing. The check and the write run with no await between them, so two calls with one key add one
	 * event.
	 */
	create(call: CalendarCall, input: CreateInput): EventRecord | Refusal {
		const refused = this.enter(call);
		if (refused) return refused;
		const now = Date.now();
		if (input.idempotency) {
			const earlier = this.sql
				.exec<{ request_hash: string; event_id: string }>(
					"SELECT request_hash, event_id FROM idempotency WHERE key = ? AND created_at > ?",
					input.idempotency.key,
					now - IDEMPOTENCY_TTL_MS,
				)
				.toArray()[0];
			if (earlier) {
				if (earlier.request_hash !== input.idempotency.requestHash) {
					return refuse("conflict", "The idempotency key was used with a different request.");
				}
				return (
					this.row(earlier.event_id) ?? refuse("conflict", "The event of this idempotency key does not exist now.")
				);
			}
		}
		const count = Number(this.meta("event_count") ?? 0);
		if (count >= CALENDAR_LIMITS.events) {
			return refuse("invalid", `A calendar can have at most ${CALENDAR_LIMITS.events} events. Delete events first.`);
		}
		const { fields } = input;
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(
				`INSERT INTO events (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
				input.id,
				fields.title,
				fields.description,
				fields.location,
				fields.all_day ? 1 : 0,
				fields.start_at,
				fields.end_at,
				fields.start_date,
				fields.end_date,
				fields.time_zone,
				now,
				now,
			);
			this.setMeta("event_count", String(count + 1));
			if (input.idempotency) {
				this.sql.exec("DELETE FROM idempotency WHERE created_at <= ?", now - IDEMPOTENCY_TTL_MS);
				this.sql.exec(
					"INSERT OR REPLACE INTO idempotency (key, request_hash, event_id, created_at) VALUES (?, ?, ?, ?)",
					input.idempotency.key,
					input.idempotency.requestHash,
					input.id,
					now,
				);
			}
		});
		return this.row(input.id) as EventRecord;
	}

	/**
	 * Changes the fields of the patch. A patch that changes nothing writes nothing and keeps the revision. A
	 * `baseRevision` that is not the revision of the event changes nothing.
	 */
	update(
		call: CalendarCall,
		eventId: string,
		patch: Partial<EventFields>,
		baseRevision: number | undefined,
	): { event: EventRecord; changed: boolean } | Refusal {
		const refused = this.enter(call);
		if (refused) return refused;
		const event = this.row(eventId);
		if (!event) return refuse("not_found", NOT_FOUND);
		if (baseRevision !== undefined && baseRevision !== event.revision) {
			return refuse(
				"conflict",
				`The event has revision ${event.revision} now, not ${baseRevision}. Read it again, then try again.`,
			);
		}
		const next: EventRecord = { ...event };
		for (const key of FIELD_KEYS) {
			if (patch[key] !== undefined) (next as unknown as Record<string, unknown>)[key] = patch[key];
		}
		if (FIELD_KEYS.every((key) => next[key] === event[key])) return { event, changed: false };
		const now = Date.now();
		this.sql.exec(
			`UPDATE events SET title = ?, description = ?, location = ?, all_day = ?, start_at = ?, end_at = ?,
				start_date = ?, end_date = ?, time_zone = ?, revision = revision + 1, updated_at = ?
			WHERE id = ?`,
			next.title,
			next.description,
			next.location,
			next.all_day ? 1 : 0,
			next.start_at,
			next.end_at,
			next.start_date,
			next.end_date,
			next.time_zone,
			now,
			eventId,
		);
		return { event: this.row(eventId) as EventRecord, changed: true };
	}

	/** Deletes an event, or with `dryRun` returns it without a change. */
	remove(
		call: CalendarCall,
		eventId: string,
		baseRevision: number | undefined,
		dryRun: boolean,
	): EventRecord | Refusal {
		const refused = this.enter(call);
		if (refused) return refused;
		const event = this.row(eventId);
		if (!event) return refuse("not_found", NOT_FOUND);
		if (baseRevision !== undefined && baseRevision !== event.revision) {
			return refuse(
				"conflict",
				`The event has revision ${event.revision} now, not ${baseRevision}. Read it again, then try again.`,
			);
		}
		if (dryRun) return event;
		this.ctx.storage.transactionSync(() => {
			this.sql.exec("DELETE FROM events WHERE id = ?", eventId);
			this.setMeta("event_count", String(Math.max(0, Number(this.meta("event_count") ?? 1) - 1)));
		});
		return event;
	}
}
