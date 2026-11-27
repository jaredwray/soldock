import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { InputOf } from "@asterra/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Actor, callTool, codeOf, createActor, PASSWORD, seedOrg, settleCalendars } from "./helpers.ts";

// Find a time, invitations from a delegate, and the story of the user: "My agent can find 30 minutes with a
// teammate and send the invitation from my calendar, but only after I grant it access." Ada is the person, bot is
// her agent, and Grace is the teammate.

let owner: Actor;
let ada: Actor;
let bot: Actor;
let grace: Actor;

beforeEach(async () => {
	({ owner, ada, bot } = await seedOrg());
	grace = await createActor(owner, {
		kind: "human",
		display_name: "Grace Hopper",
		address: "grace@dock.test",
		password: PASSWORD,
	});
});

type CreateInput = InputOf<"calendar.create_event">;
type FindInput = InputOf<"calendar.find_times">;

const meeting = (title: string, start: string, end: string, extra: Partial<CreateInput> = {}): CreateInput => ({
	title,
	when: { kind: "timed", start, end, time_zone: "UTC" },
	...extra,
});

const allDay = (title: string, start_date: string, end_date: string): CreateInput => ({
	title,
	when: { kind: "all_day", start_date, end_date },
});

/** One day in UTC, far in the future, so no suggestion is in the past. */
const DAY = { time_min: "2030-03-04T00:00:00Z", time_max: "2030-03-05T00:00:00Z" } as const;

const find = (actor: Actor, input: Partial<FindInput>) =>
	actor.call("calendar.find_times", { ...DAY, duration_minutes: 30, time_zone: "UTC", ...input });

/** The calendar entry of one principal in a find_times answer. */
function entry<T extends { principal_id: string }>(result: { calendars: T[] }, id: string): T | undefined {
	return result.calendars.find((calendar) => calendar.principal_id === id);
}

const calendarStub = (id: string) => env.CALENDAR.get(env.CALENDAR.idFromName(id));

