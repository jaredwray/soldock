import { ID_CHARS, prefixedId, Timestamp } from "./common.ts";
import { defineOperation } from "./operation.ts";
import { CALENDAR_WEBHOOK_EVENTS, CalendarWebhookSubscription } from "./webhooks.ts";
import { z } from "./zod.ts";

// The calendar of a principal. Each person, agent and service account has one calendar. A call reaches
// only the calendar of its caller. The time helpers are here, so the server and the web app agree.

export const CALENDAR_LIMITS = {
	titleChars: 300,
	locationChars: 500,
	descriptionChars: 8000,
	/** The longest event, in days. */
	eventDays: 366,
	/** The longest time range of one calendar.list_events, in days. */
	rangeDays: 366,
	/** The events of one page of calendar.list_events, without `limit`. */
	defaultPageSize: 100,
	pageSize: 250,
	/** The events of one calendar. */
	events: 50_000,
	/** The first day that an event can use. */
	firstDate: "1970-01-01",
	/** The last day that an event can use. */
	lastDate: "2100-12-31",
	/** The repeated events (series) of one calendar. */
	recurringEvents: 500,
	/** The changed and cancelled occurrences of one series. */
	exceptions: 500,
	/** The most occurrences of a repeat with a count. */
	recurrenceCount: 730,
	/** The largest interval of a repeat. */
	recurrenceInterval: 99,
	/** The most occurrences of one series in one range query. */
	occurrencesPerSeries: 400,
	/** The attendees of one event, without the organizer. */
	attendees: 50,
	/** The principals of one calendar.query_free_busy. */
	freeBusyPrincipals: 20,
	/** The longest range of one calendar.query_free_busy, in days. */
	freeBusyDays: 62,
	/** The changes of one page of calendar.list_changes, without `limit`, and the most. */
	changesPageSize: 200,
	/** A published change stays in the change feed for this many days. Then a cursor before it expires. */
	changeDays: 30,
	/** The most published changes that one calendar keeps. Older ones go first. */
	changes: 10_000,
} as const;

/** The reminders that a participant can choose, in minutes before the start. */
export const REMINDER_MINUTES = [5, 10, 30] as const;
export type ReminderMinutes = (typeof REMINDER_MINUTES)[number];
/** The reminder of a new timed event and of a new invitation. */
export const DEFAULT_REMINDER_MINUTES: ReminderMinutes = 10;

export const DAY_MS = 86_400_000;

/** The ms of the first instant and of the instant after the last day that an event can use. */
const FIRST_MS = Date.UTC(1970, 0, 1);
const END_MS = Date.UTC(2101, 0, 1);

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The UTC midnight of a date in YYYY-MM-DD form, in ms. NaN for a text that is not a real date. */
export function dateToUtcMs(date: string): number {
	const match = DATE_PATTERN.exec(date);
	if (!match) return Number.NaN;
	const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
	const ms = Date.UTC(year, month - 1, day);
	const back = new Date(ms);
	if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) {
		return Number.NaN;
	}
	return ms;
}

/** True for a real date in YYYY-MM-DD form, for example 2026-12-01. 2026-02-30 is not a real date. */
export function isRealDate(date: string): boolean {
	return !Number.isNaN(dateToUtcMs(date));
}

