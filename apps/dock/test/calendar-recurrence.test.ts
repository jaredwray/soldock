import {
	createExecutionContext,
	createMessageBatch,
	getQueueResult,
	runDurableObjectAlarm,
	runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { CALENDAR_LIMITS, type CalendarEvent, EVENTS_SOCKET_PATH, type InputOf } from "@asterra/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_PUSH_QUEUE } from "../src/chat/push.ts";
import worker from "../src/index.ts";
import { type Actor, api, bearer, codeOf, readSocket, request, seedOrg } from "./helpers.ts";

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

		// Ada shares her availability with the owner: free/busy needs a grant.
		await ada.call("calendar.set_grant", { principal_id: owner.id, access: "free_busy" });
		const { calendars } = await owner.call("calendar.query_free_busy", {
			principal_ids: `${owner.id},${ada.id}`,
			time_min: RANGE.time_min,
			time_max: RANGE.time_max,
		});
		const busy = expected.map((start) => ({ start, end: new Date(Date.parse(start) + 3_600_000).toISOString() }));
		expect(calendars).toEqual([
			{ principal_id: owner.id, availability: "known", busy },
			{ principal_id: ada.id, availability: "known", busy },
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

		await ada.call("calendar.set_grant", { principal_id: owner.id, access: "free_busy" });
		const { calendars } = await owner.call("calendar.query_free_busy", {
			principal_ids: ada.id,
			time_min: "2030-12-01T00:00:00Z",
			time_max: "2030-12-05T00:00:00Z",
		});
		expect(calendars[0]).toEqual({ principal_id: ada.id, availability: "known", busy: [] });

		await at("2030-12-03T16:50:00Z", owner.id, ada.id);
		expect(await reminders(owner)).toContain("2030-12-03T17:00:00.000Z");
		expect(await reminders(ada)).not.toContain("2030-12-03T17:00:00.000Z");
	});

	it("reminds an attendee of an occurrence that the attendee accepted in a series that the attendee declined", async () => {
		const { series } = await setUp();
		const { events } = await ada.call("calendar.list_events", RANGE);
		const december = events[2];
		if (!december?.occurrence_id) throw new Error("No occurrence on 2030-12-03.");
		await ada.call("calendar.respond_to_event", { event_id: series.id, response: "declined" });
		await ada.call("calendar.respond_to_event", {
			event_id: series.id,
			occurrence_id: december.occurrence_id,
			response: "accepted",
		});
		await at("2030-10-22T15:50:00Z", owner.id, ada.id);
		await at("2030-11-05T18:50:00Z", owner.id, ada.id);
		expect(await reminders(ada)).toEqual([]);
		await at("2030-12-03T16:50:00Z", owner.id, ada.id);
		expect(await reminders(ada)).toEqual(["2030-12-03T17:00:00.000Z"]);
	});

	it("asks each attendee again for an occurrence that the organizer moves", async () => {
		const { event: series } = await owner.call("calendar.create_event", { ...meeting, attendee_ids: [ada.id] });
		await drain(owner.id, ada.id);
		const first = (await ada.call("calendar.list_events", RANGE)).events[0]?.occurrence_id;
		if (!first) throw new Error("The series has no occurrences.");
		await ada.call("calendar.respond_to_event", { event_id: series.id, occurrence_id: first, response: "declined" });
		await drain(ada.id, owner.id);
		const responses = async () => [
			(await owner.call("calendar.list_events", RANGE)).events.slice(0, 2).map((e) => e.attendees[0]?.response),
			(await ada.call("calendar.list_events", RANGE)).events.slice(0, 2).map((e) => e.my_response),
		];
		expect(await responses()).toEqual([
			["declined", "needs_action"],
			["declined", "needs_action"],
		]);
		// Ada accepts the series. Her response to the first occurrence stays, then the organizer moves it.
		await ada.call("calendar.respond_to_event", { event_id: series.id, response: "accepted" });
		await ada.call("calendar.respond_to_event", { event_id: series.id, occurrence_id: first, response: "declined" });
		await drain(ada.id, owner.id);
		await owner.call("calendar.update_occurrence", {
			occurrence_id: first,
			when: { kind: "timed", start: "2030-10-22T11:00:00-07:00", end: "2030-10-22T12:00:00-07:00", time_zone: LA },
		});
		await drain(owner.id, ada.id);
		expect(await responses()).toEqual([
			["needs_action", "accepted"],
			["needs_action", "accepted"],
		]);
		await ada.call("calendar.set_grant", { principal_id: owner.id, access: "free_busy" });
		const { calendars } = await owner.call("calendar.query_free_busy", {
			principal_ids: ada.id,
			time_min: "2030-10-22T00:00:00Z",
			time_max: "2030-10-23T00:00:00Z",
		});
		expect(calendars[0]?.availability).toBe("known");
		expect(calendars[0]?.busy).toEqual([{ start: "2030-10-22T18:00:00.000Z", end: "2030-10-22T19:00:00.000Z" }]);
		await at("2030-10-22T17:50:00Z", owner.id, ada.id);
		expect(await reminders(ada)).toEqual(["2030-10-22T18:00:00.000Z"]);
		// A change of the title of the moved occurrence does not ask again.
		await ada.call("calendar.respond_to_event", { event_id: series.id, occurrence_id: first, response: "accepted" });
		await owner.call("calendar.update_occurrence", { occurrence_id: first, title: "Team sync, late" });
		await drain(ada.id, owner.id, ada.id);
		expect((await responses()).map((side) => side[0])).toEqual(["accepted", "accepted"]);
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

describe("a moved occurrence outside the bounds of its series", () => {
	const busyOf = async (time_min: string, time_max: string) =>
		(await owner.call("calendar.query_free_busy", { principal_ids: owner.id, time_min, time_max })).calendars[0]?.busy;

	it("lists an occurrence that moved to a time before the first start of the series, and gives it as busy", async () => {
		await owner.call("calendar.create_event", meeting);
		const { events } = await owner.call("calendar.list_events", RANGE);
		const first = events[0]?.occurrence_id;
		if (!first) throw new Error("The series has no occurrences.");
		// The series starts on Tuesday 2030-10-22. Its first occurrence moves to Monday.
		await owner.call("calendar.update_occurrence", {
			occurrence_id: first,
			when: { kind: "timed", start: "2030-10-21T11:00:00-07:00", end: "2030-10-21T12:00:00-07:00", time_zone: LA },
		});
		const monday = { time_min: "2030-10-21T07:00:00Z", time_max: "2030-10-22T07:00:00Z" };
		const listed = await owner.call("calendar.list_events", { ...monday, time_zone: LA });
		expect(listed.events.map((event) => [event.occurrence_id, event.when])).toEqual([
			[first, { kind: "timed", start: "2030-10-21T18:00:00.000Z", end: "2030-10-21T19:00:00.000Z", time_zone: LA }],
		]);
		expect(await busyOf(monday.time_min, monday.time_max)).toEqual([
			{ start: "2030-10-21T18:00:00.000Z", end: "2030-10-21T19:00:00.000Z" },
		]);
	});

	it("lists an occurrence that moved to a time after the end of the series, and gives it as busy", async () => {
		await owner.call("calendar.create_event", {
			...meeting,
			recurrence: { frequency: "daily", interval: 1, count: 3 },
		});
		const { events } = await owner.call("calendar.list_events", RANGE);
		const last = events[2]?.occurrence_id;
		if (!last) throw new Error("The series has no third occurrence.");
		// The last occurrence is on 2030-10-24. It moves to 2030-10-28.
		await owner.call("calendar.update_occurrence", {
			occurrence_id: last,
			when: { kind: "timed", start: "2030-10-28T09:00:00-07:00", end: "2030-10-28T10:00:00-07:00", time_zone: LA },
		});
		const later = { time_min: "2030-10-27T07:00:00Z", time_max: "2030-10-29T07:00:00Z" };
		const listed = await owner.call("calendar.list_events", { ...later, time_zone: LA });
		expect(listed.events.map((event) => event.occurrence_id)).toEqual([last]);
		expect(await busyOf(later.time_min, later.time_max)).toEqual([
			{ start: "2030-10-28T16:00:00.000Z", end: "2030-10-28T17:00:00.000Z" },
		]);
		// A cancelled override in a range adds nothing.
		await owner.call("calendar.cancel_occurrence", { occurrence_id: last });
		expect((await owner.call("calendar.list_events", { ...later, time_zone: LA })).events).toEqual([]);
	});

	it("lists an all-day occurrence that moved to a day after the end of the series", async () => {
		await owner.call("calendar.create_event", {
			title: "Office day",
			when: { kind: "all_day", start_date: "2030-10-22", end_date: "2030-10-23" },
			recurrence: { frequency: "weekly", interval: 1, count: 2 },
		});
		const { events } = await owner.call("calendar.list_events", RANGE);
		const last = events[1]?.occurrence_id;
		if (!last) throw new Error("The series has no second occurrence.");
		// The last occurrence is on 2030-10-29. It moves to 2030-11-12.
		await owner.call("calendar.update_occurrence", {
			occurrence_id: last,
			when: { kind: "all_day", start_date: "2030-11-12", end_date: "2030-11-13" },
		});
		const listed = await owner.call("calendar.list_events", {
			time_min: "2030-11-12T08:00:00Z",
			time_max: "2030-11-13T08:00:00Z",
			time_zone: LA,
		});
		expect(listed.events.map((event) => [event.occurrence_id, event.when])).toEqual([
			[last, { kind: "all_day", start_date: "2030-11-12", end_date: "2030-11-13" }],
		]);
	});
});

describe("a reminder that waits for a retry", () => {
	/** Makes the first delivery of a reminder of a calendar fail, as a PrincipalDO that is not reachable does. */
	async function failFirstDelivery(principalId: string): Promise<void> {
		await runInDurableObject(calendar(principalId), (instance) => {
			const binding = instance as unknown as { env: Env };
			const real = binding.env;
			// Only the first reminder fails. The hint of the change feed goes to the real object.
			let calls = 0;
			const PRINCIPAL = {
				idFromName: (name: string) => real.PRINCIPAL.idFromName(name),
				get: (id: DurableObjectId) => {
					const stub = real.PRINCIPAL.get(id);
					return {
						calendarChanged: (calendarId: string) => stub.calendarChanged(calendarId),
						recordCalendarReminder: async (...args: Parameters<typeof stub.recordCalendarReminder>) => {
							calls += 1;
							if (calls === 1) throw new Error("The PrincipalDO is not available.");
							return stub.recordCalendarReminder(...args);
						},
					};
				},
			} as unknown as Env["PRINCIPAL"];
			binding.env = { ...real, PRINCIPAL };
		});
	}

	const pending = (principalId: string) =>
		runInDurableObject(
			calendar(principalId),
			(_instance, state) =>
				state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'reminder'").one().n,
		);

	it("drops the reminder when the occurrence is cancelled before the retry", async () => {
		await owner.call("calendar.create_event", meeting);
		const { events } = await owner.call("calendar.list_events", RANGE);
		const first = events[0]?.occurrence_id;
		if (!first) throw new Error("The series has no occurrences.");
		await failFirstDelivery(owner.id);
		vi.setSystemTime(new Date("2030-10-22T15:50:00Z"));
		await runDurableObjectAlarm(calendar(owner.id));
		expect(await pending(owner.id)).toBe(1);
		await owner.call("calendar.cancel_occurrence", { occurrence_id: first });
		await at("2030-10-22T15:52:00Z", owner.id);
		expect(await pending(owner.id)).toBe(0);
		expect(await reminders(owner)).toEqual([]);
	});

	it("keeps the reminders of a series with more cancelled occurrences than one range can show", async () => {
		const { event } = await owner.call("calendar.create_event", {
			...meeting,
			recurrence: { frequency: "daily", interval: 1 },
		});
		// The first 401 occurrences are cancelled. The rows go in directly: 401 calls are slow.
		await runInDurableObject(calendar(owner.id), (_instance, state) => {
			const first = Date.parse("2030-10-22T16:00:00Z");
			for (let day = 0; day < 401; day++) {
				// 09:00 in Los Angeles is 16:00 UTC before 2030-11-03, and 17:00 UTC after it until 2031-03-09.
				const local = new Date(first + day * 86_400_000).toISOString().slice(0, 10);
				const hour = local < "2030-11-03" || local >= "2031-03-09" ? (local >= "2031-11-02" ? 17 : 16) : 17;
				const at = Date.parse(`${local}T${hour}:00:00Z`);
				const key = `${new Date(at).toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
				state.storage.sql.exec(
					"INSERT INTO event_overrides (event_id, occ_key, original_at, cancelled) VALUES (?, ?, ?, 1)",
					event.id,
					key,
					at,
				);
			}
		});
		// A change of the reminder computes the next reminder again.
		await owner.call("calendar.set_reminder", { event_id: event.id, minutes: 30 });
		const next = await runInDurableObject(calendar(owner.id), (_instance, state) =>
			state.storage.sql.exec<{ start_at: number }>("SELECT start_at FROM reminders").toArray(),
		);
		expect(next.map((row) => new Date(row.start_at).toISOString())).toEqual(["2031-11-27T17:00:00.000Z"]);
	});

	it("keeps the reminder of an attendee after more declined occurrences than a count series can have", async () => {
		const { event } = await owner.call("calendar.create_event", {
			...meeting,
			recurrence: { frequency: "daily", interval: 1 },
			attendee_ids: [ada.id],
		});
		await drain(owner.id, ada.id);
		// Ada declines the first 800 occurrences. The rows go in directly: 800 calls are slow.
		const declinedUntil = await runInDurableObject(calendar(ada.id), (_instance, state) => {
			let last = 0;
			for (let day = 0; day < 800; day++) {
				const local = new Date(Date.parse("2030-10-22T12:00:00Z") + day * 86_400_000).toISOString().slice(0, 10);
				// 09:00 in Los Angeles, with the offset of the day.
				const offset = new Intl.DateTimeFormat("en-US", { timeZone: LA, timeZoneName: "shortOffset" })
					.formatToParts(new Date(`${local}T12:00:00Z`))
					.find((part) => part.type === "timeZoneName")?.value;
				const at = Date.parse(`${local}T09:00:00${offset === "GMT-7" ? "-07:00" : "-08:00"}`);
				last = at;
				state.storage.sql.exec(
					"INSERT INTO occurrence_responses (event_id, occ_key, principal_id, response, responded_at) VALUES (?, ?, ?, 'declined', 1)",
					event.id,
					`${new Date(at).toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`,
					ada.id,
				);
			}
			return last;
		});
		// A change of the own reminder computes the next reminder again.
		await ada.call("calendar.set_reminder", { event_id: event.id, minutes: 30 });
		const next = await runInDurableObject(calendar(ada.id), (_instance, state) =>
			state.storage.sql.exec<{ start_at: number }>("SELECT start_at FROM reminders").toArray(),
		);
		expect(next).toHaveLength(1);
		expect(next[0]?.start_at).toBe(declinedUntil + 86_400_000);
	});

	it("reminds an attendee who declined the series of a far occurrence that the attendee accepted", async () => {
		const { event } = await owner.call("calendar.create_event", {
			...meeting,
			recurrence: { frequency: "daily", interval: 1 },
			attendee_ids: [ada.id],
		});
		await drain(owner.id, ada.id);
		await ada.call("calendar.respond_to_event", { event_id: event.id, response: "declined" });
		// An occurrence two years later.
		const far = `${event.id}_20321022T160000Z`;
		await ada.call("calendar.respond_to_event", { event_id: event.id, occurrence_id: far, response: "accepted" });
		const next = await runInDurableObject(calendar(ada.id), (_instance, state) =>
			state.storage.sql.exec<{ occ_key: string }>("SELECT occ_key FROM reminders").toArray(),
		);
		expect(next).toEqual([{ occ_key: "20321022T160000Z" }]);
	});
});

describe("invitations and access", () => {
	it("lets an agent repeat its own events, but not invite", async () => {
		const { event } = await bot.call("calendar.create_event", meeting);
		expect(event.recurrence).toMatchObject({ frequency: "weekly", interval: 2 });
		expect(await codeOf(bot.call("calendar.create_event", { ...meeting, attendee_ids: [ada.id] }))).toBe("forbidden");
		expect(await codeOf(owner.call("calendar.create_event", { ...meeting, attendee_ids: [bot.id] }))).toBe("invalid");
	});

	it("gives only busy times in free/busy, without titles, and only with a grant", async () => {
		await owner.call("calendar.create_event", { ...meeting, title: "Secret plan" });
		const query = {
			principal_ids: owner.id,
			time_min: "2030-10-20T00:00:00Z",
			time_max: "2030-10-30T00:00:00Z",
		};
		// Without a grant of the owner, the calendar is unknown: never free.
		expect((await bot.call("calendar.query_free_busy", query)).calendars).toEqual([
			{ principal_id: owner.id, availability: "unknown", busy: [] },
		]);
		await owner.call("calendar.set_grant", { principal_id: bot.id, access: "free_busy" });
		const result = await bot.call("calendar.query_free_busy", query);
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

	it("changes nothing and returns nothing for a call with the id of a different owner", async () => {
		const { series } = await setUp();
		const week = [Date.parse("2030-10-20T00:00:00Z"), Date.parse("2030-10-27T00:00:00Z")] as const;
		// The calendar of Ada, opened for the owner of the organization.
		const wrong = calendar(ada.id);
		const query = {
			min: week[0],
			max: week[1],
			minDate: "2030-10-20",
			maxDate: "2030-10-27",
			lowerBound: 0,
			zone: "UTC",
		};
		expect(await wrong.freeBusy({ ownerId: ada.id, actorId: ada.id }, query)).toMatchObject({ busy: [{}] });
		expect(await wrong.freeBusy({ ownerId: owner.id, actorId: owner.id }, query)).toEqual({ unknown: true });
		const before = await starts(ada);
		await wrong.applySnapshot(owner.id, { v: 1, event_id: series.id, sequence: 1_000, deleted: true });
		expect(await starts(ada)).toEqual(before);
		// The calendar of the organizer, opened for Ada: her response does not go in.
		await calendar(owner.id).applyResponse(ada.id, {
			event_id: series.id,
			attendee_id: ada.id,
			key: "",
			response: "accepted",
			at: Date.now() + 60_000,
		});
		await drain(owner.id, ada.id);
		const { event } = await owner.call("calendar.get_event", { event_id: series.id });
		expect(event.attendees.map((attendee) => attendee.response)).toEqual(["needs_action"]);
	});

	it("resets the response of an attendee on both sides when the time changes, also for a response on its way", async () => {
		const { series } = await setUp();
		const responses = async () => [
			(await owner.call("calendar.get_event", { event_id: series.id })).event.attendees[0]?.response,
			(await ada.call("calendar.get_event", { event_id: series.id })).event.my_response,
		];
		await ada.call("calendar.respond_to_event", { event_id: series.id, response: "accepted" });
		await drain(ada.id, owner.id);
		expect(await responses()).toEqual(["accepted", "accepted"]);
		// Ada declines. Before the organizer gets the response, the organizer changes the time.
		await ada.call("calendar.respond_to_event", { event_id: series.id, response: "declined" });
		await owner.call("calendar.update_event", {
			event_id: series.id,
			when: { kind: "timed", start: "2030-10-22T10:00:00-07:00", end: "2030-10-22T11:00:00-07:00", time_zone: LA },
		});
		await drain(owner.id, ada.id);
		expect(await responses()).toEqual(["needs_action", "needs_action"]);
		// A response after the reset stays when a later state of the organizer comes.
		await ada.call("calendar.respond_to_event", { event_id: series.id, response: "accepted" });
		await owner.call("calendar.update_event", { event_id: series.id, title: "Team sync, new room" });
		await drain(owner.id, ada.id);
		expect(await responses()).toEqual(["accepted", "accepted"]);
	});

	it("does not store a new invitation over a limit of the calendar of the attendee, and updates a copy that exists", async () => {
		const { event: kept } = await owner.call("calendar.create_event", { ...meeting, attendee_ids: [ada.id] });
		await drain(owner.id, ada.id);
		const setCount = (value: number) =>
			runInDurableObject(calendar(ada.id), (_instance, state) => {
				state.storage.sql.exec("UPDATE meta SET value = ? WHERE key = 'event_count'", String(value));
			});
		await setCount(CALENDAR_LIMITS.events);
		const lunch: InputOf<"calendar.create_event"> = { ...meeting, title: "Lunch", recurrence: undefined };
		await owner.call("calendar.create_event", { ...lunch, attendee_ids: [ada.id] });
		await owner.call("calendar.update_event", { event_id: kept.id, title: "Team sync, room 4" });
		await drain(owner.id, ada.id);
		const titles = async () =>
			[...new Set((await ada.call("calendar.list_events", RANGE)).events.map((e) => e.title))].sort();
		expect(await titles()).toEqual(["Team sync, room 4"]);

		// The limit of series: a new series is not stored, a new one-off event is.
		await setCount(1);
		await runInDurableObject(calendar(ada.id), (_instance, state) => {
			state.storage.sql.exec(
				`WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
				INSERT INTO events (id, title, description, location, all_day, start_at, end_at, time_zone, revision,
					created_at, updated_at, recurrence)
				SELECT 'evt_fill_' || i, 'Fill', '', '', 0, 0, 1, 'UTC', 1, 0, 0, '{"frequency":"daily","interval":1,"until":"1970-01-01","count":null}'
				FROM n`,
				CALENDAR_LIMITS.recurringEvents - 1,
			);
		});
		await owner.call("calendar.create_event", { ...meeting, title: "Second series", attendee_ids: [ada.id] });
		await owner.call("calendar.create_event", { ...lunch, title: "Dinner", attendee_ids: [ada.id] });
		await drain(owner.id, ada.id);
		expect(await titles()).toEqual(["Dinner", "Team sync, room 4"]);
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

describe("a credential without calendar.read", () => {
	it("gets no reminder in the Activity and none on the events socket", async () => {
		await ada.call("calendar.create_event", { ...meeting, title: "Secret plan", recurrence: undefined });
		// The hint of the change feed for the new event goes out before the sockets open.
		await drain(ada.id);
		const keyOf = async (scopes: InputOf<"account.create_api_key">["scopes"]) =>
			(await ada.call("account.create_api_key", { label: "narrow", scopes })).api_key.secret;
		const chatOnly = await keyOf(["chat.read", "chat.write"]);
		const both = await keyOf(["chat.read", "calendar.read"]);
		vi.setSystemTime(new Date("2030-10-22T15:50:00Z"));
		const open = async (key: string) => {
			const reader = readSocket(
				await request(EVENTS_SOCKET_PATH, { headers: { upgrade: "websocket", ...bearer(key) } }),
			);
			await reader.next();
			return reader;
		};
		const narrow = await open(chatOnly);
		const wide = await open(both);
		await drain(ada.id);

		expect(await wide.next()).toMatchObject({ type: "calendar.reminder", title: "Secret plan", untrusted: false });
		expect(await wide.next()).toEqual({ type: "chat.activity", unread_count: 1 });
		// The count of a socket without calendar.read does not tell that a reminder came.
		expect(await narrow.next()).toEqual({ type: "chat.activity", unread_count: 0 });
		for (const filter of ["all", "calendar_reminder"] as const) {
			const full = await api(both)("chat.list_activity", { filter });
			expect(full.items.map((item) => item.kind)).toEqual(["calendar_reminder"]);
			expect(full.unread_count).toBe(1);
			const listed = await api(chatOnly)("chat.list_activity", { filter });
			expect(listed.items).toEqual([]);
			expect(listed.unread_count).toBe(0);
			expect(JSON.stringify(listed)).not.toContain("Secret");
		}
		// The item is left out, not deleted: the session of the person shows it.
		expect(await reminders(ada)).toEqual(["2030-10-22T16:00:00.000Z"]);
		// The credential cannot mark the reminder read, so it cannot stop its push.
		await api(chatOnly)("chat.mark_activity_read", {});
		expect((await api(both)("chat.list_activity", { filter: "unread" })).items.map((item) => item.kind)).toEqual([
			"calendar_reminder",
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
		// The name of a real queue has a prefix: the consumer matches the queue by its suffix.
		const batch = createMessageBatch(
			`soldock-${CHAT_PUSH_QUEUE}`,
			jobs.map((body, index) => ({ id: String(index), timestamp: new Date(), attempts: 1, body })),
		);
		const context = createExecutionContext();
		await worker.queue(batch, env);
		expect((await getQueueResult(batch, context)).explicitAcks).toHaveLength(1);
		expect(posts.map((post) => post.url)).toEqual(["https://push.example.com/ada"]);

		// After the start, a late job sends nothing.
		vi.setSystemTime(new Date("2030-10-22T16:00:00Z"));
		const late = createMessageBatch(`soldock-${CHAT_PUSH_QUEUE}`, [
			{ id: "late", timestamp: new Date(), attempts: 1, body: jobs[0] },
		]);
		await worker.queue(late, env);
		expect(posts).toHaveLength(1);
	});
});
