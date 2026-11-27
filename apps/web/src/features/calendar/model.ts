// The pure model of Calendar: the days of a period, the events of each day, and the form of an event.
// Day boundaries come from the time zone (`zonedDayStart`): a day can have 23 or 25 hours.
import {
	addDays,
	CALENDAR_LIMITS,
	type CalendarEvent,
	checkRecurrence,
	checkWhen,
	DAY_MS,
	DEFAULT_REMINDER_MINUTES,
	dateToUtcMs,
	daysBetween,
	type EventWhenValue,
	type Recurrence,
	type RecurrenceInput,
	type SeriesTime,
	zonedDate,
	zonedDayStart,
	zonedInstant,
	zonedTime,
	zonedWall,
	zoneOffsetMs,
} from "@asterra/contracts";
import { type CalendarView, isCalendarDate } from "../../routes.ts";

/** The first day of a week: 0 is Sunday, 1 is Monday. */
export type FirstDay = 0 | 1;

/** The day of the week of a date: 0 is Sunday. */
export function weekday(date: string): number {
	return new Date(dateToUtcMs(date)).getUTCDay();
}

/** The first day of the week that holds a date. */
export function weekStart(date: string, firstDay: FirstDay): string {
	return addDays(date, -((weekday(date) - firstDay + 7) % 7));
}

/** The seven days of the week that holds a date. */
export function weekDays(date: string, firstDay: FirstDay): string[] {
	const start = weekStart(date, firstDay);
	return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

/** The first day of the month that holds a date. */
export function monthStart(date: string): string {
	return `${date.slice(0, 8)}01`;
}

/** The 42 days of the month view: six weeks from the week of the first day of the month. */
export function monthGrid(date: string, firstDay: FirstDay): string[] {
	const start = weekStart(monthStart(date), firstDay);
	return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}

/** The days of a period and its range. `end` is the day after the last day. */
export interface Period {
	days: string[];
	start: string;
	end: string;
	timeMin: string;
	timeMax: string;
}

export function periodOf(view: CalendarView, date: string, zone: string, firstDay: FirstDay): Period {
	const days = view === "week" ? weekDays(date, firstDay) : monthGrid(date, firstDay);
	const start = days[0] as string;
	const end = addDays(days[days.length - 1] as string, 1);
	return {
		days,
		start,
		end,
		timeMin: new Date(zonedDayStart(start, zone)).toISOString(),
		timeMax: new Date(zonedDayStart(end, zone)).toISOString(),
	};
}

/** A day in the period before or after the period of `date`. */
export function shiftPeriod(view: CalendarView, date: string, steps: number): string {
	if (view === "week") return addDays(date, 7 * steps);
	const [year, month] = date.split("-").map(Number) as [number, number];
	const index = year * 12 + (month - 1) + steps;
	return `${String(Math.floor(index / 12)).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}-01`;
}

/**
 * The day that the Previous or the Next control opens, or null when no period is there. The route accepts
 * only the days that an event can use. The period at an end of that window opens on the last day in it.
 */
export function shiftTarget(view: CalendarView, date: string, steps: number, firstDay: FirstDay): string | null {
	const target = shiftPeriod(view, date, steps);
	if (isCalendarDate(target)) return target;
	const edge = steps < 0 ? CALENDAR_LIMITS.firstDate : CALENDAR_LIMITS.lastDate;
	const periodStart = (day: string) => (view === "week" ? weekStart(day, firstDay) : monthStart(day));
	return periodStart(edge) === periodStart(date) ? null : edge;
}

/** The day in the window of the days that an event can use that is nearest to a day. */
export function clampDay(day: string): string {
	if (day < CALENDAR_LIMITS.firstDate) return CALENDAR_LIMITS.firstDate;
	return day > CALENDAR_LIMITS.lastDate ? CALENDAR_LIMITS.lastDate : day;
}

/** The minutes from 00:00 to an instant on the wall clock of a time zone: 540 for 09:00. */
export function wallMinutes(ms: number, zone: string): number {
	const local = new Date(ms + zoneOffsetMs(ms, zone));
	return local.getUTCHours() * 60 + local.getUTCMinutes() + local.getUTCSeconds() / 60;
}

/**
 * The part of an event on one day. `start` and `end` are minutes on the wall clock of the zone, from 0 to
 * 1440, so a part is at the line of its hour also on a day of 23 or 25 hours.
 */
export interface DaySegment {
	event: CalendarEvent;
	allDay: boolean;
	start: number;
	end: number;
	/** True when the event started on a day before. */
	continued: boolean;
	/** True when the event goes on after this day. */
	continues: boolean;
}

/**
 * The events of each day, in the time zone of the person. An event that goes past midnight has a part on each
 * of its days. The parts of a day keep the order of the list: all-day events first, then the first start first.
 */
export function eventsByDay(events: readonly CalendarEvent[], days: readonly string[], zone: string) {
	const byDay = new Map<string, DaySegment[]>(days.map((day) => [day, []]));
	for (const day of days) {
		const dayStart = zonedDayStart(day, zone);
		const dayEnd = zonedDayStart(addDays(day, 1), zone);
		const segments = byDay.get(day) as DaySegment[];
		for (const event of events) {
			if (event.when.kind === "all_day") {
				if (event.when.start_date <= day && day < event.when.end_date) {
					segments.push({
						event,
						allDay: true,
						start: 0,
						end: DAY_MINUTES,
						continued: day > event.when.start_date,
						continues: addDays(day, 1) < event.when.end_date,
					});
				}
				continue;
			}
			const start = Date.parse(event.when.start);
			const end = Date.parse(event.when.end);
			if (start >= dayEnd || end <= dayStart) continue;
			const continued = start < dayStart;
			const from = continued ? 0 : wallMinutes(start, zone);
			const to = end >= dayEnd ? DAY_MINUTES : wallMinutes(end, zone);
			segments.push({
				event,
				allDay: false,
				start: from,
				// When the clock goes back, an event can end at an earlier time on the wall clock than its start. Such a
				// part keeps its real length in the grid.
				end:
					to > from ? to : Math.min(from + (Math.min(end, dayEnd) - Math.max(start, dayStart)) / 60_000, DAY_MINUTES),
				continued,
				continues: end > dayEnd,
			});
		}
		segments.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start || a.end - b.end);
	}
	return byDay;
}

