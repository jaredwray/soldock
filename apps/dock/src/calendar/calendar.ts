import { DurableObject } from "cloudflare:workers";
import { CALENDAR_LIMITS, type CalendarWebhookEvent, DAY_MS } from "@asterra/contracts";
import { decodeCursor, encodeCursor, log, newId } from "../platform/index.ts";
import type { CalendarWebhookEventJob } from "../webhooks/index.ts";

// Each person, agent and service account has one CalendarDO. Its name is the principal id. It holds the
// events of the calendar of that principal in its SQLite database.
//
// A meeting is an event with attendees. The event of the organizer is the authority. Each attendee has a copy
// with the same `uid`. The organizer sends a full snapshot of the meeting to each attendee, and each attendee
// sends its answer to the organizer, through the outbox of this object and its alarm. Each message is safe to
// apply two times and in each order: see `applyMeeting` and `applyReply`.
//
// Each committed change writes one row of `changes` in its own transaction (`noteChange`). That row is the one
// record of the change for each consumer: `calendar.list_changes` reads it, the events socket gets a hint, and
// MCP Events get a queue job with the id of the row. The alarm publishes the rows in order (`publishChanges`).

type Row = Record<string, SqlStorageValue>;

/** An expected failure, as a value: an error that a Durable Object throws loses its class over RPC. */
export type Refusal = { error: { code: "invalid" | "not_found" | "conflict" | "forbidden"; message: string } };

function refuse(code: Refusal["error"]["code"], message: string): Refusal {
	return { error: { code, message } };
}

const NOT_FOUND = "Your calendar has no event with that id.";

/** The answer of an attendee. `pending` is no answer yet. */
export type Response = "pending" | "accepted" | "tentative" | "declined";
export type Answer = Exclude<Response, "pending">;