/** The date `days` days after a date in YYYY-MM-DD form. A negative count goes back. */
export function addDays(date: string, days: number): string {
	return new Date(dateToUtcMs(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The days from one date to a different date. Negative when `to` is before `from`. */
export function daysBetween(from: string, to: string): number {
	return Math.round((dateToUtcMs(to) - dateToUtcMs(from)) / DAY_MS);
}

/** A time zone name in IANA form, such as America/New_York, Etc/GMT+12 or UTC. */
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;

/**
 * The name of a time zone as the runtime keeps it, for example America/New_York for america/new_york.
 * Null for a name that is not an IANA time zone.
 */
export function canonicalTimeZone(name: string): string | null {
	if (name.length > 64 || !ZONE_NAME.test(name)) return null;
	try {
		return new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
	} catch {
		return null;
	}
}

export function isTimeZone(name: string): boolean {
	return canonicalTimeZone(name) !== null;
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>();

/** The parts of an instant on the wall clock of a time zone. Use a canonical name: the cache keys on it. */
function wallClock(ms: number, timeZone: string) {
	let format = zoneFormats.get(timeZone);
	if (!format) {
		// A caller can give each spelling of a name. The cache stays small.
		if (zoneFormats.size >= 500) zoneFormats.clear();
		format = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
		zoneFormats.set(timeZone, format);
	}
	const parts: Record<string, number> = {};
	for (const part of format.formatToParts(new Date(ms))) {
		if (part.type !== "literal") parts[part.type] = Number(part.value);
	}
	return {
		year: parts.year ?? 1970,
		month: parts.month ?? 1,
		day: parts.day ?? 1,
		hour: parts.hour ?? 0,
		minute: parts.minute ?? 0,
		second: parts.second ?? 0,
	};
}

/** The offset of a time zone from UTC at an instant, in ms. New York in winter gives -18000000. */
export function zoneOffsetMs(ms: number, timeZone: string): number {
	const wall = wallClock(ms, timeZone);
	const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
	return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The date of an instant on the wall clock of a time zone, in YYYY-MM-DD form. */
export function zonedDate(ms: number, timeZone: string): string {
	const wall = wallClock(ms, timeZone);
	return `${String(wall.year).padStart(4, "0")}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(2, "0")}`;
}

/**
 * The instant of a wall clock time in a time zone, in ms. `wallMs` is the wall clock time as if it was UTC.
 * A time that the clock shows two times gives the first instant. A time that the clock skips gives the same
 * time after the skip: 02:30 gives 03:30 when the clock goes from 02:00 to 03:00.
 */
function wallToInstant(wallMs: number, timeZone: string): number {
	// The offsets on the two sides of a change of the clock near the time. They are equal on most days.
	const before = wallMs - zoneOffsetMs(wallMs - DAY_MS, timeZone);
	const after = wallMs - zoneOffsetMs(wallMs + DAY_MS, timeZone);
	const early = Math.min(before, after);
	const late = Math.max(before, after);
	return early + zoneOffsetMs(early, timeZone) === wallMs ? early : late;
}

/**
 * The first instant of a date in a time zone, in ms. This is 00:00 on almost each day. Do not add 24 hours
 * to get the next day: a day can have 23 or 25 hours. In a zone that skips 00:00 for a change of the clock,
 * the result is the instant of the change: the day starts at 01:00 there.
 */
export function zonedDayStart(date: string, timeZone: string): number {
	return wallToInstant(dateToUtcMs(date), timeZone);
}

/**
 * The instant of a date and a wall clock time (HH:MM) in a time zone, in ms. The web app uses it to make
 * the `when` of an event from the fields of the form. A time that the clock shows two times gives the first
 * instant. A time that the clock skips gives the same time after the skip: 02:30 gives 03:30.
 */
export function zonedTime(date: string, time: string, timeZone: string): number {
	const [hour, minute] = time.split(":").map(Number);
	return wallToInstant(dateToUtcMs(date) + ((hour ?? 0) * 60 + (minute ?? 0)) * 60_000, timeZone);
}

/** The date and the ms from 00:00 of an instant on the wall clock of a time zone. */
export function zonedWall(ms: number, timeZone: string): { date: string; msOfDay: number } {
	const wall = wallClock(ms, timeZone);
	const date = `${String(wall.year).padStart(4, "0")}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(2, "0")}`;
	return {
		date,
		msOfDay: ((wall.hour * 60 + wall.minute) * 60 + wall.second) * 1000 + (ms - Math.floor(ms / 1000) * 1000),
	};
}

/**
 * The instant of a date and a time of the wall clock (ms from 00:00) in a time zone. The rules of `zonedTime`
 * apply: a time that the clock shows two times gives the first instant, and a time that the clock skips gives
 * the same time after the skip.
 */
export function zonedInstant(date: string, msOfDay: number, timeZone: string): number {
	return wallToInstant(dateToUtcMs(date) + msOfDay, timeZone);
}

/** The bounds of the days of an all-day event in each time zone: from UTC+14 to UTC-12. */
const EARLIEST_ZONE_MS = 14 * 60 * 60 * 1000;
const LATEST_ZONE_MS = 12 * 60 * 60 * 1000;

/**
 * The widest instants of the days of an all-day event in each time zone, in UTC ms: UTC midnight of
 * `startDate` minus 14 hours, and UTC midnight of `endDate` plus 12 hours.
 */
export function allDayBounds(startDate: string, endDate: string): { start_at: number; end_at: number } {
	return { start_at: dateToUtcMs(startDate) - EARLIEST_ZONE_MS, end_at: dateToUtcMs(endDate) + LATEST_ZONE_MS };
}

/** The time of an event. `timed` has two instants. `all_day` has days, without a time zone. */
export type EventWhenValue =
	| { kind: "timed"; start: string; end: string; time_zone: string }
	| { kind: "all_day"; start_date: string; end_date: string };

/**
 * The problem with the time of an event, or null when the time is good. The server and the event dialog of
 * the web app use the same texts.
 */
export function checkWhen(when: EventWhenValue): string | null {
	if (when.kind === "timed") {
		const start = Date.parse(when.start);
		const end = Date.parse(when.end);
		if (Number.isNaN(start) || Number.isNaN(end)) return "start and end must be times in ISO 8601 form.";
		if (end <= start) return "The end of an event must be after its start.";
		if (end - start > CALENDAR_LIMITS.eventDays * DAY_MS) {
			return `An event can be at most ${CALENDAR_LIMITS.eventDays} days long.`;
		}
		if (start < FIRST_MS || end > END_MS) {
			return `An event must be from ${CALENDAR_LIMITS.firstDate} to ${CALENDAR_LIMITS.lastDate}.`;
		}
		return null;
	}
	const start = dateToUtcMs(when.start_date);
	const end = dateToUtcMs(when.end_date);
	if (Number.isNaN(start) || Number.isNaN(end)) return "start_date and end_date must be real dates.";
	if (end === start) {
		return `end_date is the day after the last day of the event. A one-day event on ${when.start_date} has end_date ${addDays(when.start_date, 1)}.`;
	}
	if (end < start) return "The end_date of an event must be after its start_date.";
	if (end - start > CALENDAR_LIMITS.eventDays * DAY_MS) {
		return `An event can be at most ${CALENDAR_LIMITS.eventDays} days long.`;
	}
	if (start < FIRST_MS || end > END_MS) {
		return `An event must be from ${CALENDAR_LIMITS.firstDate} to ${CALENDAR_LIMITS.lastDate}.`;
	}
	return null;
}

const INSTANT = z.iso.datetime({ offset: true });

/** True for a time in ISO 8601 form with an offset or Z. */
export function isInstant(value: string): boolean {
	return INSTANT.safeParse(value).success;
}

export const EventId = prefixedId("evt").describe("The id of an event, as calendar.list_events returns it.");

const CONTROL = /\p{Cc}/u;
const CONTROL_ALL = /\p{Cc}/gu;

/** True when the text has a control character other than a tab or a line break. */
function hasControlOutsideLines(value: string): boolean {
	return (value.match(CONTROL_ALL) ?? []).some((char) => char !== "\t" && char !== "\n" && char !== "\r");
}

const Title = z
	.string()
	.trim()
	.min(1)
	.max(CALENDAR_LIMITS.titleChars)
	.refine((value) => !CONTROL.test(value), "must not contain control characters");
const Location = z
	.string()
	.trim()
	.max(CALENDAR_LIMITS.locationChars)
	.refine((value) => !CONTROL.test(value), "must not contain control characters");
const Description = z
	.string()
	.max(CALENDAR_LIMITS.descriptionChars)
	.refine(
		(value) => !hasControlOutsideLines(value),
		"must not contain control characters other than tabs and line breaks",
	);

const DateOnly = z.string().refine(isRealDate, "must be a real date in YYYY-MM-DD form, such as 2026-12-01");

const TimeZone = z
	.string()
	.refine(isTimeZone, "must be an IANA time zone, such as America/New_York, Europe/Berlin or UTC");

const WHEN_NOTE = [
	'A timed event has kind "timed", start, end and time_zone.',
	"start and end are ISO 8601 times with an offset or Z, for example 2026-12-01T09:00:00-05:00.",
	"time_zone is the IANA time zone of the event, for example America/New_York. The output gives start and end in UTC.",
	'An all-day event has kind "all_day", start_date and end_date in YYYY-MM-DD form, and no time zone: it is on the same days in each time zone.',
	"end_date is the day after the last day of the event, as in iCalendar. A one-day event on 2026-12-01 has start_date 2026-12-01 and end_date 2026-12-02.",
	`An event can be at most ${CALENDAR_LIMITS.eventDays} days long, from ${CALENDAR_LIMITS.firstDate} to ${CALENDAR_LIMITS.lastDate}.`,
].join(" ");

const RECURRENCE_NOTE = [
	'recurrence repeats the event. frequency is "daily", "weekly" or "monthly". interval is the number of periods from one occurrence to the next: a meeting each other week has frequency "weekly" and interval 2.',
	"A weekly repeat uses the weekday of the start. A monthly repeat uses the day of the month of the start. A month without that day has no occurrence: a repeat on the 31st skips April, June, September, November and February.",
	"A timed repeat keeps the wall clock time of the start in time_zone, also when the clock changes for daylight saving time. An all-day repeat keeps dates.",
	`Set until (a date, the last day that can have an occurrence, in time_zone) or count (from 1 to ${CALENDAR_LIMITS.recurrenceCount} occurrences), or neither for no end. Not both.`,
].join(" ");

export const RecurrenceInput = z
	.strictObject({
		frequency: z.enum(["daily", "weekly", "monthly"]),
		interval: z.number().int().min(1).max(CALENDAR_LIMITS.recurrenceInterval).default(1),
		until: DateOnly.optional(),
		count: z.number().int().min(1).max(CALENDAR_LIMITS.recurrenceCount).optional(),
	})
	.refine((rule) => rule.until === undefined || rule.count === undefined, "Set until or count, not both")
	.describe(RECURRENCE_NOTE);
export type RecurrenceInput = z.infer<typeof RecurrenceInput>;

export const Recurrence = z.object({
	frequency: z.enum(["daily", "weekly", "monthly"]),
	interval: z.number().int(),
	until: z.string().nullable(),
	count: z.number().int().nullable(),
});
export type Recurrence = z.infer<typeof Recurrence>;

const ReminderInput = z
	.union([z.literal(5), z.literal(10), z.literal(30), z.null()])
	.describe("Minutes before the start: 5, 10 or 30. null for no reminder. Only a timed event has a reminder.");

export const EventResponse = z.enum(["needs_action", "accepted", "declined"]);
export type EventResponse = z.infer<typeof EventResponse>;

export const EventAttendee = z.object({
	principal_id: z.string(),
	display_name: z.string(),
	response: EventResponse,
});
export type EventAttendee = z.infer<typeof EventAttendee>;

/** The time of an event, as a caller gives it. */
export const EventWhenInput = z
	.discriminatedUnion("kind", [
		z.strictObject({
			kind: z.literal("timed"),
			start: INSTANT,
			end: INSTANT,
			time_zone: TimeZone,
		}),
		z.strictObject({
			kind: z.literal("all_day"),
			start_date: DateOnly,
			end_date: DateOnly,
		}),
	])
	.describe(WHEN_NOTE);

/** The time of an event, as the output gives it. */
export const EventWhen = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("timed"), start: Timestamp, end: Timestamp, time_zone: z.string() }),
	z.object({ kind: z.literal("all_day"), start_date: z.string(), end_date: z.string() }),
]);
export type EventWhen = z.infer<typeof EventWhen>;

export const CalendarEvent = z.object({
	/** The id of the event. All the occurrences of a series have the id of the series. */
	id: z.string(),
	title: z.string(),
	description: z.string(),
	location: z.string(),
	/** The time of this occurrence. For a series from calendar.get_event, the time of the first occurrence. */
	when: EventWhen,
	/** 1 for a new event. Each change of the series or of one occurrence adds 1. */
	revision: z.number().int(),
	created_at: Timestamp,
	updated_at: Timestamp,
	/** The rule of a series. Null for a one-off event. */
	recurrence: Recurrence.nullable(),
	/** The id of this occurrence of a series. Null for a one-off event and for a series from calendar.get_event. */
	occurrence_id: z.string().nullable(),
	/** The start of this occurrence as the rule gives it: a UTC time, or a date for an all-day series. */
	original_start: z.string().nullable(),
	/** True when this occurrence has a change of its own. */
	is_exception: z.boolean(),
	/** organizer: you own the event. attendee: a copy of an event of a different principal that invited you. */
	role: z.enum(["organizer", "attendee"]),
	organizer: z.object({ principal_id: z.string(), display_name: z.string() }).nullable(),
	/** The invited principals, without the organizer, with the response for this occurrence. */
	attendees: z.array(EventAttendee),
	/** Your response for this occurrence. Null when you are the organizer. */
	my_response: EventResponse.nullable(),
	/** Your reminder, in minutes before the start. Null for no reminder. */
	reminder_minutes: z.number().int().nullable(),
});
export type CalendarEvent = z.infer<typeof CalendarEvent>;

const READ = { readOnly: true, destructive: false, idempotent: true, openWorld: false } as const;

const OWN_NOTE =
	"The calendar is your own calendar. Each person, agent and service account has one. Nobody else can read or change it.";

const BASE_REVISION = z
	.number()
	.int()
	.min(1)
	.optional()
	.describe(
		"The revision of the event that you read. When the event has a different revision now, the call changes nothing and returns conflict. Read the event again, then try again.",
	);

const ATTENDEES_NOTE = [
	"attendee_ids invites people of your organization: each gets a copy of the event in their calendar, and can accept or decline it.",
	`An event can have at most ${CALENDAR_LIMITS.attendees} attendees. Only a person can invite, and only people can be invited.`,
].join(" ");

const REMINDER_NOTE =
	"reminder_minutes is your own reminder: 5, 10 or 30 minutes before each occurrence, or null for none. The default for a timed event is 10. An all-day event has no reminder. A reminder shows in your Activity, and on your devices when you turned on notifications.";

const AttendeeIds = z
	.array(prefixedId("prn"))
	.max(CALENDAR_LIMITS.attendees)
	.describe("The principal ids of the people to invite.");

const RangeTime = z
	.string()
	.max(40)
	.refine(isInstant, "must be a time in ISO 8601 form with an offset or Z, such as 2026-12-01T00:00:00Z");

export const listEvents = defineOperation({
	name: "calendar.list_events",
	summary: "List the events of your calendar in a time range",
	description: [
		"Returns the events of your calendar that overlap the range from time_min to time_max, first start first.",
		"A repeated event (a series) gives one entry for each occurrence in the range, with occurrence_id set. A cancelled occurrence gives no entry. A moved occurrence is at its new time.",
		"An event that ends at time_min, or starts at time_max, is not in the range.",
		`The range can be at most ${CALENDAR_LIMITS.rangeDays} days long.`,
		"time_zone sets the days of all-day events: an all-day event is in the range when one of its days, from 00:00 to 00:00 in time_zone, overlaps the range. The default is UTC. Give your own time zone.",
		"When next_cursor is not null, more events follow: call again with the same input and cursor set to next_cursor.",
		OWN_NOTE,
	].join(" "),
	http: { method: "GET", path: "/api/v1/calendar/events" },
	scopes: ["calendar.read"],
	callers: ["human", "agent", "service"],
	annotations: READ,
	input: z
		.strictObject({
			time_min: RangeTime.describe("The start of the range: an ISO 8601 time, such as 2026-12-01T00:00:00Z."),
			time_max: RangeTime.describe("The end of the range: an ISO 8601 time. It is not in the range."),
			time_zone: TimeZone.optional().describe(
				"The IANA time zone for the days of all-day events, such as America/New_York. The default is UTC.",
			),
			limit: z.coerce
				.number()
				.int()
				.min(1)
				.max(CALENDAR_LIMITS.pageSize)
				.optional()
				.describe(`The most events on one page. The default is ${CALENDAR_LIMITS.defaultPageSize}.`),
			cursor: z.string().max(600).optional(),
		})
		.refine((input) => Date.parse(input.time_max) > Date.parse(input.time_min), "time_max must be after time_min")
		.refine(
			(input) => Date.parse(input.time_max) - Date.parse(input.time_min) <= CALENDAR_LIMITS.rangeDays * DAY_MS,
			`The range can be at most ${CALENDAR_LIMITS.rangeDays} days long`,
		),
	output: z.object({ events: z.array(CalendarEvent), next_cursor: z.string().nullable() }),
	errors: [],
});

export const getEvent = defineOperation({
	name: "calendar.get_event",
	summary: "Read one event of your calendar",
	description: [
		"Returns one event of your calendar. For a series, when is the time of the first occurrence and occurrence_id is null: use calendar.list_events for the occurrences.",
		OWN_NOTE,
	].join(" "),
	http: { method: "GET", path: "/api/v1/calendar/events/{event_id}" },
	scopes: ["calendar.read"],
	callers: ["human", "agent", "service"],
	annotations: READ,
	input: z.strictObject({ event_id: EventId }),
	output: z.object({ event: CalendarEvent }),
	errors: ["not_found"],
});

export const createEvent = defineOperation({
	name: "calendar.create_event",
	summary: "Add an event to your calendar",
	description: [
		"Adds an event to your calendar and returns it.",
		WHEN_NOTE,
		RECURRENCE_NOTE,
		ATTENDEES_NOTE,
		REMINDER_NOTE,
		`A calendar can have at most ${CALENDAR_LIMITS.events} events and ${CALENDAR_LIMITS.recurringEvents} series.`,
		"Set idempotency_key to make a retry safe.",
		OWN_NOTE,
	].join(" "),
	http: { method: "POST", path: "/api/v1/calendar/events" },
	scopes: ["calendar.write"],
	callers: ["human", "agent", "service"],
	annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: false },
	input: z.strictObject({
		title: Title,
		when: EventWhenInput,
		description: Description.default("").describe("Plain text. Line breaks stay."),
		location: Location.default(""),
		recurrence: RecurrenceInput.optional(),
		attendee_ids: AttendeeIds.optional(),
		reminder_minutes: ReminderInput.optional(),
		idempotency_key: z
			.string()
			.min(1)
			.max(255)
			.optional()
			.describe(
				"Makes a retry safe: a second call with the same key and the same input returns the first event and adds nothing.",
			),
	}),
	output: z.object({ event: CalendarEvent }),
	errors: ["conflict", "forbidden"],
});

