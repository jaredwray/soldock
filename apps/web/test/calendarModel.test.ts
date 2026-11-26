import type { CalendarEvent } from "@asterra/contracts";
import { describe, expect, it } from "vitest";
import {
	eventsByDay,
	formOf,
	formProblem,
	monthGrid,
	newEventForm,
	periodOf,
	periodTitle,
	placeSegments,
	shiftPeriod,
	weekDays,
	whenOf,
	whenText,
} from "../src/features/calendar/model.ts";

const NY = "America/New_York";

function event(id: string, when: CalendarEvent["when"], title = id): CalendarEvent {
	return {
		id,
		title,
		description: "",
		location: "",
		when,
		revision: 1,
		created_at: "2026-11-01T00:00:00.000Z",
		updated_at: "2026-11-01T00:00:00.000Z",
	};
}

const timed = (id: string, start: string, end: string) => event(id, { kind: "timed", start, end, time_zone: NY });

describe("the days of a period", () => {
	it("starts a week on the first day, and a month grid on the week of the first of the month", () => {
		// 2026-12-02 is a Wednesday.
		expect(weekDays("2026-12-02", 0)).toEqual([
			"2026-11-29",
			"2026-11-30",
			"2026-12-01",
			"2026-12-02",
			"2026-12-03",
			"2026-12-04",
			"2026-12-05",
		]);
		expect(weekDays("2026-12-02", 1)[0]).toBe("2026-11-30");
		const grid = monthGrid("2026-12-17", 0);
		expect(grid).toHaveLength(42);
		expect([grid[0], grid[41]]).toEqual(["2026-11-29", "2027-01-09"]);
		expect(periodTitle("week", "2026-12-30", 0)).toBe("Dec 27, 2026 – Jan 2, 2027");
		expect(periodTitle("month", "2026-12-30", 0)).toBe("December 2026");
	});

	it("gives a range from 00:00 to 00:00 in the zone, also over a change of the clock", () => {
		// The week of 2026-03-08 has a day of 23 hours in New York.
		const week = periodOf("week", "2026-03-10", NY, 0);
		expect([week.timeMin, week.timeMax]).toEqual(["2026-03-08T05:00:00.000Z", "2026-03-15T04:00:00.000Z"]);
		expect(shiftPeriod("month", "2026-12-17", 1)).toBe("2027-01-01");
		expect(shiftPeriod("month", "2026-01-31", -1)).toBe("2025-12-01");
		expect(shiftPeriod("week", "2026-12-30", 1)).toBe("2027-01-06");
	});
});

describe("the events of each day", () => {
	it("gives an event that goes past midnight a part on each day, and an all-day event each of its days", () => {
		const late = timed("late", "2026-12-02T03:00:00Z", "2026-12-02T07:00:00Z"); // 22:00 to 02:00 in New York
		const trip = event("trip", { kind: "all_day", start_date: "2026-12-01", end_date: "2026-12-03" });
		const days = ["2026-12-01", "2026-12-02", "2026-12-03"];
		const byDay = eventsByDay([late, trip], days, NY);
		const parts = (day: string) =>
			(byDay.get(day) ?? []).map((part) => [
				part.event.id,
				part.allDay,
				part.start,
				part.end,
				part.continued,
				part.continues,
			]);
		expect(parts("2026-12-01")).toEqual([
			["trip", true, 0, 1440, false, true],
			["late", false, 22 * 60, 1440, false, true],
		]);
		expect(parts("2026-12-02")).toEqual([
			["trip", true, 0, 1440, true, false],
			["late", false, 0, 120, true, false],
		]);
		expect(parts("2026-12-03")).toEqual([]);
		expect(whenText(late, NY)).toBe("Dec 1, 10:00 PM – Dec 2, 2:00 AM");
		expect(whenText(trip, NY)).toBe("All day, Dec 1 – Dec 2");
	});

	it("puts overlapping events side by side, and keeps a later free event at full width", () => {
		const day = "2026-12-01";
		const at = (id: string, from: string, to: string) => timed(id, `${day}T${from}:00-05:00`, `${day}T${to}:00-05:00`);
		const segments = eventsByDay(
			[at("a", "09:00", "11:00"), at("b", "09:30", "10:00"), at("c", "10:30", "11:30"), at("d", "13:00", "14:00")],
			[day],
			NY,
		).get(day);
		const placed = placeSegments(segments ?? []).map((item) => [item.segment.event.id, item.column, item.columns]);
		// b ends before c starts, so c takes the column of b. a, b and c are one group of two columns.
		expect(placed).toEqual([
			["a", 0, 2],
			["b", 1, 2],
			["c", 1, 2],
			["d", 0, 1],
		]);
	});
});

describe("the form of an event", () => {
	it("keeps the last day of an all-day event in the form, and the day after it in the event", () => {
		const form = { ...newEventForm("2026-12-01"), allDay: true, endDate: "2026-12-01" };
		expect(whenOf(form, NY)).toEqual({ kind: "all_day", start_date: "2026-12-01", end_date: "2026-12-02" });
		const allDay = event("x", { kind: "all_day", start_date: "2026-12-01", end_date: "2026-12-03" });
		expect(formOf(allDay, NY)).toMatchObject({ allDay: true, startDate: "2026-12-01", endDate: "2026-12-02" });
		expect(formProblem({ ...form, endDate: "2026-11-30" }, NY)).toMatch(/not be before its first day/);
	});

	it("reads and writes a timed event on the clock of the zone", () => {
		const form = { ...newEventForm("2026-03-08", 1), endTime: "03:30" };
		// The clock of New York goes from 02:00 to 03:00 on this day.
		expect(whenOf(form, NY)).toEqual({
			kind: "timed",
			start: "2026-03-08T06:00:00.000Z",
			end: "2026-03-08T07:30:00.000Z",
			time_zone: NY,
		});
		expect(formOf(timed("y", "2026-03-08T06:00:00Z", "2026-03-08T07:30:00Z"), NY)).toMatchObject({
			startDate: "2026-03-08",
			startTime: "01:00",
			endTime: "03:30",
		});
		expect(formProblem({ ...form, endTime: "01:00" }, NY)).toBe("The end of an event must be after its start.");
		expect(newEventForm("2026-12-01", 23)).toMatchObject({ endDate: "2026-12-02", endTime: "00:00" });
	});
});
