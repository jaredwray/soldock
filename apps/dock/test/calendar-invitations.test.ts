import { runInDurableObject } from "cloudflare:test";
import { CALENDAR_LIMITS, type CalendarEvent, type InputOf } from "@asterra/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingMessage, ReplyMessage } from "../src/calendar/calendar.ts";
import {
	type Actor,
	api,
	breakCalendarDelivery,
	calendarOutbox,
	calendarStub,
	callTool,
	codeOf,
	createActor,
	PASSWORD,
	restartLegacyCalendar,
	seedOrg,
	settleCalendars,
} from "./helpers.ts";

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

const RANGE = { time_min: "2026-12-01T00:00:00Z", time_max: "2026-12-08T00:00:00Z" } as const;

const meeting = (attendees: InputOf<"calendar.create_event">["attendees"]): InputOf<"calendar.create_event"> => ({
	title: "Design review",
	when: { kind: "timed", start: "2026-12-02T15:00:00Z", end: "2026-12-02T16:00:00Z", time_zone: "UTC" },
	location: "Room 4",
	description: "Bring the drafts.",
	attendees,
});

const laterTime = {
	kind: "timed",
	start: "2026-12-03T17:00:00Z",
	end: "2026-12-03T18:00:00Z",
	time_zone: "UTC",
} as const;

/** The events of an actor in the test week. */
async function eventsOf(actor: Actor): Promise<CalendarEvent[]> {
	return (await actor.call("calendar.list_events", RANGE)).events;
}

/** The one event of an actor with a uid, or undefined. Fails when the calendar has two. */
async function copyOf(actor: Actor, uid: string): Promise<CalendarEvent | undefined> {
	const found = (await eventsOf(actor)).filter((event) => event.uid === uid);
	expect(found.length).toBeLessThanOrEqual(1);
	return found[0];
}

/** The response of each attendee of an event of the organizer, by address. */
async function responses(organizer: Actor, eventId: string): Promise<Record<string, string>> {
	const { event } = await organizer.call("calendar.get_event", { event_id: eventId });
	return Object.fromEntries(event.attendees.map((attendee) => [attendee.email, attendee.response]));
}

/** The audit lines that the Worker wrote while `run` ran. */
async function auditLines(run: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
	const spy = vi.spyOn(console, "log");
	try {
		await run();
		return spy.mock.calls
			.map(([line]) => (typeof line === "string" && line.startsWith("{") ? JSON.parse(line) : null))
			.filter((line): line is Record<string, unknown> => line?.audit === true);
	} finally {
		spy.mockRestore();
	}
}