export const updateEvent = defineOperation({
	name: "calendar.update_event",
	summary: "Change an event of your calendar",
	description: [
		"Changes the fields that you give. A field that you do not give stays. when replaces the whole time of the event, so you can change a timed event to an all-day event.",
		"For a series, the change applies to the entire series: when is the time of the first occurrence. To change one occurrence, use calendar.update_occurrence.",
		"A change of when or of recurrence removes the changes and the cancellations of single occurrences, and sets the response of each attendee to needs_action.",
		WHEN_NOTE,
		"recurrence: null makes a series a one-off event.",
		"attendee_ids replaces the list of attendees.",
		"Only the organizer can change an event. On an invitation, use calendar.respond_to_event and calendar.set_reminder.",
		"A call that changes nothing keeps the revision.",
		"Set base_revision to the revision that you read. When the event has a different revision now, the call fails with conflict and changes nothing: read the event again.",
		"Without base_revision, the change applies to the current event.",
		OWN_NOTE,
	].join(" "),
	http: { method: "POST", path: "/api/v1/calendar/events/{event_id}" },
	scopes: ["calendar.write"],
	callers: ["human", "agent", "service"],
	annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
	input: z.strictObject({
		event_id: EventId,
		title: Title.optional(),
		when: EventWhenInput.optional(),
		description: Description.optional(),
		location: Location.optional(),
		recurrence: RecurrenceInput.nullable().optional(),
		attendee_ids: AttendeeIds.optional(),
		base_revision: BASE_REVISION,
	}),
	output: z.object({ event: CalendarEvent }),
	errors: ["not_found", "conflict", "forbidden"],
});

