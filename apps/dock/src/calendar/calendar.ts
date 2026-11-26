import { DurableObject } from "cloudflare:workers";
import {
	anchorOf,
	CALENDAR_LIMITS,
	checkRecurrence,
	DEFAULT_REMINDER_MINUTES,
	type EventResponse,
	expandOccurrences,
	firstOccurrenceAfter,
	type Occurrence,
	occurrenceAt,
	occurrenceId,
	type RecurrenceRule,
	seriesEnd,
} from "@asterra/contracts";
import { type CalendarPushJob, enqueueCalendarPush } from "../chat/index.ts";
import type { CalendarReminderInput } from "../identity/index.ts";
import { log } from "../platform/index.ts";

// Each person, agent and service account has one CalendarDO. Its name is the principal id. It holds the
// events of the calendar of that principal in its SQLite database.
//
// - A series has one row in `events` with its rule. The changes and the cancellations of single occurrences
//   are rows of `event_overrides`, keyed by the key of the occurrence. A change of one occurrence never
//   changes the rule, so the other occurrences stay where they are.
// - An organizer sends the full state of an event to the calendar of each attendee through the `outbox`. The
//   attendee keeps a copy with the same id. A copy takes a state only when its `sequence` is higher, so a retry
//   and a late delivery change nothing.
// - The object keeps the next reminder of each event in `reminders`. One alarm serves the reminders and the
//   outbox. Each change computes the next reminder of the event again, so a reminder of a moved, cancelled or
//   declined occurrence cannot stay.

type Row = Record<string, SqlStorageValue>;

/** An expected failure, as a value: an error that a Durable Object throws loses its class over RPC. */
export type Refusal = { error: { code: "invalid" | "not_found" | "conflict" | "forbidden"; message: string } };

function refuse(code: Refusal["error"]["code"], message: string): Refusal {
	return { error: { code, message } };
}

const NOT_FOUND = "Your calendar has no event with that id.";
const NO_OCCURRENCE = "The event has no occurrence with that id.";
const ORGANIZER_ONLY =
	"Only the organizer can change this event. Use calendar.respond_to_event and calendar.set_reminder for an invitation.";

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

export interface PrincipalRef {
	principal_id: string;
	display_name: string;
}

/** The organizer of an event, with its kind for the activity of a reminder. */
export interface OrganizerRef extends PrincipalRef {
	kind: "human" | "agent";
}

export interface AttendeeRecord extends PrincipalRef {
	response: EventResponse;
}

/** The row of an event. For a series, the time is the time of the first occurrence. */
export interface EventRecord extends EventFields {
	id: string;
	revision: number;
	created_at: number;
	updated_at: number;
	recurrence: RecurrenceRule | null;
	series_end_at: number | null;
	role: "organizer" | "attendee";
	organizer: OrganizerRef | null;
	sequence: number;
	my_response: EventResponse | null;
	my_responded_at: number;
	reminder_minutes: number | null;
}

/** One entry of a calendar: a one-off event, a series, or one occurrence of a series. */
export interface EventView extends EventFields {
	id: string;
	revision: number;
	created_at: number;
	updated_at: number;
	recurrence: RecurrenceRule | null;
	/** The key of the occurrence. Null for a one-off event and for a series as a whole. */
	occurrence_key: string | null;
	/** The start of the occurrence as the rule gives it: UTC ms (timed) or a date (all-day). */
	original_start_at: number | null;
	original_date: string | null;
	is_exception: boolean;
	role: "organizer" | "attendee";
	organizer: OrganizerRef | null;
	attendees: AttendeeRecord[];
	my_response: EventResponse | null;
	reminder_minutes: number | null;
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
	/** The sort key of the last entry of the page before: `sort_id` is the occurrence id or the event id. */
	after: { start_at: number; id: string } | null;
	limit: number;
}

export interface CreateInput {
	id: string;
	fields: EventFields;
	recurrence: RecurrenceRule | null;
	organizer: OrganizerRef;
	attendees: PrincipalRef[];
	reminderMinutes: number | null;
	idempotency?: { key: string; requestHash: string } | undefined;
}

export interface UpdateInput {
	patch: Partial<EventFields>;
	/** Undefined keeps the rule. Null makes a one-off event. */
	recurrence?: RecurrenceRule | null | undefined;
	/** Undefined keeps the attendees. */
	attendees?: PrincipalRef[] | undefined;
	baseRevision: number | undefined;
}

/** The full state of an event that an organizer sends to an attendee. */
export interface EventSnapshot {
	v: 1;
	event_id: string;
	sequence: number;
	deleted: boolean;
	revision?: number;
	organizer?: OrganizerRef;
	fields?: EventFields;
	recurrence?: RecurrenceRule | null;
	series_end_at?: number | null;
	overrides?: OverrideRecord[];
	attendees?: (AttendeeRecord & { responded_at: number })[];
	occurrence_responses?: { occ_key: string; principal_id: string; response: EventResponse; responded_at: number }[];
	created_at?: number;
	updated_at?: number;
}

/** A response of an attendee, as the organizer gets it. `key` is empty for the entire series. */
export interface ResponseMessage {
	event_id: string;
	attendee_id: string;
	key: string;
	response: EventResponse;
	at: number;
}

/** A reminder that fired, as the PrincipalDO of the owner records it. */
export type CalendarReminderItem = CalendarReminderInput;

export interface OverrideRecord {
	occ_key: string;
	original_at: number;
	cancelled: boolean;
	title: string | null;
	description: string | null;
	location: string | null;
	start_at: number | null;
	end_at: number | null;
	start_date: string | null;
	end_date: string | null;
}

/** A key works for 24 hours, as in Drive. */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** A fired reminder stays in `reminder_log` this long after the start of its occurrence. */
const REMINDER_LOG_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * The most occurrences that `rearm` reads for the next reminder of a series. It is more than the overrides and
 * more than the occurrences of a count, so cancelled occurrences cannot stop the reminders of a series.
 */
