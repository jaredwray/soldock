// The pure model of Calendar: the days of a period, the events of each day, and the form of an event.
// Day boundaries come from the time zone (`zonedDayStart`): a day can have 23 or 25 hours.
import {
	addDays,
	type CalendarEvent,
	checkWhen,
	DAY_MS,
	dateToUtcMs,
	type EventWhenValue,
	zonedDate,
	zonedDayStart,
	zonedTime,
	zoneOffsetMs,
} from "@asterra/contracts";
import type { CalendarView } from "../../routes.ts";

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

/** The part of an event on one day. `start` and `end` are minutes from 00:00 of the day. */
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
						end: (dayEnd - dayStart) / 60_000,
						continued: day > event.when.start_date,
						continues: addDays(day, 1) < event.when.end_date,
					});
				}
				continue;
			}
			const start = Date.parse(event.when.start);
			const end = Date.parse(event.when.end);
			if (start >= dayEnd || end <= dayStart) continue;
			segments.push({
				event,
				allDay: false,
				start: (Math.max(start, dayStart) - dayStart) / 60_000,
				end: (Math.min(end, dayEnd) - dayStart) / 60_000,
				continued: start < dayStart,
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
	};
}

/** The form of an existing event, in the time zone of the person. */
export function formOf(event: CalendarEvent, zone: string): EventForm {
	const base = { title: event.title, location: event.location, description: event.description };
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

/** The time of an event from the fields of the form. The last day of an all-day form is in the event. */
export function whenOf(form: EventForm, zone: string): EventWhenValue {
	if (form.allDay) return { kind: "all_day", start_date: form.startDate, end_date: addDays(form.endDate, 1) };
	return {
		kind: "timed",
		start: new Date(zonedTime(form.startDate, form.startTime, zone)).toISOString(),
		end: new Date(zonedTime(form.endDate, form.endTime, zone)).toISOString(),
		time_zone: zone,
	};
}

/** The problem with the time of the form, with the text of the server, or null. */
export function formProblem(form: EventForm, zone: string): string | null {
	if (!form.startDate || !form.endDate || (!form.allDay && (!form.startTime || !form.endTime))) {
		return "Give a start and an end.";
	}
	if (form.allDay && form.endDate < form.startDate) return "The last day of an event must not be before its first day.";
	return checkWhen(whenOf(form, zone));
}

/** True when the time of the form is the time of the event, so a save does not send it. */
export function sameWhen(form: EventForm, event: CalendarEvent, zone: string): boolean {
	const when = whenOf(form, zone);
	if (when.kind !== event.when.kind) return false;
	if (when.kind === "all_day" && event.when.kind === "all_day") {
		return when.start_date === event.when.start_date && when.end_date === event.when.end_date;
	}
	if (when.kind === "timed" && event.when.kind === "timed") {
		return (
			Date.parse(when.start) === Date.parse(event.when.start) && Date.parse(when.end) === Date.parse(event.when.end)
		);
	}
	return false;
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
	return [event.title, whenText(event, zone), event.location].filter(Boolean).join(", ");
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
