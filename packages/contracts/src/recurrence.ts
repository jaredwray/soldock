import {
	addDays,
	allDayBounds,
	CALENDAR_LIMITS,
	DAY_MS,
	daysBetween,
	isRealDate,
	zonedInstant,
	zonedWall,
} from "./calendar.ts";

// The recurrence engine of Calendar. It is pure: it reads no clock and keeps no state. The server and the web
// app use the same code, so they make the same occurrences.
//
// - A timed series keeps the wall clock time and the IANA zone of its first start. Each occurrence starts at
//   that time on the date of its period, so 09:00 stays 09:00 when the clock changes.
// - An all-day series keeps dates. It has no time zone.
// - A monthly series uses the day of the month of its first date. A month without that day has no
//   occurrence (as RFC 5545): a series on the 31st has no occurrence in April. `count` counts only the
//   occurrences that exist.

export const RECURRENCE_FREQUENCIES = ["daily", "weekly", "monthly"] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

/** The rule of a series. Each `interval` periods there is one occurrence. Biweekly is weekly with interval 2. */
export interface RecurrenceRule {
	frequency: RecurrenceFrequency;
	interval: number;
	/** The last date (YYYY-MM-DD) that can have an occurrence, in the time zone of a timed series. */
	until: string | null;
	/** The number of occurrences. */
	count: number | null;
}

/** The time of the first occurrence of a series, as the object stores it. */
export interface SeriesTime {
	all_day: boolean;
	start_at: number;
	end_at: number;
	start_date: string | null;
	end_date: string | null;
	time_zone: string | null;
}

/** The first occurrence of a series, in the form that the engine uses. */
export type SeriesAnchor =
	| { kind: "timed"; date: string; msOfDay: number; durationMs: number; timeZone: string }
	| { kind: "all_day"; date: string; days: number };

/** One occurrence. `key` is its original start, as the rule gives it: the RECURRENCE-ID of iCalendar. */
export interface Occurrence {
	key: string;
	start_at: number;
	end_at: number;
	/** All-day only. */
	start_date: string | null;
	end_date: string | null;
}

/** The days of one period: a series event must be shorter than this. */
function periodDays(rule: Pick<RecurrenceRule, "frequency" | "interval">): number {
	if (rule.frequency === "daily") return rule.interval;
	if (rule.frequency === "weekly") return 7 * rule.interval;
	return 28 * rule.interval;
}

export function anchorOf(time: SeriesTime): SeriesAnchor {
	if (time.all_day && time.start_date !== null && time.end_date !== null) {
		return { kind: "all_day", date: time.start_date, days: daysBetween(time.start_date, time.end_date) };
	}
	const zone = time.time_zone ?? "UTC";
	const wall = zonedWall(time.start_at, zone);
	return {
		kind: "timed",
		date: wall.date,
		msOfDay: wall.msOfDay,
		durationMs: time.end_at - time.start_at,
		timeZone: zone,
	};
}

/**
 * The problem with a rule for the time of an event, or null when the rule is good. The server and the event
 * dialog use the same texts.
 */
export function checkRecurrence(time: SeriesTime, rule: RecurrenceRule): string | null {
	if (!Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > CALENDAR_LIMITS.recurrenceInterval) {
		return `The interval of a repeat must be from 1 to ${CALENDAR_LIMITS.recurrenceInterval}.`;
	}
	if (rule.until !== null && rule.count !== null) return "A repeat can end on a date or after a count, not both.";
	if (rule.count !== null && (rule.count < 1 || rule.count > CALENDAR_LIMITS.recurrenceCount)) {
		return `A repeat can have from 1 to ${CALENDAR_LIMITS.recurrenceCount} occurrences.`;
	}
	const anchor = anchorOf(time);
	if (rule.until !== null) {
		if (!isRealDate(rule.until)) return "The end date of a repeat must be a real date.";
		if (rule.until < anchor.date) return "The end date of a repeat must not be before the first day of the event.";
	}
	const limit = periodDays(rule);
	const length = anchor.kind === "timed" ? anchor.durationMs : anchor.days * DAY_MS;
	if (length > limit * DAY_MS) {
		return "A repeated event must not be longer than the time from one occurrence to the next.";
	}
	return null;
}

