import type { CalendarEvent } from "@asterra/contracts";
import { describe, expect, it } from "vitest";
import {
	changedSharing,
	clampDay,
	eventsByDay,
	formOf,
	formProblem,
	monthGrid,
	newEventForm,
	periodOf,
	periodTitle,
	placeSegments,
	sameTimeFields,
	shiftPeriod,
	shiftTarget,
	weekDays,
	whenOf,
	whenText,
	withSlot,
} from "../src/features/calendar/model.ts";

const NY = "America/New_York";

function event(id: string, when: CalendarEvent["when"], title = id): CalendarEvent {
	return {
		id,
		calendar_id: "prn_me",
		organizer_id: "prn_me",
		created_by: "prn_me",
		title,
		description: "",
		location: "",
		when,
		visibility: "default",
		attendees: [],
		redacted: false,
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
	});

	it("moves to the period before or after, and to no period outside the days that an event can use", () => {
		expect(shiftPeriod("month", "2026-12-17", 1)).toBe("2027-01-01");
		expect(shiftPeriod("month", "2026-01-31", -1)).toBe("2025-12-01");
		expect(shiftPeriod("week", "2026-12-30", 1)).toBe("2027-01-06");
		expect(shiftTarget("week", "2026-12-30", 1, 0)).toBe("2027-01-06");
		expect(shiftTarget("month", "2026-01-31", -1, 0)).toBe("2025-12-01");
		// The route accepts 1970-01-01 to 2100-12-31. 1970-01-01 is a Thursday and 2100-12-31 is a Friday.
		expect(shiftTarget("month", "1970-01-20", -1, 0)).toBeNull();
		expect(shiftTarget("month", "2100-12-05", 1, 0)).toBeNull();
		expect(shiftTarget("week", "1970-01-02", -1, 0)).toBeNull();
		expect(shiftTarget("week", "2100-12-27", 1, 0)).toBeNull();
		// The first week has days before 1970, so the step to it opens its first day in the window.
		expect(shiftTarget("week", "1970-01-05", -1, 0)).toBe("1970-01-01");
		expect(shiftTarget("week", "2100-12-25", 1, 0)).toBe("2100-12-31");
		// The first week starts on 1969-12-28. A new event there starts on the first day in the window.
		expect([clampDay("1969-12-28"), clampDay("2101-01-01"), clampDay("2026-12-01")]).toEqual([
			"1970-01-01",
			"2100-12-31",
			"2026-12-01",
		]);
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

	it("puts each part at its time on the wall clock, also on a day of 23 or 25 hours", () => {
		const parts = (item: CalendarEvent, day: string) =>
			(eventsByDay([item], [day], NY).get(day) ?? []).map((part) => [part.start, part.end, part.continues]);
		// 2026-03-08 has no 02:00 in New York. 09:00 is 8 hours after the start of the day.
		expect(parts(timed("a", "2026-03-08T13:00:00Z", "2026-03-08T14:00:00Z"), "2026-03-08")).toEqual([
			[9 * 60, 10 * 60, false],
		]);
		// 2026-11-01 has 01:00 two times. 23:00 is 24 hours after the start of the day.
		expect(parts(timed("b", "2026-11-02T04:00:00Z", "2026-11-02T04:30:00Z"), "2026-11-01")).toEqual([
			[23 * 60, 23 * 60 + 30, false],
		]);
		expect(parts(timed("c", "2026-11-02T04:00:00Z", "2026-11-02T06:00:00Z"), "2026-11-01")).toEqual([
			[23 * 60, 1440, true],
		]);
		// From 01:30 before the change to 01:10 after it: the part keeps its real length of 40 minutes in the grid.
		expect(parts(timed("d", "2026-11-01T05:30:00Z", "2026-11-01T06:10:00Z"), "2026-11-01")).toEqual([[90, 130, false]]);
		// A new event from a click on the 9 AM line is at that line.
		const clicked = whenOf(newEventForm("2026-03-08", 9), NY);
		expect(parts(event("e", clicked as CalendarEvent["when"]), "2026-03-08")).toEqual([[9 * 60, 10 * 60, false]]);
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

		// An event at the second 01:15 of 2026-11-01, with seconds. The form cannot give these instants back.
		const second = timed("z", "2026-11-01T06:15:20Z", "2026-11-01T06:45:00Z");
		const opened = formOf(second, NY);
		expect(opened).toMatchObject({ startDate: "2026-11-01", startTime: "01:15", endTime: "01:45" });
		expect(whenOf(opened, NY)).toMatchObject({ start: "2026-11-01T05:15:00.000Z" });
		// So a save with a new title only does not send the time, and a save with a new time field does.
		expect(sameTimeFields({ ...opened, title: "New title", location: "Room 3" }, opened)).toBe(true);
		for (const change of [
			{ allDay: true },
			{ startDate: "2026-11-02" },
			{ startTime: "01:30" },
			{ endDate: "2026-11-02" },
			{ endTime: "02:00" },
		]) {
			expect(sameTimeFields({ ...opened, ...change }, opened), JSON.stringify(change)).toBe(false);
		}
		expect(newEventForm("2026-12-01", 23)).toMatchObject({ endDate: "2026-12-02", endTime: "00:00" });
	});

	// The server checks each attendee that a save sends. A save of a different field must not send them.
	it("sends the attendees and the visibility of a save only when the person changed them", () => {
		const opened = { ...newEventForm("2026-12-01"), title: "Sync", attendees: ["prn_a", "prn_b"] };
		expect(changedSharing({ ...opened, title: "New title" }, opened)).toEqual({});
		expect(changedSharing({ ...opened, attendees: ["prn_a"] }, opened)).toEqual({ attendees: ["prn_a"] });
		expect(changedSharing({ ...opened, attendees: ["prn_a", "prn_c"] }, opened)).toEqual({
			attendees: ["prn_a", "prn_c"],
		});
		expect(changedSharing({ ...opened, visibility: "private" }, opened)).toEqual({ visibility: "private" });
	});

	// Find a time can search in a different zone. A suggestion is two instants, so the form must show them on the
	// clock of the dialog, and a save must send the same instants back.
	it("fills the form with a suggestion of Find a time on the clock of the dialog zone", () => {
		const allDay = { ...newEventForm("2026-12-01"), allDay: true, title: "Sync", attendees: ["prn_a"] };
		// 09:00 in Berlin on 2026-12-02 is 03:00 in New York.
		const start = Date.parse("2026-12-02T08:00:00Z");
		const filled = withSlot(allDay, start, start + 30 * 60_000, NY);
		expect(filled).toMatchObject({
			title: "Sync",
			attendees: ["prn_a"],
			allDay: false,
			startDate: "2026-12-02",
			startTime: "03:00",
			endDate: "2026-12-02",
			endTime: "03:30",
		});
		expect(whenOf(filled, NY)).toMatchObject({ start: "2026-12-02T08:00:00.000Z", end: "2026-12-02T08:30:00.000Z" });
	});
});
