import { describe, expect, it } from "vitest";
import {
	anchorOf,
	checkRecurrence,
	expandOccurrences,
	firstOccurrenceAfter,
	occurrenceAt,
	parseOccurrenceId,
	type RecurrenceRule,
	type SeriesTime,
	seriesEnd,
	zonedTime,
} from "../src/index.ts";

const iso = (ms: number) => new Date(ms).toISOString();
const LA = "America/Los_Angeles";

function timed(date: string, time: string, minutes: number, zone: string): SeriesTime {
	const start = zonedTime(date, time, zone);
	return {
		all_day: false,
		start_at: start,
		end_at: start + minutes * 60_000,
		start_date: null,
		end_date: null,
		time_zone: zone,
	};
}

function allDay(start: string, end: string): SeriesTime {
	return { all_day: true, start_at: 0, end_at: 0, start_date: start, end_date: end, time_zone: null };
}

function rule(frequency: RecurrenceRule["frequency"], extra: Partial<RecurrenceRule> = {}): RecurrenceRule {
	return { frequency, interval: 1, until: null, count: null, ...extra };
}

const YEAR_2026 = { min: Date.parse("2026-01-01T00:00:00Z"), max: Date.parse("2028-01-01T00:00:00Z") };
const YEAR = { min: Date.parse("2030-01-01T00:00:00Z"), max: Date.parse("2032-01-01T00:00:00Z") };

describe("a timed series", () => {
	it("keeps 09:00 in Los Angeles when the clock goes back", () => {
		// The clock in Los Angeles goes back on 2030-11-03: PDT (UTC-7) before, PST (UTC-8) after.
		const anchor = anchorOf(timed("2030-10-22", "09:00", 60, LA));
		const found = expandOccurrences(anchor, rule("weekly", { interval: 2 }), YEAR, 4);
		expect(found.map((occurrence) => iso(occurrence.start_at))).toEqual([
			"2030-10-22T16:00:00.000Z",
			"2030-11-05T17:00:00.000Z",
			"2030-11-19T17:00:00.000Z",
			"2030-12-03T17:00:00.000Z",
		]);
		expect(found.map((occurrence) => occurrence.key)).toEqual([
			"20301022T160000Z",
			"20301105T170000Z",
			"20301119T170000Z",
			"20301203T170000Z",
		]);
		expect(found.every((occurrence) => occurrence.end_at - occurrence.start_at === 3_600_000)).toBe(true);
	});

	it("moves a time that the clock skips to the same time after the skip, on that day only", () => {
		// The clock in Los Angeles goes from 02:00 to 03:00 on 2030-03-10.
		const anchor = anchorOf(timed("2030-03-09", "02:30", 30, LA));
		const found = expandOccurrences(anchor, rule("daily"), YEAR, 3);
		expect(found.map((occurrence) => iso(occurrence.start_at))).toEqual([
			"2030-03-09T10:30:00.000Z",
			"2030-03-10T10:30:00.000Z", // 03:30 PDT
			"2030-03-11T09:30:00.000Z", // 02:30 PDT
		]);
	});

	it("uses the first instant of a time that the clock shows two times", () => {
		const anchor = anchorOf(timed("2030-11-02", "01:30", 30, LA));
		const found = expandOccurrences(anchor, rule("daily"), YEAR, 2);
		expect(iso(found[1]?.start_at ?? 0)).toBe("2030-11-03T08:30:00.000Z"); // 01:30 PDT, not PST
	});

	it("keeps a first start at the second instance of a time that the clock shows two times", () => {
		// The clock in Los Angeles shows 01:30 two times on 2026-11-01. The series starts at the second one.
		const start = Date.parse("2026-11-01T01:30:00-08:00");
		const time: SeriesTime = { ...timed("2026-11-01", "01:30", 30, LA), start_at: start, end_at: start + 1_800_000 };
		const anchor = anchorOf(time);
		const found = expandOccurrences(anchor, rule("daily"), YEAR_2026, 2);
		expect(found.map((occurrence) => iso(occurrence.start_at))).toEqual([
			"2026-11-01T09:30:00.000Z", // 01:30 PST, as stored
			"2026-11-02T09:30:00.000Z",
		]);
		expect(found[0]?.key).toBe("20261101T093000Z");
		expect(occurrenceAt(anchor, rule("daily"), "20261101T093000Z")?.start_at).toBe(start);
		expect(occurrenceAt(anchor, rule("daily"), "20261101T083000Z")).toBeNull();
	});

	it("gives the same occurrences for a range far from the start as a walk from the start", () => {
		const cases: [SeriesTime, RecurrenceRule][] = [
			[timed("2030-01-31", "09:00", 60, LA), rule("monthly")],
			[timed("2030-01-07", "23:30", 60, "Asia/Kolkata"), rule("weekly", { interval: 3 })],
			[timed("2030-01-01", "00:15", 30, "Pacific/Kiritimati"), rule("daily", { interval: 5 })],
			[allDay("2030-02-28", "2030-03-02"), rule("monthly", { interval: 2 })],
		];
		for (const [time, ruleOf] of cases) {
			const anchor = anchorOf(time);
			const all = expandOccurrences(anchor, ruleOf, { min: 0, max: Date.parse("2034-01-01T00:00:00Z") }, 5000);
			const range = { min: Date.parse("2032-06-10T00:00:00Z"), max: Date.parse("2032-09-01T00:00:00Z") };
			const expected = all.filter((occurrence) => occurrence.end_at > range.min && occurrence.start_at < range.max);
			expect(expandOccurrences(anchor, ruleOf, range, 5000), JSON.stringify(ruleOf)).toEqual(expected);
			expect(expected.length).toBeGreaterThan(0);
		}
	});

	it("stops at the cap", () => {
		const anchor = anchorOf(timed("2030-01-01", "09:00", 30, LA));
		expect(expandOccurrences(anchor, rule("daily"), YEAR, 7)).toHaveLength(7);
	});
});

