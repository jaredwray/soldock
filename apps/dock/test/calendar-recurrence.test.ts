import {
	createExecutionContext,
	createMessageBatch,
	getQueueResult,
	runDurableObjectAlarm,
	runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { CalendarEvent, InputOf } from "@asterra/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_PUSH_QUEUE } from "../src/chat/push.ts";
import worker from "../src/index.ts";
import { type Actor, codeOf, seedOrg } from "./helpers.ts";

// The acceptance scenario of recurring events and reminders: "Our team meets every other Tuesday at 9 a.m.
// Seattle time. I can move one meeting, and everyone gets reminded at the right time."
//
// The clock is fake and in 2030, so the runtime never fires an alarm by itself: each step moves the clock and
// runs the alarms. The clock in Los Angeles goes back on 2030-11-03, so the series spans the change.

const LA = "America/Los_Angeles";
const RANGE = { time_min: "2030-10-20T00:00:00Z", time_max: "2030-12-20T00:00:00Z", time_zone: LA };

let owner: Actor;
let ada: Actor;
let bot: Actor;

beforeEach(async () => {
	({ owner, ada, bot } = await seedOrg());
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2030-10-01T12:00:00Z"));
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const meeting: InputOf<"calendar.create_event"> = {
	title: "Team sync",
	when: { kind: "timed", start: "2030-10-22T09:00:00-07:00", end: "2030-10-22T10:00:00-07:00", time_zone: LA },
	recurrence: { frequency: "weekly", interval: 2 },
};

function calendar(principalId: string) {
	return env.CALENDAR.get(env.CALENDAR.idFromName(principalId));
}

/** Runs the alarms of the calendars until no outbox row is due. */
async function drain(...principalIds: string[]): Promise<void> {
	for (let round = 0; round < 10; round++) {
		let due = 0;
		for (const id of principalIds) {
			const stub = calendar(id);
			await runDurableObjectAlarm(stub);
			due += await runInDurableObject(
				stub,
				(_instance, state) =>
					state.storage.sql
						.exec<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE next_attempt_at <= ?", Date.now())
						.one().n,
			);
		}
		if (due === 0) return;
	}
	throw new Error("The calendar outbox did not drain.");
}

/** Moves the clock and runs the alarms of the calendars two times, as a retry of the runtime can. */
async function at(time: string, ...principalIds: string[]): Promise<void> {
	vi.setSystemTime(new Date(time));
	await drain(...principalIds);
	await drain(...principalIds);
}

async function starts(actor: Actor): Promise<string[]> {
	const { events } = await actor.call("calendar.list_events", RANGE);
	return events.map((event) => (event.when.kind === "timed" ? event.when.start : event.when.start_date));
}

/** The starts of the calendar reminders in the Activity of a principal, oldest first. */
async function reminders(actor: Actor): Promise<string[]> {
	const { items } = await actor.call("chat.list_activity", { filter: "calendar_reminder" });
	return items.map((item) => item.event?.start ?? "").reverse();
}

/** The organizer makes the series, moves the second meeting to 11:00 and cancels the third. */
async function setUp(): Promise<{ series: CalendarEvent; moved: string; cancelled: string }> {
	const { event: series } = await owner.call("calendar.create_event", { ...meeting, attendee_ids: [ada.id] });
	const { events } = await owner.call("calendar.list_events", RANGE);
	const [, second, third] = events;
	if (!second?.occurrence_id || !third?.occurrence_id) throw new Error("The series has no occurrences.");
	const { event: moved } = await owner.call("calendar.update_occurrence", {
		occurrence_id: second.occurrence_id,
		when: { kind: "timed", start: "2030-11-05T11:00:00-08:00", end: "2030-11-05T12:00:00-08:00", time_zone: LA },
		base_revision: series.revision,
	});
	await owner.call("calendar.cancel_occurrence", { occurrence_id: third.occurrence_id, base_revision: moved.revision });
	await drain(owner.id, ada.id);
	return { series, moved: second.occurrence_id, cancelled: third.occurrence_id };
}

describe("a biweekly meeting across a change of the clock", () => {
	it("shows the moved and the cancelled occurrence to the organizer, the attendee and free/busy", async () => {
		const { series, moved, cancelled } = await setUp();
		const expected = [
			"2030-10-22T16:00:00.000Z", // 09:00 PDT
			"2030-11-05T19:00:00.000Z", // moved to 11:00 PST
			// 2030-11-19 is cancelled
			"2030-12-03T17:00:00.000Z", // 09:00 PST
			"2030-12-17T17:00:00.000Z",
		];
		expect(await starts(owner)).toEqual(expected);
		expect(await starts(ada)).toEqual(expected);

		const { events: mine } = await owner.call("calendar.list_events", RANGE);
		expect(mine.map((event) => event.id)).toEqual(Array(4).fill(series.id));
		expect(mine[1]).toMatchObject({
			occurrence_id: moved,
			original_start: "2030-11-05T17:00:00.000Z",
			is_exception: true,
			role: "organizer",
			my_response: null,
			attendees: [{ principal_id: ada.id, display_name: "Ada Lovelace", response: "needs_action" }],
		});
		expect(mine.map((event) => event.occurrence_id)).not.toContain(cancelled);

		const { events: theirs } = await ada.call("calendar.list_events", RANGE);
		expect(theirs[1]).toMatchObject({
			id: series.id,
			occurrence_id: moved,
			role: "attendee",
			organizer: { principal_id: owner.id },
			my_response: "needs_action",
			reminder_minutes: 10,
		});
		expect((await ada.call("calendar.get_event", { event_id: series.id })).event.recurrence).toEqual({
			frequency: "weekly",
			interval: 2,
			until: null,
			count: null,
		});

		const { calendars } = await owner.call("calendar.query_free_busy", {
			principal_ids: `${owner.id},${ada.id}`,
			time_min: RANGE.time_min,
			time_max: RANGE.time_max,
		});
		const busy = expected.map((start) => ({ start, end: new Date(Date.parse(start) + 3_600_000).toISOString() }));
		expect(calendars).toEqual([
			{ principal_id: owner.id, busy },
			{ principal_id: ada.id, busy },
		]);
	});

	it("reminds each participant once for each meeting: at the revised time, and never for the cancelled one", async () => {
		await setUp();
		const both = [owner.id, ada.id];
		await at("2030-10-22T15:49:00Z", ...both);
		expect(await reminders(owner)).toEqual([]);
		await at("2030-10-22T15:50:00Z", ...both);
		expect(await reminders(owner)).toEqual(["2030-10-22T16:00:00.000Z"]);
		expect(await reminders(ada)).toEqual(["2030-10-22T16:00:00.000Z"]);

		// The original time of the moved meeting gives no reminder.
		await at("2030-11-05T16:50:00Z", ...both);
		expect(await reminders(ada)).toHaveLength(1);
		await at("2030-11-05T18:50:00Z", ...both);
		expect(await reminders(owner)).toEqual(["2030-10-22T16:00:00.000Z", "2030-11-05T19:00:00.000Z"]);
		expect(await reminders(ada)).toEqual(["2030-10-22T16:00:00.000Z", "2030-11-05T19:00:00.000Z"]);

		// The cancelled meeting gives none. The next meeting is at 09:00 PST again.
		await at("2030-11-19T16:50:00Z", ...both);
		expect(await reminders(ada)).toHaveLength(2);
		await at("2030-12-03T16:50:00Z", ...both);
		const all = ["2030-10-22T16:00:00.000Z", "2030-11-05T19:00:00.000Z", "2030-12-03T17:00:00.000Z"];
		expect(await reminders(owner)).toEqual(all);
		expect(await reminders(ada)).toEqual(all);
	});

	it("keeps the other occurrences and the id of a moved occurrence", async () => {
		const { series, moved } = await setUp();
		const { event } = await owner.call("calendar.get_event", { event_id: series.id });
		// A second move of the same occurrence keeps its id and adds no occurrence.
		await owner.call("calendar.update_occurrence", {
			occurrence_id: moved,
			when: { kind: "timed", start: "2030-11-06T09:00:00-08:00", end: "2030-11-06T10:00:00-08:00", time_zone: LA },
			base_revision: event.revision,
		});
		const { events } = await owner.call("calendar.list_events", RANGE);
		expect(events.map((entry) => entry.occurrence_id?.split("_").at(-1))).toEqual([
			"20301022T160000Z",
			"20301105T170000Z",
			"20301203T170000Z",
			"20301217T170000Z",
		]);
		expect(events[1]?.when).toMatchObject({ start: "2030-11-06T17:00:00.000Z" });
		// A move back to the time of the rule removes the exception.
		await owner.call("calendar.update_occurrence", {
			occurrence_id: moved,
			when: { kind: "timed", start: "2030-11-05T09:00:00-08:00", end: "2030-11-05T10:00:00-08:00", time_zone: LA },
		});
		const { events: after } = await owner.call("calendar.list_events", RANGE);
		expect(after[1]).toMatchObject({ occurrence_id: moved, is_exception: false });
	});

	it("checks the revision for an occurrence and for the series, and refuses changes of an attendee", async () => {
		const { series, moved } = await setUp();
		expect(
			await codeOf(owner.call("calendar.update_occurrence", { occurrence_id: moved, title: "Old", base_revision: 1 })),
		).toBe("conflict");
		expect(
			await codeOf(owner.call("calendar.update_event", { event_id: series.id, title: "Old", base_revision: 1 })),
		).toBe("conflict");
		expect(await codeOf(ada.call("calendar.update_occurrence", { occurrence_id: moved, title: "Mine" }))).toBe(
			"forbidden",
		);
		expect(await codeOf(ada.call("calendar.update_event", { event_id: series.id, title: "Mine" }))).toBe("forbidden");
		expect(await codeOf(ada.call("calendar.delete_event", { event_id: series.id }))).toBe("forbidden");
		expect(await codeOf(owner.call("calendar.respond_to_event", { event_id: series.id, response: "accepted" }))).toBe(
			"invalid",
		);
		// An occurrence that the rule does not make is not found.
		expect(
			await codeOf(owner.call("calendar.cancel_occurrence", { occurrence_id: `${series.id}_20301029T160000Z` })),
		).toBe("not_found");
	});

	it("removes the reminder and the busy time of an occurrence that the attendee declines", async () => {
		const { series } = await setUp();
		const { events } = await ada.call("calendar.list_events", RANGE);
		const december = events[2];
		if (!december?.occurrence_id) throw new Error("No occurrence on 2030-12-03.");
		const { event } = await ada.call("calendar.respond_to_event", {
			event_id: series.id,
			occurrence_id: december.occurrence_id,
			response: "declined",
		});
		expect(event.my_response).toBe("declined");
		await drain(ada.id, owner.id);

		const { events: organizer } = await owner.call("calendar.list_events", RANGE);
		expect(organizer[2]?.attendees).toEqual([
			{ principal_id: ada.id, display_name: "Ada Lovelace", response: "declined" },
		]);
		expect(organizer[3]?.attendees[0]?.response).toBe("needs_action");
		// The organizer state comes back to Ada. Her own response stays.
		expect((await ada.call("calendar.list_events", RANGE)).events[2]?.my_response).toBe("declined");

		const { calendars } = await owner.call("calendar.query_free_busy", {
			principal_ids: ada.id,
			time_min: "2030-12-01T00:00:00Z",
			time_max: "2030-12-05T00:00:00Z",
		});
		expect(calendars[0]?.busy).toEqual([]);

		await at("2030-12-03T16:50:00Z", owner.id, ada.id);
		expect(await reminders(owner)).toContain("2030-12-03T17:00:00.000Z");
		expect(await reminders(ada)).not.toContain("2030-12-03T17:00:00.000Z");
	});

	it("lets each participant change or remove the own reminder", async () => {
		const { series } = await setUp();
		await ada.call("calendar.set_reminder", { event_id: series.id, minutes: 30 });
		await owner.call("calendar.set_reminder", { event_id: series.id, minutes: null });
		await at("2030-10-22T15:30:00Z", owner.id, ada.id);
		expect(await reminders(ada)).toEqual(["2030-10-22T16:00:00.000Z"]);
		await at("2030-10-22T15:55:00Z", owner.id, ada.id);
		expect(await reminders(owner)).toEqual([]);
		expect((await ada.call("calendar.get_event", { event_id: series.id })).event.reminder_minutes).toBe(30);
	});

	it("removes the copy of each attendee when the organizer deletes the series, and clears exceptions on a series change", async () => {
		const { series } = await setUp();
		const { event } = await owner.call("calendar.update_event", {
			event_id: series.id,
			when: { kind: "timed", start: "2030-10-22T10:00:00-07:00", end: "2030-10-22T11:00:00-07:00", time_zone: LA },
		});
		await drain(owner.id, ada.id);
		expect(await starts(ada)).toEqual([
			"2030-10-22T17:00:00.000Z",
			"2030-11-05T18:00:00.000Z",
			"2030-11-19T18:00:00.000Z",
			"2030-12-03T18:00:00.000Z",
			"2030-12-17T18:00:00.000Z",
		]);
		await owner.call("calendar.delete_event", { event_id: series.id, base_revision: event.revision });
		await drain(owner.id, ada.id);
		expect(await starts(ada)).toEqual([]);
		expect(await codeOf(ada.call("calendar.get_event", { event_id: series.id }))).toBe("not_found");
	});
});

describe("invitations and access", () => {
	it("lets an agent repeat its own events, but not invite", async () => {
		const { event } = await bot.call("calendar.create_event", meeting);
		expect(event.recurrence).toMatchObject({ frequency: "weekly", interval: 2 });
		expect(await codeOf(bot.call("calendar.create_event", { ...meeting, attendee_ids: [ada.id] }))).toBe("forbidden");
		expect(await codeOf(owner.call("calendar.create_event", { ...meeting, attendee_ids: [bot.id] }))).toBe("invalid");
	});

	it("gives only busy times in free/busy, without titles", async () => {
		await owner.call("calendar.create_event", { ...meeting, title: "Secret plan" });
		const result = await bot.call("calendar.query_free_busy", {
			principal_ids: owner.id,
			time_min: "2030-10-20T00:00:00Z",
			time_max: "2030-10-30T00:00:00Z",
		});
		expect(JSON.stringify(result)).not.toContain("Secret");
		expect(result.calendars[0]?.busy).toEqual([{ start: "2030-10-22T16:00:00.000Z", end: "2030-10-22T17:00:00.000Z" }]);
	});

	it("ignores a state of the organizer that is older than the copy", async () => {
		const { series } = await setUp();
		const stub = calendar(ada.id);
		const sequence = await runInDurableObject(
			stub,
			(_instance, state) =>
				state.storage.sql.exec<{ sequence: number }>("SELECT sequence FROM events WHERE id = ?", series.id).one()
					.sequence,
		);
		await stub.applySnapshot(ada.id, { v: 1, event_id: series.id, sequence: sequence - 1, deleted: true });
		expect((await ada.call("calendar.get_event", { event_id: series.id })).event.title).toBe("Team sync");
	});

	it("pages through occurrences and one-off events in order", async () => {
		await owner.call("calendar.create_event", {
			...meeting,
			recurrence: { frequency: "daily", interval: 1, count: 5 },
		});
		await owner.call("calendar.create_event", {
			title: "Lunch",
			when: { kind: "timed", start: "2030-10-23T12:00:00-07:00", end: "2030-10-23T13:00:00-07:00", time_zone: LA },
		});
		const seen: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await owner.call("calendar.list_events", { ...RANGE, limit: 2, ...(cursor ? { cursor } : {}) });
			seen.push(...page.events.map((event) => `${event.title} ${event.when.kind === "timed" ? event.when.start : ""}`));
			cursor = page.next_cursor ?? undefined;
		} while (cursor);
		expect(seen).toEqual([
			"Team sync 2030-10-22T16:00:00.000Z",
			"Team sync 2030-10-23T16:00:00.000Z",
			"Lunch 2030-10-23T19:00:00.000Z",
			"Team sync 2030-10-24T16:00:00.000Z",
			"Team sync 2030-10-25T16:00:00.000Z",
			"Team sync 2030-10-26T16:00:00.000Z",
		]);
	});
});

describe("device notifications", () => {
	it("sends one push for each reminder, and a retry adds no second Activity item", async () => {
		await owner.call("chat.update_push_settings", { enabled: true, subject: "mailto:admin@example.com" });
		await ada.call("chat.subscribe_push", {
			endpoint: "https://push.example.com/ada",
			keys: {
				p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
				auth: "tBHItJI5svbpez7KI4CCXg",
			},
		});
		const { event } = await owner.call("calendar.create_event", {
			...meeting,
			recurrence: undefined,
			attendee_ids: [ada.id],
			reminder_minutes: 30,
		});
		await drain(owner.id, ada.id);
		// The reminder of the organizer is not the reminder of the attendee.
		await ada.call("calendar.set_reminder", { event_id: event.id, minutes: 5 });

		// The first send to the queue fails, after the Activity item exists. The retry sends the job.
		const jobs: unknown[] = [];
		let sends = 0;
		const queue = {
			sendBatch: async (batch: { body: unknown }[]) => {
				sends += 1;
				if (sends === 1) throw new Error("The queue is not available.");
				jobs.push(...batch.map(({ body }) => body));
			},
		} as unknown as Queue;
		await runInDurableObject(calendar(ada.id), (instance) => {
			const binding = instance as unknown as { env: Env };
			binding.env = { ...binding.env, CHAT_PUSH: queue };
		});
		vi.setSystemTime(new Date("2030-10-22T15:55:00Z"));
		await runDurableObjectAlarm(calendar(ada.id));
		expect(jobs).toEqual([]);
		vi.setSystemTime(new Date("2030-10-22T15:56:00Z"));
		await drain(ada.id);
		expect(await reminders(ada)).toEqual(["2030-10-22T16:00:00.000Z"]);
		expect(jobs).toEqual([
			expect.objectContaining({ kind: "calendar_reminder", eventId: event.id, principalId: ada.id, minutes: 5 }),
		]);

		const posts: Request[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const req = new Request(input, init);
			const url = new URL(req.url);
			if (url.hostname === "cloudflare-dns.com") {
				return Response.json({
					Status: 0,
					Answer: url.searchParams.get("type") === "1" ? [{ type: 1, data: "8.8.8.8" }] : [],
				});
			}
			posts.push(req);
			return new Response(null, { status: 201 });
		});
		const batch = createMessageBatch(
			CHAT_PUSH_QUEUE,
			jobs.map((body, index) => ({ id: String(index), timestamp: new Date(), attempts: 1, body })),
		);
		const context = createExecutionContext();
		await worker.queue(batch, env);
		expect((await getQueueResult(batch, context)).explicitAcks).toHaveLength(1);
		expect(posts.map((post) => post.url)).toEqual(["https://push.example.com/ada"]);

		// After the start, a late job sends nothing.
		vi.setSystemTime(new Date("2030-10-22T16:00:00Z"));
		const late = createMessageBatch(CHAT_PUSH_QUEUE, [
			{ id: "late", timestamp: new Date(), attempts: 1, body: jobs[0] },
		]);
		await worker.queue(late, env);
		expect(posts).toHaveLength(1);
	});
});