export const deleteEvent = defineOperation({
	name: "calendar.delete_event",
	summary: "Delete an event of your calendar",
	description: [
		"Deletes an event of your calendar. This cannot be undone. For a series, it deletes each occurrence. To cancel one occurrence, use calendar.cancel_occurrence.",
		"The event is removed from the calendar of each attendee too. On an invitation, the call fails with forbidden: decline it with calendar.respond_to_event.",
		"Set dry_run to true to get the event without a change.",
		"Set base_revision to the revision that you read. When the event has a different revision now, the call fails with conflict and deletes nothing: read the event again.",
		"Without base_revision, the call deletes the current event.",
		OWN_NOTE,
	].join(" "),
	http: { method: "DELETE", path: "/api/v1/calendar/events/{event_id}" },
	scopes: ["calendar.write"],
	callers: ["human", "agent", "service"],
	annotations: { readOnly: false, destructive: true, idempotent: false, openWorld: false },
	input: z.strictObject({
		event_id: EventId,
		base_revision: BASE_REVISION,
		dry_run: z.boolean().default(false),
	}),
	output: z.object({ event: CalendarEvent, dry_run: z.boolean() }),
	errors: ["not_found", "conflict", "forbidden"],
});

const OCCURRENCE_ID_PATTERN = new RegExp(`^evt_${ID_CHARS}_\\d{8}(?:T\\d{6}Z)?$`);

