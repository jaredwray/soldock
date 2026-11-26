import { DurableObject } from "cloudflare:workers";
import { CALENDAR_LIMITS, type CalendarAccess, type EventVisibility, zonedDayStart } from "@asterra/contracts";
import { log } from "../platform/index.ts";

// Each person, agent and service account has one CalendarDO. Its name is the principal id. It holds the
// events of the calendar of that principal in its SQLite database, the grants that the owner gives, and an
// outbox of invitations. The outbox and the alarm deliver each invitation to the calendar of each attendee.

type Row = Record<string, SqlStorageValue>;

/** An expected failure, as a value: an error that a Durable Object throws loses its class over RPC. */
export type Refusal = { error: { code: "invalid" | "not_found" | "conflict" | "forbidden"; message: string } };

function refuse(code: Refusal["error"]["code"], message: string): Refusal {
	return { error: { code, message } };
}

const NOT_FOUND = "The calendar has no event with that id.";
const NO_GRANT = "The owner of this calendar gave you no access to it.";
const FREE_BUSY_ONLY = "Your access to this calendar shows only busy times. The owner can let you schedule.";

/** The caller of the object. */
export interface CalendarCall {
	/** The principal that owns the calendar. The handler opens the object of this principal. */
	ownerId: string;
	/** The principal of the call: the owner, or a principal that holds a grant of the owner. */
	actorId: string;
}

/** What the caller is in this calendar: the owner, or a principal with a `schedule` grant. */
type Role = "owner" | "schedule";

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
	visibility: EventVisibility;
	/** The principal ids of the attendees, without the organizer. */
	attendees: string[];
}

export interface EventRecord extends EventFields {
	id: string;
	/** Null for an own event. The calendar of the organizer for an invitation. */
	organizer_id: string | null;
	/** Null for the owner. The delegate that added the event. */
	created_by: string | null;
	revision: number;
	created_at: number;
	updated_at: number;
}

/** An event as one caller sees it. A delegate sees a part of an event that it did not add. */
export interface EventView extends EventRecord {
	redacted: boolean;
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

/** The range of a free/busy query: a list query without a page, and the time zone for all-day events. */
export interface BusyQuery extends Omit<ListQuery, "after" | "limit"> {
	zone: string;
}

export interface CreateInput {
	id: string;
	fields: EventFields;
	idempotency?: { key: string; requestHash: string } | undefined;
}

export interface GrantRecord {
	principal_id: string;
	access: CalendarAccess;
	created_at: number;
}

/** The copy of an event of an organizer, as the outbox delivers it to an attendee. */
export interface InviteSnapshot extends EventFields {
	id: string;
	/** The revision of the event in the calendar of the organizer. A copy never goes back to an earlier one. */
	revision: number;
}

/** An interval of busy time, in UTC ms. `end` is not in the interval. */
export interface BusySpan {
	start: number;
	end: number;
}

/** A key works for 24 hours, as in Drive. */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** The rows of a free/busy query. A calendar with more events in the range gives unknown, never a part. */
const BUSY_ROWS = 2000;

const OUTBOX_BATCH = 50;
const OUTBOX_MAX_ATTEMPTS = 8;

function backoff(attempts: number): number {
	return Math.min(60_000 * 2 ** (attempts - 1), 60 * 60 * 1000);
}

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
	[
		"ALTER TABLE events ADD COLUMN visibility TEXT NOT NULL DEFAULT 'default' CHECK (visibility IN ('default', 'private'))",
		"ALTER TABLE events ADD COLUMN organizer_id TEXT",
		"ALTER TABLE events ADD COLUMN organizer_revision INTEGER",
		"ALTER TABLE events ADD COLUMN created_by TEXT",
		"ALTER TABLE events ADD COLUMN attendees TEXT NOT NULL DEFAULT '[]'",
		`CREATE TABLE grants (
			principal_id TEXT PRIMARY KEY,
			access TEXT NOT NULL CHECK (access IN ('free_busy', 'schedule')),
			created_at INTEGER NOT NULL
		) WITHOUT ROWID`,
		`CREATE TABLE outbox (
			event_id TEXT NOT NULL,
			target TEXT NOT NULL,
			gen INTEGER NOT NULL,
			attempts INTEGER NOT NULL,
			next_attempt_at INTEGER NOT NULL,
			last_error TEXT,
			PRIMARY KEY (event_id, target)
		) WITHOUT ROWID`,
		"CREATE INDEX outbox_due ON outbox (next_attempt_at)",
	],
];