describe("invitations between principals", () => {
	it("puts one copy on each calendar, and the organizer sees each answer", async () => {
		const { event } = await ada.call(
			"calendar.create_event",
			meeting([{ principal_id: owner.id }, { email: "BOT@dock.test" }]),
		);
		expect(event).toMatchObject({
			uid: event.id,
			is_organizer: true,
			my_response: null,
			organizer: { principal_id: ada.id, email: "ada@dock.test", name: "Ada Lovelace", self: true },
			attendees: [
				{ principal_id: owner.id, email: "owner@dock.test", response: "pending", responded_at: null, self: false },
				{ principal_id: bot.id, email: "bot@dock.test", response: "pending", responded_at: null, self: false },
			],
		});
		await settleCalendars(ada.id, owner.id, bot.id);

		const copy = await copyOf(owner, event.uid);
		expect(copy).toMatchObject({
			title: "Design review",
			location: "Room 4",
			description: "Bring the drafts.",
			when: event.when,
			is_organizer: false,
			my_response: "pending",
			organizer: { principal_id: ada.id, email: "ada@dock.test", name: "Ada Lovelace", self: false },
		});
		expect(copy?.id).not.toBe(event.id);
		expect(copy?.attendees.find((attendee) => attendee.self)?.email).toBe("owner@dock.test");

		const answered = await owner.call("calendar.respond_to_invitation", {
			event_id: copy?.id as string,
			response: "accepted",
		});
		expect(answered.event.my_response).toBe("accepted");
		// The output has the answer and its time at once, before the next snapshot of the organizer comes back.
		const own = answered.event.attendees.find((attendee) => attendee.self);
		expect(own?.response).toBe("accepted");
		expect(own?.responded_at).not.toBeNull();
		await settleCalendars(owner.id, ada.id, bot.id);

		const { event: seen } = await ada.call("calendar.get_event", { event_id: event.id });
		expect(seen.attendees[0]).toMatchObject({ principal_id: owner.id, response: "accepted" });
		expect(seen.attendees[0]?.responded_at).not.toBeNull();
		// An answer does not change the revision of the organizer.
		expect(seen.revision).toBe(event.revision);
		// The other attendee sees the answer too.
		const botCopy = await copyOf(bot, event.uid);
		expect(botCopy?.attendees.find((attendee) => attendee.principal_id === owner.id)?.response).toBe("accepted");
		expect(botCopy?.my_response).toBe("pending");
	});

	it("moves the meeting on each calendar and keeps the answers", async () => {
		const { event } = await ada.call("calendar.create_event", meeting([{ principal_id: owner.id }]));
		await settleCalendars(ada.id, owner.id);
		const copy = (await copyOf(owner, event.uid)) as CalendarEvent;
		await owner.call("calendar.respond_to_invitation", { event_id: copy.id, response: "tentative" });
		await settleCalendars(owner.id, ada.id);

		const moved = await ada.call("calendar.update_event", {
			event_id: event.id,
			when: laterTime,
			base_revision: event.revision,
		});
		expect(moved.event.revision).toBe(event.revision + 1);
		await settleCalendars(ada.id, owner.id);

		for (const actor of [ada, owner]) {
			const found = (await eventsOf(actor)).filter((item) => item.uid === event.uid);
			expect(found).toHaveLength(1);
			expect(found[0]?.when).toEqual({
				kind: "timed",
				start: "2026-12-03T17:00:00.000Z",
				end: "2026-12-03T18:00:00.000Z",
				time_zone: "UTC",
			});
		}
		expect((await copyOf(owner, event.uid))?.id).toBe(copy.id);
		expect((await copyOf(owner, event.uid))?.my_response).toBe("tentative");
		expect(await responses(ada, event.id)).toEqual({ "owner@dock.test": "tentative" });
	});

	it("adds and removes attendees, and a removed attendee gets no later change", async () => {
		const { event } = await ada.call("calendar.create_event", meeting([{ principal_id: owner.id }]));
		await settleCalendars(ada.id, owner.id);
		const copy = (await copyOf(owner, event.uid)) as CalendarEvent;

		const changed = await ada.call("calendar.update_event", {
			event_id: event.id,
			attendees: [{ principal_id: grace.id }],
		});
		expect(changed.event.attendees.map((attendee) => attendee.email)).toEqual(["grace@dock.test"]);
		await settleCalendars(ada.id, owner.id, grace.id);

		expect(await copyOf(owner, event.uid)).toBeUndefined();
		expect(await codeOf(owner.call("calendar.get_event", { event_id: copy.id }))).toBe("not_found");
		expect(
			await codeOf(owner.call("calendar.respond_to_invitation", { event_id: copy.id, response: "accepted" })),
		).toBe("not_found");
		expect((await copyOf(grace, event.uid))?.my_response).toBe("pending");

		await ada.call("calendar.update_event", { event_id: event.id, title: "Design review, part 2" });
		expect((await calendarOutbox(ada.id)).map((row) => row.target)).not.toContain(owner.id);
		await settleCalendars(ada.id, owner.id, grace.id);
		expect(await eventsOf(owner)).toEqual([]);
		expect((await copyOf(grace, event.uid))?.title).toBe("Design review, part 2");

		// An empty list removes each attendee. The event stays on the calendar of the organizer.
		const alone = await ada.call("calendar.update_event", { event_id: event.id, attendees: [] });
		expect(alone.event).toMatchObject({ attendees: [], organizer: null, is_organizer: true });
		await settleCalendars(ada.id, grace.id);
		expect(await eventsOf(grace)).toEqual([]);
	});

	it("cancels the meeting on each calendar when the organizer deletes it", async () => {
		const { event } = await ada.call(
			"calendar.create_event",
			meeting([{ principal_id: owner.id }, { principal_id: grace.id }]),
		);
		await settleCalendars(ada.id, owner.id, grace.id);
		const copy = (await copyOf(owner, event.uid)) as CalendarEvent;
		await owner.call("calendar.respond_to_invitation", { event_id: copy.id, response: "accepted" });
		await settleCalendars(owner.id, ada.id, grace.id);

		const dry = await ada.call("calendar.delete_event", { event_id: event.id, dry_run: true });
		expect(dry.dry_run).toBe(true);
		expect(await calendarOutbox(ada.id)).toEqual([]);

		await ada.call("calendar.delete_event", { event_id: event.id });
		await settleCalendars(ada.id, owner.id, grace.id);
		for (const actor of [ada, owner, grace]) expect(await eventsOf(actor)).toEqual([]);
		expect(await codeOf(owner.call("calendar.get_event", { event_id: copy.id }))).toBe("not_found");
	});
});

