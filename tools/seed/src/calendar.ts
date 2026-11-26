// The events of the calendars of Wrenfield Studio. Each event has a day from the day of the seed, so the
// current week always has events. The times are on the clock of the studio.
import { addDays, type EventWhenValue, zonedTime } from "@asterra/contracts";
import type { ActorKey } from "./cast.ts";

/** The time zone of the studio. */
export const STUDIO_ZONE = "Europe/London";

export interface SeedEvent {
	/** A stable name for the idempotency key. */
	id: string;
	owner: ActorKey;
	title: string;
	/** The days from the day of the seed. A negative count is a day before it. */
	day: number;
	/** HH:MM on the clock of the studio. Without times, the event is an all-day event. */
	start?: string;
	end?: string;
	/** The days of an all-day event. The default is 1. */
	days?: number;
	location?: string;
	description?: string;
}

export const EVENTS: readonly SeedEvent[] = [
	{
		id: "standup",
		owner: "nadia",
		title: "Studio stand-up",
		day: 0,
		start: "09:30",
		end: "09:45",
		location: "Studio floor",
	},
	{
		id: "alder-review",
		owner: "nadia",
		title: "Alder Street Library: design review",
		day: 1,
		start: "14:00",
		end: "15:30",
		location: "Meeting room",
		description: "Walk through the reading room options and the daylight study.",
	},
	{ id: "away-day", owner: "nadia", title: "Studio away day", day: 9, days: 2, location: "Hartwell Barn" },
	{ id: "portfolio", owner: "nadia", title: "Hiring: portfolio review", day: -2, start: "11:00", end: "12:30" },
	{
		id: "fee-proposal",
		owner: "nadia",
		title: "Fee proposal: Tamsin Bakery",
		day: -1,
		start: "10:00",
		end: "11:00",
		location: "Meeting room",
	},
	{
		id: "planning-officer",
		owner: "nadia",
		title: "Call with the planning officer",
		day: 1,
		start: "15:00",
		end: "15:30",
	},
	{ id: "planning-nadia", owner: "nadia", title: "Planning submission due", day: 4 },
	{
		id: "supplier-lunch",
		owner: "nadia",
		title: "Lunch with the joinery supplier",
		day: -3,
		start: "12:30",
		end: "13:30",
	},
	{ id: "consultant", owner: "chidi", title: "Structural engineer call", day: 0, start: "11:00", end: "11:45" },
	{
		id: "alder-review-chidi",
		owner: "chidi",
		title: "Alder Street Library: design review",
		day: 1,
		start: "14:00",
		end: "15:30",
		location: "Meeting room",
	},
	{ id: "samples", owner: "meiling", title: "Materials library: samples", day: 1, start: "10:00", end: "11:00" },
	{
		id: "bakery-finishes",
		owner: "meiling",
		title: "Tamsin Bakery: finishes board",
		day: 2,
		start: "13:30",
		end: "14:30",
		location: "Studio floor",
	},
	{
		id: "site-visit",
		owner: "rafael",
		title: "Site visit, Tamsin Bakery",
		day: 2,
		start: "08:00",
		end: "11:00",
		location: "14 Tamsin Row",
	},
	{ id: "planning", owner: "tomasz", title: "Planning submission due", day: 4 },
	{ id: "payroll", owner: "tomasz", title: "Payroll run", day: 3, start: "15:00", end: "16:00" },
	{
		id: "client-call",
		owner: "ingrid",
		title: "Client call: Tamsin Bakery",
		day: 0,
		start: "16:00",
		end: "16:30",
		location: "Phone",
	},
	{
		id: "digest",
		owner: "research",
		title: "Weekly materials digest",
		day: 3,
		start: "17:00",
		end: "17:30",
		description: "Collect new notes on materials and rules, and post a summary in Design.",
	},
	{ id: "support-summary", owner: "triage", title: "Support summary", day: 0, start: "18:00", end: "18:15" },
];

/** The time of a seed event, from the day of the seed (YYYY-MM-DD). */
export function whenOfSeedEvent(event: SeedEvent, seedDay: string): EventWhenValue {
	const date = addDays(seedDay, event.day);
	if (event.start === undefined || event.end === undefined) {
		return { kind: "all_day", start_date: date, end_date: addDays(date, event.days ?? 1) };
	}
	const at = (time: string) => new Date(zonedTime(date, time, STUDIO_ZONE)).toISOString();
	return { kind: "timed", start: at(event.start), end: at(event.end), time_zone: STUDIO_ZONE };
}
