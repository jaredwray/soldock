import { describe, expect, it } from "vitest";
import { snoozeInput, snoozePresets, toDateTimeInput } from "../src/features/mail/snooze.ts";

// The dates are in the time zone of the runner, as the dialog uses the time zone of the person.
const at = (year: number, month: number, day: number, hour = 0, minute = 0) =>
	new Date(year, month - 1, day, hour, minute);

describe("the times of the Snooze dialog", () => {
	it("offers 3 hours from now, tomorrow morning and the morning of the next Monday", () => {
		// 25 November 2026 is a Wednesday.
		expect(snoozePresets(at(2026, 11, 25, 14, 30)).map((preset) => [preset.label, preset.at])).toEqual([
			["In 3 hours", at(2026, 11, 25, 17, 30)],
			["Tomorrow", at(2026, 11, 26, 8)],
			["Next week", at(2026, 11, 30, 8)],
		]);
	});

	// "Next week" never means today or tomorrow: on a Monday it is 7 days later, and on a Sunday "Tomorrow" is
	// that Monday already. The days also go into the next month and the next year.
	it("counts the next Monday from each day of the week, into the next year", () => {
		const nextWeek = (now: Date) => snoozePresets(now).find((preset) => preset.key === "nextWeek")?.at ?? null;
		expect(nextWeek(at(2026, 11, 23, 9))).toEqual(at(2026, 11, 30, 8));
		expect(nextWeek(at(2026, 11, 28, 23, 59))).toEqual(at(2026, 11, 30, 8));
		expect(nextWeek(at(2026, 11, 29, 9))).toBeNull();
		expect(nextWeek(at(2026, 12, 29, 9))).toEqual(at(2027, 1, 4, 8));
		expect(snoozePresets(at(2026, 12, 31, 23)).find((preset) => preset.key === "tomorrow")?.at).toEqual(
			at(2027, 1, 1, 8),
		);
	});

	it("reads the date field as a time of the person, and refuses a value that is not later than now", () => {
		const now = at(2026, 11, 25, 14, 30);
		expect(toDateTimeInput(at(2027, 1, 4, 8, 5))).toBe("2027-01-04T08:05");
		expect(snoozeInput("2027-01-04T08:05", now)).toEqual(at(2027, 1, 4, 8, 5));
		expect(snoozeInput(toDateTimeInput(now), now)).toBeNull();
		expect(snoozeInput("2026-11-25T14:29", now)).toBeNull();
		expect(snoozeInput("", now)).toBeNull();
		expect(snoozeInput("tomorrow", now)).toBeNull();
	});
});
