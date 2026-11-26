import { describe, expect, it } from "vitest";
import {
	addDays,
	canonicalTimeZone,
	checkWhen,
	EventWhenInput,
	isRealDate,
	operations,
	zonedDate,
	zonedDayStart,
	zonedTime,
} from "../src/index.ts";

const iso = (ms: number) => new Date(ms).toISOString();

describe("the days of a time zone", () => {
	it("gives 00:00 of a date, also on the days that the clock changes", () => {
		// New York: EST is UTC-5, EDT is UTC-4. The clock goes forward on 2026-03-08 and back on 2026-11-01.
		expect(iso(zonedDayStart("2026-03-08", "America/New_York"))).toBe("2026-03-08T05:00:00.000Z");
		expect(iso(zonedDayStart("2026-03-09", "America/New_York"))).toBe("2026-03-09T04:00:00.000Z");
		expect(iso(zonedDayStart("2026-11-01", "America/New_York"))).toBe("2026-11-01T04:00:00.000Z");
		expect(iso(zonedDayStart("2026-11-02", "America/New_York"))).toBe("2026-11-02T05:00:00.000Z");
		// The zones at the two ends of the day line.
		expect(iso(zonedDayStart("2026-12-01", "Pacific/Kiritimati"))).toBe("2026-11-30T10:00:00.000Z");
		expect(iso(zonedDayStart("2026-12-01", "Etc/GMT+12"))).toBe("2026-12-01T12:00:00.000Z");
		expect(iso(zonedDayStart("2026-12-01", "Asia/Kolkata"))).toBe("2026-11-30T18:30:00.000Z");
	});

	it("gives the date and the instant of a wall clock time in a zone", () => {
		expect(zonedDate(Date.parse("2026-12-01T03:00:00Z"), "America/New_York")).toBe("2026-11-30");
		expect(zonedDate(Date.parse("2026-12-01T03:00:00Z"), "Asia/Tokyo")).toBe("2026-12-01");
		expect(iso(zonedTime("2026-03-08", "09:30", "America/New_York"))).toBe("2026-03-08T13:30:00.000Z");
		expect(iso(zonedTime("2026-03-07", "09:30", "America/New_York"))).toBe("2026-03-07T14:30:00.000Z");
	});

	it("keeps the name of a known zone, and refuses a name that is not an IANA zone", () => {
		expect(canonicalTimeZone("america/new_york")).toBe("America/New_York");
		expect(canonicalTimeZone("UTC")).toBe("UTC");
		for (const bad of ["Mars/Olympus", "+05:00", "", "America/New York", "x".repeat(70)]) {
			expect(canonicalTimeZone(bad), bad).toBeNull();
		}
	});

	it("knows the real dates and moves across months and years", () => {
		expect(isRealDate("2028-02-29")).toBe(true);
		expect(isRealDate("2026-02-29")).toBe(false);
		expect(isRealDate("2026-2-01")).toBe(false);
		expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
		expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
	});
});

describe("the time of an event", () => {
	it("tells why a time is not good, with the text that the server and the dialog show", () => {
		const timed = (start: string, end: string) => checkWhen({ kind: "timed", start, end, time_zone: "UTC" });
		const allDay = (start_date: string, end_date: string) => checkWhen({ kind: "all_day", start_date, end_date });
		expect(timed("2026-12-01T09:00:00Z", "2026-12-01T10:00:00Z")).toBeNull();
		expect(timed("2026-12-01T10:00:00Z", "2026-12-01T10:00:00Z")).toMatch(/after its start/);
		expect(timed("2026-01-01T00:00:00Z", "2027-01-03T00:00:00Z")).toMatch(/at most 366 days/);
		expect(timed("1969-12-31T23:00:00Z", "1970-01-01T01:00:00Z")).toMatch(/from 1970-01-01 to 2100-12-31/);
		expect(allDay("2026-12-01", "2026-12-02")).toBeNull();
		// The usual mistake: an end_date that is the last day of the event.
		expect(allDay("2026-12-01", "2026-12-01")).toBe(
			"end_date is the day after the last day of the event. A one-day event on 2026-12-01 has end_date 2026-12-02.",
		);
		expect(allDay("2026-12-02", "2026-12-01")).toMatch(/after its start_date/);
		expect(allDay("2100-12-31", "2101-01-01")).toBeNull();
		expect(allDay("2100-12-31", "2101-01-02")).toMatch(/from 1970-01-01 to 2100-12-31/);
	});

	it("takes a timed event with an offset, and refuses the fields of the other kind", () => {
		expect(
			EventWhenInput.safeParse({
				kind: "timed",
				start: "2026-12-01T09:00:00-05:00",
				end: "2026-12-01T10:00:00-05:00",
				time_zone: "America/New_York",
			}).success,
		).toBe(true);
		expect(
			EventWhenInput.safeParse({ kind: "all_day", start_date: "2026-12-01", end_date: "2026-12-02", time_zone: "UTC" })
				.success,
		).toBe(false);
		expect(
			EventWhenInput.safeParse({
				kind: "timed",
				start: "2026-12-01T09:00:00",
				end: "2026-12-01T10:00:00Z",
				time_zone: "UTC",
			}).success,
		).toBe(false);
	});

	it("refuses a list range that ends before it starts or is too long", () => {
		const input = operations["calendar.list_events"].input;
		const range = (time_min: string, time_max: string) => input.safeParse({ time_min, time_max }).success;
		expect(range("2026-12-01T00:00:00Z", "2026-12-08T00:00:00Z")).toBe(true);
		expect(range("2026-12-08T00:00:00Z", "2026-12-01T00:00:00Z")).toBe(false);
		expect(range("2026-01-01T00:00:00Z", "2027-01-03T00:00:00Z")).toBe(false);
	});
});