describe("the access to a meeting", () => {
	it("lets an attendee change only their own answer", async () => {
		const { event } = await ada.call(
			"calendar.create_event",
			meeting([{ principal_id: owner.id }, { principal_id: grace.id }]),
		);
		await settleCalendars(ada.id, owner.id, grace.id);
		const copy = (await copyOf(owner, event.uid)) as CalendarEvent;
		const graceCopy = (await copyOf(grace, event.uid)) as CalendarEvent;

		expect(await codeOf(owner.call("calendar.update_event", { event_id: copy.id, title: "Mine now" }))).toBe(
			"forbidden",
		);
		expect(await codeOf(owner.call("calendar.update_event", { event_id: copy.id, attendees: [] }))).toBe("forbidden");
		expect(await codeOf(owner.call("calendar.delete_event", { event_id: copy.id }))).toBe("forbidden");
		// The id of the organizer and the id of a different attendee are not on the calendar of the attendee.
		for (const id of [event.id, graceCopy.id]) {
			expect(await codeOf(owner.call("calendar.get_event", { event_id: id }))).toBe("not_found");
			expect(await codeOf(owner.call("calendar.update_event", { event_id: id, title: "x" }))).toBe("not_found");
			expect(await codeOf(owner.call("calendar.delete_event", { event_id: id }))).toBe("not_found");
			expect(await codeOf(owner.call("calendar.respond_to_invitation", { event_id: id, response: "declined" }))).toBe(
				"not_found",
			);
		}
		await settleCalendars(ada.id, owner.id, grace.id);
		expect((await ada.call("calendar.get_event", { event_id: event.id })).event).toMatchObject({
			title: "Design review",
			revision: event.revision,
		});
		expect(await responses(ada, event.id)).toEqual({ "owner@dock.test": "pending", "grace@dock.test": "pending" });
		expect(await copyOf(owner, event.uid)).toMatchObject({ title: "Design review", revision: copy.revision });

		// The organizer does not answer their own event.
		expect(await codeOf(ada.call("calendar.respond_to_invitation", { event_id: event.id, response: "accepted" }))).toBe(
			"invalid",
		);
	});

	it("shows a meeting to nobody but its organizer and its attendees", async () => {
		const { event } = await ada.call("calendar.create_event", meeting([{ principal_id: owner.id }]));
		const { event: privateEvent } = await ada.call("calendar.create_event", {
			...meeting(undefined),
			title: "Dentist",
		});
		const { event: ownerPrivate } = await owner.call("calendar.create_event", { ...meeting(undefined), title: "Gym" });
		await settleCalendars(ada.id, owner.id);
		const copy = (await copyOf(owner, event.uid)) as CalendarEvent;

		// An unrelated member, the sponsor of an agent and an owner of the organization see nothing of a different
		// calendar.
		for (const id of [event.id, copy.id, privateEvent.id, ownerPrivate.id]) {
			expect(await codeOf(grace.call("calendar.get_event", { event_id: id }))).toBe("not_found");
		}
		expect(await eventsOf(grace)).toEqual([]);
		expect(await codeOf(owner.call("calendar.get_event", { event_id: privateEvent.id }))).toBe("not_found");
		expect((await eventsOf(owner)).map((item) => item.title).sort()).toEqual(["Design review", "Gym"]);
		expect((await eventsOf(ada)).map((item) => item.title).sort()).toEqual(["Dentist", "Design review"]);
	});

	it("needs calendar.write to answer, and no directory scope to invite", async () => {
		const { event } = await ada.call("calendar.create_event", meeting([{ principal_id: owner.id }]));
		await settleCalendars(ada.id, owner.id);
		const copy = (await copyOf(owner, event.uid)) as CalendarEvent;
		const readOnly = api(
			(await owner.call("account.create_api_key", { label: "read", scopes: ["calendar.read"] })).api_key.secret,
		);
		expect(await codeOf(readOnly("calendar.respond_to_invitation", { event_id: copy.id, response: "accepted" }))).toBe(
			"forbidden",
		);
		const writeOnly = api(
			(await ada.call("account.create_api_key", { label: "write", scopes: ["calendar.write"] })).api_key.secret,
		);
		const { event: second } = await writeOnly(
			"calendar.create_event",
			meeting([{ principal_id: grace.id }, { email: "owner@dock.test" }]),
		);
		expect(second.attendees.map((attendee) => attendee.email)).toEqual(["grace@dock.test", "owner@dock.test"]);
	});

	it("lets agents and service accounts invite and answer", async () => {
		const { principal: service } = await owner.call("directory.create_service_account", {
			display_name: "CI Pipeline",
			address: "ci@dock.test",
			description: "Books rooms",
			sponsor_id: ada.id,
		});
		const ci = api(
			(await owner.call("account.create_api_key", { principal_id: service.id, label: "ci" })).api_key.secret,
		);
		const { event } = await bot.call(
			"calendar.create_event",
			meeting([{ principal_id: service.id }, { principal_id: ada.id }]),
		);
		await settleCalendars(bot.id, service.id, ada.id);
		const copy = (await ci("calendar.list_events", RANGE)).events.find((item) => item.uid === event.uid);
		await ci("calendar.respond_to_invitation", { event_id: copy?.id as string, response: "declined" });
		await settleCalendars(service.id, bot.id, ada.id);
		expect(await responses(bot, event.id)).toEqual({ "ci@dock.test": "declined", "ada@dock.test": "pending" });
		// A declined meeting stays on the calendar of the attendee, so the attendee can change the answer.
		expect((await ci("calendar.get_event", { event_id: copy?.id as string })).event.my_response).toBe("declined");
	});

	it("refuses an unknown or archived attendee, and leaves out the organizer and a second entry", async () => {
		const unknown = "prn_01ARZ3NDEKTSV4RRFFQ69G5FAV";
		expect(await codeOf(ada.call("calendar.create_event", meeting([{ principal_id: unknown }])))).toBe("invalid");
		expect(await codeOf(ada.call("calendar.create_event", meeting([{ email: "nobody@dock.test" }])))).toBe("invalid");
		expect(await codeOf(ada.call("calendar.create_event", meeting([{ email: "someone@example.com" }])))).toBe(
			"invalid",
		);
		expect(
			await codeOf(
				ada.call("calendar.create_event", meeting([{ principal_id: owner.id, email: "owner@dock.test" }] as never)),
			),
		).toBe("invalid");
		expect(
			await codeOf(
				ada.call(
					"calendar.create_event",
					meeting(Array.from({ length: CALENDAR_LIMITS.attendees + 1 }, () => ({ principal_id: owner.id }))),
				),
			),
		).toBe("invalid");
		// A team mailbox has no calendar.
		const { team_mailbox: support } = await owner.call("directory.create_team_mailbox", {
			display_name: "Support",
			address: "support@dock.test",
		});
		expect(await codeOf(ada.call("calendar.create_event", meeting([{ email: support.address }])))).toBe("invalid");
		await owner.call("directory.archive_principal", { principal_id: grace.id });
		expect(await codeOf(ada.call("calendar.create_event", meeting([{ principal_id: grace.id }])))).toBe("invalid");
		// Nothing was added.
		expect(await eventsOf(ada)).toEqual([]);

		const { event } = await ada.call(
			"calendar.create_event",
			meeting([{ principal_id: ada.id }, { principal_id: owner.id }, { email: "owner@dock.test" }]),
		);
		expect(event.attendees.map((attendee) => attendee.principal_id)).toEqual([owner.id]);

		// An alias of a person invites that person, with the primary address.
		await owner.call("directory.add_mailbox_alias", { mailbox_id: owner.id, address: "olive@second.test" });
		const { event: byAlias } = await ada.call("calendar.create_event", meeting([{ email: "olive@second.test" }]));
		expect(byAlias.attendees.map((attendee) => [attendee.principal_id, attendee.email])).toEqual([
			[owner.id, "owner@dock.test"],
		]);
	});
});