const REARM_SCAN = Math.max(CALENDAR_LIMITS.exceptions, CALENDAR_LIMITS.recurrenceCount) + 1;
const OUTBOX_BATCH = 50;

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
		"ALTER TABLE events ADD COLUMN recurrence TEXT",
		"ALTER TABLE events ADD COLUMN series_end_at INTEGER",
		"ALTER TABLE events ADD COLUMN role TEXT NOT NULL DEFAULT 'organizer'",
		"ALTER TABLE events ADD COLUMN organizer_json TEXT",
		"ALTER TABLE events ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0",
		"ALTER TABLE events ADD COLUMN my_response TEXT",
		"ALTER TABLE events ADD COLUMN my_responded_at INTEGER NOT NULL DEFAULT 0",
		"ALTER TABLE events ADD COLUMN reminder_minutes INTEGER",
		"CREATE INDEX events_recurring ON events (start_at) WHERE recurrence IS NOT NULL",
		`CREATE TABLE event_overrides (
			event_id TEXT NOT NULL,
			occ_key TEXT NOT NULL,
			original_at INTEGER NOT NULL,
			cancelled INTEGER NOT NULL CHECK (cancelled IN (0, 1)),
			title TEXT,
			description TEXT,
			location TEXT,
			start_at INTEGER,
			end_at INTEGER,
			start_date TEXT,
			end_date TEXT,
			PRIMARY KEY (event_id, occ_key)
		) WITHOUT ROWID`,
		`CREATE TABLE event_attendees (
			event_id TEXT NOT NULL,
			principal_id TEXT NOT NULL,
			display_name TEXT NOT NULL,
			response TEXT NOT NULL DEFAULT 'needs_action',
			responded_at INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (event_id, principal_id)
		) WITHOUT ROWID`,
		`CREATE TABLE occurrence_responses (
			event_id TEXT NOT NULL,
			occ_key TEXT NOT NULL,
			principal_id TEXT NOT NULL,
			response TEXT NOT NULL,
			responded_at INTEGER NOT NULL,
			PRIMARY KEY (event_id, occ_key, principal_id)
		) WITHOUT ROWID`,
		`CREATE TABLE reminders (
			event_id TEXT PRIMARY KEY,
			occ_key TEXT NOT NULL,
			start_at INTEGER NOT NULL,
			fire_at INTEGER NOT NULL
		) WITHOUT ROWID`,
		"CREATE INDEX reminders_fire ON reminders (fire_at)",
		`CREATE TABLE reminder_log (
			event_id TEXT NOT NULL,
			occ_key TEXT NOT NULL,
			start_at INTEGER NOT NULL,
			PRIMARY KEY (event_id, occ_key, start_at)
		) WITHOUT ROWID`,
		`CREATE TABLE outbox (
			id TEXT PRIMARY KEY,
			kind TEXT NOT NULL CHECK (kind IN ('snapshot', 'response', 'reminder')),
			target_id TEXT NOT NULL,
			event_id TEXT NOT NULL,
			payload TEXT NOT NULL,
			version INTEGER NOT NULL,
			attempts INTEGER NOT NULL DEFAULT 0,
			next_attempt_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL
		) WITHOUT ROWID`,
		"CREATE INDEX outbox_due ON outbox (next_attempt_at)",
	],
];

const COLUMNS = `id, title, description, location, all_day, start_at, end_at, start_date, end_date, time_zone, revision,
	created_at, updated_at, recurrence, series_end_at, role, organizer_json, sequence, my_response, my_responded_at,
	reminder_minutes`;

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
		recurrence: row.recurrence == null ? null : (JSON.parse(row.recurrence as string) as RecurrenceRule),
		series_end_at: (row.series_end_at as number | null) ?? null,
		role: row.role === "attendee" ? "attendee" : "organizer",
		organizer: row.organizer_json == null ? null : (JSON.parse(row.organizer_json as string) as OrganizerRef),
		sequence: row.sequence as number,
		my_response: (row.my_response as EventResponse | null) ?? null,
		my_responded_at: (row.my_responded_at as number | null) ?? 0,
		reminder_minutes: (row.reminder_minutes as number | null) ?? null,
	};
}

