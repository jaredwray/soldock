import { ID_CHARS, prefixedId, Timestamp } from "./common.ts";
import { defineOperation } from "./operation.ts";
import { z } from "./zod.ts";

// The calendar of a principal. Each person, agent and service account has one calendar. A call reaches the
// calendar of its caller, or the calendar of a person who gave the caller access (`calendar.set_grant`). The
// time helpers are here, so the server and the web app agree.

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
	/** The attendees of one event, without the organizer. */
	attendees: 50,
	/** The grants of one calendar. */
	grants: 200,
	/** The longest time range of one calendar.find_times, in days. */
	findRangeDays: 31,
	/** The attendees of one calendar.find_times, without the calendar of the call. */
	findAttendees: 20,
	/** The suggestions of one calendar.find_times, without `limit`. */
	defaultSuggestions: 20,
	suggestions: 50,
	/** The shortest and the longest meeting of calendar.find_times, in minutes. */
	minDurationMinutes: 5,
	maxDurationMinutes: 1440,
} as const;

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

/** Who sees the details of an event. `private`: a delegate of the calendar sees only the time. */
export const EventVisibility = z.enum(["default", "private"]);
export type EventVisibility = z.infer<typeof EventVisibility>;

/** What a grant on a calendar lets its principal do. `schedule` includes `free_busy`. */
export const CalendarAccess = z.enum(["free_busy", "schedule"]);
export type CalendarAccess = z.infer<typeof CalendarAccess>;

export const EventAttendee = z.object({
	principal_id: z.string(),
	/** The answer of the attendee. No operation sets it yet: it is always needs_action. */
	response: z.enum(["needs_action", "accepted", "declined", "tentative"]),
});
export type EventAttendee = z.infer<typeof EventAttendee>;

export const CalendarEvent = z.object({
	id: z.string(),
	/** The principal whose calendar holds this event. */
	calendar_id: z.string(),
	/** The organizer: the owner of the calendar for an own event, the calendar of the organizer for an invitation. */
	organizer_id: z.string(),
	/** The principal that added the event: the owner, or a delegate that schedules for the owner. */
	created_by: z.string(),
	title: z.string(),
	description: z.string(),
	location: z.string(),
	when: EventWhen,
	visibility: EventVisibility,
	attendees: z.array(EventAttendee),
	/**
	 * True when the caller sees only a part of the event: a delegate sees the time, and the title of an event
	 * that is not private, of an event that it did not add.
	 */
	redacted: z.boolean(),
	/** 1 for a new event. Each change adds 1. */
	revision: z.number().int(),
	created_at: Timestamp,
	updated_at: Timestamp,
});
export type CalendarEvent = z.infer<typeof CalendarEvent>;

export const CalendarGrant = z.object({
	principal_id: z.string(),
	access: CalendarAccess,
	created_at: Timestamp,
});
export type CalendarGrant = z.infer<typeof CalendarGrant>;

/** An interval of busy time, in UTC. */
export const BusyInterval = z.object({ start: Timestamp, end: Timestamp });
export type BusyInterval = z.infer<typeof BusyInterval>;

const READ = { readOnly: true, destructive: false, idempotent: true, openWorld: false } as const;

const OWN_NOTE = [
	"Without calendar_id, the call uses your own calendar. Each person, agent and service account has one.",
	"Set calendar_id to the id of a person who gave you schedule access (calendar.set_grant) to use the calendar of that person.",
	"In that calendar you see the time of each event, and the title of an event that is not private. You see all fields only of the events that you added, and you change only those events.",
].join(" ");

const PrincipalId = prefixedId("prn");

const CALENDAR_ID = PrincipalId.optional().describe(
	"The id of the person whose calendar the call uses. Leave it out for your own calendar. The person must give you schedule access first.",
);

const ATTENDEES_NOTE = [
	"attendees lists the principal ids of the people and agents of the organization to invite.",
	"Each attendee gets one copy of the event on the own calendar, with the owner of the calendar as organizer.",
	"An agent or a service account cannot invite an agent or a service account.",
].join(" ");