/** The caller of the object. Only the owner reaches the calendar. */
export interface CalendarCall {
	/** The principal that owns the calendar. The handler opens the object of this principal. */
	ownerId: string;
	/** The principal of the call. */
	actorId: string;
	/** The address and the name of the owner, for the meetings that the owner organizes. */
	ownerEmail: string;
	ownerName: string;
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

/** An attendee that the organizer invites. `key` is the principal id. */
export interface AttendeeRef {
	key: string;
	principal_id: string | null;
	email: string;
	name: string;
}

export interface AttendeeRecord extends AttendeeRef {
	response: Response;
	/** UTC ms of the last answer, or null. */
	responded_at: number | null;
}

export interface OrganizerRef {
	principal_id: string | null;
	email: string;
	name: string;
}

export interface EventRecord extends EventFields {
	id: string;
	/** The identity of the meeting. Each calendar has at most one event for a uid. */
	uid: string;
	/** `owner` for an event of the owner. `attendee` for the copy of a meeting of a different principal. */
	role: "owner" | "attendee";
	/** The organizer counter of the meeting. See `MeetingMessage.sequence`. */
	sequence: number;
	revision: number;
	created_at: number;
	updated_at: number;
	/** The organizer of a copy. Null on an event of the owner. */
	organizer: OrganizerRef | null;
	/** The attendees, without the organizer. */
	attendees: AttendeeRecord[];
	/** The answer of the owner, on a copy. Null on an event of the owner. */
	my_response: Response | null;
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
	/** The attendees of a meeting. Empty for an event without attendees. */
	attendees: AttendeeRef[];
	idempotency?: { key: string; requestHash: string } | undefined;
}

/**
 * Organizer to attendee: a full snapshot of the meeting. `sequence` grows by one for each change of the
 * organizer that the attendees must see. An attendee applies only a sequence that is larger than the last that
 * it applied, so a duplicate and an old message change nothing.
 */
export interface MeetingMessage {
	uid: string;
	sequence: number;
	state: "invited" | "cancelled" | "removed";
	organizer: { principal_id: string; email: string; name: string };
	/** Only for `invited`. */
	fields: EventFields | null;
	/** Only for `invited`. Empty otherwise. */
	attendees: AttendeeRecord[];
}

/**
 * Attendee to organizer: an answer. `stamp` grows in the calendar of the attendee, so an old answer never
 * replaces a newer one. `sequence` is the sequence of the copy when the attendee answered.
 */
export interface ReplyMessage {
	uid: string;
	attendee_id: string;
	response: Answer;
	stamp: number;
	sequence: number;
}

/** A row of the change feed. `at` is UTC ms. `cursor` is the position after the change. */
export interface ChangeRecord {
	id: string;
	type: CalendarWebhookEvent;
	calendar_id: string;
	event_id: string;
	uid: string;
	occurrence_id: string | null;
	revision: number;
	actor_id: string | null;
	at: number;
	cursor: string;
}

export interface ChangePage {
	changes: ChangeRecord[];
	/** The position after the last change of the page, or the head when the page is empty. */
	cursor: string;
	has_more: boolean;
	/** True when the cursor is older than the feed. The page then has no changes and the cursor of the head. */
	expired: boolean;
}

export type ApplyResult =
	| { applied: true }
	| { applied: false; reason: "stale" | "not_organizer" | "not_attendee" | "unknown" | "full" | "wrong_calendar" };

/** A key works for 24 hours, as in Drive. */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** A tombstone stops an old invitation for this time. The outbox gives up on a message long before. */
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** About 14 hours of attempts with `backoff`. Then the message is dropped. */
const OUTBOX_MAX_ATTEMPTS = 20;
const OUTBOX_BATCH = 50;
/** The rows of the change feed that one round of `publishChanges` sends. */
const PUBLISH_BATCH = 50;
/** The oldest rows that one prune reads. The prune deletes only a prefix of the feed. */
const PRUNE_BATCH = 500;

/** 1 minute, doubled for each failure, at most 1 hour. */
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
	// Meetings: the uid of each event, the copies of the meetings of other principals, the attendees of the
	// meetings of the owner, the tombstones of cancelled and removed copies, and the outbox.
	[
		"ALTER TABLE events ADD COLUMN uid TEXT",
		"UPDATE events SET uid = id",
		"CREATE UNIQUE INDEX events_uid ON events (uid)",
		"ALTER TABLE events ADD COLUMN role TEXT NOT NULL DEFAULT 'owner'",
		"ALTER TABLE events ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0",
		"ALTER TABLE events ADD COLUMN organizer_id TEXT",
		"ALTER TABLE events ADD COLUMN organizer_email TEXT",
		"ALTER TABLE events ADD COLUMN organizer_name TEXT",
		"ALTER TABLE events ADD COLUMN my_response TEXT",
		"ALTER TABLE events ADD COLUMN my_reply_stamp INTEGER NOT NULL DEFAULT 0",
		"ALTER TABLE events ADD COLUMN attendees_json TEXT",
		`CREATE TABLE attendees (
			event_id TEXT NOT NULL,
			attendee_key TEXT NOT NULL,
			principal_id TEXT,
			email TEXT NOT NULL,
			name TEXT NOT NULL,
			response TEXT NOT NULL DEFAULT 'pending',
			reply_stamp INTEGER NOT NULL DEFAULT 0,
			responded_at INTEGER,
			invited_sequence INTEGER NOT NULL,
			added_at INTEGER NOT NULL,
			position INTEGER NOT NULL,
			PRIMARY KEY (event_id, attendee_key)
		) WITHOUT ROWID`,
		`CREATE TABLE meeting_tombstones (
			uid TEXT PRIMARY KEY,
			organizer TEXT NOT NULL,
			sequence INTEGER NOT NULL,
			state TEXT NOT NULL,
			at INTEGER NOT NULL
		) WITHOUT ROWID`,
		`CREATE TABLE outbox (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			kind TEXT NOT NULL,
			target TEXT NOT NULL,
			uid TEXT NOT NULL,
			payload TEXT NOT NULL,
			gen INTEGER NOT NULL DEFAULT 1,
			attempts INTEGER NOT NULL DEFAULT 0,
			next_attempt_at INTEGER NOT NULL,
			last_error TEXT,
			UNIQUE (kind, target, uid)
		)`,
		"CREATE INDEX outbox_due ON outbox (next_attempt_at)",
	],
	// The change feed: one row for each committed change, in order. `change_feed` is the random id of this feed,
	// so a cursor of a different feed expires. The statements can run again on a calendar that has them.
	[
		`CREATE TABLE IF NOT EXISTS changes (
			seq INTEGER PRIMARY KEY AUTOINCREMENT,
			id TEXT NOT NULL UNIQUE,
			type TEXT NOT NULL,
			event_id TEXT NOT NULL,
			uid TEXT NOT NULL,
			occurrence_id TEXT,
			revision INTEGER NOT NULL,
			actor_id TEXT,
			at INTEGER NOT NULL
		)`,
		"INSERT OR IGNORE INTO meta (key, value) VALUES ('change_feed', lower(hex(randomblob(8))))",
	],
];

const COLUMNS = [
	"id",
	"title",
	"description",
	"location",
	"all_day",
	"start_at",
	"end_at",
	"start_date",
	"end_date",
	"time_zone",
	"revision",
	"created_at",
	"updated_at",
	"uid",
	"role",
	"sequence",
	"organizer_id",
	"organizer_email",
	"organizer_name",
	"my_response",
	"my_reply_stamp",
	"attendees_json",
].join(", ");

interface StoredRow {
	record: EventRecord;
	organizerId: string | null;
	myReplyStamp: number;
}

function fieldsOf(row: Row): EventFields {
	return {
		title: row.title as string,
		description: row.description as string,
		location: row.location as string,
		all_day: row.all_day === 1,
		start_at: row.start_at as number,
		end_at: row.end_at as number,
		start_date: (row.start_date as string | null) ?? null,
		end_date: (row.end_date as string | null) ?? null,
		time_zone: (row.time_zone as string | null) ?? null,
	};
}

