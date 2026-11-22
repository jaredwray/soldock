import { describe, expect, it } from "vitest";
import {
	customDateBounds,
	expiryLabel,
	expiryPhrase,
	localDate,
	TTL_OPTIONS,
	ttlInput,
} from "../src/features/settings/ttl.ts";

const DAY = 24 * 60 * 60 * 1000;
// Noon in the local time zone, so a day before or after stays in the same local day boundaries.
const NOW = new Date(2026, 10, 22, 12, 0, 0).getTime();

describe("the lifetime of a new API key", () => {
	it("offers 1, 7, 30, 90 and 180 days, a custom date and no end", () => {
		expect(TTL_OPTIONS.map((option) => option.label)).toEqual([
			"1 day",
			"7 days",
			"30 days",
			"90 days",
			"180 days",
			"Custom date",
			"Never",
		]);
	});

	// The server takes days or a time, never both. No end sends neither.
	it("sends the days of a preset, the end of a custom day, or nothing for no end", () => {
		expect(ttlInput("7", "", NOW)).toEqual({ expires_in_days: 7 });
		expect(ttlInput("never", "2026-12-01", NOW)).toEqual({});
		const custom = ttlInput("custom", "2026-12-01", NOW);
		expect(custom).toEqual({ expires_at: new Date(2026, 11, 1, 23, 59, 59).toISOString().replace(".000Z", "Z") });
	});

	// The server refuses an end within a minute and an end after 730 days.
	it("keeps a custom date from tomorrow to the day before the limit", () => {
		const { min, max } = customDateBounds(NOW);
		expect(min).toBe(localDate(NOW + DAY));
		expect(max).toBe(localDate(NOW + 729 * DAY));
		expect(ttlInput("custom", localDate(NOW), NOW)).toMatch(/from tomorrow/);
		expect(ttlInput("custom", localDate(NOW + 730 * DAY), NOW)).toMatch(/729 days/);
		expect(ttlInput("custom", "", NOW)).toMatch(/Choose the date/);
		expect(typeof ttlInput("custom", max, NOW)).toBe("object");
	});

	it("tells when a key stops", () => {
		expect(expiryLabel(null, NOW)).toBe("Never");
		expect(expiryLabel(new Date(NOW - 1000).toISOString(), NOW)).toBe("Expired");
		expect(expiryLabel(new Date(NOW + DAY).toISOString(), NOW)).toBe("In 1 day");
		expect(expiryLabel(new Date(NOW + 7 * DAY).toISOString(), NOW)).toBe("In 7 days");
		expect(expiryLabel(new Date(NOW + 180 * DAY).toISOString(), NOW)).not.toMatch(/^In /);
		// Inside a sentence, a far date keeps its capital letters.
		expect(expiryPhrase(null, NOW)).toBe("no end");
		expect(expiryPhrase(new Date(NOW + 7 * DAY).toISOString(), NOW)).toBe("ends in 7 days");
		expect(expiryPhrase(new Date(NOW + 180 * DAY).toISOString(), NOW)).toMatch(/^ends on [A-Z0-9]/);
	});
});