const Attendees = z
	.array(PrincipalId)
	.max(CALENDAR_LIMITS.attendees)
	.describe(`${ATTENDEES_NOTE} At most ${CALENDAR_LIMITS.attendees} attendees.`);

const Visibility = EventVisibility.describe(
	"private: a delegate of the calendar sees only the time of the event. default: a delegate also sees the title.",
);

const BASE_REVISION = z
	.number()
	.int()
	.min(1)
	.optional()
	.describe(
		"The revision of the event that you read. When the event has a different revision now, the call changes nothing and returns conflict. Read the event again, then try again.",
	);

const RangeTime = z
	.string()
	.max(40)
	.refine(isInstant, "must be a time in ISO 8601 form with an offset or Z, such as 2026-12-01T00:00:00Z");

export const listEvents = defineOperation({
	name: "calendar.list_events",
	summary: "List the events of a calendar in a time range",
	description: [
		"Returns the events of the calendar that overlap the range from time_min to time_max, first start first.",
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
			calendar_id: CALENDAR_ID,
		})
		.refine((input) => Date.parse(input.time_max) > Date.parse(input.time_min), "time_max must be after time_min")
		.refine(
			(input) => Date.parse(input.time_max) - Date.parse(input.time_min) <= CALENDAR_LIMITS.rangeDays * DAY_MS,
			`The range can be at most ${CALENDAR_LIMITS.rangeDays} days long`,
		),
	output: z.object({ events: z.array(CalendarEvent), next_cursor: z.string().nullable() }),
	errors: ["not_found", "forbidden"],
});

export const getEvent = defineOperation({
	name: "calendar.get_event",
	summary: "Read one event of a calendar",
	description: ["Returns one event of the calendar.", OWN_NOTE].join(" "),
	http: { method: "GET", path: "/api/v1/calendar/events/{event_id}" },
	scopes: ["calendar.read"],
	callers: ["human", "agent", "service"],
	annotations: READ,
	input: z.strictObject({ event_id: EventId, calendar_id: CALENDAR_ID }),
	output: z.object({ event: CalendarEvent }),
	errors: ["not_found", "forbidden"],
});

export const createEvent = defineOperation({
	name: "calendar.create_event",
	summary: "Add an event to a calendar, and invite attendees",
	description: [
		"Adds an event to the calendar and returns it.",
		WHEN_NOTE,
		ATTENDEES_NOTE,
		"In the calendar of a different person, that person is the organizer, and the event records you in created_by.",
		`A calendar can have at most ${CALENDAR_LIMITS.events} events.`,
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
		attendees: Attendees.default([]),
		visibility: Visibility.default("default"),
		calendar_id: CALENDAR_ID,
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
	errors: ["conflict", "not_found", "forbidden"],
});

export const updateEvent = defineOperation({
	name: "calendar.update_event",
	summary: "Change an event of a calendar",
	description: [
		"Changes the fields that you give. A field that you do not give stays. when replaces the whole time of the event, so you can change a timed event to an all-day event.",
		WHEN_NOTE,
		"attendees replaces the whole list. Each new attendee gets a copy of the event, and each removed attendee loses it.",
		"Only the organizer changes an event. An attendee can only delete its copy.",
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
		attendees: Attendees.optional(),
		visibility: Visibility.optional(),
		calendar_id: CALENDAR_ID,
		base_revision: BASE_REVISION,
	}),
	output: z.object({ event: CalendarEvent }),
	errors: ["not_found", "conflict", "forbidden"],
});

export const deleteEvent = defineOperation({
	name: "calendar.delete_event",
	summary: "Delete an event of a calendar",
	description: [
		"Deletes an event of the calendar. This cannot be undone. Each attendee loses its copy.",
		"The delete of an invitation that you got removes only your copy.",
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
		calendar_id: CALENDAR_ID,
		base_revision: BASE_REVISION,
		dry_run: z.boolean().default(false),
	}),
	output: z.object({ event: CalendarEvent, dry_run: z.boolean() }),
	errors: ["not_found", "conflict", "forbidden"],
});