function parseDate(date: string): [number, number, number] {
	return [Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10))];
}

function monthIndex(date: string): number {
	const [year, month] = parseDate(date);
	return year * 12 + (month - 1);
}

/** The date of period `n`, or null when the month of the period does not have the day. */
function periodDate(anchorDate: string, rule: RecurrenceRule, n: number): string | null {
	if (rule.frequency === "daily") return addDays(anchorDate, n * rule.interval);
	if (rule.frequency === "weekly") return addDays(anchorDate, 7 * n * rule.interval);
	const total = monthIndex(anchorDate) + n * rule.interval;
	const day = anchorDate.slice(8, 10);
	const candidate = `${String(Math.floor(total / 12)).padStart(4, "0")}-${String((total % 12) + 1).padStart(2, "0")}-${day}`;
	return isRealDate(candidate) ? candidate : null;
}

/** The periods from the anchor to a date, rounded down. Negative before the anchor. */
function periodsTo(anchorDate: string, rule: RecurrenceRule, date: string): number {
	if (rule.frequency === "monthly") return Math.floor((monthIndex(date) - monthIndex(anchorDate)) / rule.interval);
	return Math.floor(daysBetween(anchorDate, date) / periodDays(rule));
}

/** The period of a date, or null when the rule makes no occurrence on that date. */
function periodOf(anchorDate: string, rule: RecurrenceRule, date: string): number | null {
	if (rule.frequency === "monthly") {
		if (date.slice(8, 10) !== anchorDate.slice(8, 10)) return null;
		const months = monthIndex(date) - monthIndex(anchorDate);
		return months >= 0 && months % rule.interval === 0 ? months / rule.interval : null;
	}
	const days = daysBetween(anchorDate, date);
	const step = periodDays(rule);
	return days >= 0 && days % step === 0 ? days / step : null;
}