describe("busy times", () => {
	it("shows unknown, never free, for a calendar that shares nothing", async () => {
		await grace.call("calendar.create_event", meeting("Busy", "2030-03-04T09:00:00Z", "2030-03-04T17:00:00Z"));
		const result = await find(ada, { attendee_ids: grace.id });
		expect(result.complete).toBe(false);
		expect(result.calendars).toEqual([
			{ principal_id: ada.id, availability: "known", busy: [] },
			{ principal_id: grace.id, availability: "unknown", busy: [] },
		]);
		// Grace is busy all day, and Ada cannot know it. The answer suggests no time.
		expect(result.suggestions).toEqual([]);
		expect((await find(ada, { attendee_ids: grace.id, ignore_unknown: "false" })).suggestions).toEqual([]);
		// The caller can ask for the times of the known calendars. The answer still tells that it is not complete.
		const others = await find(ada, { attendee_ids: grace.id, ignore_unknown: "true" });
		expect(others.complete).toBe(false);
		expect(others.calendars).toEqual(result.calendars);
		expect(others.suggestions[0]).toEqual({ start: "2030-03-04T09:00:00.000Z", end: "2030-03-04T09:30:00.000Z" });
		expect(await codeOf(find(ada, { attendee_ids: "prn_01JD0000000000000000000099" }))).toBe("not_found");
		// calendar.query_free_busy uses the same rule.
		const raw = await ada.call("calendar.query_free_busy", { principal_ids: grace.id, ...DAY });
		expect(raw.calendars).toEqual([{ principal_id: grace.id, availability: "unknown", busy: [] }]);
	});

	it("checks the grant also for a range that can hold no event", async () => {
		const far = { time_min: "2150-01-01T00:00:00Z", time_max: "2150-01-02T00:00:00Z", attendee_ids: grace.id };
		const before = await find(ada, far);
		expect(before.calendars.map((calendar) => calendar.availability)).toEqual(["known", "unknown"]);
		expect(before.complete).toBe(false);
		await grace.call("calendar.set_grant", { principal_id: ada.id, access: "free_busy" });
		expect(await find(ada, far)).toMatchObject({
			calendars: [
				{ principal_id: ada.id, availability: "known", busy: [] },
				{ principal_id: grace.id, availability: "known", busy: [] },
			],
			suggestions: [],
			complete: true,
		});
	});

	it("merges overlapping events, and keeps a private event as busy time without a detail", async () => {
		await grace.call("calendar.set_grant", { principal_id: ada.id, access: "free_busy" });
		await grace.call("calendar.create_event", meeting("Design", "2030-03-04T10:00:00Z", "2030-03-04T11:00:00Z"));
		await grace.call("calendar.create_event", meeting("Review", "2030-03-04T10:30:00Z", "2030-03-04T12:00:00Z"));
		await grace.call("calendar.create_event", meeting("Lunch", "2030-03-04T12:00:00Z", "2030-03-04T12:30:00Z"));
		const { event: secret } = await grace.call("calendar.create_event", {
			...meeting("Therapy", "2030-03-04T14:00:00Z", "2030-03-04T15:00:00Z"),
			description: "Room 9",
			visibility: "private",
		});
		const result = await find(ada, { attendee_ids: grace.id });
		expect(result.complete).toBe(true);
		expect(entry(result, grace.id)).toEqual({
			principal_id: grace.id,
			availability: "known",
			busy: [
				{ start: "2030-03-04T10:00:00.000Z", end: "2030-03-04T12:30:00.000Z" },
				{ start: "2030-03-04T14:00:00.000Z", end: "2030-03-04T15:00:00.000Z" },
			],
		});
		const text = JSON.stringify(result);
		for (const detail of ["Therapy", "Room 9", secret.id, "Design"]) expect(text).not.toContain(detail);
		// The suggestions avoid each busy interval, inside the default hours from 09:00 to 17:00.
		expect(result.suggestions.slice(0, 4)).toEqual([
			{ start: "2030-03-04T09:00:00.000Z", end: "2030-03-04T09:30:00.000Z" },
			{ start: "2030-03-04T09:30:00.000Z", end: "2030-03-04T10:00:00.000Z" },
			{ start: "2030-03-04T12:30:00.000Z", end: "2030-03-04T13:00:00.000Z" },
			{ start: "2030-03-04T13:00:00.000Z", end: "2030-03-04T13:30:00.000Z" },
		]);
		expect(result.suggestions.some((slot) => slot.start === "2030-03-04T14:00:00.000Z")).toBe(false);
		expect(result.suggestions.at(-1)?.end).toBe("2030-03-04T17:00:00.000Z");
	});

	it("puts an all-day event on the days of the time zone of the query", async () => {
		await grace.call("calendar.set_grant", { principal_id: ada.id, access: "free_busy" });
		await grace.call("calendar.create_event", allDay("Offsite", "2030-03-05", "2030-03-06"));
		const range = { time_min: "2030-03-04T00:00:00Z", time_max: "2030-03-07T00:00:00Z", attendee_ids: grace.id };
		const newYork = await find(ada, { ...range, time_zone: "America/New_York" });
		expect(entry(newYork, grace.id)?.busy).toEqual([
			{ start: "2030-03-05T05:00:00.000Z", end: "2030-03-06T05:00:00.000Z" },
		]);
		const kiritimati = await find(ada, { ...range, time_zone: "Pacific/Kiritimati" });
		expect(entry(kiritimati, grace.id)?.busy).toEqual([
			{ start: "2030-03-04T10:00:00.000Z", end: "2030-03-05T10:00:00.000Z" },
		]);
		// No suggestion of New York falls on the day of the event there.
		expect(newYork.suggestions.some((slot) => slot.start.startsWith("2030-03-05T1"))).toBe(false);
		// calendar.query_free_busy counts an all-day event as busy in its time_zone too.
		const raw = await ada.call("calendar.query_free_busy", {
			principal_ids: grace.id,
			time_min: range.time_min,
			time_max: range.time_max,
			time_zone: "America/New_York",
		});
		expect(raw.calendars[0]?.busy).toEqual(entry(newYork, grace.id)?.busy);
	});

	it("suggests the wall clock hours of each day across a change of the clock", async () => {
		// New York changes from EST to EDT on 2030-03-10.
		const result = await find(ada, {
			time_min: "2030-03-09T05:00:00Z",
			time_max: "2030-03-11T04:00:00Z",
			time_zone: "America/New_York",
			day_start: "09:00",
			day_end: "10:00",
			duration_minutes: 60,
		});
		expect(result.suggestions).toEqual([
			{ start: "2030-03-09T14:00:00.000Z", end: "2030-03-09T15:00:00.000Z" },
			{ start: "2030-03-10T13:00:00.000Z", end: "2030-03-10T14:00:00.000Z" },
		]);
	});

	it("asks the attendees as the owner of calendar_id, only for a principal with schedule access", async () => {
		await grace.call("calendar.set_grant", { principal_id: ada.id, access: "free_busy" });
		await grace.call("calendar.create_event", meeting("Design", "2030-03-04T10:00:00Z", "2030-03-04T11:00:00Z"));
		// The grant of Grace names Ada, not the agent.
		expect(entry(await find(bot, { attendee_ids: grace.id }), grace.id)?.availability).toBe("unknown");
		expect(await codeOf(find(bot, { attendee_ids: grace.id, calendar_id: ada.id }))).toBe("forbidden");
		await ada.call("calendar.set_grant", { principal_id: bot.id, access: "free_busy" });
		expect(await codeOf(find(bot, { attendee_ids: grace.id, calendar_id: ada.id }))).toBe("forbidden");
		await ada.call("calendar.set_grant", { principal_id: bot.id, access: "schedule" });
		const result = await find(bot, { attendee_ids: grace.id, calendar_id: ada.id });
		expect(result.calendars.map((calendar) => [calendar.principal_id, calendar.availability])).toEqual([
			[ada.id, "known"],
			[grace.id, "known"],
		]);
	});
});

