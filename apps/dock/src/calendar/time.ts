import { canonicalTimeZone, checkWhen, dateToUtcMs, type EventWhenValue } from "@asterra/contracts";
import type { EventTime } from "./calendar.ts";

/** The bounds of the days of an all-day event in each time zone: from UTC+14 to UTC-12. */
export const EARLIEST_ZONE_MS = 14 * 60 * 60 * 1000;
export const LATEST_ZONE_MS = 12 * 60 * 60 * 1000;

/**
 * The stored time of an event, or the problem with the time. The handlers use it for the input of a call, and
 * the object uses it for the time of an invitation by mail. The problem is the text of `checkWhen`.
 */
export function storedTime(when: EventWhenValue): EventTime | { problem: string } {
	const problem = checkWhen(when);
	if (problem) return { problem };
	if (when.kind === "timed") {
		const zone = canonicalTimeZone(when.time_zone);
		if (!zone) return { problem: "time_zone must be an IANA time zone, such as America/New_York." };
		return {
			all_day: false,
			start_at: Date.parse(when.start),
			end_at: Date.parse(when.end),
			start_date: null,
			end_date: null,
			time_zone: zone,
		};
	}
	return {
		all_day: true,
		start_at: dateToUtcMs(when.start_date) - EARLIEST_ZONE_MS,
		end_at: dateToUtcMs(when.end_date) + LATEST_ZONE_MS,
		start_date: when.start_date,
		end_date: when.end_date,
		time_zone: null,
	};
}