/** The column of a timed part in the grid of its day, and the count of columns of its group of overlaps. */
export interface Placed {
	segment: DaySegment;
	column: number;
	columns: number;
}

/**
 * Places the timed parts of one day side by side where they overlap. Each part gets the first free column.
 * The parts that overlap each other, also through a third part, share one count of columns.
 */
export function placeSegments(segments: readonly DaySegment[]): Placed[] {
	const timed = segments.filter((segment) => !segment.allDay).sort((a, b) => a.start - b.start || b.end - a.end);
	const placed: Placed[] = [];
	let group: Placed[] = [];
	let columnEnds: number[] = [];
	let groupEnd = Number.NEGATIVE_INFINITY;
	const close = () => {
		for (const item of group) item.columns = columnEnds.length;
		group = [];
		columnEnds = [];
	};
	for (const segment of timed) {
		if (segment.start >= groupEnd) close();
		let column = columnEnds.findIndex((end) => end <= segment.start);
		if (column === -1) {
			column = columnEnds.length;
			columnEnds.push(segment.end);
		} else {
			columnEnds[column] = segment.end;
		}
		const item = { segment, column, columns: 1 };
		group.push(item);
		placed.push(item);
		groupEnd = Math.max(groupEnd, segment.end);
	}
	close();
	return placed;
}

/** The fields of the event dialog. The dates are in YYYY-MM-DD form and the times in HH:MM form. */
export interface EventForm {
	title: string;
	allDay: boolean;
	startDate: string;
	startTime: string;
	/** The last day of the event. For an all-day event this is the last day, not the day after. */
	endDate: string;
	endTime: string;
	location: string;
	description: string;
	/** How the event repeats. Biweekly is weekly with an interval of 2. */
	repeat: RepeatChoice;
	/** How a repeat ends: never, on a date (`until`, YYYY-MM-DD) or after `count` occurrences. */
	ends: "never" | "until" | "count";
	until: string;
	count: string;
	/** The own reminder, in minutes before the start, or "none". */
	reminder: ReminderChoice;
}

export type RepeatChoice = "none" | "daily" | "weekly" | "biweekly" | "monthly";
export type ReminderChoice = "none" | "5" | "10" | "30";