const COLUMNS =
	"id, title, description, location, all_day, start_at, end_at, start_date, end_date, time_zone, revision, created_at, updated_at, visibility, organizer_id, created_by, attendees";

function parseAttendees(value: SqlStorageValue | undefined): string[] {
	try {
		const parsed: unknown = JSON.parse(typeof value === "string" ? value : "[]");
		return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
	} catch {
		return [];
	}
}

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
		visibility: row.visibility === "private" ? "private" : "default",
		attendees: parseAttendees(row.attendees),
		organizer_id: (row.organizer_id as string | null) ?? null,
		created_by: (row.created_by as string | null) ?? null,
		revision: row.revision as number,
		created_at: row.created_at as number,
		updated_at: row.updated_at as number,
	};
}

/** The fields of an event that a patch can change. `attendees` compares as JSON. */
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
	"visibility",
	"attendees",
] as const satisfies readonly (keyof EventFields)[];

function sameField(key: (typeof FIELD_KEYS)[number], a: EventFields, b: EventFields): boolean {
	return key === "attendees" ? JSON.stringify(a.attendees) === JSON.stringify(b.attendees) : a[key] === b[key];
}

/**
 * The event as the caller sees it. The owner sees each field. A delegate sees each field of an event that it
 * added. Of a different event it sees the time, and the title when the event is not private: never the
 * description, the location or the attendees.
 */
function viewFor(role: Role, actorId: string, record: EventRecord): EventView {
	if (role === "owner" || (record.created_by === actorId && record.organizer_id === null)) {
		return { ...record, redacted: false };
	}
	return {
		...record,
		title: record.visibility === "private" ? "" : record.title,
		description: "",
		location: "",
		attendees: [],
		created_by: null,
		redacted: true,
	};
}

/** Merges intervals that overlap or touch. The input is in any order. */
function mergeIntervals(intervals: [number, number][]): [number, number][] {
	const sorted = [...intervals].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	const merged: [number, number][] = [];
	for (const [start, end] of sorted) {
		const last = merged.at(-1);
		if (last && start <= last[1]) last[1] = Math.max(last[1], end);
		else merged.push([start, end]);
	}
	return merged;
}

export class CalendarDO extends DurableObject<Env> {
	private readonly sql: SqlStorage;
	private drainTask: Promise<void> | null = null;

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
	 * Keeps the owner on the first call. A handler that opens the object of a different principal gets false,
	 * never the events.
	 */
	private ownedBy(ownerId: string): boolean {
		const owner = this.meta("owner_id");
		if (owner === null) {
			this.setMeta("owner_id", ownerId);
			return true;
		}
		return owner === ownerId;
	}

	private grantOf(principalId: string): CalendarAccess | null {
		const row = this.sql
			.exec<{ access: string }>("SELECT access FROM grants WHERE principal_id = ?", principalId)
			.toArray()[0];
		return row?.access === "schedule" || row?.access === "free_busy" ? row.access : null;
	}

	/**
	 * Checks the caller. The owner can do each thing. With `need` "schedule", a principal that holds a
	 * `schedule` grant of the owner can enter too. The grant is read on each call, so a removed grant ends the
	 * access at once.
	 */
	private enter(call: CalendarCall, need: "owner" | "schedule"): Role | Refusal {
		if (!this.ownedBy(call.ownerId)) return refuse("not_found", NOT_FOUND);
		if (call.actorId === call.ownerId) return "owner";
		if (need === "owner") return refuse("forbidden", "Only the owner of a calendar can do this.");
		const access = this.grantOf(call.actorId);
		if (access === null) return refuse("forbidden", NO_GRANT);
		if (access === "free_busy") return refuse("forbidden", FREE_BUSY_ONLY);
		return "schedule";
	}

	private row(id: string): EventRecord | null {
		const row = this.sql.exec<Row>(`SELECT ${COLUMNS} FROM events WHERE id = ?`, id).toArray()[0];
		return row ? toRecord(row) : null;
	}