function toOverride(row: Row): OverrideRecord {
	return {
		occ_key: row.occ_key as string,
		original_at: row.original_at as number,
		cancelled: row.cancelled === 1,
		title: (row.title as string | null) ?? null,
		description: (row.description as string | null) ?? null,
		location: (row.location as string | null) ?? null,
		start_at: (row.start_at as number | null) ?? null,
		end_at: (row.end_at as number | null) ?? null,
		start_date: (row.start_date as string | null) ?? null,
		end_date: (row.end_date as string | null) ?? null,
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

const TIME_KEYS = [
	"all_day",
	"start_at",
	"end_at",
	"start_date",
	"end_date",
	"time_zone",
] as const satisfies readonly (keyof EventTime)[];

function sameRule(a: RecurrenceRule | null, b: RecurrenceRule | null): boolean {
	if (a === null || b === null) return a === b;
	return a.frequency === b.frequency && a.interval === b.interval && a.until === b.until && a.count === b.count;
}

function seriesEndOf(time: EventTime, rule: RecurrenceRule | null): number | null {
	return rule === null ? null : seriesEnd(anchorOf(time), rule);
}

/** The overlap rule of a range: by instants for a timed entry, by dates for an all-day entry. */
function inRange(entry: EventTime, query: Pick<ListQuery, "min" | "max" | "minDate" | "maxDate">): boolean {
	if (entry.all_day) {
		return (
			entry.start_date !== null &&
			entry.end_date !== null &&
			entry.start_date < query.maxDate &&
			entry.end_date > query.minDate
		);
	}
	return entry.end_at > query.min && entry.start_at < query.max;
}

function sortId(view: EventView): string {
	return view.occurrence_key === null ? view.id : occurrenceId(view.id, view.occurrence_key);
}

function compareViews(a: EventView, b: EventView): number {
	if (a.start_at !== b.start_at) return a.start_at - b.start_at;
	const ia = sortId(a);
	const ib = sortId(b);
	return ia < ib ? -1 : ia > ib ? 1 : 0;
}

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

	private addCount(delta: number): void {
		this.setMeta("event_count", String(Math.max(0, Number(this.meta("event_count") ?? 0) + delta)));
	}

	/**
	 * Checks the caller. The first call keeps the owner, so a handler that opens the object of a different
	 * principal gets a refusal, never the events. Only the owner reaches the calendar in this layer.
	 */
	private enter(call: CalendarCall): Refusal | null {
		if (!this.pin(call.ownerId)) return refuse("not_found", NOT_FOUND);
		if (call.actorId !== call.ownerId) return refuse("not_found", NOT_FOUND);
		return null;
	}

	/** True when the object belongs to `ownerId`. The first call keeps the owner. */
	private pin(ownerId: string): boolean {
		const owner = this.meta("owner_id");
		if (owner === null) this.setMeta("owner_id", ownerId);
		return owner === null || owner === ownerId;
	}

	private row(id: string): EventRecord | null {
		const row = this.sql.exec<Row>(`SELECT ${COLUMNS} FROM events WHERE id = ?`, id).toArray()[0];
		return row ? toRecord(row) : null;
	}

	private attendeesOf(eventId: string): (AttendeeRecord & { responded_at: number })[] {
		return this.sql
			.exec<{ principal_id: string; display_name: string; response: EventResponse; responded_at: number }>(
				"SELECT principal_id, display_name, response, responded_at FROM event_attendees WHERE event_id = ? ORDER BY display_name, principal_id",
				eventId,
			)
			.toArray()
			.map((row) => ({ ...row }));
	}

	private overridesOf(eventId: string): Map<string, OverrideRecord> {
		const map = new Map<string, OverrideRecord>();
		for (const row of this.sql.exec<Row>("SELECT * FROM event_overrides WHERE event_id = ?", eventId)) {
			const record = toOverride(row);
			map.set(record.occ_key, record);
		}
		return map;
	}

	/** The responses of single occurrences: key, then principal. */
	private occurrenceResponses(eventId: string): Map<string, Map<string, { response: EventResponse; at: number }>> {
		const map = new Map<string, Map<string, { response: EventResponse; at: number }>>();
		for (const row of this.sql.exec<{
			occ_key: string;
			principal_id: string;
			response: EventResponse;
			responded_at: number;
		}>("SELECT occ_key, principal_id, response, responded_at FROM occurrence_responses WHERE event_id = ?", eventId)) {
			let inner = map.get(row.occ_key);
			if (!inner) {
				inner = new Map();
				map.set(row.occ_key, inner);
			}
			inner.set(row.principal_id, { response: row.response, at: row.responded_at });
		}
		return map;
	}

	// --- Views --------------------------------------------------------------------------------------

	/** The view of a one-off event or of a series as a whole. */
	private masterView(event: EventRecord): EventView {
		const owner = this.meta("owner_id");
		return {
			...this.fieldsOf(event),
			id: event.id,
			revision: event.revision,
			created_at: event.created_at,
			updated_at: event.updated_at,
			recurrence: event.recurrence,
			occurrence_key: null,
			original_start_at: null,
			original_date: null,
			is_exception: false,
			role: event.role,
			organizer: event.organizer,
			attendees: this.attendeesOf(event.id).map(({ principal_id, display_name, response }) => ({
				principal_id,
				display_name,
				response: principal_id === owner && event.my_response !== null ? event.my_response : response,
			})),
			my_response: event.role === "attendee" ? (event.my_response ?? "needs_action") : null,
			reminder_minutes: event.all_day ? null : event.reminder_minutes,
		};
	}

	private fieldsOf(event: EventFields): EventFields {
		const fields = {} as Record<string, unknown>;
		for (const key of FIELD_KEYS) fields[key] = event[key];
		return fields as unknown as EventFields;
	}

	/** The occurrences of a series, with their overrides, as views. `range` limits the expansion. */
	private seriesViews(
		event: EventRecord,
		range: { min: number; max: number },
		cap: number,
		keep: (view: EventView) => boolean,
	): EventView[] {
		const rule = event.recurrence;
		if (rule === null) return [];
		const anchor = anchorOf(event);
		const overrides = this.overridesOf(event.id);
		const responses = this.occurrenceResponses(event.id);
		const master = this.masterView(event);
		const owner = this.meta("owner_id");
		const views: EventView[] = [];
		const build = (occurrence: Occurrence, override: OverrideRecord | undefined): EventView => {
			const time: EventTime =
				override?.start_at != null
					? {
							all_day: event.all_day,
							start_at: override.start_at,
							end_at: override.end_at ?? override.start_at,
							start_date: override.start_date,
							end_date: override.end_date,
							time_zone: event.time_zone,
						}
					: {
							all_day: event.all_day,
							start_at: occurrence.start_at,
							end_at: occurrence.end_at,
							start_date: occurrence.start_date,
							end_date: occurrence.end_date,
							time_zone: event.time_zone,
						};
			const answers = responses.get(occurrence.key);
			const mine = owner === null ? undefined : answers?.get(owner);
			return {
				...master,
				...time,
				title: override?.title ?? event.title,
				description: override?.description ?? event.description,
				location: override?.location ?? event.location,
				occurrence_key: occurrence.key,
				original_start_at: occurrence.start_at,
				original_date: occurrence.start_date,
				is_exception: override !== undefined,
				attendees: master.attendees.map((attendee) => ({
					...attendee,
					response: answers?.get(attendee.principal_id)?.response ?? attendee.response,
				})),
				my_response: master.my_response === null ? null : (mine?.response ?? master.my_response),
			};
		};
		for (const occurrence of expandOccurrences(anchor, rule, range, cap)) {
			const override = overrides.get(occurrence.key);
			if (override?.cancelled || override?.start_at != null) continue;
			const view = build(occurrence, override);
			if (keep(view)) views.push(view);
		}
		for (const override of overrides.values()) {
			if (override.cancelled || override.start_at === null) continue;
			const occurrence = occurrenceAt(anchor, rule, override.occ_key);
			if (!occurrence) continue;
			const view = build(occurrence, override);
			if (view.end_at > range.min && view.start_at < range.max && keep(view)) views.push(view);
		}
		return views;
	}

	/** The view of one occurrence, or null when the rule makes no such occurrence or it is cancelled. */
	private occurrenceView(event: EventRecord, key: string): EventView | null {
		if (event.recurrence === null) return null;
		const anchor = anchorOf(event);
		const occurrence = occurrenceAt(anchor, event.recurrence, key);
		if (!occurrence) return null;
		const override = this.overridesOf(event.id).get(key);
		if (override?.cancelled) return null;
		const at = override?.start_at ?? occurrence.start_at;
		const views = this.seriesViews(
			event,
			{ min: Math.min(at, occurrence.start_at) - 1, max: Math.max(at, occurrence.start_at) + 1 },
			4,
			(view) => view.occurrence_key === key,
		);
		return views[0] ?? null;
	}

	// --- Reads --------------------------------------------------------------------------------------

	/** The entries of a range, first start first, and true when more follow. */
	list(call: CalendarCall, query: ListQuery): { events: EventView[]; more: boolean } | Refusal {
		const refused = this.enter(call);
		if (refused) return refused;
		const bindings: SqlStorageValue[] = [query.max, query.lowerBound, query.min, query.maxDate, query.minDate];
		let after = "";
		if (query.after) {
			after = "AND (start_at, id) > (?, ?)";
			bindings.push(query.after.start_at, query.after.id);
		}
		bindings.push(query.limit + 1);
		const single = this.sql
			.exec<Row>(
				`SELECT ${COLUMNS} FROM events
				WHERE start_at < ? AND start_at >= ? AND recurrence IS NULL
					AND ((all_day = 0 AND end_at > ?) OR (all_day = 1 AND start_date < ? AND end_date > ?))
					${after}
				ORDER BY start_at, id
				LIMIT ?`,
				...bindings,
			)
			.toArray()
			.map((row) => this.masterView(toRecord(row)));
		const entries = [...single, ...this.seriesInRange(query)];
		const cursor = query.after;
		const page = entries
			.filter((view) => {
				if (!cursor) return true;
				if (view.start_at !== cursor.start_at) return view.start_at > cursor.start_at;
				return sortId(view) > cursor.id;
			})
			.sort(compareViews);
		return { events: page.slice(0, query.limit), more: page.length > query.limit };
	}

	/**
	 * The occurrences of each series in a range, without the cancelled occurrences. A moved occurrence can be
	 * before the first start of its series or after `series_end_at`, so the query also reads each series with
	 * a moved occurrence in the range.
	 */
	private seriesInRange(query: Pick<ListQuery, "min" | "max" | "minDate" | "maxDate">): EventView[] {
		const series = this.sql
			.exec<Row>(
				`SELECT ${COLUMNS} FROM events
				WHERE recurrence IS NOT NULL AND (
					(start_at < ? AND (series_end_at IS NULL OR series_end_at > ?))
					OR EXISTS (
						SELECT 1 FROM event_overrides AS moved
						WHERE moved.event_id = events.id AND moved.cancelled = 0 AND moved.start_at < ? AND moved.end_at > ?
					)
				)`,
				query.max,
				query.min,
				query.max,
				query.min,
			)
			.toArray()
			.map(toRecord);
		return series.flatMap((event) =>
			this.seriesViews(event, { min: query.min, max: query.max }, CALENDAR_LIMITS.occurrencesPerSeries, (view) =>
				inRange(view, query),
			),
		);
	}

	get(call: CalendarCall, eventId: string): EventView | Refusal {
		const refused = this.enter(call);
		if (refused) return refused;
		const event = this.row(eventId);
		return event ? this.masterView(event) : refuse("not_found", NOT_FOUND);
	}

	/**
	 * The busy times of the owner in a range: timed events and occurrences, without cancelled occurrences and
	 * without the events and occurrences that the owner declined. The handler checks the access.
	 */
	freeBusy(ownerId: string, min: number, max: number): { start: number; end: number }[] {
		if (this.meta("owner_id") !== ownerId) return [];
		const query = { min, max, minDate: "0000-00-00", maxDate: "0000-00-00" };
		const single = this.sql
			.exec<Row>(
				`SELECT ${COLUMNS} FROM events
				WHERE all_day = 0 AND recurrence IS NULL AND start_at < ? AND end_at > ? AND start_at >= ?`,
				max,
				min,
				min - (CALENDAR_LIMITS.eventDays + 1) * 86_400_000,
			)
			.toArray()
			.map((row) => this.masterView(toRecord(row)));
		const busy = [...single, ...this.seriesInRange(query)]
			.filter((view) => !view.all_day && view.my_response !== "declined")
			.map((view) => ({ start: Math.max(view.start_at, min), end: Math.min(view.end_at, max) }))
			.sort((a, b) => a.start - b.start);
		const merged: { start: number; end: number }[] = [];
		for (const interval of busy) {
			const last = merged.at(-1);
			if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
			else merged.push({ ...interval });
		}
		return merged;
	}

	// --- Changes of the organizer ------------------------------------------------------------------

	/**
	 * Adds an event. With an idempotency key that a call with the same request used, it returns that event and
	 * adds nothing. The check and the write run with no await between them, so two calls with one key add one
	 * event.
	 */
	async create(call: CalendarCall, input: CreateInput): Promise<EventView | Refusal> {
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
				const event = this.row(earlier.event_id);
				return event
					? this.masterView(event)
					: refuse("conflict", "The event of this idempotency key does not exist now.");
			}
		}
		const count = Number(this.meta("event_count") ?? 0);
		if (count >= CALENDAR_LIMITS.events) {
			return refuse("invalid", `A calendar can have at most ${CALENDAR_LIMITS.events} events. Delete events first.`);
		}
		const { fields, recurrence } = input;
		if (recurrence !== null) {
			const problem = checkRecurrence(fields, recurrence);
			if (problem) return refuse("invalid", problem);
			if (this.seriesCount() >= CALENDAR_LIMITS.recurringEvents) {
				return refuse(
					"invalid",
					`A calendar can have at most ${CALENDAR_LIMITS.recurringEvents} repeated events. Delete a series first.`,
				);
			}
		}
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(
				`INSERT INTO events (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 'organizer', ?, 0, NULL, 0, ?)`,
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
				recurrence === null ? null : JSON.stringify(recurrence),
				seriesEndOf(fields, recurrence),
				JSON.stringify(input.organizer),
				fields.all_day ? null : input.reminderMinutes,
			);
			this.addCount(1);
			for (const attendee of input.attendees) {
				this.sql.exec(
					"INSERT INTO event_attendees (event_id, principal_id, display_name, response, responded_at) VALUES (?, ?, ?, 'needs_action', ?)",
					input.id,
					attendee.principal_id,
					attendee.display_name,
					now,
				);
			}
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
			if (input.attendees.length > 0) this.fanOut(input.id, []);
			this.rearm(input.id);
		});
		await this.scheduleAlarm();
		return this.masterView(this.row(input.id) as EventRecord);
	}

	private seriesCount(): number {
		return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE recurrence IS NOT NULL").one().n;
	}

	private checkRevision(event: EventRecord, baseRevision: number | undefined): Refusal | null {
		if (baseRevision !== undefined && baseRevision !== event.revision) {
			return refuse(
				"conflict",
				`The event has revision ${event.revision} now, not ${baseRevision}. Read it again, then try again.`,
			);
		}
		return null;
	}

	/**
	 * Changes the entire event or series. A change that changes nothing writes nothing and keeps the revision. A
	 * `baseRevision` that is not the revision of the event changes nothing. A change of the time or of the rule
	 * removes the overrides and the responses of single occurrences, and asks each attendee again.
	 */
	async update(
		call: CalendarCall,
		eventId: string,
		input: UpdateInput,
	): Promise<{ event: EventView; changed: boolean } | Refusal> {
		const refused = this.enter(call);
		if (refused) return refused;
		const event = this.row(eventId);
		if (!event) return refuse("not_found", NOT_FOUND);
		if (event.role !== "organizer") return refuse("forbidden", ORGANIZER_ONLY);
		const conflict = this.checkRevision(event, input.baseRevision);
		if (conflict) return conflict;
		const next: EventRecord = { ...event };
		for (const key of FIELD_KEYS) {
			if (input.patch[key] !== undefined) (next as unknown as Record<string, unknown>)[key] = input.patch[key];
		}
		if (input.recurrence !== undefined) next.recurrence = input.recurrence;
		if (next.recurrence !== null) {
			const problem = checkRecurrence(next, next.recurrence);
			if (problem) return refuse("invalid", problem);
			if (event.recurrence === null && this.seriesCount() >= CALENDAR_LIMITS.recurringEvents) {
				return refuse("invalid", `A calendar can have at most ${CALENDAR_LIMITS.recurringEvents} repeated events.`);
			}
		}
		const before = this.attendeesOf(eventId);
		const timeChanged =
			TIME_KEYS.some((key) => next[key] !== event[key]) || !sameRule(next.recurrence, event.recurrence);
		const fieldsChanged = FIELD_KEYS.some((key) => next[key] !== event[key]);
		const wanted = input.attendees;
		const attendeesChanged =
			wanted !== undefined &&
			(wanted.length !== before.length ||
				wanted.some((attendee) => !before.some((old) => old.principal_id === attendee.principal_id)));
		if (!fieldsChanged && !timeChanged && !attendeesChanged) return { event: this.masterView(event), changed: false };
		const now = Date.now();
		const removed =
			wanted === undefined ? [] : before.filter((old) => !wanted.some((a) => a.principal_id === old.principal_id));
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(
				`UPDATE events SET title = ?, description = ?, location = ?, all_day = ?, start_at = ?, end_at = ?,
					start_date = ?, end_date = ?, time_zone = ?, recurrence = ?, series_end_at = ?, revision = revision + 1,
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
				next.recurrence === null ? null : JSON.stringify(next.recurrence),
				seriesEndOf(next, next.recurrence),
				now,
				eventId,
			);
			if (timeChanged) {
				this.sql.exec("DELETE FROM event_overrides WHERE event_id = ?", eventId);
				this.sql.exec("DELETE FROM occurrence_responses WHERE event_id = ?", eventId);
				// The time of the reset is after each response that the organizer has, so the reset is the newer one.
				this.sql.exec(
					"UPDATE event_attendees SET response = 'needs_action', responded_at = MAX(responded_at + 1, ?) WHERE event_id = ?",
					now,
					eventId,
				);
			}
			for (const old of removed) {
				this.sql.exec("DELETE FROM event_attendees WHERE event_id = ? AND principal_id = ?", eventId, old.principal_id);
				this.sql.exec(
					"DELETE FROM occurrence_responses WHERE event_id = ? AND principal_id = ?",
					eventId,
					old.principal_id,
				);
			}
			for (const attendee of wanted ?? []) {
				this.sql.exec(
					`INSERT INTO event_attendees (event_id, principal_id, display_name, response, responded_at)
					VALUES (?, ?, ?, 'needs_action', ?) ON CONFLICT (event_id, principal_id) DO NOTHING`,
					eventId,
					attendee.principal_id,
					attendee.display_name,
					now,
				);
			}
			this.fanOut(
				eventId,
				removed.map((old) => old.principal_id),
			);
			this.rearm(eventId);
		});
		await this.scheduleAlarm();
		return { event: this.masterView(this.row(eventId) as EventRecord), changed: true };
	}

	/** Deletes an event, or with `dryRun` returns it without a change. Each attendee loses the copy. */
	async remove(
		call: CalendarCall,
		eventId: string,
		baseRevision: number | undefined,
		dryRun: boolean,
	): Promise<EventView | Refusal> {
		const refused = this.enter(call);
		if (refused) return refused;
		const event = this.row(eventId);
		if (!event) return refuse("not_found", NOT_FOUND);
		if (event.role !== "organizer") {
			return refuse("forbidden", "You cannot delete an invitation. Decline the event with calendar.respond_to_event.");
		}
		const conflict = this.checkRevision(event, baseRevision);
		if (conflict) return conflict;
		const view = this.masterView(event);
		if (dryRun) return view;
		this.ctx.storage.transactionSync(() => {
			const attendees = this.attendeesOf(eventId).map((attendee) => attendee.principal_id);
			this.fanOut(eventId, attendees);
			this.deleteEventRows(eventId);
		});
		await this.scheduleAlarm();
		return view;
	}

	private deleteEventRows(eventId: string): void {
		this.sql.exec("DELETE FROM events WHERE id = ?", eventId);
		this.sql.exec("DELETE FROM event_overrides WHERE event_id = ?", eventId);
		this.sql.exec("DELETE FROM event_attendees WHERE event_id = ?", eventId);
		this.sql.exec("DELETE FROM occurrence_responses WHERE event_id = ?", eventId);
		this.sql.exec("DELETE FROM reminders WHERE event_id = ?", eventId);
		this.sql.exec("DELETE FROM outbox WHERE event_id = ? AND kind = 'reminder'", eventId);
		this.addCount(-1);
	}

	/**
	 * Changes one occurrence of a series: its time, title, description or location. The rule stays, so the other
	 * occurrences stay. A change that makes the occurrence equal to the rule again removes its override.
	 */
	async updateOccurrence(
		call: CalendarCall,
		eventId: string,
		key: string,
		patch: Partial<EventFields>,
		baseRevision: number | undefined,
	): Promise<{ event: EventView; changed: boolean } | Refusal> {
		const refused = this.enter(call);
		if (refused) return refused;
		const event = this.row(eventId);
		if (!event) return refuse("not_found", NOT_FOUND);
		const current = this.occurrenceView(event, key);
		if (!current || event.recurrence === null) return refuse("not_found", NO_OCCURRENCE);
		if (event.role !== "organizer") return refuse("forbidden", ORGANIZER_ONLY);
		const conflict = this.checkRevision(event, baseRevision);
		if (conflict) return conflict;
		if (patch.all_day !== undefined && patch.all_day !== event.all_day) {
			return refuse(
				"invalid",
				event.all_day
					? "This occurrence is all-day: when must be all-day. To change the entire series, use calendar.update_event."
					: "This occurrence is timed: when must be timed. To change the entire series, use calendar.update_event.",
			);
		}
		if (patch.time_zone !== undefined && patch.time_zone !== event.time_zone) {
			return refuse(
				"invalid",
				"An occurrence uses the time zone of its series. To change it, use calendar.update_event.",
			);
		}
		const occurrence = occurrenceAt(anchorOf(event), event.recurrence, key) as Occurrence;
		const existing = this.overridesOf(eventId).get(key);
		const next: OverrideRecord = existing
			? { ...existing }
			: {
					occ_key: key,
					original_at: occurrence.start_at,
					cancelled: false,
					title: null,
					description: null,
					location: null,
					start_at: null,
					end_at: null,
					start_date: null,
					end_date: null,
				};
		for (const field of ["title", "description", "location"] as const) {
			const value = patch[field];
			if (value !== undefined) next[field] = value === event[field] ? null : value;
		}
		if (patch.start_at !== undefined && patch.end_at !== undefined) {
			const asRule = event.all_day
				? patch.start_date === occurrence.start_date && patch.end_date === occurrence.end_date
				: patch.start_at === occurrence.start_at && patch.end_at === occurrence.end_at;
			next.start_at = asRule ? null : patch.start_at;
			next.end_at = asRule ? null : patch.end_at;
			next.start_date = asRule || !event.all_day ? null : (patch.start_date ?? null);
			next.end_date = asRule || !event.all_day ? null : (patch.end_date ?? null);
		}
		const empty = next.title === null && next.description === null && next.location === null && next.start_at === null;
		const same =
			existing === undefined
				? empty
				: (["title", "description", "location", "start_at", "end_at", "start_date", "end_date"] as const).every(
						(field) => existing[field] === next[field],
					);
		if (same) return { event: current, changed: false };
		if (!existing && this.overridesOf(eventId).size >= CALENDAR_LIMITS.exceptions) {
			return refuse(
				"invalid",
				`A series can have at most ${CALENDAR_LIMITS.exceptions} changed or cancelled occurrences.`,
			);
		}
		const now = Date.now();
		const moved = (["start_at", "end_at", "start_date", "end_date"] as const).some(
			(field) => (existing?.[field] ?? null) !== next[field],
		);
		this.ctx.storage.transactionSync(() => {
			if (empty) {
				this.sql.exec("DELETE FROM event_overrides WHERE event_id = ? AND occ_key = ?", eventId, key);
			} else {
				this.writeOverride(eventId, next);
			}
			if (moved) this.askAgain(eventId, key, now);
			this.sql.exec("UPDATE events SET revision = revision + 1, updated_at = ? WHERE id = ?", now, eventId);
			this.fanOut(eventId, []);
			this.rearm(eventId);
		});
		await this.scheduleAlarm();
		const updated = this.row(eventId) as EventRecord;
		return { event: this.occurrenceView(updated, key) as EventView, changed: true };
	}

	/**
	 * Sets the response of each attendee to one occurrence to `needs_action`, after a change of its time. The row
	 * of the occurrence comes before the response of the series. Its time is after each response that the
	 * organizer has, so the reset is the newer one, and the copy of the attendee takes it from the state.
	 */
	private askAgain(eventId: string, key: string, now: number): void {
		const answers = this.occurrenceResponses(eventId).get(key);
		for (const attendee of this.attendeesOf(eventId)) {
			const at = Math.max(now, attendee.responded_at + 1, (answers?.get(attendee.principal_id)?.at ?? 0) + 1);
			this.sql.exec(
				`INSERT OR REPLACE INTO occurrence_responses (event_id, occ_key, principal_id, response, responded_at)
				VALUES (?, ?, ?, 'needs_action', ?)`,
				eventId,
				key,
				attendee.principal_id,
				at,
			);
		}
	}

	private writeOverride(eventId: string, record: OverrideRecord): void {
		this.sql.exec(
			`INSERT OR REPLACE INTO event_overrides
			(event_id, occ_key, original_at, cancelled, title, description, location, start_at, end_at, start_date, end_date)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			eventId,
			record.occ_key,
			record.original_at,
			record.cancelled ? 1 : 0,
			record.title,
			record.description,
			record.location,
			record.start_at,
			record.end_at,
			record.start_date,
			record.end_date,
		);
	}

	/** Cancels one occurrence of a series, or with `dryRun` returns it without a change. */
	async cancelOccurrence(
		call: CalendarCall,
		eventId: string,
		key: string,
		baseRevision: number | undefined,
		dryRun: boolean,
	): Promise<EventView | Refusal> {
		const refused = this.enter(call);
		if (refused) return refused;
		const event = this.row(eventId);
		if (!event) return refuse("not_found", NOT_FOUND);
		const current = this.occurrenceView(event, key);
		if (!current || event.recurrence === null) return refuse("not_found", NO_OCCURRENCE);
		if (event.role !== "organizer") return refuse("forbidden", ORGANIZER_ONLY);
		const conflict = this.checkRevision(event, baseRevision);
		if (conflict) return conflict;
		if (dryRun) return current;
		const existing = this.overridesOf(eventId).get(key);
		if (!existing && this.overridesOf(eventId).size >= CALENDAR_LIMITS.exceptions) {
			return refuse(
				"invalid",
				`A series can have at most ${CALENDAR_LIMITS.exceptions} changed or cancelled occurrences.`,
			);
		}
		const occurrence = occurrenceAt(anchorOf(event), event.recurrence, key) as Occurrence;
		const now = Date.now();
		this.ctx.storage.transactionSync(() => {
			this.writeOverride(eventId, {
				occ_key: key,
				original_at: occurrence.start_at,
				cancelled: true,
				title: null,
				description: null,
				location: null,
				start_at: null,
				end_at: null,
				start_date: null,
				end_date: null,
			});
			this.sql.exec("DELETE FROM occurrence_responses WHERE event_id = ? AND occ_key = ?", eventId, key);
			this.sql.exec("UPDATE events SET revision = revision + 1, updated_at = ? WHERE id = ?", now, eventId);
			this.fanOut(eventId, []);
			this.rearm(eventId);
		});
		await this.scheduleAlarm();
		return current;
	}

	// --- Changes of a participant ------------------------------------------------------------------

	/**
	 * Sets the response of the owner to an invitation, for the series (`key` null) or for one occurrence. A
	 * decline removes the pending reminder at once. The organizer gets the response through the outbox.
	 */
	async respond(
		call: CalendarCall,
		eventId: string,
		key: string | null,
		response: "accepted" | "declined",
	): Promise<EventView | Refusal> {
		const refused = this.enter(call);
		if (refused) return refused;
		const event = this.row(eventId);
		if (!event) return refuse("not_found", NOT_FOUND);
		if (key !== null && !this.occurrenceView(event, key)) return refuse("not_found", NO_OCCURRENCE);
		if (event.role !== "attendee" || event.organizer === null) {
			return refuse("invalid", "You are the organizer of this event. Only an attendee responds to an invitation.");
		}
		const latest = this.sql
			.exec<{ at: number | null }>(
				"SELECT MAX(responded_at) AS at FROM occurrence_responses WHERE event_id = ? AND principal_id = ?",
				eventId,
				call.ownerId,
			)
			.one().at;
		const at = Math.max(Date.now(), event.my_responded_at + 1, (latest ?? 0) + 1);
		this.ctx.storage.transactionSync(() => {
			if (key === null) {
				this.sql.exec("UPDATE events SET my_response = ?, my_responded_at = ? WHERE id = ?", response, at, eventId);
				this.sql.exec(
					"DELETE FROM occurrence_responses WHERE event_id = ? AND principal_id = ?",
					eventId,
					call.ownerId,
				);
			} else {
				this.sql.exec(
					`INSERT OR REPLACE INTO occurrence_responses (event_id, occ_key, principal_id, response, responded_at)
					VALUES (?, ?, ?, ?, ?)`,
					eventId,
					key,
					call.ownerId,
					response,
					at,
				);
			}
			const message: ResponseMessage = { event_id: eventId, attendee_id: call.ownerId, key: key ?? "", response, at };
			this.putOutbox(
				`resp:${eventId}:${key ?? ""}`,
				"response",
				event.organizer?.principal_id ?? "",
				eventId,
				JSON.stringify(message),
				at,
			);
			this.rearm(eventId);
		});
		await this.scheduleAlarm();
		const updated = this.row(eventId) as EventRecord;
		return key === null ? this.masterView(updated) : (this.occurrenceView(updated, key) as EventView);
	}

	/** Sets the own reminder of the owner. It does not change the revision. */
	async setReminder(call: CalendarCall, eventId: string, minutes: number | null): Promise<EventView | Refusal> {
		const refused = this.enter(call);
		if (refused) return refused;
		const event = this.row(eventId);
		if (!event) return refuse("not_found", NOT_FOUND);
		if (event.all_day && minutes !== null) return refuse("invalid", "An all-day event has no reminder.");
		this.ctx.storage.transactionSync(() => {
			this.sql.exec("UPDATE events SET reminder_minutes = ? WHERE id = ?", minutes, eventId);
			this.rearm(eventId);
		});
		await this.scheduleAlarm();
		return this.masterView(this.row(eventId) as EventRecord);
	}

	// --- Messages from other calendars --------------------------------------------------------------

	/**
	 * Takes the state of an event from its organizer. A state with a `sequence` that is not higher than the
	 * stored one changes nothing, so a retry and a late delivery are safe. Only the outbox of a CalendarDO calls it.
	 *
	 * - The response of the owner: the state has the response that the organizer keeps for the owner, with its
	 *   time. When that time is not older than the time of the own response, the copy takes it. So a reset of the
	 *   organizer (a change of the time or of the rule) applies, and a newer own response stays. The same rule
	 *   applies to the response to one occurrence, so a move of one occurrence asks again for that occurrence.
	 * - The limits: a new copy over a limit of the calendar is not stored. A copy that exists always updates.
	 */
	async applySnapshot(ownerId: string, snapshot: EventSnapshot): Promise<void> {
		if (!this.pin(ownerId)) return;
		const existing = this.row(snapshot.event_id);
		if (existing && (existing.role !== "attendee" || snapshot.sequence <= existing.sequence)) return;
		if (snapshot.deleted) {
			if (existing) this.ctx.storage.transactionSync(() => this.deleteEventRows(snapshot.event_id));
			await this.scheduleAlarm();
			return;
		}
		const fields = snapshot.fields;
		if (!fields || !snapshot.organizer) return;
		const recurrence = snapshot.recurrence ?? null;
		if (!existing) {
			const limit =
				Number(this.meta("event_count") ?? 0) >= CALENDAR_LIMITS.events
					? "events"
					: recurrence !== null && this.seriesCount() >= CALENDAR_LIMITS.recurringEvents
						? "series"
						: null;
			if (limit) {
				log("warn", "calendar invitation not stored: the calendar is at a limit", { limit });
				return;
			}
		}
		const now = Date.now();
		const theirs = snapshot.attendees?.find((attendee) => attendee.principal_id === ownerId);
		// With no row of the owner in the state, a copy that exists keeps its response.
		const mine =
			existing && (!theirs || theirs.responded_at < existing.my_responded_at)
				? { response: existing.my_response ?? "needs_action", at: existing.my_responded_at }
				: { response: theirs?.response ?? "needs_action", at: theirs?.responded_at ?? now };
		this.ctx.storage.transactionSync(() => {
			const reminder = existing ? existing.reminder_minutes : fields.all_day ? null : DEFAULT_REMINDER_MINUTES;
			this.sql.exec(
				`INSERT OR REPLACE INTO events (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'attendee', ?, ?, ?, ?, ?)`,
				snapshot.event_id,
				fields.title,
				fields.description,
				fields.location,
				fields.all_day ? 1 : 0,
				fields.start_at,
				fields.end_at,
				fields.start_date,
				fields.end_date,
				fields.time_zone,
				snapshot.revision ?? 1,
				snapshot.created_at ?? now,
				snapshot.updated_at ?? now,
				recurrence === null ? null : JSON.stringify(recurrence),
				snapshot.series_end_at ?? null,
				JSON.stringify(snapshot.organizer),
				snapshot.sequence,
				mine.response,
				mine.at,
				reminder,
			);
			if (!existing) this.addCount(1);
			this.sql.exec("DELETE FROM event_overrides WHERE event_id = ?", snapshot.event_id);
			for (const override of snapshot.overrides ?? []) this.writeOverride(snapshot.event_id, override);
			this.sql.exec("DELETE FROM event_attendees WHERE event_id = ?", snapshot.event_id);
			for (const attendee of snapshot.attendees ?? []) {
				this.sql.exec(
					"INSERT INTO event_attendees (event_id, principal_id, display_name, response, responded_at) VALUES (?, ?, ?, ?, ?)",
					snapshot.event_id,
					attendee.principal_id,
					attendee.display_name,
					attendee.response,
					attendee.responded_at,
				);
			}
			// The own responses of single occurrences that are newer than the response of the series stay: they can
			// be newer than the state of the organizer.
			this.sql.exec(
				"DELETE FROM occurrence_responses WHERE event_id = ? AND (principal_id != ? OR responded_at <= ?)",
				snapshot.event_id,
				ownerId,
				mine.at,
			);
			const own = this.occurrenceResponses(snapshot.event_id);
			for (const answer of snapshot.occurrence_responses ?? []) {
				if (answer.principal_id === ownerId) {
					// The row of the owner in the state is a reset of the organizer, or a response that the owner sent.
					// The newer one of it and the own row stays.
					const local = own.get(answer.occ_key)?.get(ownerId);
					if (answer.responded_at <= mine.at || (local && local.at > answer.responded_at)) continue;
				}
				this.sql.exec(
					"INSERT OR REPLACE INTO occurrence_responses (event_id, occ_key, principal_id, response, responded_at) VALUES (?, ?, ?, ?, ?)",
					snapshot.event_id,
					answer.occ_key,
					answer.principal_id,
					answer.response,
					answer.responded_at,
				);
			}
			this.rearm(snapshot.event_id);
		});
		await this.scheduleAlarm();
	}

	/**
	 * Takes the response of an attendee. A response that is older than the stored one changes nothing, so the
	 * order of delivery does not matter. Only the outbox of a CalendarDO calls it.
	 */
	async applyResponse(ownerId: string, message: ResponseMessage): Promise<void> {
		if (!this.pin(ownerId)) return;
		const event = this.row(message.event_id);
		if (event?.role !== "organizer") return;
		const attendee = this.attendeesOf(message.event_id).find((a) => a.principal_id === message.attendee_id);
		if (!attendee) return;
		let changed = false;
		this.ctx.storage.transactionSync(() => {
			if (message.key === "") {
				if (message.at <= attendee.responded_at) return;
				this.sql.exec(
					"UPDATE event_attendees SET response = ?, responded_at = ? WHERE event_id = ? AND principal_id = ?",
					message.response,
					message.at,
					message.event_id,
					message.attendee_id,
				);
				this.sql.exec(
					"DELETE FROM occurrence_responses WHERE event_id = ? AND principal_id = ? AND responded_at < ?",
					message.event_id,
					message.attendee_id,
					message.at,
				);
				changed = true;
			} else {
				if (message.at <= attendee.responded_at || !this.occurrenceView(event, message.key)) return;
				const earlier = this.occurrenceResponses(message.event_id).get(message.key)?.get(message.attendee_id);
				if (earlier && earlier.at >= message.at) return;
				this.sql.exec(
					"INSERT OR REPLACE INTO occurrence_responses (event_id, occ_key, principal_id, response, responded_at) VALUES (?, ?, ?, ?, ?)",
					message.event_id,
					message.key,
					message.attendee_id,
					message.response,
					message.at,
				);
				changed = true;
			}
			if (changed) this.fanOut(message.event_id, []);
		});
		if (changed) await this.scheduleAlarm();
	}

	// --- The outbox ----------------------------------------------------------------------------------

	/**
	 * Adds 1 to the sequence of an event and sends its new state to each attendee. Each principal in `removed`
	 * gets a delete instead. One row for each target holds only the newest version.
	 */
	private fanOut(eventId: string, removed: readonly string[]): void {
		const event = this.row(eventId);
		const sequence = (event?.sequence ?? 0) + 1;
		if (event) this.sql.exec("UPDATE events SET sequence = ? WHERE id = ?", sequence, eventId);
		const targets = new Set([...this.attendeesOf(eventId).map((a) => a.principal_id), ...removed]);
		for (const target of targets)
			this.putOutbox(`snap:${eventId}:${target}`, "snapshot", target, eventId, "", sequence);
	}

	private putOutbox(
		id: string,
		kind: "snapshot" | "response" | "reminder",
		target: string,
		eventId: string,
		payload: string,
		version: number,
	): void {
		const now = Date.now();
		this.sql.exec(
			`INSERT INTO outbox (id, kind, target_id, event_id, payload, version, attempts, next_attempt_at, created_at)
			VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
			ON CONFLICT (id) DO UPDATE SET payload = excluded.payload, version = excluded.version, attempts = 0,
				next_attempt_at = excluded.next_attempt_at`,
			id,
			kind,
			target,
			eventId,
			payload,
			version,
			now,
			now,
		);
	}

	/** The state of an event for one attendee, or a delete when the event or the attendee is gone. */
	private snapshotFor(eventId: string, target: string, version: number): EventSnapshot {
		const event = this.row(eventId);
		const attendees = event ? this.attendeesOf(eventId) : [];
		if (event?.role !== "organizer" || !attendees.some((a) => a.principal_id === target)) {
			return { v: 1, event_id: eventId, sequence: Math.max(version, event?.sequence ?? 0), deleted: true };
		}
		const responses: NonNullable<EventSnapshot["occurrence_responses"]> = [];
		for (const [occ_key, inner] of this.occurrenceResponses(eventId)) {
			for (const [principal_id, answer] of inner) {
				responses.push({ occ_key, principal_id, response: answer.response, responded_at: answer.at });
			}
		}
		return {
			v: 1,
			event_id: eventId,
			sequence: event.sequence,
			deleted: false,
			revision: event.revision,
			organizer: event.organizer ?? { principal_id: this.meta("owner_id") ?? "", display_name: "", kind: "human" },
			fields: this.fieldsOf(event),
			recurrence: event.recurrence,
			series_end_at: event.series_end_at,
			overrides: [...this.overridesOf(eventId).values()],
			attendees,
			occurrence_responses: responses,
			created_at: event.created_at,
			updated_at: event.updated_at,
		};
	}

	private async deliver(row: {
		id: string;
		kind: string;
		target_id: string;
		event_id: string;
		payload: string;
		version: number;
	}): Promise<boolean> {
		const owner = this.meta("owner_id") ?? "";
		if (row.kind === "snapshot") {
			const stub = this.env.CALENDAR.get(this.env.CALENDAR.idFromName(row.target_id));
			await stub.applySnapshot(row.target_id, this.snapshotFor(row.event_id, row.target_id, row.version));
			return true;
		}
		if (row.kind === "response") {
			const stub = this.env.CALENDAR.get(this.env.CALENDAR.idFromName(row.target_id));
			await stub.applyResponse(row.target_id, JSON.parse(row.payload) as ResponseMessage);
			return true;
		}
		const item = JSON.parse(row.payload) as CalendarReminderItem;
		// A reminder after the start helps nobody. A reminder that the current state does not give is dropped.
		if (item.start_at <= Date.now() || !this.reminderIsCurrent(item)) return true;
		const principal = this.env.PRINCIPAL.get(this.env.PRINCIPAL.idFromName(owner));
		const devices = await principal.recordCalendarReminder(item);
		if (devices.length > 0) {
			const jobs: CalendarPushJob[] = devices.map((subscriptionId) => ({
				v: 1,
				kind: "calendar_reminder",
				principalId: owner,
				subscriptionId,
				reminderId: item.id,
				eventId: item.event_id,
				occurrenceId: item.occurrence_id,
				startAt: item.start_at,
				minutes: item.minutes,
			}));
			await enqueueCalendarPush(this.env, jobs);
		}
		return true;
	}

	// --- Reminders ----------------------------------------------------------------------------------

	/**
	 * True when the current state of the event still gives this reminder. A reminder row can wait in the outbox
	 * for a retry. A move, a cancel, a decline, a delete or the removal of the reminder in that time makes the
	 * row stale.
	 */
	private reminderIsCurrent(item: CalendarReminderItem): boolean {
		const event = this.row(item.event_id);
		if (!event || event.reminder_minutes === null || event.all_day) return false;
		if (item.occurrence_id === null) {
			if (event.role === "attendee" && event.my_response === "declined") return false;
			return event.recurrence === null && event.start_at === item.start_at;
		}
		const view = this.occurrenceView(event, item.occurrence_id.slice(item.event_id.length + 1));
		if (!view || view.start_at !== item.start_at) return false;
		return !(event.role === "attendee" && view.my_response === "declined");
	}

	/**
	 * Computes the next reminder of an event again from the current state. It picks the first occurrence that
	 * starts after now, is not cancelled or declined, and has no fired reminder. For an occurrence, declined is
	 * the response of the occurrence, or the response of the series when the occurrence has none. When its reminder time is in the
	 * past, the reminder fires at once.
	 */
	private rearm(eventId: string): void {
		this.sql.exec("DELETE FROM reminders WHERE event_id = ?", eventId);
		const event = this.row(eventId);
		if (!event || event.reminder_minutes === null || event.all_day) return;
		const invited = event.role === "attendee";
		if (invited && event.recurrence === null && event.my_response === "declined") return;
		const lead = event.reminder_minutes * 60_000;
		const now = Date.now();
		const fired = (key: string, start: number) =>
			this.sql
				.exec("SELECT 1 FROM reminder_log WHERE event_id = ? AND occ_key = ? AND start_at = ?", eventId, key, start)
				.toArray().length > 0;
		let best: { key: string; start: number } | null = null;
		if (event.recurrence === null) {
			if (event.start_at > now && !fired("", event.start_at)) best = { key: "", start: event.start_at };
		} else {
			const owner = this.meta("owner_id") ?? "";
			const overrides = this.overridesOf(eventId);
			const responses = this.occurrenceResponses(eventId);
			// The response of one occurrence comes before the response of the series, as in the views. So an accepted
			// occurrence of a declined series has a reminder.
			const declined = (key: string) =>
				invited && (responses.get(key)?.get(owner)?.response ?? event.my_response) === "declined";
			const anchor = anchorOf(event);
			// The walk stops at the first occurrence that can have a reminder. It builds no list.
			const next = firstOccurrenceAfter(anchor, event.recurrence, now, REARM_SCAN, (occurrence) => {
				const override = overrides.get(occurrence.key);
				if (override?.cancelled || override?.start_at != null || declined(occurrence.key)) return false;
				return !fired(occurrence.key, occurrence.start_at);
			});
			if (next) best = { key: next.key, start: next.start_at };
			for (const override of overrides.values()) {
				if (override.cancelled || override.start_at === null || override.start_at <= now) continue;
				if (declined(override.occ_key) || fired(override.occ_key, override.start_at)) continue;
				if (best === null || override.start_at < best.start) best = { key: override.occ_key, start: override.start_at };
			}
		}
		if (best === null) return;
		this.sql.exec(
			"INSERT INTO reminders (event_id, occ_key, start_at, fire_at) VALUES (?, ?, ?, ?)",
			eventId,
			best.key,
			best.start,
			best.start - lead,
		);
	}

	private async scheduleAlarm(): Promise<void> {
		const next = this.sql
			.exec<{ at: number | null }>(
				"SELECT MIN(at) AS at FROM (SELECT MIN(fire_at) AS at FROM reminders UNION ALL SELECT MIN(next_attempt_at) FROM outbox)",
			)
			.one().at;
		if (next === null) {
			await this.ctx.storage.deleteAlarm();
			return;
		}
		const due = Math.max(next, Date.now());
		const current = await this.ctx.storage.getAlarm();
		if (current === null || current > due) await this.ctx.storage.setAlarm(due);
	}

	/** Fires the due reminders, then delivers the due rows of the outbox. */
	override async alarm(): Promise<void> {
		const now = Date.now();
		const owner = this.meta("owner_id") ?? "";
		const due = this.sql
			.exec<{ event_id: string; occ_key: string; start_at: number; fire_at: number }>(
				"SELECT event_id, occ_key, start_at, fire_at FROM reminders WHERE fire_at <= ?",
				now,
			)
			.toArray();
		for (const reminder of due) {
			this.ctx.storage.transactionSync(() => {
				const event = this.row(reminder.event_id);
				if (event && reminder.start_at > now && event.reminder_minutes !== null) {
					this.sql.exec(
						"INSERT OR IGNORE INTO reminder_log (event_id, occ_key, start_at) VALUES (?, ?, ?)",
						reminder.event_id,
						reminder.occ_key,
						reminder.start_at,
					);
					const view = reminder.occ_key === "" ? this.masterView(event) : this.occurrenceView(event, reminder.occ_key);
					const id = `calrem:${reminder.event_id}:${reminder.occ_key}:${reminder.start_at}`;
					const organizer = event.organizer ?? { principal_id: owner, display_name: "", kind: "human" as const };
					const item: CalendarReminderItem = {
						id,
						event_id: reminder.event_id,
						occurrence_id: reminder.occ_key === "" ? null : occurrenceId(reminder.event_id, reminder.occ_key),
						title: view?.title ?? event.title,
						start_at: reminder.start_at,
						minutes: event.reminder_minutes,
						actor: organizer,
					};
					this.sql.exec(
						`INSERT OR IGNORE INTO outbox (id, kind, target_id, event_id, payload, version, attempts, next_attempt_at, created_at)
						VALUES (?, 'reminder', ?, ?, ?, 1, 0, ?, ?)`,
						id,
						owner,
						reminder.event_id,
						JSON.stringify(item),
						now,
						now,
					);
				}
				this.rearm(reminder.event_id);
			});
		}
		await this.deliverDue();
		this.sql.exec("DELETE FROM reminder_log WHERE start_at < ?", Date.now() - REMINDER_LOG_MS);
		await this.scheduleAlarm();
	}

	private async deliverDue(): Promise<void> {
		const rows = this.sql
			.exec<{
				id: string;
				kind: string;
				target_id: string;
				event_id: string;
				payload: string;
				version: number;
				attempts: number;
			}>(
				"SELECT id, kind, target_id, event_id, payload, version, attempts FROM outbox WHERE next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT ?",
				Date.now(),
				OUTBOX_BATCH,
			)
			.toArray();
		for (const row of rows) {
			try {
				await this.deliver(row);
				// A change during the await can replace the row with a newer version. That version stays.
				this.sql.exec("DELETE FROM outbox WHERE id = ? AND version = ?", row.id, row.version);
			} catch (error) {
				const attempts = row.attempts + 1;
				const delay = Math.min(5_000 * 2 ** attempts, 60 * 60_000);
				this.sql.exec(
					"UPDATE outbox SET attempts = ?, next_attempt_at = ? WHERE id = ? AND version = ?",
					attempts,
					Date.now() + delay,
					row.id,
					row.version,
				);
				log("warn", "calendar outbox delivery failed", {
					kind: row.kind,
					attempts,
					error: error instanceof Error ? error.name : "unknown",
				});
			}
		}
	}
}