export const REPEAT_OPTIONS: readonly { value: RepeatChoice; label: string }[] = [
	{ value: "none", label: "Does not repeat" },
	{ value: "daily", label: "Every day" },
	{ value: "weekly", label: "Every week" },
	{ value: "biweekly", label: "Every 2 weeks" },
	{ value: "monthly", label: "Every month" },
];

export const REMINDER_OPTIONS: readonly { value: ReminderChoice; label: string }[] = [
	{ value: "none", label: "No reminder" },
	{ value: "5", label: "5 minutes before" },
	{ value: "10", label: "10 minutes before" },
	{ value: "30", label: "30 minutes before" },
];

/** The fields of a form that do not depend on the event. */
const REPEAT_DEFAULTS = { repeat: "none", ends: "never", until: "", count: "10" } as const;

/** The repeat choice of a rule. A rule that the dialog cannot show, such as every 3 weeks, keeps its own text. */
export function repeatChoice(recurrence: Recurrence | null): RepeatChoice | null {
	if (recurrence === null) return "none";
	if (recurrence.frequency === "weekly" && recurrence.interval === 2) return "biweekly";
	if (recurrence.interval !== 1) return null;
	return recurrence.frequency;
}

/** The rule of the form, or null for no repeat. */
export function recurrenceOf(form: EventForm): RecurrenceInput | null {
	if (form.repeat === "none") return null;
	const frequency = form.repeat === "biweekly" ? "weekly" : form.repeat;
	const interval = form.repeat === "biweekly" ? 2 : 1;
	return {
		frequency,
		interval,
		...(form.ends === "until" && form.until ? { until: form.until } : {}),
		...(form.ends === "count" ? { count: Number(form.count) } : {}),
	};
}

/** True when the repeat fields of two forms give the same rule. */
export function sameRepeat(form: EventForm, opened: EventForm): boolean {
	return JSON.stringify(recurrenceOf(form)) === JSON.stringify(recurrenceOf(opened));
}

/** The reminder of the form, in minutes, or null. */
export function reminderOf(form: EventForm): 5 | 10 | 30 | null {
	return form.reminder === "none" ? null : (Number(form.reminder) as 5 | 10 | 30);
}

/** The text of a rule, for example "Every 2 weeks, 5 times". */
export function repeatText(recurrence: Recurrence): string {
	const unit = { daily: "day", weekly: "week", monthly: "month" }[recurrence.frequency];
	const every = recurrence.interval === 1 ? `Every ${unit}` : `Every ${recurrence.interval} ${unit}s`;
	if (recurrence.count !== null) return `${every}, ${recurrence.count} times`;
	if (recurrence.until !== null)
		return `${every}, until ${shortDate(recurrence.until)}, ${recurrence.until.slice(0, 4)}`;
	return every;
}

function wallTime(ms: number, zone: string): string {
	const local = new Date(ms + zoneOffsetMs(ms, zone));
	return `${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`;
}

/** The form of a new event: one hour from `hour` on `date`, or 09:00. */
export function newEventForm(date: string, hour = 9): EventForm {
	const start = Math.min(Math.max(hour, 0), 23);
	const end = start + 1;
	return {
		title: "",
		allDay: false,
		startDate: date,
		startTime: `${String(start).padStart(2, "0")}:00`,
		endDate: end === 24 ? addDays(date, 1) : date,
		endTime: `${String(end % 24).padStart(2, "0")}:00`,
		location: "",
		description: "",
		...REPEAT_DEFAULTS,
		reminder: String(DEFAULT_REMINDER_MINUTES) as ReminderChoice,
	};
}

/** The form of an existing event, in the time zone of the person. */
export function formOf(event: CalendarEvent, zone: string): EventForm {
	const rule = event.recurrence;
	const base = {
		title: event.title,
		location: event.location,
		description: event.description,
		repeat: repeatChoice(rule) ?? "none",
		ends: rule?.count != null ? ("count" as const) : rule?.until != null ? ("until" as const) : ("never" as const),
		until: rule?.until ?? "",
		count: String(rule?.count ?? 10),
		reminder: (event.reminder_minutes === null ? "none" : String(event.reminder_minutes)) as ReminderChoice,
	};
	if (event.when.kind === "all_day") {
		return {
			...base,
			allDay: true,
			startDate: event.when.start_date,
			startTime: "09:00",
			endDate: addDays(event.when.end_date, -1),
			endTime: "10:00",
		};
	}
	const start = Date.parse(event.when.start);
	const end = Date.parse(event.when.end);
	return {
		...base,
		allDay: false,
		startDate: zonedDate(start, zone),
		startTime: wallTime(start, zone),
		endDate: zonedDate(end, zone),
		endTime: wallTime(end, zone),
	};
}