describe("invitations from a delegate", () => {
	it("gives the attendee one copy with the owner as organizer, and follows the changes of the delegate", async () => {
		await ada.call("calendar.set_grant", { principal_id: bot.id, access: "schedule" });
		const input = {
			...meeting("Kickoff", "2030-03-04T10:00:00Z", "2030-03-04T11:00:00Z"),
			location: "Room 3",
			attendee_ids: [grace.id],
			calendar_id: ada.id,
			idempotency_key: "kickoff",
		};
		const { event } = await bot.call("calendar.create_event", input);
		expect(event).toMatchObject({ organizer: { principal_id: ada.id }, created_by: bot.id, role: "organizer" });
		// A retry of the delegate adds no second event and no second invitation.
		await bot.call("calendar.create_event", input);
		await settleCalendars(ada.id, grace.id);
		const copies = (await grace.call("calendar.list_events", DAY)).events;
		expect(copies).toEqual([
			expect.objectContaining({
				id: event.id,
				role: "attendee",
				organizer: { principal_id: ada.id, display_name: "Ada Lovelace" },
				created_by: null,
				title: "Kickoff",
				location: "Room 3",
				redacted: false,
			}),
		]);
		expect((await ada.call("calendar.list_events", DAY)).events.map((entry) => entry.id)).toEqual([event.id]);

		await bot.call("calendar.update_event", { event_id: event.id, calendar_id: ada.id, title: "Kickoff v2" });
		await settleCalendars(ada.id, grace.id);
		expect((await grace.call("calendar.list_events", DAY)).events.map((copy) => copy.title)).toEqual(["Kickoff v2"]);
		await bot.call("calendar.delete_event", { event_id: event.id, calendar_id: ada.id });
		await settleCalendars(ada.id, grace.id);
		expect((await grace.call("calendar.list_events", DAY)).events).toEqual([]);
	});

	it("needs a person as the organizer, and invites only people", async () => {
		const helper = await createActor(owner, {
			kind: "agent",
			display_name: "Helper",
			address: "helper@dock.test",
			sponsor_id: ada.id,
		});
		await ada.call("calendar.set_grant", { principal_id: bot.id, access: "schedule" });
		const at = meeting("Sync", "2030-03-04T10:00:00Z", "2030-03-04T11:00:00Z");
		// An agent invites from the calendar of a person, never from its own calendar, and never an agent.
		expect(await codeOf(bot.call("calendar.create_event", { ...at, attendee_ids: [grace.id] }))).toBe("forbidden");
		expect(
			await codeOf(bot.call("calendar.create_event", { ...at, calendar_id: ada.id, attendee_ids: [helper.id] })),
		).toBe("invalid");
		expect(
			await codeOf(bot.call("calendar.create_event", { ...at, calendar_id: ada.id, attendee_ids: [ada.id] })),
		).toBe("invalid");
		expect(
			await codeOf(
				bot.call("calendar.create_event", {
					...at,
					calendar_id: ada.id,
					attendee_ids: ["prn_01JD0000000000000000000099"],
				}),
			),
		).toBe("invalid");
	});
});