describe("delivery between calendars", () => {
	it("tries a failed delivery again, and a second delivery adds nothing", async () => {
		const broken = await breakCalendarDelivery(ada.id);
		const { event } = await ada.call("calendar.create_event", meeting([{ principal_id: owner.id }]));
		await vi.waitFor(async () => expect((await calendarOutbox(ada.id))[0]?.attempts).toBe(1));
		const [row] = await calendarOutbox(ada.id);
		expect(row?.next_attempt_at).toBeGreaterThan(Date.now());
		expect(await eventsOf(owner)).toEqual([]);

		broken.fail = null;
		await settleCalendars(ada.id, owner.id);
		expect(await copyOf(owner, event.uid)).toMatchObject({ my_response: "pending" });

		// The same message again: the calendar already has its sequence.
		const again = await calendarStub(owner.id).applyMeeting(owner.id, row?.payload as MeetingMessage);
		expect(again).toEqual({ applied: false, reason: "stale" });
		expect((await eventsOf(owner)).filter((item) => item.uid === event.uid)).toHaveLength(1);
	});

	it("applies the newest state of the organizer in each order of delivery", async () => {
		const broken = await breakCalendarDelivery(ada.id);
		const payloads: MeetingMessage[] = [];
		const capture = async () => {
			const row = (await calendarOutbox(ada.id)).find((item) => item.target === owner.id);
			payloads.push(row?.payload as MeetingMessage);
		};
		const { event } = await ada.call("calendar.create_event", meeting([{ principal_id: owner.id }]));
		await capture();
		await ada.call("calendar.update_event", { event_id: event.id, when: laterTime });
		await capture();
		await ada.call("calendar.delete_event", { event_id: event.id });
		await capture();
		const [invited, moved, cancelled] = payloads as [MeetingMessage, MeetingMessage, MeetingMessage];
		expect([invited.sequence, moved.sequence, cancelled.sequence]).toEqual([0, 1, 2]);
		expect(cancelled.state).toBe("cancelled");

		// The cancellation first. The old invitation and the old change after it cannot bring the meeting back.
		const target = calendarStub(owner.id);
		expect(await target.applyMeeting(owner.id, cancelled)).toEqual({ applied: true });
		expect(await target.applyMeeting(owner.id, invited)).toEqual({ applied: false, reason: "stale" });
		expect(await target.applyMeeting(owner.id, moved)).toEqual({ applied: false, reason: "stale" });
		expect(await eventsOf(owner)).toEqual([]);

		// The queued messages arrive late too. The final state on both calendars: no meeting.
		broken.fail = null;
		await settleCalendars(ada.id, owner.id);
		expect(await eventsOf(owner)).toEqual([]);
		expect(await eventsOf(ada)).toEqual([]);
	});

	it("keeps the newer change when an older invitation arrives after it", async () => {
		const broken = await breakCalendarDelivery(ada.id);
		const { event } = await ada.call("calendar.create_event", meeting([{ principal_id: owner.id }]));
		const invited = (await calendarOutbox(ada.id))[0]?.payload as MeetingMessage;
		await ada.call("calendar.update_event", { event_id: event.id, when: laterTime, title: "Moved review" });
		const moved = (await calendarOutbox(ada.id))[0]?.payload as MeetingMessage;
		// Two quick changes leave one message for the attendee, with the newest sequence.
		expect(await calendarOutbox(ada.id)).toHaveLength(1);

		const target = calendarStub(owner.id);
		expect(await target.applyMeeting(owner.id, moved)).toEqual({ applied: true });
		expect(await target.applyMeeting(owner.id, invited)).toEqual({ applied: false, reason: "stale" });
		broken.fail = null;
		await settleCalendars(ada.id, owner.id);
		const copies = (await eventsOf(owner)).filter((item) => item.uid === event.uid);
		expect(copies).toHaveLength(1);
		expect(copies[0]).toMatchObject({ title: "Moved review", when: { start: "2026-12-03T17:00:00.000Z" } });
		expect((await ada.call("calendar.get_event", { event_id: event.id })).event.title).toBe("Moved review");
	});

	it("only lets the organizer on record change a copy", async () => {
		const { event } = await ada.call("calendar.create_event", meeting([{ principal_id: owner.id }]));
		await settleCalendars(ada.id, owner.id);
		const forged: MeetingMessage = {
			uid: event.uid,
			sequence: 99,
			state: "cancelled",
			organizer: { principal_id: grace.id, email: "grace@dock.test", name: "Grace Hopper" },
			fields: null,
			attendees: [],
		};
		expect(await calendarStub(owner.id).applyMeeting(owner.id, forged)).toEqual({
			applied: false,
			reason: "not_organizer",
		});
		// A message for the own event of a calendar changes nothing.
		expect(
			await calendarStub(ada.id).applyMeeting(ada.id, {
				...forged,
				organizer: { principal_id: owner.id, email: "", name: "" },
			}),
		).toEqual({ applied: false, reason: "not_organizer" });
		// A message for a different calendar than the object.
		expect(await calendarStub(owner.id).applyMeeting(grace.id, forged)).toEqual({
			applied: false,
			reason: "wrong_calendar",
		});
		expect(await copyOf(owner, event.uid)).toBeDefined();
		expect((await ada.call("calendar.get_event", { event_id: event.id })).event.title).toBe("Design review");
	});

	it("never lets an older answer replace a newer one", async () => {
		const { event } = await ada.call("calendar.create_event", meeting([{ principal_id: owner.id }]));
		await settleCalendars(ada.id, owner.id);
		const organizer = calendarStub(ada.id);
		const reply = (response: ReplyMessage["response"], stamp: number, sequence = 0): ReplyMessage => ({
			uid: event.uid,
			attendee_id: owner.id,
			response,
			stamp,
			sequence,
		});
		expect(await organizer.applyReply(ada.id, reply("declined", 2))).toEqual({ applied: true });
		expect(await organizer.applyReply(ada.id, reply("accepted", 1))).toEqual({ applied: false, reason: "stale" });
		expect(await organizer.applyReply(ada.id, reply("declined", 2))).toEqual({ applied: false, reason: "stale" });
		expect(await responses(ada, event.id)).toEqual({ "owner@dock.test": "declined" });
		expect(await organizer.applyReply(ada.id, { ...reply("accepted", 3), attendee_id: grace.id })).toEqual({
			applied: false,
			reason: "not_attendee",
		});

		// Remove the attendee and invite them again. An answer from before the removal changes nothing.
		await ada.call("calendar.update_event", { event_id: event.id, attendees: [] });
		await ada.call("calendar.update_event", { event_id: event.id, attendees: [{ principal_id: owner.id }] });
		expect(await organizer.applyReply(ada.id, reply("accepted", Date.now() + 1000, 0))).toEqual({
			applied: false,
			reason: "stale",
		});
		expect(await responses(ada, event.id)).toEqual({ "owner@dock.test": "pending" });
		await settleCalendars(ada.id, owner.id);
		expect((await copyOf(owner, event.uid))?.my_response).toBe("pending");
		// An answer to a meeting that the organizer cancelled changes nothing.
		await ada.call("calendar.delete_event", { event_id: event.id });
		expect(await organizer.applyReply(ada.id, reply("accepted", Date.now() + 2000, 5))).toEqual({
			applied: false,
			reason: "unknown",
		});
	});

	it("starts a new invitation with no answer when the removal did not arrive before it", async () => {
		const { event } = await ada.call("calendar.create_event", meeting([{ principal_id: owner.id }]));
		await settleCalendars(ada.id, owner.id);
		const copy = (await copyOf(owner, event.uid)) as CalendarEvent;
		await owner.call("calendar.respond_to_invitation", { event_id: copy.id, response: "accepted" });
		await settleCalendars(owner.id, ada.id);

		// The removal waits in the outbox, and the new invitation replaces it. The copy never sees the removal.
		const broken = await breakCalendarDelivery(ada.id);
		await ada.call("calendar.update_event", { event_id: event.id, attendees: [] });
		await ada.call("calendar.update_event", { event_id: event.id, attendees: [{ principal_id: owner.id }] });
		expect((await calendarOutbox(ada.id)).map((row) => (row.payload as MeetingMessage).state)).toEqual(["invited"]);
		broken.fail = null;
		await settleCalendars(ada.id, owner.id);

		// The two calendars agree: the organizer has no answer for the new invitation, and the copy shows none.
		expect(await responses(ada, event.id)).toEqual({ "owner@dock.test": "pending" });
		const again = (await copyOf(owner, event.uid)) as CalendarEvent;
		expect(again).toMatchObject({ id: copy.id, my_response: "pending" });
		expect(again.attendees.find((attendee) => attendee.self)).toMatchObject({
			response: "pending",
			responded_at: null,
		});
		// The attendee answers the new invitation, and the organizer sees the answer.
		await owner.call("calendar.respond_to_invitation", { event_id: again.id, response: "accepted" });
		await settleCalendars(owner.id, ada.id);
		expect(await responses(ada, event.id)).toEqual({ "owner@dock.test": "accepted" });
	});

	it("keeps a change that the organizer makes while a delivery runs", async () => {
		const broken = await breakCalendarDelivery(ada.id);
		broken.fail = null;
		let release = () => {};
		broken.hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { event } = await ada.call("calendar.create_event", meeting([{ principal_id: owner.id }]));
		// The alarm of the organizer waits in the call with the invitation. The organizer cancels now.
		await ada.call("calendar.delete_event", { event_id: event.id });
		const [waiting] = await calendarOutbox(ada.id);
		expect(waiting?.payload).toMatchObject({ state: "cancelled" });
		broken.hold = null;
		release();
		await settleCalendars(ada.id, owner.id);
		// The cancellation was not lost with the delivery of the invitation: no calendar has the meeting.
		expect(await eventsOf(owner)).toEqual([]);
		expect(
			await runInDurableObject(calendarStub(owner.id), (_instance, state) =>
				state.storage.sql.exec<{ state: string }>("SELECT state FROM meeting_tombstones").toArray(),
			),
		).toEqual([{ state: "cancelled" }]);
	});

	it("delivers the messages that waited after the calendar starts again with no alarm", async () => {
		const broken = await breakCalendarDelivery(ada.id);
		const { event } = await ada.call("calendar.create_event", meeting([{ principal_id: owner.id }]));
		await vi.waitFor(async () => expect((await calendarOutbox(ada.id))[0]?.attempts).toBe(1));
		broken.fail = null;
		// The object stops after the commit of a change and before its alarm is set.
		await expect(
			runInDurableObject(calendarStub(ada.id), (_instance, state) =>
				state.blockConcurrencyWhile(async () => {
					await state.storage.deleteAlarm();
					state.storage.sql.exec("UPDATE outbox SET next_attempt_at = 0");
					await state.storage.sync();
					state.abort("Restart the calendar.");
				}),
			),
		).rejects.toThrow("Restart the calendar.");
		// The next call starts the object. Its start sets the alarm, and no helper runs the alarm here.
		expect(await eventsOf(ada)).toHaveLength(1);
		await vi.waitFor(async () => expect(await copyOf(owner, event.uid)).toBeDefined(), { timeout: 5000 });
	});

	it("drops an invitation that a full calendar cannot take", async () => {
		await runInDurableObject(calendarStub(owner.id), async (_instance, state) => {
			await owner.call("calendar.list_events", RANGE);
			state.storage.sql.exec("UPDATE meta SET value = ? WHERE key = 'event_count'", String(CALENDAR_LIMITS.events));
		});
		const { event } = await ada.call("calendar.create_event", meeting([{ principal_id: owner.id }]));
		await settleCalendars(ada.id, owner.id);
		expect(await eventsOf(owner)).toEqual([]);
		expect(await responses(ada, event.id)).toEqual({ "owner@dock.test": "pending" });
	});
});

