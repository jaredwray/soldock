import { DurableObject } from "cloudflare:workers";
import { CALENDAR_LIMITS } from "@asterra/contracts";
import { type CalendarSenderCheck, sendCalendarMail } from "../mail/index.ts";
import { log, newId } from "../platform/index.ts";
import {
	buildICalendar,
	type ICalAttendee,
	type ICalInvite,
	type ICalOutput,
	type PartStat,
	parseICalendar,
} from "./ical.ts";
import { storedTime } from "./time.ts";

// Each person, agent and service account has one CalendarDO. Its name is the principal id. It holds the
// events of the calendar of that principal in its SQLite database.
//
// A meeting is an event with attendees. The event of the organizer is the authority. Each attendee has a copy
// with the same `uid`. The organizer sends a full snapshot of the meeting to each attendee, and each attendee
// sends its answer to the organizer, through the outbox of this object and its alarm. Each message is safe to
// apply two times and in each order: see `applyMeeting` and `applyReply`.

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
	/** The sequence of the meeting when the organizer invited this attendee. A new invitation has a larger one. */
	invited_sequence: number;
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
	/** UTC ms of the answer of the owner, on a copy. Null on an event of the owner and before the first answer. */
	my_responded_at: number | null;
	/** On the copy of a meeting by mail: the address of the owner that the invitation names. */
	my_email: string | null;
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

export type ApplyResult =
	| { applied: true }
	| {
			applied: false;
			reason:
				| "stale"
				| "not_organizer"
				| "not_attendee"
				| "unknown"
				| "full"
				| "wrong_calendar"
				| "unreadable"
				| "unsupported"
				| "unverified";
	  };

/** A message by mail: an invitation, a change or a cancellation to an attendee, or an answer to an organizer. */
export interface MailPayload {
	method: ICalOutput["method"];
	ical: ICalOutput;
	subject: string;
	text: string;
	/** The idempotency key of the send. The same message has the same key, so a retry sends it one time. */
	key: string;
}

/** A calendar part of a mail that the mailbox of the owner received. Each value comes from the sender. */
export interface IncomingMail {
	ics: string;
	/** The From address, in lowercase. */
	from: string | null;
	verification: CalendarSenderCheck;
	receivedAt: number;
}

/** The answer of the owner to an invitation by mail. The handler read the mail and its sender. */
export interface MailAnswer {
	invite: ICalInvite;
	/** The stored time of the invitation. */
	time: EventTime;
	/** The From address of the mail, in lowercase. */
	from: string;
	/** The address of the owner that the invitation names. */
	myEmail: string;
	response: Answer;
}

const PARTSTAT: Record<Response, PartStat> = {
	pending: "NEEDS-ACTION",
	accepted: "ACCEPTED",
	tentative: "TENTATIVE",
	declined: "DECLINED",
};

const RESPONSE_OF: Record<PartStat, Response> = {
	"NEEDS-ACTION": "pending",
	ACCEPTED: "accepted",
	TENTATIVE: "tentative",
	DECLINED: "declined",
};

/** The key of an attendee or an organizer outside the organization: `mailto:` and the address in lowercase. */
export function mailKey(address: string): string {
	return `mailto:${address.toLowerCase()}`;
}

/** The plain text of a message by mail. It holds the facts of the meeting, and no HTML. */
function mailText(intro: string, ical: ICalOutput): string {
	const { fields } = ical;
	const when =
		fields.all_day && fields.start_date && fields.end_date
			? `All day, from ${fields.start_date} until ${fields.end_date} (the day after the last day)`
			: `${new Date(fields.start_at).toISOString().replace("T", " ").slice(0, 16)} to ${new Date(fields.end_at).toISOString().replace("T", " ").slice(0, 16)} UTC`;
	const lines = [intro, "", fields.title, `When: ${when}`];
	if (fields.location) lines.push(`Where: ${fields.location}`);
	lines.push(
		`Organizer: ${ical.organizer.name ? `${ical.organizer.name} <${ical.organizer.email}>` : ical.organizer.email}`,
	);
	if (ical.method === "REQUEST" && ical.attendees.length > 0) {
		lines.push(`Attendees: ${ical.attendees.map((attendee) => attendee.email).join(", ")}`);
	}
	if (fields.description && ical.method !== "REPLY") lines.push("", fields.description);
	return lines.join("\n");
}