describe("the end of a series", () => {
	it("includes the until date in the zone of the event", () => {
		const anchor = anchorOf(timed("2030-10-22", "09:00", 60, LA));
		const found = expandOccurrences(anchor, rule("weekly", { interval: 2, until: "2030-11-19" }), YEAR, 99);
		expect(found.map((occurrence) => occurrence.key)).toEqual([
			"20301022T160000Z",
			"20301105T170000Z",
			"20301119T170000Z",
		]);
		expect(seriesEnd(anchor, rule("weekly", { interval: 2, until: "2030-11-19" }))).toBeGreaterThanOrEqual(
			found.at(-1)?.end_at ?? Number.POSITIVE_INFINITY,
		);
	});

	it("gives exactly count occurrences, and its end is the end of the last one", () => {
		const anchor = anchorOf(timed("2030-10-22", "09:00", 60, LA));
		const ruleOf = rule("weekly", { count: 5 });
		const found = expandOccurrences(anchor, ruleOf, YEAR, 99);
		expect(found).toHaveLength(5);
		expect(seriesEnd(anchor, ruleOf)).toBe(found[4]?.end_at);
		expect(seriesEnd(anchor, rule("weekly"))).toBeNull();
	});
});

describe("a monthly series", () => {
	it("skips the months without the day, and counts only real occurrences", () => {
		const anchor = anchorOf(timed("2030-01-31", "09:00", 60, LA));
		const found = expandOccurrences(anchor, rule("monthly", { count: 4 }), YEAR, 99);
		expect(found.map((occurrence) => occurrence.key.slice(0, 8))).toEqual([
			"20300131",
			"20300331",
			"20300531",
			"20300731",
		]);
	});

	it("has February 29 only in a leap year", () => {
		const anchor = anchorOf(allDay("2028-01-29", "2028-01-30"));
		const found = expandOccurrences(
			anchor,
			rule("monthly", { interval: 1 }),
			{ min: Date.parse("2028-02-01T00:00:00Z"), max: Date.parse("2029-04-01T00:00:00Z") },
			99,
		);
		const dates = found.map((occurrence) => occurrence.start_date);
		expect(dates).toContain("2028-02-29");
		expect(dates).not.toContain("2029-02-29");
		expect(dates).toContain("2029-03-29");
	});
});