function parseAttendees(json: SqlStorageValue | undefined): AttendeeRecord[] {
	if (typeof json !== "string") return [];
	try {
		const value = JSON.parse(json) as unknown;
		return Array.isArray(value) ? (value as AttendeeRecord[]) : [];
	} catch {
		return [];
	}
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

/**
 * What a snapshot of the organizer changes on an existing copy. `fields`: a field or the set of attendees.
 * `answers`: the answer of a different attendee. The answer of the owner of the copy comes back in each
 * snapshot after the owner answers. The copy shows `my_response` for the owner, so that echo is no change.
 */
function copyChanges(
	record: EventRecord,
	message: MeetingMessage,
	ownerId: string,
): { fields: boolean; answers: boolean; answerActor: string | null } {
	const fields = message.fields as EventFields;
	const before = new Map(record.attendees.map((attendee) => [attendee.key, attendee]));
	const setChanged =
		before.size !== message.attendees.length || message.attendees.some((attendee) => !before.has(attendee.key));
	const answered = message.attendees.filter((attendee) => {
		const earlier = before.get(attendee.key);
		return attendee.key !== ownerId && earlier !== undefined && earlier.response !== attendee.response;
	});
	return {
		fields: setChanged || FIELD_KEYS.some((key) => record[key] !== fields[key]),
		answers: answered.length > 0,
		answerActor: answered.length === 1 ? (answered[0]?.principal_id ?? null) : null,
	};
}

export class CalendarDO extends DurableObject<Env> {
	private readonly sql: SqlStorage;
	/** The drain of the outbox that runs now. One drain at a time. */
	private drainTask: Promise<void> | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		ctx.blockConcurrencyWhile(async () => {
			this.migrate();
			// A change sets the alarm after its transaction commits. If the object stopped between the two, the
			// outbox or the change feed has work and no alarm: set one now.
			if ((this.outboxSize() > 0 || this.publishDue() !== null) && (await ctx.storage.getAlarm()) === null) {
				await ctx.storage.setAlarm(Date.now());
			}
		});
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

	private outboxSize(): number {
		return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM outbox").one().n;
	}

	private metaNumber(key: string): number {
		return Number(this.meta(key) ?? 0);
	}

	/**
	 * Records one committed change in the change feed. Call this inside the transaction of the change, so a
	 * change that fails records nothing and a change that commits has its row. The alarm publishes the row.
	 */
	private noteChange(
		type: CalendarWebhookEvent,
		event: Pick<EventRecord, "id" | "uid" | "revision">,
		actorId: string | null,
		occurrenceId: string | null = null,
	): void {
		const now = Date.now();
		const { seq } = this.sql
			.exec<{ seq: number }>(
				`INSERT INTO changes (id, type, event_id, uid, occurrence_id, revision, actor_id, at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
				newId("chg", now),
				type,
				event.id,
				event.uid,
				occurrenceId,
				event.revision,
				actorId,
				now,
			)
			.one();
		this.setMeta("change_head", String(seq));
	}

	/**
	 * Deletes the oldest published changes: the changes after the age or the count of `CALENDAR_LIMITS`. It
	 * deletes only a prefix of the feed and never a change to publish, and `change_floor` keeps the last seq
	 * that it deleted. A cursor before the floor has expired.
	 */
	private pruneChanges(now: number): void {
		const published = this.metaNumber("change_published");
		const byCount = this.metaNumber("change_head") - CALENDAR_LIMITS.changes;
		const cutoff = now - CALENDAR_LIMITS.changeDays * DAY_MS;
		let last = Math.min(published, Math.max(byCount, 0));
		const rows = this.sql
			.exec<{ seq: number; at: number }>(
				"SELECT seq, at FROM changes WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?",
				last,
				published,
				PRUNE_BATCH,
			)
			.toArray();
		for (const row of rows) {
			if (row.at >= cutoff) break;
			last = row.seq;
		}
		if (last <= this.metaNumber("change_floor")) return;
		this.ctx.storage.transactionSync(() => {
			this.sql.exec("DELETE FROM changes WHERE seq <= ?", last);
			this.setMeta("change_floor", String(last));
		});
	}

	/** The time of the next round of `publishChanges`, or null when each change is published. */
	private publishDue(): number | null {
		if (this.metaNumber("change_head") <= this.metaNumber("change_published")) return null;
		return Math.max(this.metaNumber("publish_at"), Date.now());
	}

	private changeCursor(seq: number): string {
		return encodeCursor([this.meta("change_feed") ?? "", seq]);
	}

	private toChange(row: Row, calendarId: string): ChangeRecord {
		return {
			id: row.id as string,
			type: row.type as CalendarWebhookEvent,
			calendar_id: calendarId,
			event_id: row.event_id as string,
			uid: row.uid as string,
			occurrence_id: (row.occurrence_id as string | null) ?? null,
			revision: row.revision as number,
			actor_id: (row.actor_id as string | null) ?? null,
			at: row.at as number,
			cursor: this.changeCursor(row.seq as number),
		};
	}

	/**
	 * Publishes the committed changes in order: a hint to the events sockets of the owner, then one queue job
	 * for each change when a subscription of MCP Events or a webhook exists. `change_published` moves only after
	 * the sends of a change succeed, so a stop of the Worker sends a change again, never loses one. A job sent
	 * again has the same `eventId`, so the receiver gets the same `webhook-id`. A failure tries again later,
	 * with `backoff`, and never drops a change.
	 */
	private async publishChanges(): Promise<void> {
		const calendarId = this.meta("owner_id");
		if (calendarId === null || this.publishDue() === null || this.metaNumber("publish_at") > Date.now()) return;
		try {
			for (;;) {
				const rows = this.sql
					.exec<Row>(
						"SELECT seq, id, type, event_id, uid, occurrence_id, revision, actor_id, at FROM changes WHERE seq > ? ORDER BY seq LIMIT ?",
						this.metaNumber("change_published"),
						PUBLISH_BATCH,
					)
					.toArray();
				if (rows.length === 0) break;
				await this.env.PRINCIPAL.get(this.env.PRINCIPAL.idFromName(calendarId)).calendarChanged(calendarId);
				for (const row of rows) {
					if (this.meta("webhook_events") === "1") {
						const change = this.toChange(row, calendarId);
						const job: CalendarWebhookEventJob = {
							v: 1,
							kind: "calendar_event",
							calendarId,
							eventType: change.type,
							eventId: change.id,
							occurredAt: change.at,
							calendarEventId: change.event_id,
							uid: change.uid,
							occurrenceId: change.occurrence_id,
							revision: change.revision,
							actorId: change.actor_id,
							cursor: change.cursor,
						};
						await this.env.WEBHOOKS.send(job);
					}
					this.setMeta("change_published", String(row.seq));
				}
				if (rows.length < PUBLISH_BATCH) break;
			}
			if (this.meta("publish_attempts") !== null) {
				this.sql.exec("DELETE FROM meta WHERE key IN ('publish_attempts', 'publish_at')");
			}
			this.pruneChanges(Date.now());
		} catch (error) {
			const attempts = this.metaNumber("publish_attempts") + 1;
			this.setMeta("publish_attempts", String(attempts));
			this.setMeta("publish_at", String(Date.now() + backoff(attempts)));
			log("warn", "calendar change publish failed", {
				attempts,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * The changes after a cursor, oldest first. Without a cursor: no changes and the cursor of the head. A
	 * cursor of a different feed, or before the floor, or after the head, has expired.
	 */
	listChanges(call: CalendarCall, cursor: string | null, limit: number): ChangePage | Refusal {
		const refused = this.enter(call);
		if (refused) return refused;
		const head = this.metaNumber("change_head");
		const atHead: ChangePage = { changes: [], cursor: this.changeCursor(head), has_more: false, expired: false };
		if (cursor === null) return atHead;
		const decoded = decodeCursor<[string, number]>(cursor, ["string", "number"]);
		if (!decoded || !Number.isSafeInteger(decoded[1]) || decoded[1] < 0) {
			return refuse("invalid", "The cursor is not a cursor of calendar.list_changes.");
		}
		const [feed, after] = decoded;
		if (feed !== this.meta("change_feed") || after > head || after < this.metaNumber("change_floor")) {
			return { ...atHead, expired: true };
		}
		const rows = this.sql
			.exec<Row>(
				"SELECT seq, id, type, event_id, uid, occurrence_id, revision, actor_id, at FROM changes WHERE seq > ? ORDER BY seq LIMIT ?",
				after,
				limit + 1,
			)
			.toArray();
		const page = rows.slice(0, limit).map((row) => this.toChange(row, call.ownerId));
		const last = page[page.length - 1];
		return { changes: page, cursor: last ? last.cursor : cursor, has_more: rows.length > limit, expired: false };
	}

	/** Turns queue jobs of the change feed on. The Worker calls this before it stores a subscription. */
	enableChangeEvents(calendarId: string): boolean {
		if (!this.claim(calendarId)) return false;
		if (this.meta("webhook_events") !== "1") this.setMeta("webhook_events", "1");
		return true;
	}

	private eventCount(): number {
		return Number(this.meta("event_count") ?? 0);
	}

	private addToCount(delta: number): void {
		this.setMeta("event_count", String(Math.max(0, this.eventCount() + delta)));
	}

	/**
	 * Checks the caller. The first call keeps the owner, so a handler that opens the object of a different
	 * principal gets a refusal, never the events. Only the owner reaches the calendar.
	 */
	private enter(call: CalendarCall): Refusal | null {
		const owner = this.meta("owner_id");
		if (owner === null) this.setMeta("owner_id", call.ownerId);
		else if (owner !== call.ownerId) return refuse("not_found", NOT_FOUND);
		if (call.actorId !== call.ownerId) return refuse("not_found", NOT_FOUND);
		// The organizer identity of the snapshots that an answer of an attendee makes, without a call.
		if (this.meta("owner_email") !== call.ownerEmail) this.setMeta("owner_email", call.ownerEmail);
		if (this.meta("owner_name") !== call.ownerName) this.setMeta("owner_name", call.ownerName);
		return null;
	}

	/** For a message from a different calendar: keeps the owner on the first message, as `enter` does. */
	private claim(targetId: string): boolean {
		const owner = this.meta("owner_id");
		if (owner === null) {
			this.setMeta("owner_id", targetId);
			return true;
		}
		return owner === targetId;
	}

	private attendeesOf(eventId: string): AttendeeRecord[] {
		return this.sql
			.exec<Row>(
				`SELECT attendee_key, principal_id, email, name, response, responded_at FROM attendees
				WHERE event_id = ? ORDER BY position`,
				eventId,
			)
			.toArray()
			.map((row) => ({
				key: row.attendee_key as string,
				principal_id: (row.principal_id as string | null) ?? null,
				email: row.email as string,
				name: row.name as string,
				response: row.response as Response,
				responded_at: (row.responded_at as number | null) ?? null,
			}));
	}

	private toStored(row: Row): StoredRow {
		const role = row.role === "attendee" ? "attendee" : "owner";
		const record: EventRecord = {
			id: row.id as string,
			uid: (row.uid as string | null) ?? (row.id as string),
			role,
			sequence: row.sequence as number,
			revision: row.revision as number,
			created_at: row.created_at as number,
			updated_at: row.updated_at as number,
			...fieldsOf(row),
			organizer:
				role === "attendee"
					? {
							principal_id: (row.organizer_id as string | null) ?? null,
							email: (row.organizer_email as string | null) ?? "",
							name: (row.organizer_name as string | null) ?? "",
						}
					: null,
			attendees: role === "attendee" ? parseAttendees(row.attendees_json) : this.attendeesOf(row.id as string),
			my_response: role === "attendee" ? ((row.my_response as Response | null) ?? "pending") : null,
		};
		return {
			record,
			organizerId: (row.organizer_id as string | null) ?? null,
			myReplyStamp: (row.my_reply_stamp as number | null) ?? 0,
		};
	}

	private stored(where: "id" | "uid", value: string): StoredRow | null {
		const row = this.sql.exec<Row>(`SELECT ${COLUMNS} FROM events WHERE ${where} = ?`, value).toArray()[0];
		return row ? this.toStored(row) : null;
	}

	private row(id: string): EventRecord | null {
		return this.stored("id", id)?.record ?? null;
	}

	/** The organizer of the meetings of the owner, for a snapshot. */
	private organizerRef(): MeetingMessage["organizer"] {
		return {
			principal_id: this.meta("owner_id") ?? "",
			email: this.meta("owner_email") ?? "",
			name: this.meta("owner_name") ?? "",
		};
	}

	/**
	 * Puts a message in the outbox. A message that waits for the same target and the same meeting gets the newer
	 * payload: each message is a full state, so only the newest one matters.
	 */
	private enqueue(kind: "meeting" | "reply", target: string, uid: string, payload: unknown): void {
		this.sql.exec(
			`INSERT INTO outbox (kind, target, uid, payload, next_attempt_at) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT (kind, target, uid) DO UPDATE SET payload = excluded.payload, gen = gen + 1, attempts = 0,
				next_attempt_at = excluded.next_attempt_at, last_error = NULL`,
			kind,
			target,
			uid,
			JSON.stringify(payload),
			Date.now(),
		);
	}

	/** Queues the snapshot of an event of the owner for each attendee, with the current sequence. */
	private sendSnapshots(event: EventRecord): void {
		const message: MeetingMessage = {
			uid: event.uid,
			sequence: event.sequence,
			state: "invited",
			organizer: this.organizerRef(),
			fields: Object.fromEntries(FIELD_KEYS.map((key) => [key, event[key]])) as unknown as EventFields,
			attendees: event.attendees,
		};
		for (const attendee of event.attendees) {
			if (attendee.principal_id) this.enqueue("meeting", attendee.principal_id, event.uid, message);
		}
	}

	private sendEnd(uid: string, sequence: number, state: "cancelled" | "removed", attendee: AttendeeRecord): void {
		if (!attendee.principal_id) return;
		const message: MeetingMessage = {
			uid,
			sequence,
			state,
			organizer: this.organizerRef(),
			fields: null,
			attendees: [],
		};
		this.enqueue("meeting", attendee.principal_id, uid, message);
	}

	/** Sets the alarm for the first message of the outbox, or the first change to publish, that is due. */
	private async schedule(): Promise<void> {
		const outbox = this.sql.exec<{ at: number | null }>("SELECT MIN(next_attempt_at) AS at FROM outbox").one().at;
		const publish = this.publishDue();
		const next = outbox === null ? publish : publish === null ? outbox : Math.min(outbox, publish);
		if (next === null) return;
		const at = Math.max(next, Date.now());
		const set = await this.ctx.storage.getAlarm();
		if (set === null || set > at) await this.ctx.storage.setAlarm(at);
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
		return { events: rows.slice(0, query.limit).map((row) => this.toStored(row).record), more };
	}

	get(call: CalendarCall, eventId: string): EventRecord | Refusal {
		const refused = this.enter(call);
		if (refused) return refused;
		return this.row(eventId) ?? refuse("not_found", NOT_FOUND);
	}

	/**
	 * Adds an event. With an idempotency key that a call with the same request used, it returns that event and
	 * adds nothing. The check and the write run with no await between them, so two calls with one key add one
	 * event. Each attendee gets an invitation through the outbox.
	 */
	async create(call: CalendarCall, input: CreateInput): Promise<EventRecord | Refusal> {
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
		const count = this.eventCount();
		if (count >= CALENDAR_LIMITS.events) {
			return refuse("invalid", `A calendar can have at most ${CALENDAR_LIMITS.events} events. Delete events first.`);
		}
		const { fields } = input;
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(
				`INSERT INTO events (id, title, description, location, all_day, start_at, end_at, start_date, end_date,
					time_zone, revision, created_at, updated_at, uid, role, sequence)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'owner', 0)`,
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
				input.id,
			);
			for (const attendee of input.attendees) this.insertAttendee(input.id, attendee, 0, now);
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
			const event = this.row(input.id) as EventRecord;
			this.sendSnapshots(event);
			this.noteChange("calendar.event.created", event, call.actorId);
		});
		await this.schedule();
		return this.row(input.id) as EventRecord;
	}

	/** Adds an attendee after the others, so the list keeps the order of the organizer. */
	private insertAttendee(eventId: string, attendee: AttendeeRef, sequence: number, now: number): void {
		this.sql.exec(
			`INSERT INTO attendees (event_id, attendee_key, principal_id, email, name, invited_sequence, added_at, position)
			VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM attendees WHERE event_id = ?))`,
			eventId,
			attendee.key,
			attendee.principal_id,
			attendee.email,
			attendee.name,
			sequence,
			now,
			eventId,
		);
	}

	/**
	 * Changes the fields of the patch, and with `attendees` the set of attendees. A patch that changes nothing
	 * writes nothing and keeps the revision. A `baseRevision` that is not the revision of the event changes
	 * nothing. Only the organizer changes a meeting.
	 */
	async update(
		call: CalendarCall,
		eventId: string,
		patch: Partial<EventFields>,
		attendees: AttendeeRef[] | undefined,
		baseRevision: number | undefined,
	): Promise<{ event: EventRecord; changed: boolean } | Refusal> {
		const refused = this.enter(call);
		if (refused) return refused;
		const event = this.row(eventId);
		if (!event) return refuse("not_found", NOT_FOUND);
		if (event.role === "attendee") {
			return refuse(
				"forbidden",
				"Only the organizer can change this meeting. Use calendar.respond_to_invitation to change your answer.",
			);
		}
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
		const fieldsChanged = FIELD_KEYS.some((key) => next[key] !== event[key]);
		const before = new Map(event.attendees.map((attendee) => [attendee.key, attendee]));
		const after = attendees ? new Map(attendees.map((attendee) => [attendee.key, attendee])) : before;
		const added = [...after.values()].filter((attendee) => !before.has(attendee.key));
		const removed = [...before.values()].filter((attendee) => !after.has(attendee.key));
		if (!fieldsChanged && added.length === 0 && removed.length === 0) return { event, changed: false };
		const now = Date.now();
		const sequence = event.sequence + 1;
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(
				`UPDATE events SET title = ?, description = ?, location = ?, all_day = ?, start_at = ?, end_at = ?,
					start_date = ?, end_date = ?, time_zone = ?, revision = revision + 1, sequence = ?, updated_at = ?
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
				sequence,
				now,
				eventId,
			);
			for (const attendee of removed) {
				this.sql.exec("DELETE FROM attendees WHERE event_id = ? AND attendee_key = ?", eventId, attendee.key);
				this.sendEnd(event.uid, sequence, "removed", attendee);
			}
			for (const attendee of added) this.insertAttendee(eventId, attendee, sequence, now);
			const updated = this.row(eventId) as EventRecord;
			this.sendSnapshots(updated);
			this.noteChange("calendar.event.updated", updated, call.actorId);
		});
		await this.schedule();
		return { event: this.row(eventId) as EventRecord, changed: true };
	}

	/**
	 * Deletes an event, or with `dryRun` returns it without a change. The delete of a meeting of the owner
	 * cancels it for each attendee. Only the organizer cancels a meeting.
	 */
	async remove(
		call: CalendarCall,
		eventId: string,
		baseRevision: number | undefined,
		dryRun: boolean,
	): Promise<EventRecord | Refusal> {
		const refused = this.enter(call);
		if (refused) return refused;
		const event = this.row(eventId);
		if (!event) return refuse("not_found", NOT_FOUND);
		if (event.role === "attendee") {
			return refuse(
				"forbidden",
				"Only the organizer can cancel this meeting. Answer No with calendar.respond_to_invitation.",
			);
		}
		if (baseRevision !== undefined && baseRevision !== event.revision) {
			return refuse(
				"conflict",
				`The event has revision ${event.revision} now, not ${baseRevision}. Read it again, then try again.`,
			);
		}
		if (dryRun) return event;
		this.ctx.storage.transactionSync(() => {
			this.noteChange("calendar.event.deleted", event, call.actorId);
			for (const attendee of event.attendees) this.sendEnd(event.uid, event.sequence + 1, "cancelled", attendee);
			this.sql.exec("DELETE FROM attendees WHERE event_id = ?", eventId);
			this.sql.exec("DELETE FROM events WHERE id = ?", eventId);
			this.addToCount(-1);
		});
		await this.schedule();
		return event;
	}

	/** Sets the answer of the owner to the copy of a meeting, and sends it to the organizer. */
	async respond(
		call: CalendarCall,
		eventId: string,
		response: Answer,
	): Promise<{ event: EventRecord; changed: boolean } | Refusal> {
		const refused = this.enter(call);
		if (refused) return refused;
		const stored = this.stored("id", eventId);
		if (!stored) return refuse("not_found", NOT_FOUND);
		const { record } = stored;
		if (record.role === "owner" || !stored.organizerId) {
			return refuse("invalid", "You are the organizer of this event. Only an attendee answers an invitation.");
		}
		if (record.my_response === response) return { event: record, changed: false };
		const now = Date.now();
		const stamp = Math.max(now, stored.myReplyStamp + 1);
		const organizerId = stored.organizerId;
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(
				"UPDATE events SET my_response = ?, my_reply_stamp = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
				response,
				stamp,
				now,
				eventId,
			);
			const reply: ReplyMessage = {
				uid: record.uid,
				attendee_id: call.ownerId,
				response,
				stamp,
				sequence: record.sequence,
			};
			this.enqueue("reply", organizerId, record.uid, reply);
			this.noteChange("calendar.rsvp.changed", { ...record, revision: record.revision + 1 }, call.actorId);
		});
		await this.schedule();
		return { event: this.row(eventId) as EventRecord, changed: true };
	}

	/**
	 * From the outbox of the organizer: the snapshot of a meeting. Only the organizer on record changes a copy,
	 * and only a larger sequence applies. A cancelled or removed copy leaves a tombstone, so an old invitation
	 * cannot bring it back. Handlers never call this method: only the outbox of a calendar does.
	 */
	async applyMeeting(targetId: string, message: MeetingMessage): Promise<ApplyResult> {
		let result: ApplyResult = { applied: true };
		this.ctx.storage.transactionSync(() => {
			result = this.applyMeetingNow(targetId, message);
		});
		// A copy that changed has a row in the change feed to publish.
		if (result.applied) await this.schedule();
		return result;
	}

	private applyMeetingNow(targetId: string, message: MeetingMessage): ApplyResult {
		if (!this.claim(targetId)) return { applied: false, reason: "wrong_calendar" };
		const organizerId = message.organizer.principal_id;
		if (!organizerId || organizerId === targetId) return { applied: false, reason: "not_organizer" };
		const stored = this.stored("uid", message.uid);
		const tomb = this.sql
			.exec<{ organizer: string; sequence: number }>(
				"SELECT organizer, sequence FROM meeting_tombstones WHERE uid = ?",
				message.uid,
			)
			.toArray()[0];
		if (stored && (stored.record.role === "owner" || stored.organizerId !== organizerId)) {
			return { applied: false, reason: "not_organizer" };
		}
		if (!stored && tomb && tomb.organizer !== organizerId) return { applied: false, reason: "not_organizer" };
		const last = stored?.record.sequence ?? tomb?.sequence ?? -1;
		if (message.sequence <= last) return { applied: false, reason: "stale" };
		const now = Date.now();
		this.sql.exec("DELETE FROM meeting_tombstones WHERE at < ?", now - TOMBSTONE_TTL_MS);

		if (message.state !== "invited" || !message.fields) {
			if (stored) {
				this.noteChange("calendar.invitation.cancelled", stored.record, organizerId);
				this.sql.exec("DELETE FROM events WHERE id = ?", stored.record.id);
				this.addToCount(-1);
			}
			this.sql.exec("DELETE FROM outbox WHERE kind = 'reply' AND uid = ?", message.uid);
			this.sql.exec(
				`INSERT INTO meeting_tombstones (uid, organizer, sequence, state, at) VALUES (?, ?, ?, ?, ?)
				ON CONFLICT (uid) DO UPDATE SET organizer = excluded.organizer, sequence = excluded.sequence,
					state = excluded.state, at = excluded.at`,
				message.uid,
				organizerId,
				message.sequence,
				message.state === "invited" ? "removed" : message.state,
				now,
			);
			return { applied: true };
		}

		const fields = message.fields;
		const attendeesJson = JSON.stringify(message.attendees);
		if (stored) {
			const changes = copyChanges(stored.record, message, targetId);
			this.sql.exec(
				`UPDATE events SET title = ?, description = ?, location = ?, all_day = ?, start_at = ?, end_at = ?,
					start_date = ?, end_date = ?, time_zone = ?, organizer_email = ?, organizer_name = ?, sequence = ?,
					attendees_json = ?, revision = revision + 1, updated_at = ?
				WHERE id = ?`,
				fields.title,
				fields.description,
				fields.location,
				fields.all_day ? 1 : 0,
				fields.start_at,
				fields.end_at,
				fields.start_date,
				fields.end_date,
				fields.time_zone,
				message.organizer.email,
				message.organizer.name,
				message.sequence,
				attendeesJson,
				now,
				stored.record.id,
			);
			const copy = { ...stored.record, revision: stored.record.revision + 1 };
			if (changes.fields) this.noteChange("calendar.invitation.updated", copy, organizerId);
			if (changes.answers) this.noteChange("calendar.rsvp.changed", copy, changes.answerActor);
			return { applied: true };
		}
		if (this.eventCount() >= CALENDAR_LIMITS.events) return { applied: false, reason: "full" };
		const copyId = newId("evt");
		this.sql.exec(
			`INSERT INTO events (id, title, description, location, all_day, start_at, end_at, start_date, end_date,
				time_zone, revision, created_at, updated_at, uid, role, sequence, organizer_id, organizer_email,
				organizer_name, my_response, my_reply_stamp, attendees_json)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'attendee', ?, ?, ?, ?, 'pending', 0, ?)`,
			copyId,
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
			message.uid,
			message.sequence,
			organizerId,
			message.organizer.email,
			message.organizer.name,
			attendeesJson,
		);
		this.addToCount(1);
		this.sql.exec("DELETE FROM meeting_tombstones WHERE uid = ?", message.uid);
		this.noteChange("calendar.invitation.received", { id: copyId, uid: message.uid, revision: 1 }, organizerId);
		return { applied: true };
	}

	/**
	 * From the outbox of an attendee: an answer. Only a current attendee of a meeting of the owner answers, and
	 * an answer applies only when it is newer than the last one. An answer from before a removal and a new
	 * invitation has a smaller sequence than the new invitation, so it changes nothing.
	 */
	async applyReply(targetId: string, reply: ReplyMessage): Promise<ApplyResult> {
		let result: ApplyResult = { applied: true };
		this.ctx.storage.transactionSync(() => {
			if (!this.claim(targetId)) {
				result = { applied: false, reason: "wrong_calendar" };
				return;
			}
			const stored = this.stored("uid", reply.uid);
			if (stored?.record.role !== "owner") {
				result = { applied: false, reason: "unknown" };
				return;
			}
			const attendee = this.sql
				.exec<{ attendee_key: string; reply_stamp: number; invited_sequence: number }>(
					"SELECT attendee_key, reply_stamp, invited_sequence FROM attendees WHERE event_id = ? AND principal_id = ?",
					stored.record.id,
					reply.attendee_id,
				)
				.toArray()[0];
			if (!attendee) {
				result = { applied: false, reason: "not_attendee" };
				return;
			}
			if (reply.sequence < attendee.invited_sequence || reply.stamp <= attendee.reply_stamp) {
				result = { applied: false, reason: "stale" };
				return;
			}
			this.sql.exec(
				"UPDATE attendees SET response = ?, reply_stamp = ?, responded_at = ? WHERE event_id = ? AND attendee_key = ?",
				reply.response,
				reply.stamp,
				reply.stamp,
				stored.record.id,
				attendee.attendee_key,
			);
			// The answer does not change the revision, so an answer never makes an edit of the organizer fail.
			this.sql.exec("UPDATE events SET sequence = sequence + 1 WHERE id = ?", stored.record.id);
			this.sendSnapshots(this.row(stored.record.id) as EventRecord);
			this.noteChange("calendar.rsvp.changed", stored.record, reply.attendee_id);
		});
		if (result.applied) await this.schedule();
		return result;
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
	 * Delivers the due messages. Each message is independent: a target that fails does not stop the others. A
	 * result of the target, also `applied: false`, is a delivery. A thrown error tries again later, with
	 * `backoff`, `OUTBOX_MAX_ATTEMPTS` times. The `gen` check keeps a newer payload that a change wrote while
	 * the call ran.
	 */
	private async drain(): Promise<void> {
		await this.publishChanges();
		const rows = this.sql
			.exec<{ id: number; kind: string; target: string; payload: string; gen: number; attempts: number }>(
				"SELECT id, kind, target, payload, gen, attempts FROM outbox WHERE next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT ?",
				Date.now(),
				OUTBOX_BATCH,
			)
			.toArray();
		for (const row of rows) {
			try {
				const stub = this.env.CALENDAR.get(this.env.CALENDAR.idFromName(row.target));
				const result =
					row.kind === "reply"
						? await stub.applyReply(row.target, JSON.parse(row.payload) as ReplyMessage)
						: await stub.applyMeeting(row.target, JSON.parse(row.payload) as MeetingMessage);
				if (!result.applied) log("info", "calendar message not applied", { kind: row.kind, reason: result.reason });
				this.sql.exec("DELETE FROM outbox WHERE id = ? AND gen = ?", row.id, row.gen);
			} catch (error) {
				const attempts = row.attempts + 1;
				const message = error instanceof Error ? error.message : String(error);
				log(attempts >= OUTBOX_MAX_ATTEMPTS ? "error" : "warn", "calendar outbox delivery failed", {
					kind: row.kind,
					attempts,
					error: message,
				});
				if (attempts >= OUTBOX_MAX_ATTEMPTS) {
					this.sql.exec("DELETE FROM outbox WHERE id = ? AND gen = ?", row.id, row.gen);
				} else {
					this.sql.exec(
						"UPDATE outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ? AND gen = ?",
						attempts,
						Date.now() + backoff(attempts),
						message.slice(0, 500),
						row.id,
						row.gen,
					);
				}
			}
		}
		await this.schedule();
	}
}