/**
 * The time zone that a save of an event keeps: the zone of a timed event, or the zone of the person for a new
 * event and for an all-day event. The person can be in a different zone than the event.
 */
export function zoneOfEvent(event: CalendarEvent | null, zone: string): string {
	return event?.when.kind === "timed" ? event.when.time_zone : zone;
}

/**
 * The time of an event from the fields of the form. The last day of an all-day form is in the event. The
 * fields are on the clock of `zone`, the zone of the person. `eventZone` is the zone that the event keeps.
 */
export function whenOf(form: EventForm, zone: string, eventZone = zone): EventWhenValue {
	if (form.allDay) return { kind: "all_day", start_date: form.startDate, end_date: addDays(form.endDate, 1) };
	return {
		kind: "timed",
		start: new Date(zonedTime(form.startDate, form.startTime, zone)).toISOString(),
		end: new Date(zonedTime(form.endDate, form.endTime, zone)).toISOString(),
		time_zone: eventZone,
	};
}

/**
 * The problem with the time of the form, with the text of the server, or null. With `ruleStays`, the form is
 * the form of one occurrence and its rule did not change, so the rule gets no check: the time of one occurrence
 * can be outside the rule, and the server checks a change of the series.
 */
export function formProblem(
	form: EventForm,
	zone: string,
	options: { eventZone?: string; ruleStays?: boolean } = {},
): string | null {
	if (!form.startDate || !form.endDate || (!form.allDay && (!form.startTime || !form.endTime))) {
		return "Give a start and an end.";
	}
	if (form.allDay && form.endDate < form.startDate) return "The last day of an event must not be before its first day.";
	const when = whenOf(form, zone, options.eventZone);
	const problem = checkWhen(when);
	if (problem) return problem;
	const rule = recurrenceOf(form);
	if (rule === null || options.ruleStays) return null;
	if (form.ends === "until" && !form.until) return "Give the last day of the repeat.";
	if (form.ends === "count" && !/^\d+$/.test(form.count)) return "Give the number of times as a number.";
	return checkRecurrence(seriesTimeOf(when), {
		frequency: rule.frequency,
		interval: rule.interval,
		until: rule.until ?? null,
		count: rule.count ?? null,
	});
}

/** The time of an event in the form that the recurrence engine reads. */
function seriesTimeOf(when: EventWhenValue): SeriesTime {
	if (when.kind === "all_day") {
		return {
			all_day: true,
			start_at: 0,
			end_at: 0,
			start_date: when.start_date,
			end_date: when.end_date,
			time_zone: null,
		};
	}
	return {
		all_day: false,
		start_at: Date.parse(when.start),
		end_at: Date.parse(when.end),
		start_date: null,
		end_date: null,
		time_zone: when.time_zone,
	};
}

/**
 * The time of a series after a change to one of its occurrences for the entire series. The occurrence moves
 * by some days and gets a new wall clock time: the first occurrence moves by the same days and gets the same
 * time and length. `master` is the series as calendar.get_event returns it.
 *
 * A timed series keeps its own time zone. The fields of the form are on the clock of `zone`, the zone of the
 * person, so the days and the new time are computed on the clock of the series.
 */
export function seriesWhen(master: CalendarEvent, opened: EventForm, form: EventForm, zone: string): EventWhenValue {
	if (master.when.kind === "all_day" || form.allDay) {
		const shift = daysBetween(opened.startDate, form.startDate);
		const first = formOf(master, zone);
		const length = daysBetween(form.startDate, form.endDate);
		const startDate = addDays(first.startDate, shift);
		return whenOf({ ...form, startDate, endDate: addDays(startDate, length) }, zone);
	}
	const seriesZone = master.when.time_zone;
	const from = zonedTime(opened.startDate, opened.startTime, zone);
	const to = zonedTime(form.startDate, form.startTime, zone);
	const length = zonedTime(form.endDate, form.endTime, zone) - to;
	const shift = daysBetween(zonedDate(from, seriesZone), zonedDate(to, seriesZone));
	const firstDate = addDays(zonedDate(Date.parse(master.when.start), seriesZone), shift);
	const start = zonedInstant(firstDate, zonedWall(to, seriesZone).msOfDay, seriesZone);
	return {
		kind: "timed",
		start: new Date(start).toISOString(),
		end: new Date(start + length).toISOString(),
		time_zone: seriesZone,
	};
}

