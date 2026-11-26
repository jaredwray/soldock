import { prefixedId, Timestamp } from "./common.ts";
import { defineOperation } from "./operation.ts";
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
 * The instant of 00:00 of a date in a time zone, in ms. Do not add 24 hours to get the next day: a day
 * can have 23 or 25 hours. In a zone that skips 00:00 for a change of the clock, the result is the
 * nearest instant.
 */
export function zonedDayStart(date: string, timeZone: string): number {
	const guess = dateToUtcMs(date);
	const first = guess - zoneOffsetMs(guess, timeZone);
	const second = guess - zoneOffsetMs(first, timeZone);
	return second;
}

/**
 * The instant of a date and a wall clock time (HH:MM) in a time zone, in ms. The web app uses it to make
 * the `when` of an event from the fields of the form.
 */
export function zonedTime(date: string, time: string, timeZone: string): number {
	const [hour, minute] = time.split(":").map(Number);
	const guess = dateToUtcMs(date) + ((hour ?? 0) * 60 + (minute ?? 0)) * 60_000;
	const first = guess - zoneOffsetMs(guess, timeZone);
	return guess - zoneOffsetMs(first, timeZone);
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
	'A timed event has kind "timed", start and end as ISO 8601 times with an offset or Z (for example 2026-12-01T09:00:00-05:00), and time_zone, the IANA time zone of the event (for example America/New_York). The output gives start and end in UTC.',
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

export const CalendarEvent = z.object({
	id: z.string(),
	title: z.string(),
	description: z.string(),
	location: z.string(),
	when: EventWhen,
	/** 1 for a new event. Each change adds 1. */
	revision: z.number().int(),
	created_at: Timestamp,
	updated_at: Timestamp,
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

const RangeTime = z
	.string()
	.max(40)
	.refine(isInstant, "must be a time in ISO 8601 form with an offset or Z, such as 2026-12-01T00:00:00Z");

export const listEvents = defineOperation({
	name: "calendar.list_events",
	summary: "List the events of your calendar in a time range",
	description: [
		"Returns the events of your calendar that overlap the range from time_min to time_max, first start first.",
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
	description: ["Returns one event of your calendar.", OWN_NOTE].join(" "),
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
	errors: ["conflict"],
});

export const updateEvent = defineOperation({
	name: "calendar.update_event",
	summary: "Change an event of your calendar",
	description: [
		"Changes the fields that you give. A field that you do not give stays. when replaces the whole time of the event, so you can change a timed event to an all-day event.",
		WHEN_NOTE,
		"A call that changes nothing keeps the revision.",
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
		base_revision: BASE_REVISION,
	}),
	output: z.object({ event: CalendarEvent }),
	errors: ["not_found", "conflict"],
});

export const deleteEvent = defineOperation({
	name: "calendar.delete_event",
	summary: "Delete an event of your calendar",
	description: [
		"Deletes an event of your calendar. This cannot be undone.",
		"Set dry_run to true to get the event without a change.",
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
	errors: ["not_found", "conflict"],
});

export const calendarOperations = {
	"calendar.list_events": listEvents,
	"calendar.get_event": getEvent,
	"calendar.create_event": createEvent,
	"calendar.update_event": updateEvent,
	"calendar.delete_event": deleteEvent,
} as const;