export const OccurrenceId = z
	.string()
	.regex(OCCURRENCE_ID_PATTERN, "must be an occurrence id, as calendar.list_events returns it in occurrence_id")
	.describe("The id of one occurrence of a series, as calendar.list_events returns it in occurrence_id.");

const SCOPE_NOTE =
	"The change applies to this occurrence only. The other occurrences of the series and the id of this occurrence stay the same. base_revision is the revision of the series.";

export const updateOccurrence = defineOperation({
	name: "calendar.update_occurrence",
	summary: "Change one occurrence of a repeated event",
	description: [
		"Changes the fields that you give for one occurrence of a series. A field that you do not give stays.",
		"when moves the occurrence to a different date or time. Its kind must be the kind of the series.",
		SCOPE_NOTE,
		"The attendees get the change. To change the entire series, use calendar.update_event.",
		OWN_NOTE,
	].join(" "),
	http: { method: "POST", path: "/api/v1/calendar/occurrences/{occurrence_id}" },
	scopes: ["calendar.write"],
	callers: ["human", "agent", "service"],
	annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
	input: z.strictObject({
		occurrence_id: OccurrenceId,
		title: Title.optional(),
		when: EventWhenInput.optional(),
		description: Description.optional(),
		location: Location.optional(),
		base_revision: BASE_REVISION,
	}),
	output: z.object({ event: CalendarEvent }),
	errors: ["not_found", "conflict", "forbidden"],
});