describe("revisions, idempotency and the stored calendar", () => {
	it("keeps idempotency keys and revisions as for a personal event", async () => {
		const input = { ...meeting([{ principal_id: owner.id }]), idempotency_key: "review-1" };
		const first = await ada.call("calendar.create_event", input);
		const second = await ada.call("calendar.create_event", input);
		expect(second.event.id).toBe(first.event.id);
		expect(await codeOf(ada.call("calendar.create_event", { ...input, attendees: [{ principal_id: grace.id }] }))).toBe(
			"conflict",
		);
		await settleCalendars(ada.id, owner.id, grace.id);
		expect((await eventsOf(owner)).filter((item) => item.uid === first.event.uid)).toHaveLength(1);
		expect(await eventsOf(grace)).toEqual([]);

		// An answer does not change the revision, so the edit of the organizer with the revision before it works.
		const copy = (await copyOf(owner, first.event.uid)) as CalendarEvent;
		await owner.call("calendar.respond_to_invitation", { event_id: copy.id, response: "accepted" });
		await settleCalendars(owner.id, ada.id);
		const edited = await ada.call("calendar.update_event", {
			event_id: first.event.id,
			title: "Renamed",
			base_revision: first.event.revision,
		});
		expect(edited.event.revision).toBe(first.event.revision + 1);
		await settleCalendars(ada.id, owner.id);

		// A change that changes nothing keeps the revision and sends nothing.
		const same = await ada.call("calendar.update_event", {
			event_id: first.event.id,
			title: "Renamed",
			attendees: [{ email: "owner@dock.test" }],
		});
		expect(same.event.revision).toBe(edited.event.revision);
		expect(await calendarOutbox(ada.id)).toEqual([]);

		// A repeated answer changes nothing and writes one audit line only for the first.
		const lines = await auditLines(async () => {
			await owner.call("calendar.respond_to_invitation", { event_id: copy.id, response: "declined" });
			await owner.call("calendar.respond_to_invitation", { event_id: copy.id, response: "declined" });
		});
		expect(lines.filter((line) => line.op === "calendar.respond_to_invitation")).toHaveLength(1);
	});

	it("returns the first event for a retry with the key after an attendee was archived", async () => {
		const input = { ...meeting([{ principal_id: grace.id }]), idempotency_key: "review-2" };
		const first = await ada.call("calendar.create_event", input);
		await settleCalendars(ada.id, grace.id);
		// A team mailbox has no calendar.
		const { team_mailbox: support } = await owner.call("directory.create_team_mailbox", {
			display_name: "Support",
			address: "support@dock.test",
		});
		expect(await codeOf(ada.call("calendar.create_event", meeting([{ email: support.address }])))).toBe("invalid");
		await owner.call("directory.archive_principal", { principal_id: grace.id });
		const second = await ada.call("calendar.create_event", input);
		expect(second.event.id).toBe(first.event.id);
		// The retry sends no second invitation, and adds no second event.
		expect(await calendarOutbox(ada.id)).toEqual([]);
		expect(await eventsOf(ada)).toHaveLength(1);
		// A new request with the archived attendee is refused, as before.
		expect(await codeOf(ada.call("calendar.create_event", { ...input, idempotency_key: "review-3" }))).toBe("invalid");
	});

	it("keeps the events of a calendar from before meetings, and invites after the upgrade", async () => {
		const { event: one } = await ada.call("calendar.create_event", { ...meeting(undefined), title: "One" });
		const { event: two } = await ada.call("calendar.create_event", { ...meeting(undefined), title: "Two" });
		await restartLegacyCalendar(ada.id);
		const events = await eventsOf(ada);
		expect(events.map((item) => [item.id, item.uid, item.is_organizer, item.attendees, item.organizer])).toEqual(
			[
				[one.id, one.id, true, [], null],
				[two.id, two.id, true, [], null],
			].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
		);
		await ada.call("calendar.update_event", { event_id: one.id, attendees: [{ principal_id: owner.id }] });
		await settleCalendars(ada.id, owner.id);
		expect((await copyOf(owner, one.uid))?.title).toBe("One");
	});
});

describe("invitations through MCP", () => {
	it("invites and answers with the same rules as REST", async () => {
		const created = await callTool(bot.key, "calendar_create_event", {
			...meeting([{ email: "ada@dock.test" }]),
		});
		expect(created.isError).toBeFalsy();
		const event = (created.structuredContent as { event: CalendarEvent }).event;
		await settleCalendars(bot.id, ada.id);
		const copy = (await copyOf(ada, event.uid)) as CalendarEvent;

		const denied = await callTool(ada.key, "calendar_update_event", { event_id: copy.id, title: "Mine" });
		expect(denied.isError).toBe(true);
		const answered = await callTool(ada.key, "calendar_respond_to_invitation", {
			event_id: copy.id,
			response: "accepted",
		});
		expect(answered.isError).toBeFalsy();
		expect(answered.structuredContent).toEqual({
			event: (await ada.call("calendar.get_event", { event_id: copy.id })).event,
		});
		await settleCalendars(ada.id, bot.id);
		expect(await responses(bot, event.id)).toEqual({ "ada@dock.test": "accepted" });
	});
});