/** A key works for 24 hours, as in Drive. */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** A tombstone stops an old invitation for this time. The outbox gives up on a message long before. */
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** About 14 hours of attempts with `backoff`. Then the message is dropped. */
const OUTBOX_MAX_ATTEMPTS = 20;
const OUTBOX_BATCH = 50;

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
	// Meetings by mail: the From address of the accepted invitation, the DTSTAMP of the last applied change, and
	// the address of the owner that the invitation names. An attendee outside the organization has the key
	// `mailto:<address>` and no principal id. The outbox gets the kind `mail`.
	[
		"ALTER TABLE events ADD COLUMN sender_email TEXT",
		"ALTER TABLE events ADD COLUMN organizer_stamp INTEGER NOT NULL DEFAULT 0",
		"ALTER TABLE events ADD COLUMN my_email TEXT",
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
	"sender_email",
	"organizer_stamp",
	"my_email",
].join(", ");

interface StoredRow {
	record: EventRecord;
	organizerId: string | null;
	myReplyStamp: number;
	/** The From address of the accepted invitation by mail. */
	senderEmail: string | null;
	/** The DTSTAMP of the last applied change by mail. */
	organizerStamp: number;
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
			// outbox has rows and no alarm: set one now.
			if (this.outboxSize() > 0 && (await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now());
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
				`SELECT attendee_key, principal_id, email, name, response, responded_at, invited_sequence FROM attendees
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
				invited_sequence: row.invited_sequence as number,
			}));
	}

	private toStored(row: Row): StoredRow {
		const role = row.role === "attendee" ? "attendee" : "owner";
		const myResponse = role === "attendee" ? ((row.my_response as Response | null) ?? "pending") : null;
		const myReplyStamp = (row.my_reply_stamp as number | null) ?? 0;
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
			my_response: myResponse,
			// The stamp of an answer is its time. After a new invitation the stamp stays, and the answer is `pending`.
			my_responded_at: myResponse !== null && myResponse !== "pending" && myReplyStamp > 0 ? myReplyStamp : null,
			my_email: (row.my_email as string | null) ?? null,
		};
		return {
			record,
			organizerId: (row.organizer_id as string | null) ?? null,
			myReplyStamp,
			senderEmail: (row.sender_email as string | null) ?? null,
			organizerStamp: (row.organizer_stamp as number | null) ?? 0,
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
	private enqueue(kind: "meeting" | "reply" | "mail", target: string, uid: string, payload: unknown): void {
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

	/** The fields of an event that a message carries. */
	private fieldsOfRecord(event: EventRecord): EventFields {
		return Object.fromEntries(FIELD_KEYS.map((key) => [key, event[key]])) as unknown as EventFields;
	}

	/** The iCalendar of an event of the owner, for a message by mail. */
	private icalOf(
		event: EventRecord,
		method: ICalOutput["method"],
		sequence: number,
		attendees: ICalAttendee[],
	): ICalOutput {
		const organizer = this.organizerRef();
		return {
			method,
			uid: event.uid,
			sequence,
			stamp: Date.now(),
			fields: this.fieldsOfRecord(event),
			organizer: { email: organizer.email, name: organizer.name },
			attendees,
		};
	}

	/**
	 * Queues the snapshot of an event of the owner for each attendee, with the current sequence. With `mail`, each
	 * attendee outside the organization gets the invitation or the change by mail. An answer of an attendee
	 * changes only the answers, so it sends no mail.
	 */
	private sendSnapshots(event: EventRecord, mail = true): void {
		const message: MeetingMessage = {
			uid: event.uid,
			sequence: event.sequence,
			state: "invited",
			organizer: this.organizerRef(),
			fields: this.fieldsOfRecord(event),
			attendees: event.attendees,
		};
		for (const attendee of event.attendees) {
			if (attendee.principal_id) this.enqueue("meeting", attendee.principal_id, event.uid, message);
		}
		if (!mail) return;
		const everyone = event.attendees.map((attendee) => ({
			email: attendee.email,
			name: attendee.name === attendee.email ? "" : attendee.name,
			partstat: PARTSTAT[attendee.response],
		}));
		for (const attendee of event.attendees) {
			if (attendee.principal_id) continue;
			const ical = this.icalOf(event, "REQUEST", event.sequence, everyone);
			const first = attendee.invited_sequence === event.sequence;
			const payload: MailPayload = {
				method: "REQUEST",
				ical,
				subject: `${first ? "Invitation" : "Updated invitation"}: ${event.title}`,
				text: mailText(first ? "You are invited to this meeting." : "The organizer changed this meeting.", ical),
				key: `asterra-calendar:${event.uid}:REQUEST:${event.sequence}:${attendee.email}`,
			};
			this.enqueue("mail", attendee.key, event.uid, payload);
		}
	}

	/** Tells an attendee that the meeting is cancelled, or that the organizer removed the attendee. */
	private sendEnd(
		event: EventRecord,
		sequence: number,
		state: "cancelled" | "removed",
		attendee: AttendeeRecord,
	): void {
		if (!attendee.principal_id) {
			const ical = this.icalOf(event, "CANCEL", sequence, [
				{ email: attendee.email, name: "", partstat: "NEEDS-ACTION" },
			]);
			const payload: MailPayload = {
				method: "CANCEL",
				ical,
				subject: `Cancelled: ${event.title}`,
				text: mailText(
					state === "cancelled"
						? "The organizer cancelled this meeting."
						: "The organizer removed you from this meeting.",
					ical,
				),
				key: `asterra-calendar:${event.uid}:CANCEL:${sequence}:${attendee.email}`,
			};
			this.enqueue("mail", attendee.key, event.uid, payload);
			return;
		}
		const message: MeetingMessage = {
			uid: event.uid,
			sequence,
			state,
			organizer: this.organizerRef(),
			fields: null,
			attendees: [],
		};
		this.enqueue("meeting", attendee.principal_id, event.uid, message);
	}

	/** Queues the answer of the owner to an organizer outside the organization, by mail. */
	private sendMailReply(record: EventRecord, response: Answer, stamp: number, myEmail: string, key: string): void {
		const organizer = record.organizer;
		if (!organizer?.email) return;
		const ical: ICalOutput = {
			method: "REPLY",
			uid: record.uid,
			sequence: record.sequence,
			stamp,
			fields: this.fieldsOfRecord(record),
			organizer: { email: organizer.email, name: organizer.name },
			attendees: [{ email: myEmail, name: this.meta("owner_name") ?? "", partstat: PARTSTAT[response] }],
		};
		const label = response === "accepted" ? "Accepted" : response === "tentative" ? "Maybe" : "Declined";
		const payload: MailPayload = {
			method: "REPLY",
			ical,
			subject: `${label}: ${record.title}`,
			text: mailText(`${myEmail} answered: ${label}.`, ical),
			key,
		};
		this.enqueue("mail", mailKey(organizer.email), record.uid, payload);
	}

	/** Sets the alarm for the first message of the outbox that is due. */
	private async schedule(): Promise<void> {
		const next = this.sql.exec<{ at: number | null }>("SELECT MIN(next_attempt_at) AS at FROM outbox").one().at;
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

	/** The result of the call that used an idempotency key in the last 24 hours, or null when no call did. */
	private earlier(idempotency: { key: string; requestHash: string }, now: number): EventRecord | Refusal | null {
		const earlier = this.sql
			.exec<{ request_hash: string; event_id: string }>(
				"SELECT request_hash, event_id FROM idempotency WHERE key = ? AND created_at > ?",
				idempotency.key,
				now - IDEMPOTENCY_TTL_MS,
			)
			.toArray()[0];
		if (!earlier) return null;
		if (earlier.request_hash !== idempotency.requestHash) {
			return refuse("conflict", "The idempotency key was used with a different request.");
		}
		return this.row(earlier.event_id) ?? refuse("conflict", "The event of this idempotency key does not exist now.");
	}

	/**
	 * The result of an earlier `create` with this idempotency key, or null. The handler asks before it reads the
	 * directory, so a retry returns the first event also when an attendee is archived now. `create` does the
	 * check again with its write.
	 */
	replay(call: CalendarCall, idempotency: { key: string; requestHash: string }): EventRecord | Refusal | null {
		return this.enter(call) ?? this.earlier(idempotency, Date.now());
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
			const earlier = this.earlier(input.idempotency, now);
			if (earlier) return earlier;
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
				this.sendEnd(next, sequence, "removed", attendee);
			}
			for (const attendee of added) this.insertAttendee(eventId, attendee, sequence, now);
			this.sendSnapshots(this.row(eventId) as EventRecord);
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
		const external = event.role === "attendee" && event.organizer?.principal_id === null;
		if (event.role === "attendee" && !external) {
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
		if (external) {
			// A meeting by mail from outside the organization: the owner removes it from the own calendar only. A
			// tombstone stops the same invitation from coming back. A newer invitation can be accepted again.
			this.ctx.storage.transactionSync(() => {
				this.sql.exec("DELETE FROM events WHERE id = ?", eventId);
				this.addToCount(-1);
				this.writeTombstone(event.uid, mailKey(event.organizer?.email ?? ""), event.sequence, "removed");
			});
			return event;
		}
		this.ctx.storage.transactionSync(() => {
			for (const attendee of event.attendees) this.sendEnd(event, event.sequence + 1, "cancelled", attendee);
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
		if (record.role === "owner") {
			return refuse("invalid", "You are the organizer of this event. Only an attendee answers an invitation.");
		}
		if (record.my_response === response) return { event: record, changed: false };
		const now = Date.now();
		const stamp = Math.max(now, stored.myReplyStamp + 1);
		const organizerId = stored.organizerId;
		if (!organizerId) {
			// A meeting by mail: the answer goes to the organizer by mail.
			const myEmail = record.my_email ?? call.ownerEmail;
			this.ctx.storage.transactionSync(() => {
				this.sql.exec(
					"UPDATE events SET my_response = ?, my_reply_stamp = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
					response,
					stamp,
					now,
					eventId,
				);
				this.sendMailReply(
					record,
					response,
					stamp,
					myEmail,
					`asterra-calendar:${record.uid}:REPLY:${stamp}:${myEmail}`,
				);
			});
			await this.schedule();
			return { event: this.row(eventId) as EventRecord, changed: true };
		}
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
		});
		await this.schedule();
		return { event: this.row(eventId) as EventRecord, changed: true };
	}

	/**
	 * From the outbox of the organizer: the snapshot of a meeting. Only the organizer on record changes a copy,
	 * and only a larger sequence applies. A cancelled or removed copy leaves a tombstone, so an old invitation
	 * cannot bring it back. Handlers never call this method: only the outbox of a calendar does.
	 */
	applyMeeting(targetId: string, message: MeetingMessage): ApplyResult {
		let result: ApplyResult = { applied: true };
		this.ctx.storage.transactionSync(() => {
			result = this.applyMeetingNow(targetId, message);
		});
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
				this.sql.exec("DELETE FROM events WHERE id = ?", stored.record.id);
				this.addToCount(-1);
			}
			this.sql.exec("DELETE FROM outbox WHERE kind = 'reply' AND uid = ?", message.uid);
			this.writeTombstone(
				message.uid,
				organizerId,
				message.sequence,
				message.state === "invited" ? "removed" : message.state,
			);
			return { applied: true };
		}

		const fields = message.fields;
		const attendeesJson = JSON.stringify(message.attendees);
		if (stored) {
			// The organizer removed the owner and invited the owner again, and the `removed` message did not arrive
			// before the new invitation replaced it in the outbox. The organizer has no answer for the new
			// invitation, so the copy starts again with `pending`. An answer that waits is from the old invitation.
			const invitedAt = message.attendees.find((attendee) => attendee.principal_id === targetId)?.invited_sequence;
			if (typeof invitedAt === "number" && invitedAt > stored.record.sequence) {
				this.sql.exec("UPDATE events SET my_response = 'pending' WHERE id = ?", stored.record.id);
				this.sql.exec("DELETE FROM outbox WHERE kind = 'reply' AND uid = ?", message.uid);
			}
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
			return { applied: true };
		}
		if (this.eventCount() >= CALENDAR_LIMITS.events) return { applied: false, reason: "full" };
		this.sql.exec(
			`INSERT INTO events (id, title, description, location, all_day, start_at, end_at, start_date, end_date,
				time_zone, revision, created_at, updated_at, uid, role, sequence, organizer_id, organizer_email,
				organizer_name, my_response, my_reply_stamp, attendees_json)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'attendee', ?, ?, ?, ?, 'pending', 0, ?)`,
			newId("evt"),
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
			// An answer changes only the answers, so the attendees outside the organization get no mail.
			this.sendSnapshots(this.row(stored.record.id) as EventRecord, false);
		});
		if (result.applied) await this.schedule();
		return result;
	}

	/** Writes the tombstone of a copy, so an older invitation cannot bring it back. */
	private writeTombstone(uid: string, organizer: string, sequence: number, state: "cancelled" | "removed"): void {
		const now = Date.now();
		this.sql.exec("DELETE FROM meeting_tombstones WHERE at < ?", now - TOMBSTONE_TTL_MS);
		this.sql.exec(
			`INSERT INTO meeting_tombstones (uid, organizer, sequence, state, at) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT (uid) DO UPDATE SET organizer = excluded.organizer, sequence = excluded.sequence,
				state = excluded.state, at = excluded.at`,
			uid,
			organizer,
			sequence,
			state,
			now,
		);
	}

	private tombstone(uid: string): { organizer: string; sequence: number } | null {
		return (
			this.sql
				.exec<{ organizer: string; sequence: number }>(
					"SELECT organizer, sequence FROM meeting_tombstones WHERE uid = ?",
					uid,
				)
				.toArray()[0] ?? null
		);
	}

	/** The attendees of an invitation by mail, as a copy keeps them. */
	private mailAttendees(invite: ICalInvite): AttendeeRecord[] {
		return invite.attendees.map((attendee) => ({
			key: mailKey(attendee.email),
			principal_id: null,
			email: attendee.email,
			name: attendee.name || attendee.email,
			response: RESPONSE_OF[attendee.partstat],
			responded_at: null,
			invited_sequence: 0,
		}));
	}

	/**
	 * From the mailbox of the owner: the calendar part of a mail that it received. Only a rule against a row that the
	 * calendar holds applies a change. A new invitation changes nothing: the owner answers it
	 * (`respondToMail`). Bad content gives a refusal, never an error.
	 *
	 * - REPLY: the answer of an attendee outside the organization to a meeting of the owner. The From address must
	 *   be the one attendee of the reply and an attendee of the meeting. An older answer changes nothing.
	 * - REQUEST and CANCEL: a change or a cancellation of a meeting by mail that the owner accepted. The organizer
	 *   and the From address must be the ones of the accepted invitation, and the receiving server must have
	 *   verified the sender, or the mail is internal.
	 */
	async applyMail(targetId: string, mail: IncomingMail): Promise<ApplyResult> {
		const invite = parseICalendar(mail.ics);
		if (!invite) return { applied: false, reason: "unreadable" };
		if (invite.recurring) return { applied: false, reason: "unsupported" };
		let result: ApplyResult = { applied: false, reason: "unknown" };
		let queued = false;
		this.ctx.storage.transactionSync(() => {
			if (!this.claim(targetId)) {
				result = { applied: false, reason: "wrong_calendar" };
				return;
			}
			const stored = this.stored("uid", invite.uid);
			if (!stored) return;
			if (invite.method === "REPLY") {
				result = this.applyMailReply(stored, invite, mail);
				queued = result.applied;
				return;
			}
			if (invite.method !== "REQUEST" && invite.method !== "CANCEL") return;
			const { record } = stored;
			if (record.role !== "attendee" || stored.organizerId !== null) {
				result = { applied: false, reason: "not_organizer" };
				return;
			}
			if (
				invite.organizer?.email !== record.organizer?.email ||
				mail.from === null ||
				mail.from !== stored.senderEmail
			) {
				result = { applied: false, reason: "not_organizer" };
				return;
			}
			if (mail.verification !== "internal" && mail.verification !== "verified") {
				result = { applied: false, reason: "unverified" };
				return;
			}
			if (invite.method === "CANCEL") {
				// The same rule as for a change, but a cancellation with the stamp of the last change also counts.
				const current =
					invite.sequence > record.sequence ||
					(invite.sequence === record.sequence && invite.stamp >= stored.organizerStamp);
				if (!current) {
					result = { applied: false, reason: "stale" };
					return;
				}
				this.sql.exec("DELETE FROM events WHERE id = ?", record.id);
				this.addToCount(-1);
				this.writeTombstone(invite.uid, mailKey(record.organizer?.email ?? ""), invite.sequence, "cancelled");
				result = { applied: true };
				return;
			}
			if (!invite.when) {
				result = { applied: false, reason: "unsupported" };
				return;
			}
			const time = storedTime(invite.when);
			if ("problem" in time) {
				result = { applied: false, reason: "unsupported" };
				return;
			}
			const newer =
				invite.sequence > record.sequence ||
				(invite.sequence === record.sequence && invite.stamp > stored.organizerStamp);
			if (!newer) {
				result = { applied: false, reason: "stale" };
				return;
			}
			this.updateMailCopy(record.id, invite, time);
			result = { applied: true };
		});
		if (queued) await this.schedule();
		return result;
	}

	/** Writes a newer version of a meeting by mail into its copy. The answer of the owner stays. */
	private updateMailCopy(eventId: string, invite: ICalInvite, time: EventTime): void {
		this.sql.exec(
			`UPDATE events SET title = ?, description = ?, location = ?, all_day = ?, start_at = ?, end_at = ?,
				start_date = ?, end_date = ?, time_zone = ?, organizer_name = ?, sequence = ?, organizer_stamp = ?,
				attendees_json = ?, revision = revision + 1, updated_at = ?
			WHERE id = ?`,
			invite.title,
			invite.description,
			invite.location,
			time.all_day ? 1 : 0,
			time.start_at,
			time.end_at,
			time.start_date,
			time.end_date,
			time.time_zone,
			invite.organizer?.name ?? "",
			invite.sequence,
			invite.stamp,
			JSON.stringify(this.mailAttendees(invite)),
			Date.now(),
			eventId,
		);
	}

	private applyMailReply(stored: StoredRow, invite: ICalInvite, mail: IncomingMail): ApplyResult {
		const { record } = stored;
		if (record.role !== "owner") return { applied: false, reason: "unknown" };
		const [answer] = invite.attendees;
		if (invite.attendees.length !== 1 || !answer || mail.from === null || answer.email !== mail.from) {
			return { applied: false, reason: "not_attendee" };
		}
		if (mail.verification === "failed" || answer.partstat === "NEEDS-ACTION") {
			return { applied: false, reason: "unverified" };
		}
		const row = this.sql
			.exec<{ reply_stamp: number; added_at: number }>(
				"SELECT reply_stamp, added_at FROM attendees WHERE event_id = ? AND attendee_key = ?",
				record.id,
				mailKey(mail.from),
			)
			.toArray()[0];
		if (!row) return { applied: false, reason: "not_attendee" };
		// A sender can write each DTSTAMP. A stamp after the arrival counts as the arrival.
		const stamp = Math.min(invite.stamp || mail.receivedAt, mail.receivedAt);
		if (stamp <= row.reply_stamp || stamp < row.added_at) return { applied: false, reason: "stale" };
		this.sql.exec(
			"UPDATE attendees SET response = ?, reply_stamp = ?, responded_at = ? WHERE event_id = ? AND attendee_key = ?",
			RESPONSE_OF[answer.partstat],
			stamp,
			stamp,
			record.id,
			mailKey(mail.from),
		);
		this.sql.exec("UPDATE events SET sequence = sequence + 1 WHERE id = ?", record.id);
		this.sendSnapshots(this.row(record.id) as EventRecord, false);
		return { applied: true };
	}

	/**
	 * The answer of the owner to an invitation by mail. Yes and Maybe put the meeting on the calendar, or change
	 * the answer of the copy. No without a copy adds nothing. Each new answer goes to the organizer by mail. The
	 * same answer again changes nothing and sends nothing. A copy of the same uid from a different organizer or
	 * sender, or a tombstone of this version or a newer one, gives `conflict`.
	 */
	async respondToMail(
		call: CalendarCall,
		input: MailAnswer,
	): Promise<{ event: EventRecord | null; changed: boolean } | Refusal> {
		const refused = this.enter(call);
		if (refused) return refused;
		const { invite } = input;
		const organizer = invite.organizer;
		if (!organizer) return refuse("invalid", "The invitation names no organizer.");
		const tomb = this.tombstone(invite.uid);
		const stored = this.stored("uid", invite.uid);
		if (!stored && tomb && tomb.sequence >= invite.sequence) {
			return refuse("conflict", "The organizer cancelled this meeting, or you removed it from your calendar.");
		}
		const now = Date.now();
		let eventId: string | null = null;
		let changed = true;
		if (stored) {
			const { record } = stored;
			if (
				record.role !== "attendee" ||
				stored.organizerId !== null ||
				record.organizer?.email !== organizer.email ||
				stored.senderEmail !== input.from
			) {
				return refuse("conflict", "A different organizer made the event with this id on your calendar.");
			}
			eventId = record.id;
			const newer =
				invite.sequence > record.sequence ||
				(invite.sequence === record.sequence && invite.stamp > stored.organizerStamp);
			if (record.my_response === input.response && !newer) return { event: record, changed: false };
			const stamp = Math.max(now, stored.myReplyStamp + 1);
			this.ctx.storage.transactionSync(() => {
				if (newer) this.updateMailCopy(record.id, invite, input.time);
				if (record.my_response === input.response) {
					changed = false;
					return;
				}
				this.sql.exec(
					"UPDATE events SET my_response = ?, my_reply_stamp = ?, my_email = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
					input.response,
					stamp,
					input.myEmail,
					now,
					record.id,
				);
				this.sendMailReply(
					this.row(record.id) as EventRecord,
					input.response,
					stamp,
					input.myEmail,
					`asterra-calendar:${invite.uid}:REPLY:${stamp}:${input.myEmail}`,
				);
			});
		} else if (input.response === "declined") {
			// No adds nothing to the calendar. The key has no time, so the same No again sends no second mail.
			const fake = this.copyRecordOf(invite, input, null);
			this.ctx.storage.transactionSync(() =>
				this.sendMailReply(
					fake,
					"declined",
					now,
					input.myEmail,
					`asterra-calendar:${invite.uid}:REPLY:${invite.sequence}:declined:${input.myEmail}`,
				),
			);
		} else {
			if (this.eventCount() >= CALENDAR_LIMITS.events) {
				return refuse("invalid", `A calendar can have at most ${CALENDAR_LIMITS.events} events. Delete events first.`);
			}
			eventId = newId("evt");
			const id = eventId;
			const time = input.time;
			this.ctx.storage.transactionSync(() => {
				this.sql.exec(
					`INSERT INTO events (id, title, description, location, all_day, start_at, end_at, start_date, end_date,
						time_zone, revision, created_at, updated_at, uid, role, sequence, organizer_id, organizer_email,
						organizer_name, my_response, my_reply_stamp, attendees_json, sender_email, organizer_stamp, my_email)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'attendee', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
					id,
					invite.title,
					invite.description,
					invite.location,
					time.all_day ? 1 : 0,
					time.start_at,
					time.end_at,
					time.start_date,
					time.end_date,
					time.time_zone,
					now,
					now,
					invite.uid,
					invite.sequence,
					organizer.email,
					organizer.name,
					input.response,
					now,
					JSON.stringify(this.mailAttendees(invite)),
					input.from,
					invite.stamp,
					input.myEmail,
				);
				this.addToCount(1);
				this.sql.exec("DELETE FROM meeting_tombstones WHERE uid = ?", invite.uid);
				this.sendMailReply(
					this.row(id) as EventRecord,
					input.response,
					now,
					input.myEmail,
					`asterra-calendar:${invite.uid}:REPLY:${now}:${input.myEmail}`,
				);
			});
		}
		await this.schedule();
		return { event: eventId ? this.row(eventId) : null, changed };
	}

	/** A record of an invitation by mail that is not on the calendar, for the answer No. */
	private copyRecordOf(invite: ICalInvite, input: MailAnswer, id: string | null): EventRecord {
		return {
			id: id ?? "",
			uid: invite.uid,
			role: "attendee",
			sequence: invite.sequence,
			revision: 0,
			created_at: 0,
			updated_at: 0,
			title: invite.title,
			description: invite.description,
			location: invite.location,
			...input.time,
			organizer: { principal_id: null, email: invite.organizer?.email ?? "", name: invite.organizer?.name ?? "" },
			attendees: this.mailAttendees(invite),
			my_response: input.response,
			my_responded_at: null,
			my_email: input.myEmail,
		};
	}

	/**
	 * The state of an invitation by mail on the calendar of the owner: the copy or the event of this uid, or its
	 * tombstone. `sequence` is the SEQUENCE of the mail.
	 */
	mailInvitationState(
		call: CalendarCall,
		uid: string,
		sequence: number,
	):
		| { state: "new" | "on_calendar" | "outdated" | "cancelled"; my_response: Response | null; event_id: string | null }
		| Refusal {
		const refused = this.enter(call);
		if (refused) return refused;
		const stored = this.stored("uid", uid);
		if (stored) {
			return {
				state: stored.record.sequence > sequence ? "outdated" : "on_calendar",
				my_response: stored.record.my_response,
				event_id: stored.record.id,
			};
		}
		const tomb = this.tombstone(uid);
		if (tomb && tomb.sequence >= sequence) return { state: "cancelled", my_response: null, event_id: null };
		return { state: "new", my_response: null, event_id: null };
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
	 * the call ran. Each message is read again immediately before its call, so a payload that a change replaced
	 * while an earlier call ran is not sent, and a deleted message is not sent.
	 */
	private async drain(): Promise<void> {
		const due = this.sql
			.exec<{ id: number }>(
				"SELECT id FROM outbox WHERE next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT ?",
				Date.now(),
				OUTBOX_BATCH,
			)
			.toArray();
		for (const { id } of due) {
			const row = this.sql
				.exec<{ id: number; kind: string; target: string; payload: string; gen: number; attempts: number }>(
					"SELECT id, kind, target, payload, gen, attempts FROM outbox WHERE id = ?",
					id,
				)
				.toArray()[0];
			if (!row) continue;
			try {
				if (row.kind === "mail") {
					const payload = JSON.parse(row.payload) as MailPayload;
					const sent = await sendCalendarMail(this.env, {
						senderId: this.meta("owner_id") ?? "",
						to: row.target.slice("mailto:".length),
						subject: payload.subject,
						text: payload.text,
						method: payload.method,
						ics: buildICalendar(payload.ical),
						idempotencyKey: payload.key,
					});
					if (sent.status === "refused") log("info", "calendar mail not sent", { reason: sent.reason });
					this.sql.exec("DELETE FROM outbox WHERE id = ? AND gen = ?", row.id, row.gen);
					continue;
				}
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