export const cancelOccurrence = defineOperation({
	name: "calendar.cancel_occurrence",
	summary: "Cancel one occurrence of a repeated event",
	description: [
		"Cancels one occurrence of a series. The occurrence is removed from your calendar and from the calendar of each attendee. Its reminders do not occur. This cannot be undone.",
		SCOPE_NOTE,
		"Set dry_run to true to get the occurrence without a change. To delete the entire series, use calendar.delete_event.",
		OWN_NOTE,
	].join(" "),
	http: { method: "DELETE", path: "/api/v1/calendar/occurrences/{occurrence_id}" },
	scopes: ["calendar.write"],
	callers: ["human", "agent", "service"],
	annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
	input: z.strictObject({
		occurrence_id: OccurrenceId,
		base_revision: BASE_REVISION,
		dry_run: z.boolean().default(false),
	}),
	output: z.object({ event: CalendarEvent, dry_run: z.boolean() }),
	errors: ["not_found", "conflict", "forbidden"],
});

export const respondToEvent = defineOperation({
	name: "calendar.respond_to_event",
	summary: "Accept or decline an invitation",
	description: [
		"Sets your response to an event of a different principal that invited you.",
		"Without occurrence_id, the response is for the entire series. With occurrence_id, it is for that occurrence only.",
		"A declined occurrence has no reminder and does not show as busy in calendar.query_free_busy.",
		"The organizer gets the response. The organizer of an event cannot respond to it.",
	].join(" "),
	http: { method: "POST", path: "/api/v1/calendar/events/{event_id}/response" },
	scopes: ["calendar.write"],
	callers: ["human", "agent", "service"],
	annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
	input: z.strictObject({
		event_id: EventId,
		occurrence_id: OccurrenceId.optional(),
		response: z.enum(["accepted", "declined"]),
	}),
	output: z.object({ event: CalendarEvent }),
	errors: ["not_found", "invalid"],
});