/** The key of an entry of a list: the id of the occurrence, or the id of a one-off event. */
export function eventKey(event: CalendarEvent): string {
	return event.occurrence_id ?? event.id;
}

/**
 * True when the time fields of the form are the fields of the form that the dialog opened with, so a save
 * does not send the time. The dialog does not compare instants: the form has no seconds, and it cannot tell
 * the second 01:15 of a day that has that time two times.
 */
export function sameTimeFields(form: EventForm, opened: EventForm): boolean {
	return (
		form.allDay === opened.allDay &&
		form.startDate === opened.startDate &&
		form.startTime === opened.startTime &&
		form.endDate === opened.endDate &&
		form.endTime === opened.endTime
	);
}

const formats = new Map<string, Intl.DateTimeFormat>();

function format(zone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
	const key = `${zone}|${JSON.stringify(options)}`;
	let found = formats.get(key);
	if (!found) {
		found = new Intl.DateTimeFormat("en-US", { ...options, timeZone: zone });
		formats.set(key, found);
	}
	return found;
}

/** A time on the clock of the person, for example 9:30 AM. */
export function timeText(ms: number, zone: string): string {
	return format(zone, { hour: "numeric", minute: "2-digit" }).format(ms);
}

/** A date for the name of a day, for example Tuesday, December 1, 2026. */
export function longDate(date: string): string {
	return format("UTC", { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(dateToUtcMs(date));
}

/** A short date, for example Dec 1. */
export function shortDate(date: string): string {
	return format("UTC", { month: "short", day: "numeric" }).format(dateToUtcMs(date));
}

/** The short name of the day of a date, for example Tue. */
export function weekdayName(date: string): string {
	return format("UTC", { weekday: "short" }).format(dateToUtcMs(date));
}

/** The title of a period: "Nov 29 – Dec 5, 2026" for a week, "December 2026" for a month. */
export function periodTitle(view: CalendarView, date: string, firstDay: FirstDay): string {
	if (view === "month") return format("UTC", { month: "long", year: "numeric" }).format(dateToUtcMs(date));
	const days = weekDays(date, firstDay);
	const first = days[0] as string;
	const last = days[6] as string;
	const year = (day: string) => day.slice(0, 4);
	const head = year(first) === year(last) ? shortDate(first) : `${shortDate(first)}, ${year(first)}`;
	return `${head} – ${shortDate(last)}, ${year(last)}`;
}

/**
 * The time of an event as text, in the time zone of the person: "All day", "All day, Dec 1 – Dec 3", or
 * "9:00 AM – 10:00 AM".
 */
export function whenText(event: CalendarEvent, zone: string): string {
	if (event.when.kind === "all_day") {
		const last = addDays(event.when.end_date, -1);
		return last === event.when.start_date
			? "All day"
			: `All day, ${shortDate(event.when.start_date)} – ${shortDate(last)}`;
	}
	const start = Date.parse(event.when.start);
	const end = Date.parse(event.when.end);
	const sameDay = zonedDate(start, zone) === zonedDate(end - 1, zone);
	const startText = timeText(start, zone);
	const endText = timeText(end, zone);
	if (sameDay) return `${startText} – ${endText}`;
	return `${shortDate(zonedDate(start, zone))}, ${startText} – ${shortDate(zonedDate(end, zone))}, ${endText}`;
}

/** The accessible name of an event: its title, its time and its place. */
export function eventLabel(event: CalendarEvent, zone: string): string {
	return [
		event.title,
		whenText(event, zone),
		event.location,
		event.recurrence ? repeatText(event.recurrence) : "",
		event.my_response === "declined" ? "Declined" : "",
	]
		.filter(Boolean)
		.join(", ");
}

/** The hours of the grid of the week view. */
export const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/** The text of an hour of the grid, for example 9 AM. */
export function hourText(hour: number): string {
	if (hour === 0) return "12 AM";
	if (hour === 12) return "12 PM";
	return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

/** The minutes of a day with no change of the clock. */
export const DAY_MINUTES = DAY_MS / 60_000;