function compactUtc(ms: number): string {
	return `${new Date(ms).toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
}

function build(anchor: SeriesAnchor, date: string): Occurrence {
	if (anchor.kind === "all_day") {
		const end = addDays(date, anchor.days);
		const bounds = allDayBounds(date, end);
		return {
			key: date.replace(/-/g, ""),
			start_at: bounds.start_at,
			end_at: bounds.end_at,
			start_date: date,
			end_date: end,
		};
	}
	const start = zonedInstant(date, anchor.msOfDay, anchor.timeZone);
	return {
		key: compactUtc(start),
		start_at: start,
		end_at: start + anchor.durationMs,
		start_date: null,
		end_date: null,
	};
}

/** True when a date is past the end of the rule or of the calendar. */
function pastEnd(rule: RecurrenceRule, date: string): boolean {
	return date > CALENDAR_LIMITS.lastDate || (rule.until !== null && date > rule.until);
}

/**
 * Walks the occurrences of a series from period `from`, and calls `visit` for each. `visit` returns false to stop.
 * With a count, the walk starts at period 0, so it can count the occurrences that exist.
 */
function walk(
	anchor: SeriesAnchor,
	rule: RecurrenceRule,
	from: number,
	visit: (occurrence: Occurrence, period: number) => boolean,
): void {
	let ordinal = 0;
	const start = rule.count === null ? Math.max(0, from) : 0;
	// A monthly series on the 31st has 7 occurrences in 12 months. This bound stops a walk that finds no date.
	for (let n = start, misses = 0; misses < 48; n++) {
		const date = periodDate(anchor.date, rule, n);
		if (date === null) {
			misses += 1;
			continue;
		}
		misses = 0;
		if (pastEnd(rule, date)) return;
		ordinal += 1;
		if (rule.count !== null && ordinal > rule.count) return;
		if (n < from) continue;
		if (!visit(build(anchor, date), n)) return;
	}
}

/** The first period that can have an occurrence that ends after `ms`. */
function firstPeriodNear(anchor: SeriesAnchor, rule: RecurrenceRule, ms: number): number {
	const span = anchor.kind === "timed" ? anchor.durationMs : anchor.days * DAY_MS;
	// A UTC date two days early is before each local date of the instant.
	const date = new Date(ms - span - 2 * DAY_MS).toISOString().slice(0, 10);
	if (date < anchor.date) return 0;
	return Math.max(0, periodsTo(anchor.date, rule, date) - 1);
}

/**
 * The occurrences that overlap a range (`end_at > min` and `start_at < max`), first start first. It stops at
 * `cap` occurrences. For an all-day series, `start_at` and `end_at` are the widest bounds of its days, so the
 * caller filters the dates again for one time zone.
 */
export function expandOccurrences(
	anchor: SeriesAnchor,
	rule: RecurrenceRule,
	range: { min: number; max: number },
	cap: number,
): Occurrence[] {
	const found: Occurrence[] = [];
	if (cap <= 0 || range.min >= range.max) return found;
	walk(anchor, rule, firstPeriodNear(anchor, rule, range.min), (occurrence) => {
		if (occurrence.start_at >= range.max) return false;
		if (occurrence.end_at > range.min) found.push(occurrence);
		return found.length < cap;
	});
	return found;
}

/** The first `limit` occurrences that start after `after`, first start first. */
export function occurrencesAfter(
	anchor: SeriesAnchor,
	rule: RecurrenceRule,
	after: number,
	limit: number,
): Occurrence[] {
	const found: Occurrence[] = [];
	if (limit <= 0) return found;
	walk(anchor, rule, firstPeriodNear(anchor, rule, after), (occurrence) => {
		if (occurrence.start_at > after) found.push(occurrence);
		return found.length < limit;
	});
	return found;
}

const KEY_PATTERN = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z)?$/;

/** The occurrence of a key, or null when the rule makes no occurrence with that key. */
export function occurrenceAt(anchor: SeriesAnchor, rule: RecurrenceRule, key: string): Occurrence | null {
	const match = KEY_PATTERN.exec(key);
	if (!match) return null;
	const timedKey = match[4] !== undefined;
	if (timedKey !== (anchor.kind === "timed")) return null;
	let date = `${match[1]}-${match[2]}-${match[3]}`;
	if (!isRealDate(date)) return null;
	if (anchor.kind === "timed") {
		const ms = Date.UTC(
			Number(match[1]),
			Number(match[2]) - 1,
			Number(match[3]),
			Number(match[4]),
			Number(match[5]),
			Number(match[6]),
		);
		date = zonedWall(ms, anchor.timeZone).date;
	}
	const period = periodOf(anchor.date, rule, date);
	if (period === null) return null;
	let found: Occurrence | null = null;
	walk(anchor, rule, period, (occurrence, n) => {
		if (n === period && occurrence.key === key) found = occurrence;
		return false;
	});
	return found;
}

/** The end of the last occurrence, or an instant after it. Null for a series without an end. */
export function seriesEnd(anchor: SeriesAnchor, rule: RecurrenceRule): number | null {
	if (rule.until === null && rule.count === null) return null;
	if (rule.until !== null) {
		const after = addDays(rule.until, 1);
		if (anchor.kind === "all_day") return allDayBounds(after, addDays(after, anchor.days)).end_at;
		return zonedInstant(after, 0, anchor.timeZone) + anchor.durationMs;
	}
	let last: Occurrence | null = null;
	walk(anchor, rule, 0, (occurrence) => {
		last = occurrence;
		return true;
	});
	return (last as Occurrence | null)?.end_at ?? null;
}

const OCCURRENCE_ID = /^(evt_[0-9A-HJKMNP-TV-Z]{26})_(\d{8}(?:T\d{6}Z)?)$/;

/** The id of an occurrence: the id of its series, `_`, and its key. */
export function occurrenceId(eventId: string, key: string): string {
	return `${eventId}_${key}`;
}

export function parseOccurrenceId(id: string): { eventId: string; key: string } | null {
	const match = OCCURRENCE_ID.exec(id);
	return match ? { eventId: match[1] as string, key: match[2] as string } : null;
}