const WallTime = z
	.string()
	.regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be a time of the wall clock in HH:MM form, such as 09:00");

/** The principal ids of a comma-separated list. */
export function splitIds(value: string | undefined): string[] {
	if (value === undefined) return [];
	return value
		.split(",")
		.map((id) => id.trim())
		.filter((id) => id.length > 0);
}

const PRINCIPAL_ID_PATTERN = new RegExp(`^prn_${ID_CHARS}$`);

export const findTimes = defineOperation({
	name: "calendar.find_times",
	summary: "Find the busy times of people and suggest free times for a meeting",
	description: [
		"Returns the busy intervals of each calendar, and suggested times of duration_minutes when each calendar is free.",
		"The calendar of the call (your own calendar, or calendar_id) is always the first entry of calendars. attendee_ids adds more calendars.",
		"busy holds only merged intervals of busy time: no title, no detail and no count of events. A private event is busy time too.",
		"availability is unknown when the owner of a calendar shares no availability with you. Never treat unknown as free.",
		"complete is false when a calendar is unknown. suggestions is then empty.",
		'With ignore_unknown "true", the suggestions use only the calendars with known availability: a suggestion is then free only for those calendars, so tell the person which calendars are unknown.',
		"With calendar_id, the call asks each attendee calendar as the owner of calendar_id: you see the busy times that the attendees share with that person. You must hold schedule access to calendar_id.",
		"Suggestions are between day_start and day_end on each day in time_zone, and never in the past.",
		`The range can be at most ${CALENDAR_LIMITS.findRangeDays} days long.`,
	].join(" "),
	http: { method: "GET", path: "/api/v1/calendar/find-times" },
	scopes: ["calendar.read"],
	callers: ["human", "agent", "service"],
	annotations: READ,
	input: z
		.strictObject({
			attendee_ids: z
				.string()
				// An id has 30 characters. Each id can have a comma and a space after it.
				.max(CALENDAR_LIMITS.findAttendees * 32 + 16)
				.refine(
					(value) => splitIds(value).every((id) => PRINCIPAL_ID_PATTERN.test(id)),
					"must be principal ids that start with prn_, separated by commas",
				)
				.refine(
					(value) => splitIds(value).length <= CALENDAR_LIMITS.findAttendees,
					`can have at most ${CALENDAR_LIMITS.findAttendees} ids`,
				)
				.optional()
				.describe(
					"The principal ids of the people to meet, separated by commas, such as prn_A,prn_B. Leave it out to see only the calendar of the call.",
				),
			time_min: RangeTime.describe("The start of the range: an ISO 8601 time, such as 2026-12-01T00:00:00Z."),
			time_max: RangeTime.describe("The end of the range: an ISO 8601 time. It is not in the range."),
			duration_minutes: z.coerce
				.number()
				.int()
				.min(CALENDAR_LIMITS.minDurationMinutes)
				.max(CALENDAR_LIMITS.maxDurationMinutes)
				.describe("The length of the meeting, in minutes, such as 30."),
			time_zone: TimeZone.describe(
				"The IANA time zone of the days, such as America/New_York. day_start, day_end and all-day events use it.",
			),
			day_start: WallTime.optional().describe(
				"The first time of a day for a suggestion, in HH:MM. The default is 09:00.",
			),
			day_end: WallTime.optional().describe(
				"The last time of a day for a suggestion to end, in HH:MM. The default is 17:00.",
			),
			limit: z.coerce
				.number()
				.int()
				.min(1)
				.max(CALENDAR_LIMITS.suggestions)
				.optional()
				.describe(`The most suggestions. The default is ${CALENDAR_LIMITS.defaultSuggestions}.`),
			ignore_unknown: z
				.enum(["true", "false"])
				.optional()
				.describe(
					'"true" gives suggestions when the availability of a calendar is unknown. They are free only for the known calendars. The default is "false": no suggestions when a calendar is unknown.',
				),
			calendar_id: CALENDAR_ID,
		})
		.refine((input) => Date.parse(input.time_max) > Date.parse(input.time_min), "time_max must be after time_min")
		.refine(
			// One more hour: the days of a time zone can include the day of 25 hours, when the clock goes back.
			(input) =>
				Date.parse(input.time_max) - Date.parse(input.time_min) <=
				CALENDAR_LIMITS.findRangeDays * DAY_MS + 60 * 60 * 1000,
			`The range can be at most ${CALENDAR_LIMITS.findRangeDays} days long`,
		)
		.refine((input) => (input.day_start ?? "09:00") < (input.day_end ?? "17:00"), "day_end must be after day_start"),
	output: z.object({
		time_zone: z.string(),
		calendars: z.array(
			z.object({
				principal_id: z.string(),
				availability: z.enum(["known", "unknown"]),
				/** Empty when the availability is unknown. */
				busy: z.array(BusyInterval),
			}),
		),
		/** Empty when the availability of a calendar is unknown, unless the call has ignore_unknown "true". */
		suggestions: z.array(BusyInterval),
		/** False when the availability of a calendar is unknown. */
		complete: z.boolean(),
	}),
	errors: ["not_found", "forbidden"],
});

