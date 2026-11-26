import { addDays, zonedDate, zonedDayStart, zonedTime } from "@asterra/contracts";

// The suggestions of calendar.find_times. A pure function: the handler gives it the busy intervals of each
// calendar with known availability. It never sees a calendar with unknown availability, so the caller must
// tell that a suggestion is free only for the known calendars.

const MINUTE_MS = 60_000;

export interface SuggestOptions {
	/** The range, in UTC ms. `max` is not in the range. */
	min: number;
	max: number;
	zone: string;
	/** The first and the last wall clock time of a day for a meeting, in HH:MM. */
	dayStart: string;
	dayEnd: string;
	durationMinutes: number;
	/** No suggestion starts before this instant. */
	now: number;
	limit: number;
}

/** The first instant at `from` or later that is a whole number of steps after `origin`. */
function alignUp(from: number, origin: number, step: number): number {
	return origin + Math.ceil((from - origin) / step) * step;
}

/** Merges intervals that overlap or touch. The input is in any order. */
export function mergeIntervals(intervals: readonly (readonly [number, number])[]): [number, number][] {
	const sorted = [...intervals].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	const merged: [number, number][] = [];
	for (const [start, end] of sorted) {
		const last = merged.at(-1);
		if (last && start <= last[1]) last[1] = Math.max(last[1], end);
		else merged.push([start, end]);
	}
	return merged;
}

/**
 * The free times of `durationMinutes` in the range, first first. Each one is inside the hours of its day in
 * the time zone and overlaps no busy interval. A suggestion starts on a step of 15 minutes from the start of
 * the day hours (30 minutes for a meeting of an hour or more). Two suggestions do not overlap. The days come
 * from `zonedDayStart` and `zonedTime`, so a day of 23 or 25 hours gives the correct wall clock times.
 */
export function suggestTimes(
	busy: readonly (readonly [number, number])[],
	options: SuggestOptions,
): [number, number][] {
	const duration = options.durationMinutes * MINUTE_MS;
	const step = (options.durationMinutes >= 60 ? 30 : 15) * MINUTE_MS;
	const advance = Math.ceil(duration / step) * step;
	// Merged intervals do not overlap and are in order, and the search only goes forward in time. So one index
	// goes through the intervals one time.
	const merged = mergeIntervals(busy);
	let next = 0;
	const lower = Math.max(options.min, options.now);
	const found: [number, number][] = [];
	if (lower >= options.max) return found;
	for (
		let date = zonedDate(lower, options.zone);
		zonedDayStart(date, options.zone) < options.max && found.length < options.limit;
		date = addDays(date, 1)
	) {
		const dayOpen = zonedTime(date, options.dayStart, options.zone);
		const dayClose = Math.min(zonedTime(date, options.dayEnd, options.zone), options.max);
		let start = alignUp(Math.max(dayOpen, lower), dayOpen, step);
		while (start + duration <= dayClose && found.length < options.limit) {
			const end = start + duration;
			// An interval that ends at `start` or before it blocks no later suggestion.
			while ((merged[next]?.[1] ?? Number.POSITIVE_INFINITY) <= start) next++;
			const blocking = merged[next];
			if (blocking && blocking[0] < end) {
				start = alignUp(blocking[1], dayOpen, step);
				continue;
			}
			found.push([start, end]);
			start += advance;
		}
	}
	return found;
}