describe("attendees that leave the organization", () => {
	it("lets a save keep an archived attendee, and refuses a new one", async () => {
		const linus = await createActor(owner, {
			kind: "human",
			display_name: "Linus Torvalds",
			address: "linus@dock.test",
			password: PASSWORD,
		});
		const { event } = await ada.call("calendar.create_event", {
			...meeting("Kickoff", "2030-03-04T10:00:00Z", "2030-03-04T11:00:00Z"),
			attendee_ids: [grace.id],
		});
		await owner.call("directory.archive_principal", { principal_id: grace.id });
		await owner.call("directory.archive_principal", { principal_id: linus.id });
		const saved = await ada.call("calendar.update_event", {
			event_id: event.id,
			title: "Kickoff v2",
			attendee_ids: [grace.id],
		});
		expect(saved.event).toMatchObject({
			title: "Kickoff v2",
			attendees: [{ principal_id: grace.id, display_name: "Grace Hopper", response: "needs_action" }],
		});
		expect(
			await codeOf(ada.call("calendar.update_event", { event_id: event.id, attendee_ids: [grace.id, linus.id] })),
		).toBe("invalid");
		// Ada can remove the archived attendee, and cannot add it again.
		await ada.call("calendar.update_event", { event_id: event.id, attendee_ids: [] });
		expect(await codeOf(ada.call("calendar.update_event", { event_id: event.id, attendee_ids: [grace.id] }))).toBe(
			"invalid",
		);
	});
});

describe("a calendar from before grants", () => {
	it("keeps its events after the new schema", async () => {
		const { event } = await ada.call(
			"calendar.create_event",
			meeting("Old", "2030-03-04T10:00:00Z", "2030-03-04T11:00:00Z"),
		);
		const stub = calendarStub(ada.id);
		// Back to schema 3: no grants, no visibility and no created_by.
		await expect(
			runInDurableObject(stub, (_instance, state) =>
				state.blockConcurrencyWhile(async () => {
					const sql = state.storage.sql;
					sql.exec("DROP TABLE grants");
					sql.exec("ALTER TABLE events DROP COLUMN visibility");
					sql.exec("ALTER TABLE events DROP COLUMN created_by");
					sql.exec("UPDATE meta SET value = '3' WHERE key = 'schema_version'");
					await state.storage.sync();
					state.abort("Restart the legacy calendar.");
				}),
			),
		).rejects.toThrow("Restart the legacy calendar.");
		const { event: read } = await ada.call("calendar.get_event", { event_id: event.id });
		expect(read).toEqual({ ...event });
		expect(read).toMatchObject({ visibility: "default", created_by: null });
		await ada.call("calendar.set_grant", { principal_id: grace.id, access: "free_busy" });
	});
});

