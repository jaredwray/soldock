// The rules of Snooze that do not need React: the times that the dialog offers, the value of its date field,
// and the text of a snooze time.

const HOUR_MS = 3_600_000;

/** The hour of the day of a time that names only a day, for example "Tomorrow". */
const MORNING_HOUR = 8;

export interface SnoozePreset {
	key: "hours" | "tomorrow" | "nextWeek";
	label: string;
	at: Date;
}

/** The start of the morning, `days` days after the day of `now`, in the time zone of the person. */
function morning(now: Date, days: number): Date {
	return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, MORNING_HOUR);
}

/**
 * The times that the dialog offers: 3 hours from now, tomorrow morning, and the morning of the next Monday.
 * On a Monday, the next Monday is 7 days later. On a Sunday, tomorrow is that Monday, so the dialog offers it
 * one time only.
 */
export function snoozePresets(now: Date): SnoozePreset[] {
	const toMonday = (8 - now.getDay()) % 7 || 7;
	const presets: SnoozePreset[] = [
		{ key: "hours", label: "In 3 hours", at: new Date(now.getTime() + 3 * HOUR_MS) },
		{ key: "tomorrow", label: "Tomorrow", at: morning(now, 1) },
	];
	if (toMonday > 1) presets.push({ key: "nextWeek", label: "Next week", at: morning(now, toMonday) });
	return presets;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** The value of a `datetime-local` field for a time, in the time zone of the person: `2027-01-04T08:00`. */
export function toDateTimeInput(date: Date): string {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The time of the value of a `datetime-local` field, or null when the value is not a time that is later than
 * `now`. The server refuses a snooze that does not end later than now.
 */
export function snoozeInput(value: string, now: Date): Date | null {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) || date.getTime() <= now.getTime() ? null : date;
}

const sameDayFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const sameYearFormat = new Intl.DateTimeFormat(undefined, {
	weekday: "short",
	month: "short",
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
});
const otherYearFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** The time of a snooze in a sentence: the time for today, then the day and the time, then also the year. */
export function snoozeTime(until: string | Date, now: Date = new Date()): string {
	const date = typeof until === "string" ? new Date(until) : until;
	if (Number.isNaN(date.getTime())) return "";
	if (date.toDateString() === now.toDateString()) return `${sameDayFormat.format(date)} today`;
	return (date.getFullYear() === now.getFullYear() ? sameYearFormat : otherYearFormat).format(date);
}