export const setReminder = defineOperation({
	name: "calendar.set_reminder",
	summary: "Set or remove your reminder of an event",
	description: [
		"Sets your own reminder of an event: 5, 10 or 30 minutes before each occurrence, or null for no reminder.",
		"The reminder is yours only. The organizer and each attendee choose their own reminder. It does not change the revision.",
		REMINDER_NOTE,
	].join(" "),
	http: { method: "POST", path: "/api/v1/calendar/events/{event_id}/reminder" },
	scopes: ["calendar.write"],
	callers: ["human", "agent", "service"],
	annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
	input: z.strictObject({ event_id: EventId, minutes: ReminderInput }),
	output: z.object({ event: CalendarEvent }),
	errors: ["not_found", "invalid"],
});

export const BusyInterval = z.object({ start: Timestamp, end: Timestamp });

export const queryFreeBusy = defineOperation({
	name: "calendar.query_free_busy",
	summary: "Get the busy times of principals of your organization",
	description: [
		"Returns the busy times of each principal in principal_ids from time_min to time_max, without titles or other details.",
		'principal_ids is one text, with a comma between the ids, for example "prn_…,prn_…".',
		"A busy time is a timed event or occurrence. Cancelled occurrences, and events and occurrences that the principal declined, are not busy. All-day events are not busy.",
		`One call takes at most ${CALENDAR_LIMITS.freeBusyPrincipals} principals and a range of at most ${CALENDAR_LIMITS.freeBusyDays} days.`,
	].join(" "),
	http: { method: "GET", path: "/api/v1/calendar/free_busy" },
	scopes: ["calendar.read"],
	callers: ["human", "agent", "service"],
	annotations: READ,
	input: z
		.strictObject({
			principal_ids: z
				.string()
				.max(1000)
				.regex(
					new RegExp(
						`^\\s*prn_${ID_CHARS}(?:\\s*,\\s*prn_${ID_CHARS}){0,${CALENDAR_LIMITS.freeBusyPrincipals - 1}}\\s*$`,
					),
					`must be at most ${CALENDAR_LIMITS.freeBusyPrincipals} ids that start with prn_, with a comma between them`,
				),
			time_min: RangeTime,
			time_max: RangeTime,
		})
		.refine((input) => Date.parse(input.time_max) > Date.parse(input.time_min), "time_max must be after time_min")
		.refine(
			(input) => Date.parse(input.time_max) - Date.parse(input.time_min) <= CALENDAR_LIMITS.freeBusyDays * DAY_MS,
			`The range can be at most ${CALENDAR_LIMITS.freeBusyDays} days long`,
		),
	output: z.object({
		calendars: z.array(z.object({ principal_id: z.string(), busy: z.array(BusyInterval) })),
	}),
	errors: ["not_found"],
});

/**
 * One committed change of a calendar. It has ids only: read the event with calendar.get_event. For a change
 * with occurrence_id, read the occurrence with calendar.list_events over its range. The change feed, the
 * events socket hint and MCP Events use the same record, with the same `id`.
 */
export const CalendarChange = z.object({
	id: z.string().describe("The stable id of the change. A retry of a delivery has the same id."),
	type: z.enum(CALENDAR_WEBHOOK_EVENTS),
	calendar_id: z.string().describe("The calendar: the id of its owner."),
	event_id: z
		.string()
		.describe("The event: the same id on the calendar of the organizer and on the copy of each attendee."),
	occurrence_id: z
		.string()
		.nullable()
		.describe(
			"The id of the occurrence that changed, as calendar.list_events gives it. Null for a change of the entire event or series.",
		),
	revision: z
		.number()
		.int()
		.describe("The revision of the event after the change. A response does not change it, so deduplicate by id."),
	actor_id: z.string().nullable().describe("The principal that caused the change, or null."),
	at: Timestamp,
	cursor: z.string().describe("The position after this change. Give it to calendar.list_changes to continue."),
});
export type CalendarChange = z.infer<typeof CalendarChange>;