describe("the story of the user, through MCP", () => {
	it("lets the agent find a time with a teammate and invite the teammate from the calendar of its person", async () => {
		const tool = async (name: string, args: Record<string, unknown>) => {
			const result = await callTool(bot.key, name, args);
			return { result, data: result.structuredContent as Record<string, unknown> };
		};
		const range = { time_min: "2030-03-04T00:00:00Z", time_max: "2030-03-06T00:00:00Z" };
		const findArgs = {
			...range,
			calendar_id: ada.id,
			attendee_ids: grace.id,
			duration_minutes: 30,
			time_zone: "America/New_York",
		};

		// Before Ada grants access, the agent cannot use her calendar.
		const early = await tool("calendar_find_times", findArgs);
		expect(early.result.isError).toBe(true);
		expect(JSON.parse(early.result.content[0]?.text ?? "{}")).toMatchObject({ code: "forbidden" });

		// Ada grants schedule access to her agent, and Grace shares her availability with Ada.
		await ada.call("calendar.set_grant", { principal_id: bot.id, access: "schedule" });
		await grace.call("calendar.set_grant", { principal_id: ada.id, access: "free_busy" });
		// Grace has a private event, an all-day event, and Ada has a meeting.
		await grace.call("calendar.create_event", {
			...meeting("Therapy", "2030-03-04T14:00:00Z", "2030-03-04T15:00:00Z"),
			visibility: "private",
			description: "Dr. Who",
		});
		await grace.call("calendar.create_event", allDay("Conference", "2030-03-05", "2030-03-06"));
		await ada.call("calendar.create_event", meeting("Ada 1:1", "2030-03-04T15:00:00Z", "2030-03-04T16:00:00Z"));

		const found = await tool("calendar_find_times", findArgs);
		expect(found.result.isError).toBeUndefined();
		const answer = found.data as {
			complete: boolean;
			calendars: { principal_id: string; availability: string; busy: { start: string; end: string }[] }[];
			suggestions: { start: string; end: string }[];
		};
		expect(answer.complete).toBe(true);
		expect(entry(answer, grace.id)?.busy).toEqual([
			{ start: "2030-03-04T14:00:00.000Z", end: "2030-03-04T15:00:00.000Z" },
			{ start: "2030-03-05T05:00:00.000Z", end: "2030-03-06T00:00:00.000Z" },
		]);
		expect(JSON.stringify(answer)).not.toContain("Therapy");
		expect(JSON.stringify(answer)).not.toContain("Dr. Who");
		// 09:00 in New York is 14:00 UTC: Grace is busy then, and Ada from 15:00. The first free slot is 16:00 UTC.
		const slot = answer.suggestions[0];
		expect(slot).toEqual({ start: "2030-03-04T16:00:00.000Z", end: "2030-03-04T16:30:00.000Z" });

		const createArgs = {
			calendar_id: ada.id,
			title: "Roadmap sync",
			when: { kind: "timed", start: slot?.start, end: slot?.end, time_zone: "America/New_York" },
			attendee_ids: [grace.id],
			idempotency_key: "roadmap-sync",
		};
		const lines: Record<string, unknown>[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
			if (typeof line === "string" && line.startsWith("{")) lines.push(JSON.parse(line));
		});
		let created: Awaited<ReturnType<typeof tool>>;
		try {
			created = await tool("calendar_create_event", createArgs);
			// A retry of the agent adds nothing.
			await tool("calendar_create_event", createArgs);
		} finally {
			spy.mockRestore();
		}
		expect(created.result.isError).toBeUndefined();
		const event = (created.data as { event: { id: string } }).event;
		expect(event).toMatchObject({ organizer: { principal_id: ada.id }, created_by: bot.id });
		expect(lines.filter((line) => line.audit === true && line.op === "calendar.create_event")).toEqual([
			expect.objectContaining({ actor: bot.id, actorKind: "agent", calendar: ada.id, target: event.id }),
		]);

		await settleCalendars(ada.id, grace.id);
		const invitations = (await grace.call("calendar.list_events", range)).events.filter(
			(copy) => copy.title === "Roadmap sync",
		);
		expect(invitations).toEqual([
			expect.objectContaining({
				id: event.id,
				role: "attendee",
				organizer: expect.objectContaining({ principal_id: ada.id }),
			}),
		]);

		// Ada removes the grant: the next attempt of the agent is refused.
		await ada.call("calendar.remove_grant", { principal_id: bot.id });
		const refused = await tool("calendar_create_event", { ...createArgs, idempotency_key: "second" });
		expect(refused.result.isError).toBe(true);
		expect(JSON.parse(refused.result.content[0]?.text ?? "{}")).toMatchObject({ code: "forbidden" });
		expect((await ada.call("calendar.list_events", range)).events.map((e) => e.title)).toEqual([
			"Ada 1:1",
			"Roadmap sync",
		]);
	});
});