	/** Puts a delivery of an event to an attendee in the outbox. A second change of the same pair runs once. */
	private touch(eventId: string, target: string, now: number): void {
		this.sql.exec(
			`INSERT INTO outbox (event_id, target, gen, attempts, next_attempt_at) VALUES (?, ?, 1, 0, ?)
			ON CONFLICT (event_id, target) DO UPDATE SET gen = gen + 1, attempts = 0,
				next_attempt_at = excluded.next_attempt_at, last_error = NULL`,
			eventId,
			target,
			now,
		);
	}

	/** Confirms that the caller can schedule in this calendar. `calendar.find_times` uses it for `calendar_id`. */
	authorize(call: CalendarCall): { ok: true } | Refusal {
		const role = this.enter(call, "schedule");
		return typeof role === "string" ? { ok: true } : role;
	}

	/** The events of a range, first start first, and true when more follow. */
	list(call: CalendarCall, query: ListQuery): { events: EventView[]; more: boolean } | Refusal {
		const role = this.enter(call, "schedule");
		if (typeof role !== "string") return role;
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
		return {
			events: rows.slice(0, query.limit).map((row) => viewFor(role, call.actorId, toRecord(row))),
			more,
		};
	}

	get(call: CalendarCall, eventId: string): EventView | Refusal {
		const role = this.enter(call, "schedule");
		if (typeof role !== "string") return role;
		const record = this.row(eventId);
		return record ? viewFor(role, call.actorId, record) : refuse("not_found", NOT_FOUND);
	}