export const listChanges = defineOperation({
	name: "calendar.list_changes",
	summary: "List the changes of your calendar after a cursor",
	description: [
		"Returns the changes of your calendar after cursor, oldest first. Each change has ids only: read the event with calendar.get_event.",
		"For a change with occurrence_id, read the occurrence with calendar.list_events over its range.",
		"Without cursor, the result has no changes and the cursor of now: keep it, then read your events.",
		"When has_more is true, call again with the cursor of the result.",
		`When expired is true, the cursor is older than the feed (${CALENDAR_LIMITS.changeDays} days or ${CALENDAR_LIMITS.changes} changes): read your events again with calendar.list_events, and continue from the cursor of the result.`,
		"A change can come two times. Skip a change with an id that you know.",
		OWN_NOTE,
	].join(" "),
	http: { method: "GET", path: "/api/v1/calendar/changes" },
	scopes: ["calendar.read"],
	callers: ["human", "agent", "service"],
	annotations: READ,
	input: z.strictObject({
		cursor: z.string().max(200).optional().describe("The cursor of a previous result or of a change."),
		limit: z.coerce
			.number()
			.int()
			.min(1)
			.max(CALENDAR_LIMITS.changesPageSize)
			.optional()
			.describe(`The most changes on one page. The default is ${CALENDAR_LIMITS.changesPageSize}.`),
	}),
	output: z.object({
		changes: z.array(CalendarChange),
		cursor: z.string(),
		has_more: z.boolean(),
		expired: z.boolean(),
	}),
	errors: [],
});

const OwnCalendarParam = prefixedId("prn")
	.optional()
	.describe("Your own id: the calendar of the caller. No other calendar is allowed. The default is your calendar.");

const createCalendarWebhookSubscription = defineOperation({
	name: "calendar.create_webhook_subscription",
	summary: "Send calendar events to an endpoint",
	description: [
		"Adds a subscription for your own calendar. No person or agent can subscribe for the calendar of a different principal.",
		"Choose the event. Each POST is one change of calendar.list_changes, with the same id (change_id) and its cursor.",
		"The POST has ids only, and no title, time or answer. Read the event with calendar.get_event.",
		"For a change with occurrence_id, read the occurrence with calendar.list_events over its range.",
		"A change from before the subscription sends no POST. Read it with calendar.list_changes.",
		"The endpoint must be yours and active.",
	].join(" "),
	http: { method: "POST", path: "/api/v1/calendar/webhook-subscriptions" },
	scopes: ["calendar.webhooks", "calendar.read"],
	callers: ["human", "agent"],
	annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: true },
	input: z.strictObject({
		endpoint_id: prefixedId("whe"),
		event: z.enum(CALENDAR_WEBHOOK_EVENTS),
		calendar_id: OwnCalendarParam,
	}),
	output: z.object({ subscription: CalendarWebhookSubscription }),
	errors: ["not_found", "policy_denied", "conflict", "forbidden"],
});

const listCalendarWebhookSubscriptions = defineOperation({
	name: "calendar.list_webhook_subscriptions",
	summary: "List calendar webhook subscriptions",
	description:
		"Lists the calendar subscriptions of your endpoints. A calendar subscription is always for the calendar of its creator, so calendar_id can only be your own id.",
	http: { method: "GET", path: "/api/v1/calendar/webhook-subscriptions" },
	scopes: ["calendar.webhooks"],
	callers: ["human", "agent"],
	annotations: READ,
	input: z.strictObject({ calendar_id: OwnCalendarParam }),
	output: z.object({ subscriptions: z.array(CalendarWebhookSubscription) }),
	errors: ["forbidden"],
});

const deleteCalendarWebhookSubscription = defineOperation({
	name: "calendar.delete_webhook_subscription",
	summary: "Delete a calendar webhook subscription",
	description: "Deletes a subscription. The endpoint stays. Only the creator of a subscription can delete it.",
	http: { method: "DELETE", path: "/api/v1/calendar/webhook-subscriptions/{subscription_id}" },
	scopes: ["calendar.webhooks"],
	callers: ["human", "agent"],
	annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
	input: z.strictObject({ subscription_id: prefixedId("whk") }),
	output: z.object({ deleted: z.boolean() }),
	errors: ["not_found"],
});

export const calendarOperations = {
	"calendar.list_events": listEvents,
	"calendar.get_event": getEvent,
	"calendar.create_event": createEvent,
	"calendar.update_event": updateEvent,
	"calendar.delete_event": deleteEvent,
	"calendar.update_occurrence": updateOccurrence,
	"calendar.cancel_occurrence": cancelOccurrence,
	"calendar.respond_to_event": respondToEvent,
	"calendar.set_reminder": setReminder,
	"calendar.query_free_busy": queryFreeBusy,
	"calendar.list_changes": listChanges,
	"calendar.create_webhook_subscription": createCalendarWebhookSubscription,
	"calendar.list_webhook_subscriptions": listCalendarWebhookSubscriptions,
	"calendar.delete_webhook_subscription": deleteCalendarWebhookSubscription,
} as const;