const OWN_CALENDAR = "People only, for their own calendar. An owner or an admin cannot do this for a different person.";

const GRANT_RULES = [
	"free_busy lets the principal see when you are busy, through calendar.find_times. It sees no detail of an event.",
	"schedule also lets it add events to your calendar, invite attendees from your calendar, and change and delete the events that it added. You are the organizer of these events.",
	"A principal with schedule access sees the time of each event of your calendar, and the title of an event that is not private. It sees no description, location or attendees of an event that it did not add.",
	"It also sees the busy times that other people share with you, when it calls calendar.find_times with your calendar_id.",
].join(" ");

const Grants = z.object({ grants: z.array(CalendarGrant) });

export const listGrants = defineOperation({
	name: "calendar.list_grants",
	summary: "List the people and agents that can see your busy times or schedule for you",
	description: `Returns each grant of your own calendar, in the order in which you added them. ${OWN_CALENDAR}`,
	http: { method: "GET", path: "/api/v1/calendar/grants" },
	scopes: ["calendar.read"],
	callers: ["human"],
	annotations: READ,
	input: z.strictObject({}),
	output: Grants,
	errors: [],
});

export const setGrant = defineOperation({
	name: "calendar.set_grant",
	summary: "Let a person or an agent see your busy times or schedule for you",
	description: [
		OWN_CALENDAR,
		"access is free_busy or schedule. For a principal that has a grant, access replaces it.",
		GRANT_RULES,
		"The grant applies at once. Your credential must hold calendar.read to give free_busy, and calendar.read and calendar.write to give schedule.",
		`A calendar can have at most ${CALENDAR_LIMITS.grants} grants.`,
	].join(" "),
	http: { method: "POST", path: "/api/v1/calendar/grants" },
	scopes: ["calendar.share"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
	input: z.strictObject({ principal_id: PrincipalId, access: CalendarAccess }),
	output: Grants,
	errors: ["not_found"],
});

export const removeGrant = defineOperation({
	name: "calendar.remove_grant",
	summary: "Remove the access of a person or an agent to your calendar",
	description: `${OWN_CALENDAR} The access ends at once. The events that the principal added stay in your calendar. A second call changes nothing.`,
	http: { method: "DELETE", path: "/api/v1/calendar/grants/{principal_id}" },
	scopes: ["calendar.share"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
	input: z.strictObject({ principal_id: PrincipalId }),
	output: Grants,
	errors: [],
});

export const calendarOperations = {
	"calendar.list_events": listEvents,
	"calendar.get_event": getEvent,
	"calendar.create_event": createEvent,
	"calendar.update_event": updateEvent,
	"calendar.delete_event": deleteEvent,
	"calendar.find_times": findTimes,
	"calendar.list_grants": listGrants,
	"calendar.set_grant": setGrant,
	"calendar.remove_grant": removeGrant,
} as const;