	/**
	 * Adds an event. With an idempotency key that a call with the same request used, it returns that event and
	 * adds nothing. The check and the write run with no await between them, so two calls with one key add one
	 * event. Each attendee gets a delivery in the outbox, in the same transaction.
	 */
	async create(call: CalendarCall, input: CreateInput): Promise<EventView | Refusal> {
		const role = this.enter(call, "schedule");
		if (typeof role !== "string") return role;
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
				const record = this.row(earlier.event_id);
				return record
					? viewFor(role, call.actorId, record)
					: refuse("conflict", "The event of this idempotency key does not exist now.");
			}
		}
		const count = Number(this.meta("event_count") ?? 0);
		if (count >= CALENDAR_LIMITS.events) {
			return refuse("invalid", `A calendar can have at most ${CALENDAR_LIMITS.events} events. Delete events first.`);
		}
		const { fields } = input;
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(
				`INSERT INTO events (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, ?, ?)`,
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
				fields.visibility,
				role === "owner" ? null : call.actorId,
				JSON.stringify(fields.attendees),
			);
			this.setMeta("event_count", String(count + 1));
			for (const target of fields.attendees) this.touch(input.id, target, now);
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
		if (fields.attendees.length > 0) await this.ctx.storage.setAlarm(now);
		return viewFor(role, call.actorId, this.row(input.id) as EventRecord);
	}

	/** Refuses a change of an event that the caller cannot change. */
	private changeRefusal(role: Role, actorId: string, event: EventRecord): Refusal | null {
		if (event.organizer_id !== null) {
			return role === "owner"
				? refuse("forbidden", "Only the organizer changes this event. You can delete your copy.")
				: refuse("forbidden", "Only the organizer changes this event.");
		}
		if (role === "schedule" && event.created_by !== actorId) {
			return refuse("forbidden", "You can change only the events that you added to this calendar.");
		}
		return null;
	}

	/**
	 * Changes the fields of the patch. A patch that changes nothing writes nothing and keeps the revision. A
	 * `baseRevision` that is not the revision of the event changes nothing. Each attendee before and after the
	 * change gets a delivery in the outbox.
	 */
	async update(
		call: CalendarCall,
		eventId: string,
		patch: Partial<EventFields>,
		baseRevision: number | undefined,
	): Promise<{ event: EventView; changed: boolean } | Refusal> {
		const role = this.enter(call, "schedule");
		if (typeof role !== "string") return role;
		const event = this.row(eventId);
		if (!event) return refuse("not_found", NOT_FOUND);
		const refused = this.changeRefusal(role, call.actorId, event);
		if (refused) return refused;
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
		if (FIELD_KEYS.every((key) => sameField(key, next, event))) {
			return { event: viewFor(role, call.actorId, event), changed: false };
		}
		const now = Date.now();
		const targets = new Set([...event.attendees, ...next.attendees]);
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(
				`UPDATE events SET title = ?, description = ?, location = ?, all_day = ?, start_at = ?, end_at = ?,
					start_date = ?, end_date = ?, time_zone = ?, visibility = ?, attendees = ?, revision = revision + 1,
					updated_at = ?
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
				next.visibility,
				JSON.stringify(next.attendees),
				now,
				eventId,
			);
			for (const target of targets) this.touch(eventId, target, now);
		});
		if (targets.size > 0) await this.ctx.storage.setAlarm(now);
		return { event: viewFor(role, call.actorId, this.row(eventId) as EventRecord), changed: true };
	}

	/**
	 * Deletes an event, or with `dryRun` returns it without a change. Each attendee of an own event loses its
	 * copy. The delete of a copy removes only the copy: the organizer keeps the event.
	 */
	async remove(
		call: CalendarCall,
		eventId: string,
		baseRevision: number | undefined,
		dryRun: boolean,
	): Promise<EventView | Refusal> {
		const role = this.enter(call, "schedule");
		if (typeof role !== "string") return role;
		const event = this.row(eventId);
		if (!event) return refuse("not_found", NOT_FOUND);
		// The owner can delete an invitation copy. A delegate deletes only the events that it added.
		if (role === "schedule") {
			const refused = this.changeRefusal(role, call.actorId, event);
			if (refused) return refused;
		}
		if (baseRevision !== undefined && baseRevision !== event.revision) {
			return refuse(
				"conflict",
				`The event has revision ${event.revision} now, not ${baseRevision}. Read it again, then try again.`,
			);
		}
		const view = viewFor(role, call.actorId, event);
		if (dryRun) return view;
		const now = Date.now();
		const targets = event.organizer_id === null ? event.attendees : [];
		this.ctx.storage.transactionSync(() => {
			this.sql.exec("DELETE FROM events WHERE id = ?", eventId);
			this.setMeta("event_count", String(Math.max(0, Number(this.meta("event_count") ?? 1) - 1)));
			for (const target of targets) this.touch(eventId, target, now);
		});
		if (targets.length > 0) await this.ctx.storage.setAlarm(now);
		return view;
	}

	// --- Grants ---------------------------------------------------------------------------------

	private grantRows(): GrantRecord[] {
		return this.sql
			.exec<{ principal_id: string; access: string; created_at: number }>(
				"SELECT principal_id, access, created_at FROM grants ORDER BY created_at, principal_id",
			)
			.toArray()
			.map((row) => ({
				principal_id: row.principal_id,
				access: row.access === "schedule" ? "schedule" : "free_busy",
				created_at: row.created_at,
			}));
	}

	grants(call: CalendarCall): { grants: GrantRecord[] } | Refusal {
		const role = this.enter(call, "owner");
		if (typeof role !== "string") return role;
		return { grants: this.grantRows() };
	}

	/** Gives a principal a grant, or changes it. `changed` is false when the grant was the same. */
	setGrant(
		call: CalendarCall,
		principalId: string,
		access: CalendarAccess,
	): { grants: GrantRecord[]; changed: boolean } | Refusal {
		const role = this.enter(call, "owner");
		if (typeof role !== "string") return role;
		if (principalId === call.ownerId) return refuse("invalid", "You use your own calendar without a grant.");
		const before = this.grantOf(principalId);
		if (before === access) return { grants: this.grantRows(), changed: false };
		if (before === null) {
			const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM grants").one().n;
			if (count >= CALENDAR_LIMITS.grants) {
				return refuse("invalid", `A calendar can have at most ${CALENDAR_LIMITS.grants} grants.`);
			}
			this.sql.exec(
				"INSERT INTO grants (principal_id, access, created_at) VALUES (?, ?, ?)",
				principalId,
				access,
				Date.now(),
			);
		} else {
			this.sql.exec("UPDATE grants SET access = ? WHERE principal_id = ?", access, principalId);
		}
		return { grants: this.grantRows(), changed: true };
	}

	/** Removes a grant. `changed` is false when the principal had no grant. */
	removeGrant(call: CalendarCall, principalId: string): { grants: GrantRecord[]; changed: boolean } | Refusal {
		const role = this.enter(call, "owner");
		if (typeof role !== "string") return role;
		const changed = this.sql.exec("DELETE FROM grants WHERE principal_id = ?", principalId).rowsWritten > 0;
		return { grants: this.grantRows(), changed };
	}

	// --- Free/busy ------------------------------------------------------------------------------

	/**
	 * The busy intervals of a range, merged, for a viewer. The viewer is the owner, or a principal with a grant
	 * of the owner (either access). Unknown for each other viewer, and for a range with too many events. The
	 * result has no id, no title and no count of events. A private event and an invitation are busy time too.
	 * An all-day event is busy from 00:00 to 00:00 of its days in the zone of the query.
	 */
	freeBusy(viewer: CalendarCall, query: BusyQuery): { busy: BusySpan[] } | { unknown: true } {
		if (!this.ownedBy(viewer.ownerId)) return { unknown: true };
		if (viewer.actorId !== viewer.ownerId && this.grantOf(viewer.actorId) === null) return { unknown: true };
		const rows = this.sql
			.exec<{ all_day: number; start_at: number; end_at: number; start_date: string | null; end_date: string | null }>(
				`SELECT all_day, start_at, end_at, start_date, end_date FROM events
				WHERE start_at < ? AND start_at >= ?
					AND ((all_day = 0 AND end_at > ?) OR (all_day = 1 AND start_date < ? AND end_date > ?))
				LIMIT ?`,
				query.max,
				query.lowerBound,
				query.min,
				query.maxDate,
				query.minDate,
				BUSY_ROWS + 1,
			)
			.toArray();
		if (rows.length > BUSY_ROWS) return { unknown: true };
		const intervals: [number, number][] = [];
		for (const row of rows) {
			const [start, end] =
				row.all_day === 1 && row.start_date !== null && row.end_date !== null
					? [zonedDayStart(row.start_date, query.zone), zonedDayStart(row.end_date, query.zone)]
					: [row.start_at, row.end_at];
			const clipped: [number, number] = [Math.max(start, query.min), Math.min(end, query.max)];
			if (clipped[0] < clipped[1]) intervals.push(clipped);
		}
		return { busy: mergeIntervals(intervals).map(([start, end]) => ({ start, end })) };
	}

	// --- Invitations ----------------------------------------------------------------------------

	/**
	 * Adds or changes the copy of an event of an organizer. The copy has the id of the event. A delivery of a
	 * revision that the copy has, or of an earlier one, changes nothing, so a second delivery adds no second
	 * copy. A row with that id from a different organizer stays as it is.
	 */
	applyInvite(input: { ownerId: string; organizerId: string; event: InviteSnapshot }): { applied: boolean } {
		if (!this.ownedBy(input.ownerId)) return { applied: false };
		const { event } = input;
		const existing = this.sql
			.exec<{ organizer_id: string | null; organizer_revision: number | null }>(
				"SELECT organizer_id, organizer_revision FROM events WHERE id = ?",
				event.id,
			)
			.toArray()[0];
		const now = Date.now();
		if (existing) {
			if (existing.organizer_id !== input.organizerId) return { applied: false };
			if ((existing.organizer_revision ?? 0) >= event.revision) return { applied: false };
			this.sql.exec(
				`UPDATE events SET title = ?, description = ?, location = ?, all_day = ?, start_at = ?, end_at = ?,
					start_date = ?, end_date = ?, time_zone = ?, visibility = ?, attendees = ?, organizer_revision = ?,
					revision = revision + 1, updated_at = ?
				WHERE id = ?`,
				event.title,
				event.description,
				event.location,
				event.all_day ? 1 : 0,
				event.start_at,
				event.end_at,
				event.start_date,
				event.end_date,
				event.time_zone,
				event.visibility,
				JSON.stringify(event.attendees),
				event.revision,
				now,
				event.id,
			);
			return { applied: true };
		}
		const count = Number(this.meta("event_count") ?? 0);
		if (count >= CALENDAR_LIMITS.events) {
			log("warn", "calendar invitation dropped: the calendar is full", { eventId: event.id });
			return { applied: false };
		}
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(
				`INSERT INTO events (${COLUMNS}, organizer_revision)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, ?, ?)`,
				event.id,
				event.title,
				event.description,
				event.location,
				event.all_day ? 1 : 0,
				event.start_at,
				event.end_at,
				event.start_date,
				event.end_date,
				event.time_zone,
				now,
				now,
				event.visibility,
				input.organizerId,
				JSON.stringify(event.attendees),
				event.revision,
			);
			this.setMeta("event_count", String(count + 1));
		});
		return { applied: true };
	}

	/** Removes the copy of an event of an organizer. A second call changes nothing. */
	removeInvite(input: { ownerId: string; organizerId: string; eventId: string }): { removed: boolean } {
		if (!this.ownedBy(input.ownerId)) return { removed: false };
		let removed = false;
		this.ctx.storage.transactionSync(() => {
			removed =
				this.sql.exec("DELETE FROM events WHERE id = ? AND organizer_id = ?", input.eventId, input.organizerId)
					.rowsWritten > 0;
			if (removed) this.setMeta("event_count", String(Math.max(0, Number(this.meta("event_count") ?? 1) - 1)));
		});
		return { removed };
	}

	override async alarm(): Promise<void> {
		// The runtime can fire an alarm while one runs. One drain at a time.
		if (this.drainTask) return this.drainTask;
		this.drainTask = this.drain();
		try {
			await this.drainTask;
		} finally {
			this.drainTask = null;
		}
	}

	/**
	 * Delivers the outbox. Each row names an event and an attendee. The delivery reads the event now: when the
	 * attendee is still on it, the attendee gets the current copy, else it loses the copy. So the rows need no
	 * order, and a row that a later change touched again delivers that change. A row that fails 8 times is
	 * dropped, and the copy of that attendee stays stale until the next change of the event.
	 */
	private async drain(): Promise<void> {
		const ownerId = this.meta("owner_id");
		const now = Date.now();
		const rows = this.sql
			.exec<{ event_id: string; target: string; gen: number; attempts: number }>(
				"SELECT event_id, target, gen, attempts FROM outbox WHERE next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?",
				now,
				OUTBOX_BATCH,
			)
			.toArray();
		for (const row of rows) {
			try {
				if (ownerId === null) throw new Error("The calendar has no owner.");
				await this.deliver(ownerId, row.event_id, row.target);
				this.sql.exec(
					"DELETE FROM outbox WHERE event_id = ? AND target = ? AND gen = ?",
					row.event_id,
					row.target,
					row.gen,
				);
			} catch (error) {
				const attempts = row.attempts + 1;
				const message = error instanceof Error ? error.message : String(error);
				log(attempts >= OUTBOX_MAX_ATTEMPTS ? "error" : "warn", "calendar invitation delivery failed", {
					eventId: row.event_id,
					attempts,
					error: message,
				});
				if (attempts >= OUTBOX_MAX_ATTEMPTS) {
					this.sql.exec(
						"DELETE FROM outbox WHERE event_id = ? AND target = ? AND gen = ?",
						row.event_id,
						row.target,
						row.gen,
					);
				} else {
					this.sql.exec(
						`UPDATE outbox SET attempts = ?, next_attempt_at = ?, last_error = ?
						WHERE event_id = ? AND target = ? AND gen = ?`,
						attempts,
						Date.now() + backoff(attempts),
						message.slice(0, 500),
						row.event_id,
						row.target,
						row.gen,
					);
				}
			}
		}
		const next = this.sql.exec<{ at: number | null }>("SELECT MIN(next_attempt_at) AS at FROM outbox").toArray()[0]?.at;
		if (next !== null && next !== undefined) await this.ctx.storage.setAlarm(Math.max(next, Date.now()));
	}

	/** One delivery to the calendar of an attendee. It is safe to run two times. */
	private async deliver(ownerId: string, eventId: string, target: string): Promise<void> {
		const stub = this.env.CALENDAR.get(this.env.CALENDAR.idFromName(target));
		const event = this.row(eventId);
		if (event && event.organizer_id === null && event.attendees.includes(target)) {
			const { id, revision, title, description, location, visibility, attendees } = event;
			await stub.applyInvite({
				ownerId: target,
				organizerId: ownerId,
				event: {
					id,
					revision,
					title,
					description,
					location,
					visibility,
					attendees,
					all_day: event.all_day,
					start_at: event.start_at,
					end_at: event.end_at,
					start_date: event.start_date,
					end_date: event.end_date,
					time_zone: event.time_zone,
				},
			});
			return;
		}
		await stub.removeInvite({ ownerId: target, organizerId: ownerId, eventId });
	}
}