describe("an all-day series", () => {
	it("keeps dates, with keys in date form", () => {
		const anchor = anchorOf(allDay("2030-10-22", "2030-10-24"));
		const found = expandOccurrences(anchor, rule("weekly"), YEAR, 2);
		expect(found.map(({ key, start_date, end_date }) => ({ key, start_date, end_date }))).toEqual([
			{ key: "20301022", start_date: "2030-10-22", end_date: "2030-10-24" },
			{ key: "20301029", start_date: "2030-10-29", end_date: "2030-10-31" },
		]);
	});
});

describe("the key of an occurrence", () => {
	it("finds the occurrence of a key, and refuses a key that the rule does not make", () => {
		const anchor = anchorOf(timed("2030-10-22", "09:00", 60, LA));
		const ruleOf = rule("weekly", { interval: 2, count: 3 });
		expect(iso(occurrenceAt(anchor, ruleOf, "20301105T170000Z")?.start_at ?? 0)).toBe("2030-11-05T17:00:00.000Z");
		expect(occurrenceAt(anchor, ruleOf, "20301105T160000Z")).toBeNull(); // the wrong time
		expect(occurrenceAt(anchor, ruleOf, "20301029T160000Z")).toBeNull(); // the week between
		expect(occurrenceAt(anchor, ruleOf, "20301203T170000Z")).toBeNull(); // after the count
		expect(occurrenceAt(anchor, ruleOf, "20301105")).toBeNull(); // a date key for a timed series
	});

	it("gives the first occurrence after an instant that the caller accepts, in the scan limit", () => {
		const anchor = anchorOf(timed("2030-10-22", "09:00", 60, LA));
		const biweekly = rule("weekly", { interval: 2 });
		const after = Date.parse("2030-11-05T17:00:00Z");
		const seen: string[] = [];
		const next = firstOccurrenceAfter(anchor, biweekly, after, 10, (occurrence) => {
			seen.push(occurrence.key);
			return occurrence.key !== "20301119T170000Z";
		});
		expect(next?.key).toBe("20301203T170000Z");
		// The walk stops at the first accepted occurrence.
		expect(seen).toEqual(["20301119T170000Z", "20301203T170000Z"]);
		expect(firstOccurrenceAfter(anchor, biweekly, after, 3, () => false)).toBeNull();
		expect(firstOccurrenceAfter(anchor, rule("weekly", { count: 2 }), after, 10, () => true)).toBeNull();
	});

	it("splits an occurrence id into the event id and the key", () => {
		expect(parseOccurrenceId("evt_01HZZZZZZZZZZZZZZZZZZZZZZZ_20301105T170000Z")).toEqual({
			eventId: "evt_01HZZZZZZZZZZZZZZZZZZZZZZZ",
			key: "20301105T170000Z",
		});
		expect(parseOccurrenceId("evt_01HZZZZZZZZZZZZZZZZZZZZZZZ")).toBeNull();
	});
});

describe("checkRecurrence", () => {
	it("refuses a rule that cannot work", () => {
		const meeting = timed("2030-10-22", "09:00", 60, LA);
		expect(checkRecurrence(meeting, rule("weekly", { interval: 2 }))).toBeNull();
		expect(checkRecurrence(meeting, rule("weekly", { until: "2030-12-01", count: 3 }))).toMatch(/not both/);
		expect(checkRecurrence(meeting, rule("weekly", { until: "2030-10-21" }))).toMatch(/before the first day/);
		expect(checkRecurrence(meeting, rule("weekly", { interval: 100 }))).toMatch(/interval/);
		expect(checkRecurrence(allDay("2030-10-22", "2030-10-25"), rule("daily", { interval: 2 }))).toMatch(/longer/);
	});
});
