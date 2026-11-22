import { API_KEY_LIMITS, API_KEY_TTL_DAYS, type InputOf } from "@asterra/contracts";

/** A choice of the lifetime control of a new key: a number of days, a custom end, or no end. */
export type TtlChoice = `${(typeof API_KEY_TTL_DAYS)[number]}` | "custom" | "never";

/** The choices of the lifetime control, in order. */
export const TTL_OPTIONS: readonly { value: TtlChoice; label: string }[] = [
	...API_KEY_TTL_DAYS.map((days) => ({
		value: `${days}` as TtlChoice,
		label: days === 1 ? "1 day" : `${days} days`,
	})),
	{ value: "custom", label: "Custom date" },
	{ value: "never", label: "Never" },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** The date part (`yyyy-mm-dd`) of a time in the local time zone, as a date input reads it. */
export function localDate(time: number): string {
	const date = new Date(time);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The first and the last day that a custom end can have: tomorrow, and the day before the last day of
 * the limit. A key stops at the end of its day, so the last day of the limit could pass the limit.
 */
export function customDateBounds(now: number): { min: string; max: string } {
	return { min: localDate(now + DAY_MS), max: localDate(now + (API_KEY_LIMITS.maxDays - 1) * DAY_MS) };
}

type TtlInput = Pick<InputOf<"account.create_api_key">, "expires_in_days" | "expires_at">;

/**
 * The lifetime fields of `account.create_api_key` for a choice. A custom end is the end of that day in
 * the local time zone. Returns an error text when the custom date is missing or outside the bounds.
 */
export function ttlInput(choice: TtlChoice, customDate: string, now: number = Date.now()): TtlInput | string {
	if (choice === "never") return {};
	if (choice !== "custom") return { expires_in_days: Number(choice) };
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(customDate);
	if (!match) return "Choose the date when the key stops.";
	const { min, max } = customDateBounds(now);
	if (customDate < min || customDate > max) {
		return `Choose a date from tomorrow to ${API_KEY_LIMITS.maxDays - 1} days from now.`;
	}
	const end = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59);
	return { expires_at: end.toISOString().replace(/\.\d{3}Z$/, "Z") };
}

/** The end of a key inside a sentence: "no end", "expired", "ends in 5 days" or "ends on Feb 20, 2027". */
export function expiryPhrase(expiresAt: string | null, now: number = Date.now()): string {
	const label = expiryLabel(expiresAt, now);
	if (expiresAt === null) return "no end";
	if (label === "Expired") return "expired";
	return label.startsWith("In ") ? `ends ${label.toLowerCase()}` : `ends on ${label}`;
}

/** A short text for the end of a key: "Never", "Expired", "In 5 days", or the date when it is far. */
export function expiryLabel(expiresAt: string | null, now: number = Date.now()): string {
	if (expiresAt === null) return "Never";
	const end = Date.parse(expiresAt);
	if (end <= now) return "Expired";
	const days = Math.ceil((end - now) / DAY_MS);
	if (days === 1) return "In 1 day";
	if (days < 60) return `In ${days} days`;
	return new Date(end).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
