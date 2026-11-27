import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { CALENDAR_LIMITS, type CalendarChange, EVENTS_SOCKET_PATH, type InputOf } from "@asterra/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import migration from "../migrations/0041_calendar_webhooks.sql?raw";
import type { CalendarDO } from "../src/calendar/calendar.ts";
import {
	type Actor,
	api,
	bearer,
	calendarMeta,
	calendarStub,
	callTool,
	codeOf,
	createActor,
	PASSWORD,
	publishCalendarChanges,
	readSocket,
	request,
	seedOrg,
	settleCalendars,
} from "./helpers.ts";

// The change feed of a calendar: each committed change writes one row in the transaction of the change. The
// feed is the one record of the change for `calendar.list_changes`, the events socket and MCP Events.

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

const WHEN = { kind: "timed", start: "2026-12-02T15:00:00Z", end: "2026-12-02T16:00:00Z", time_zone: "UTC" } as const;
const LATER = { kind: "timed", start: "2026-12-03T17:00:00Z", end: "2026-12-03T18:00:00Z", time_zone: "UTC" } as const;

const meeting = (attendeeIds: string[]): InputOf<"calendar.create_event"> => ({
	title: "Design review",
	when: WHEN,
	attendee_ids: attendeeIds,
});

/** The cursor of now in the feed of an actor. */
async function head(actor: Actor): Promise<string> {
	return (await actor.call("calendar.list_changes", {})).cursor;
}

/** Each change after a cursor, over each page. */
async function changesAfter(actor: Actor, cursor: string): Promise<CalendarChange[]> {
	const changes: CalendarChange[] = [];
	let after = cursor;
	for (;;) {
		const page = await actor.call("calendar.list_changes", { cursor: after });
		expect(page.expired).toBe(false);
		changes.push(...page.changes);
		after = page.cursor;
		if (!page.has_more) return changes;
	}
}

const typesOf = (changes: CalendarChange[]) => changes.map((change) => change.type);

/**
 * Replaces the webhook queue and the principal binding of one calendar object. `failHint` makes the hint to the
 * events sockets fail, and `failSend` the queue send, as a stop of the Worker or a failed call does. `batches`
 * has, for each batch of the queue, its size and the rows of the outbox that waited when the calendar sent it.
 */
async function wireCalendar(principalId: string) {
	const wired = {
		jobs: [] as Record<string, unknown>[],
		batches: [] as { size: number; outbox: number }[],
		failHint: false,
		failSend: false,
	};
	await runInDurableObject(calendarStub(principalId), (instance, state) => {
		const target = instance as unknown as { env: Env };
		const real = target.env.PRINCIPAL;
		const principal = {
			idFromName: (name: string) => real.idFromName(name),
			get: (id: DurableObjectId) => ({
				calendarChanged: (calendarId: string) =>
					wired.failHint ? Promise.reject(new Error("hint failed")) : real.get(id).calendarChanged(calendarId),
			}),
		} as unknown as Env["PRINCIPAL"];
		const queue = {
			sendBatch: async (messages: { body: Record<string, unknown> }[]) => {
				if (wired.failSend) throw new Error("the queue is unavailable");
				const outbox = state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM outbox").one().n;
				wired.batches.push({ size: messages.length, outbox });
				wired.jobs.push(...messages.map((message) => message.body));
			},
		} as unknown as Queue;
		target.env = { ...target.env, PRINCIPAL: principal, WEBHOOKS: queue };
	});
	return wired;
}

/**
 * Holds the outbox of one calendar object: each delivery to a different calendar fails until `release`. So the
 * calendar keeps only the newest state for each attendee, and the attendee gets many changes as one state.
 */
async function holdOutbox(principalId: string) {
	const hold = { held: true };
	await runInDurableObject(calendarStub(principalId), (instance) => {
		const target = instance as unknown as { env: Env };
		const real = target.env.CALENDAR;
		const send = <T>(call: () => Promise<T>) => (hold.held ? Promise.reject(new Error("the outbox is held")) : call());
		const calendars = {
			idFromName: (name: string) => real.idFromName(name),
			get: (id: DurableObjectId) => ({
				applySnapshot: (...args: Parameters<CalendarDO["applySnapshot"]>) =>
					send(() => real.get(id).applySnapshot(...args)),
				applyResponse: (...args: Parameters<CalendarDO["applyResponse"]>) =>
					send(() => real.get(id).applyResponse(...args)),
			}),
		} as unknown as Env["CALENDAR"];
		target.env = { ...target.env, CALENDAR: calendars };
	});
	return {
		release: () => {
			hold.held = false;
		},
	};
}

describe("the change feed of a calendar", () => {
	// Each committed change has one record with its ids and its revision. A refused or empty call must leave
	// no record, or a client would read a change that did not happen.
	it("records one change for each committed change, and none for a refused or empty call", async () => {
		const start = await head(ada);
		const input = { title: "Focus", when: WHEN, idempotency_key: "focus-1" };
		const { event } = await ada.call("calendar.create_event", input);
		await ada.call("calendar.create_event", input);
		expect(await codeOf(ada.call("calendar.update_event", { event_id: event.id, title: "X", base_revision: 9 }))).toBe(
			"conflict",
		);
		await ada.call("calendar.update_event", { event_id: event.id, title: "Focus" });
		await ada.call("calendar.update_event", { event_id: event.id, title: "Deep focus", base_revision: 1 });
		await ada.call("calendar.delete_event", { event_id: event.id, dry_run: true });
		await ada.call("calendar.delete_event", { event_id: event.id });
		expect(await codeOf(ada.call("calendar.delete_event", { event_id: event.id }))).toBe("not_found");

		const changes = await changesAfter(ada, start);
		expect(
			changes.map(({ type, event_id, revision, actor_id, calendar_id, occurrence_id }) => ({
				type,
				event_id,
				revision,
				actor_id,
				calendar_id,
				occurrence_id,
			})),
		).toEqual(
			[
				["calendar.event.created", 1],
				["calendar.event.updated", 2],
				["calendar.event.deleted", 2],
			].map(([type, revision]) => ({
				type,
				event_id: event.id,
				revision,
				actor_id: ada.id,
				calendar_id: ada.id,
				occurrence_id: null,
			})),
		);
		expect(new Set(changes.map((change) => change.id)).size).toBe(3);
		// The cursor of each change continues after it.
		expect(typesOf(await changesAfter(ada, changes[0]?.cursor ?? ""))).toEqual([
			"calendar.event.updated",
			"calendar.event.deleted",
		]);
	});

	// The user story: a response of one attendee is a change on the calendar of the organizer and of each other
	// attendee. The response of the owner of a copy comes back in the next state of the organizer: that echo must
	// not be a second change, or an agent that watches responses gets each response two times.
	it("records invitations, responses, changes and the delete on each calendar of a meeting", async () => {
		const [adaStart, graceStart, ownerStart] = [await head(ada), await head(grace), await head(owner)];
		const { event } = await ada.call("calendar.create_event", meeting([grace.id, owner.id]));
		await settleCalendars(ada.id, grace.id, owner.id);
		const [copy] = await changesAfter(grace, graceStart);
		expect(copy).toMatchObject({
			type: "calendar.invitation.received",
			event_id: event.id,
			revision: 1,
			actor_id: ada.id,
		});

		await grace.call("calendar.respond_to_event", { event_id: event.id, response: "accepted" });
		// A second equal response is no change.
		await grace.call("calendar.respond_to_event", { event_id: event.id, response: "accepted" });
		await settleCalendars(ada.id, grace.id, owner.id);
		expect(typesOf(await changesAfter(grace, graceStart))).toEqual([
			"calendar.invitation.received",
			"calendar.rsvp.changed",
		]);
		expect((await changesAfter(ada, adaStart)).at(-1)).toMatchObject({
			type: "calendar.rsvp.changed",
			event_id: event.id,
			revision: 1,
			actor_id: grace.id,
		});
		expect((await changesAfter(owner, ownerStart)).map(({ type, actor_id }) => [type, actor_id])).toEqual([
			["calendar.invitation.received", ada.id],
			["calendar.rsvp.changed", grace.id],
		]);

		// A new time asks each attendee again: the copy of grace changes, and her response goes back to
		// needs_action because of the organizer. The calendar of the organizer shows the same reset, so it has
		// the same record: a client that follows the responses there must not keep "accepted".
		await ada.call("calendar.update_event", { event_id: event.id, when: LATER });
		await settleCalendars(ada.id, grace.id, owner.id);
		await ada.call("calendar.delete_event", { event_id: event.id });
		await settleCalendars(ada.id, grace.id, owner.id);
		expect(
			(await changesAfter(ada, adaStart)).map(({ type, actor_id, revision, occurrence_id }) => [
				type,
				actor_id,
				revision,
				occurrence_id,
			]),
		).toEqual([
			["calendar.event.created", ada.id, 1, null],
			["calendar.rsvp.changed", grace.id, 1, null],
			["calendar.event.updated", ada.id, 2, null],
			["calendar.rsvp.changed", ada.id, 2, null],
			["calendar.event.deleted", ada.id, 2, null],
		]);
		expect((await changesAfter(grace, graceStart)).map(({ type, actor_id }) => [type, actor_id])).toEqual([
			["calendar.invitation.received", ada.id],
			["calendar.rsvp.changed", grace.id],
			["calendar.invitation.updated", ada.id],
			["calendar.rsvp.changed", ada.id],
			["calendar.invitation.cancelled", ada.id],
		]);
	});

	// The organizer removed an attendee and invited it again before the removal arrived. The response of that
	// attendee goes back to needs_action on the copy of each other attendee. The attendee did not respond, so the
	// record must name the organizer: an agent that skips its own changes, or trusts the actor, would be misled.
	it("names the organizer for a response that a new invitation reset on a different copy", async () => {
		const { event } = await ada.call("calendar.create_event", meeting([grace.id, owner.id]));
		await settleCalendars(ada.id, grace.id, owner.id);
		await owner.call("calendar.respond_to_event", { event_id: event.id, response: "accepted" });
		await settleCalendars(ada.id, grace.id, owner.id);
		const graceStart = await head(grace);

		// The two states for grace merge in one row of the outbox, so the copy sees only the newest one.
		await ada.call("calendar.update_event", { event_id: event.id, attendee_ids: [grace.id] });
		await ada.call("calendar.update_event", { event_id: event.id, attendee_ids: [grace.id, owner.id] });
		await settleCalendars(ada.id, grace.id, owner.id);
		const responses = (await changesAfter(grace, graceStart)).filter(
			(change) => change.type === "calendar.rsvp.changed",
		);
		expect(responses.map((change) => change.actor_id)).toEqual([ada.id]);
	});

	// Two attendees responded before the organizer sent a state. No one principal caused that change of the
	// copy of a third attendee, so the record has no actor: a wrong name would mislead a client that skips or
	// trusts an actor. The copy of a responder shows only the response of the other one, so it names that one.
	it("names no actor for the responses of two attendees that arrive in one state", async () => {
		const linus = await createActor(owner, {
			kind: "human",
			display_name: "Linus Torvalds",
			address: "linus@dock.test",
			password: PASSWORD,
		});
		const { event } = await ada.call("calendar.create_event", meeting([grace.id, owner.id, linus.id]));
		await settleCalendars(ada.id, grace.id, owner.id, linus.id);
		const [graceStart, linusStart] = [await head(grace), await head(linus)];
		const outbox = await holdOutbox(ada.id);
		await grace.call("calendar.respond_to_event", { event_id: event.id, response: "accepted" });
		await owner.call("calendar.respond_to_event", { event_id: event.id, response: "declined" });
		await settleCalendars(grace.id, owner.id);
		outbox.release();
		await settleCalendars(ada.id, grace.id, owner.id, linus.id);
		expect((await changesAfter(linus, linusStart)).map(({ type, actor_id }) => [type, actor_id])).toEqual([
			["calendar.rsvp.changed", null],
		]);
		expect((await changesAfter(grace, graceStart)).map(({ type, actor_id }) => [type, actor_id])).toEqual([
			["calendar.rsvp.changed", grace.id],
			["calendar.rsvp.changed", owner.id],
		]);
	});

	// A page that missed many edits reads them in pages, and an expired cursor makes it read the range again.
	it("pages the changes, refuses a cursor that is not one, and expires a cursor before the feed", async () => {
		const start = await head(ada);
		for (const title of ["One", "Two", "Three"]) await ada.call("calendar.create_event", { title, when: WHEN });
		const first = await ada.call("calendar.list_changes", { cursor: start, limit: 2 });
		expect(first).toMatchObject({ has_more: true, expired: false });
		expect(first.changes).toHaveLength(2);
		const second = await ada.call("calendar.list_changes", { cursor: first.cursor, limit: 2 });
		expect(second).toMatchObject({ has_more: false, expired: false });
		expect(second.changes).toHaveLength(1);
		const empty = await ada.call("calendar.list_changes", { cursor: second.cursor });
		expect(empty).toEqual({ changes: [], cursor: second.cursor, has_more: false, expired: false });
		expect(await codeOf(ada.call("calendar.list_changes", { cursor: "not-a-cursor" }))).toBe("invalid");

		// A cursor of a different calendar is not a position of this feed.
		const other = await ada.call("calendar.list_changes", { cursor: await head(grace) });
		expect(other).toMatchObject({ changes: [], expired: true, cursor: await head(ada) });

		// Age the published changes past the retention, then a new change prunes them.
		await publishCalendarChanges(ada.id);
		await runInDurableObject(calendarStub(ada.id), (_instance, state) => {
			state.storage.sql.exec("UPDATE changes SET at = ?", Date.now() - (CALENDAR_LIMITS.changeDays + 1) * 86_400_000);
		});
		await ada.call("calendar.create_event", { title: "Four", when: WHEN });
		await publishCalendarChanges(ada.id);
		const expired = await ada.call("calendar.list_changes", { cursor: start });
		expect(expired).toEqual({ changes: [], cursor: await head(ada), has_more: false, expired: true });
		expect(typesOf(await changesAfter(ada, second.cursor))).toEqual(["calendar.event.created"]);
	});

	// A calendar can have far more old changes than one read of the prune. Each old change must go after the
	// publish, or a cursor before them would stay valid past the retention.
	it("prunes each change past the retention after a publish, also more than one batch of them", async () => {
		const start = await head(ada);
		await runInDurableObject(calendarStub(ada.id), (_instance, state) => {
			const sql = state.storage.sql;
			const old = Date.now() - (CALENDAR_LIMITS.changeDays + 1) * 86_400_000;
			for (let i = 0; i < 1200; i++) {
				sql.exec(
					"INSERT INTO changes (id, type, event_id, revision, at) VALUES (?, 'calendar.event.updated', 'evt_old', 1, ?)",
					`chg_old_${i}`,
					old,
				);
			}
			const last = String(sql.exec<{ seq: number }>("SELECT MAX(seq) AS seq FROM changes").one().seq);
			sql.exec(
				"INSERT OR REPLACE INTO meta (key, value) VALUES ('change_head', ?), ('change_published', ?)",
				last,
				last,
			);
		});
		const { event } = await ada.call("calendar.create_event", { title: "New", when: WHEN });
		await publishCalendarChanges(ada.id);
		const rows = await runInDurableObject(calendarStub(ada.id), (_instance, state) =>
			state.storage.sql.exec<{ event_id: string }>("SELECT event_id FROM changes").toArray(),
		);
		expect(rows).toEqual([{ event_id: event.id }]);
		expect((await ada.call("calendar.list_changes", { cursor: start })).expired).toBe(true);
	});

	// The feed is part of the calendar: only its owner reads it, and it needs calendar.read, through REST and MCP.
	it("gives the feed to its owner only, with calendar.read, through REST and MCP", async () => {
		const start = await head(ada);
		const { event } = await ada.call("calendar.create_event", { title: "Private", when: WHEN });
		const viaMcp = await callTool(ada.key, "calendar_list_changes", { cursor: start });
		expect(viaMcp.isError).toBeFalsy();
		expect(viaMcp.structuredContent).toMatchObject({
			changes: [{ type: "calendar.event.created", event_id: event.id }],
		});
		// A cursor of ada gives grace nothing of ada: grace reads only her own feed.
		const fromGrace = await grace.call("calendar.list_changes", { cursor: start });
		expect(fromGrace.changes).toEqual([]);
		const { api_key } = await ada.call("account.create_api_key", { label: "chat", scopes: ["chat.read"] });
		expect(await codeOf(api(api_key.secret)("calendar.list_changes", {}))).toBe("forbidden");
	});
});

describe("the changes of single occurrences", () => {
	const weekly = (attendeeIds: string[] = []): InputOf<"calendar.create_event"> => ({
		title: "Weekly sync",
		when: WHEN,
		recurrence: { frequency: "weekly", interval: 1 },
		attendee_ids: attendeeIds,
	});

	/** The occurrence ids of a series in the first three weeks, first first. */
	async function occurrencesOf(actor: Actor, eventId: string): Promise<string[]> {
		const { events } = await actor.call("calendar.list_events", {
			time_min: "2026-12-01T00:00:00Z",
			time_max: "2026-12-22T00:00:00Z",
		});
		return events.flatMap((item) => (item.id === eventId && item.occurrence_id ? [item.occurrence_id] : []));
	}

	// A change of one occurrence is a change of the series for a receiver: the record names the occurrence, and a
	// refused, dry or empty call writes nothing. A private reminder is no change of the event.
	it("records a move and a cancel of one occurrence with its id, and nothing for the other calls", async () => {
		const { event } = await ada.call("calendar.create_event", weekly());
		const [first, second] = await occurrencesOf(ada, event.id);
		const start = await head(ada);
		const later = {
			kind: "timed",
			start: "2026-12-09T18:00:00Z",
			end: "2026-12-09T19:00:00Z",
			time_zone: "UTC",
		} as const;
		await ada.call("calendar.update_occurrence", { occurrence_id: second ?? "", when: later });
		await ada.call("calendar.update_occurrence", { occurrence_id: second ?? "", when: later });
		await ada.call("calendar.cancel_occurrence", { occurrence_id: first ?? "", dry_run: true });
		await ada.call("calendar.cancel_occurrence", { occurrence_id: first ?? "" });
		expect(await codeOf(ada.call("calendar.cancel_occurrence", { occurrence_id: first ?? "" }))).toBe("not_found");
		await ada.call("calendar.set_reminder", { event_id: event.id, minutes: 30 });
		expect(
			(await changesAfter(ada, start)).map(({ type, occurrence_id, revision }) => [type, occurrence_id, revision]),
		).toEqual([
			["calendar.event.updated", second, 2],
			["calendar.event.updated", first, 3],
		]);
	});

	// An attendee that follows the copy must see a moved or cancelled occurrence, and the new question for the
	// moved one, without a change record of the whole series.
	it("records a moved and a cancelled occurrence on a copy, with the reset of the response to it", async () => {
		const { event } = await ada.call("calendar.create_event", weekly([grace.id]));
		await settleCalendars(ada.id, grace.id);
		await grace.call("calendar.respond_to_event", { event_id: event.id, response: "accepted" });
		await settleCalendars(ada.id, grace.id);
		const [first, second] = await occurrencesOf(ada, event.id);
		const [start, adaStart] = [await head(grace), await head(ada)];
		const later = {
			kind: "timed",
			start: "2026-12-09T18:00:00Z",
			end: "2026-12-09T19:00:00Z",
			time_zone: "UTC",
		} as const;
		await ada.call("calendar.update_occurrence", { occurrence_id: second ?? "", when: later });
		await settleCalendars(ada.id, grace.id);
		await ada.call("calendar.cancel_occurrence", { occurrence_id: first ?? "" });
		await settleCalendars(ada.id, grace.id);
		// The calendar of the organizer shows the same reset of the response to the moved occurrence.
		expect(
			(await changesAfter(ada, adaStart)).map(({ type, occurrence_id, actor_id }) => [type, occurrence_id, actor_id]),
		).toEqual([
			["calendar.event.updated", second, ada.id],
			["calendar.rsvp.changed", second, ada.id],
			["calendar.event.updated", first, ada.id],
		]);
		expect(
			(await changesAfter(grace, start)).map(({ type, occurrence_id, actor_id }) => [type, occurrence_id, actor_id]),
		).toEqual([
			["calendar.invitation.updated", second, ada.id],
			["calendar.rsvp.changed", second, ada.id],
			["calendar.invitation.updated", first, ada.id],
		]);
	});

	// A response to one occurrence is a change of that occurrence on each calendar of the meeting. Its echo and a
	// repeated response change nothing, and a response to the series names no occurrence.
	it("records a response to one occurrence on each calendar, once", async () => {
		const { event } = await ada.call("calendar.create_event", weekly([grace.id, owner.id]));
		await settleCalendars(ada.id, grace.id, owner.id);
		const [, second] = await occurrencesOf(ada, event.id);
		const starts = [await head(ada), await head(grace), await head(owner)] as const;
		await grace.call("calendar.respond_to_event", { event_id: event.id, occurrence_id: second, response: "declined" });
		await grace.call("calendar.respond_to_event", { event_id: event.id, occurrence_id: second, response: "declined" });
		await settleCalendars(ada.id, grace.id, owner.id);
		for (const [actor, cursor] of [
			[ada, starts[0]],
			[grace, starts[1]],
			[owner, starts[2]],
		] as const) {
			expect(
				(await changesAfter(actor, cursor)).map(({ type, occurrence_id, actor_id }) => [type, occurrence_id, actor_id]),
			).toEqual([["calendar.rsvp.changed", second, grace.id]]);
		}
		const graceNext = await head(grace);
		await grace.call("calendar.respond_to_event", { event_id: event.id, response: "accepted" });
		await settleCalendars(ada.id, grace.id, owner.id);
		expect((await changesAfter(grace, graceNext)).map(({ type, occurrence_id }) => [type, occurrence_id])).toEqual([
			["calendar.rsvp.changed", null],
		]);
	});

	// A new time or a moved occurrence with no response to reset changes no response. A record there would tell
	// a client of a change of a response that did not occur.
	it("records no reset of a response on the calendar of the organizer when no attendee responded", async () => {
		const { event } = await ada.call("calendar.create_event", weekly([grace.id]));
		await settleCalendars(ada.id, grace.id);
		const [, second] = await occurrencesOf(ada, event.id);
		const start = await head(ada);
		await ada.call("calendar.update_occurrence", { occurrence_id: second ?? "", when: LATER });
		await ada.call("calendar.update_event", { event_id: event.id, when: LATER });
		expect(typesOf(await changesAfter(ada, start))).toEqual(["calendar.event.updated", "calendar.event.updated"]);
	});

	// A response to the series removes the responses to single occurrences. When each of them was the same
	// response, or its occurrence is cancelled, nothing that a calendar shows changes: a record would make a
	// client read the event for no change.
	it("records no change for a response to the series that changes no shown response", async () => {
		const { event } = await ada.call("calendar.create_event", weekly([grace.id]));
		await settleCalendars(ada.id, grace.id);
		const [, second, third] = await occurrencesOf(ada, event.id);
		await grace.call("calendar.respond_to_event", { event_id: event.id, response: "accepted" });
		await settleCalendars(ada.id, grace.id);
		const starts = [await head(ada), await head(grace)] as const;
		await grace.call("calendar.respond_to_event", { event_id: event.id, occurrence_id: second, response: "accepted" });
		await settleCalendars(ada.id, grace.id);
		await grace.call("calendar.respond_to_event", { event_id: event.id, response: "accepted" });
		await settleCalendars(ada.id, grace.id);
		expect(await changesAfter(ada, starts[0])).toEqual([]);
		expect(await changesAfter(grace, starts[1])).toEqual([]);

		// The declined occurrence goes away. The copy keeps the own response to it, but shows it no more.
		await grace.call("calendar.respond_to_event", { event_id: event.id, occurrence_id: third, response: "declined" });
		await settleCalendars(ada.id, grace.id);
		await ada.call("calendar.cancel_occurrence", { occurrence_id: third ?? "" });
		await settleCalendars(ada.id, grace.id);
		const next = [await head(ada), await head(grace)] as const;
		await grace.call("calendar.respond_to_event", { event_id: event.id, response: "accepted" });
		await settleCalendars(ada.id, grace.id);
		expect(await changesAfter(ada, next[0])).toEqual([]);
		expect(await changesAfter(grace, next[1])).toEqual([]);
	});

	// The organizer changed the title after an attendee responded to one occurrence, and the copy of a different
	// attendee gets the two changes as one state. The record of the series covers each occurrence, so the
	// response gives one record for the series, as the reset of a new time does.
	it("records one response change for the series when a state also changes the series", async () => {
		const { event } = await ada.call("calendar.create_event", weekly([grace.id, owner.id]));
		await settleCalendars(ada.id, grace.id, owner.id);
		const [, second] = await occurrencesOf(ada, event.id);
		const start = await head(grace);
		const outbox = await holdOutbox(ada.id);
		await owner.call("calendar.respond_to_event", { event_id: event.id, occurrence_id: second, response: "declined" });
		await settleCalendars(owner.id);
		await ada.call("calendar.update_event", { event_id: event.id, title: "Weekly review" });
		outbox.release();
		await settleCalendars(ada.id, grace.id, owner.id);
		expect(
			(await changesAfter(grace, start)).map(({ type, occurrence_id, actor_id }) => [type, occurrence_id, actor_id]),
		).toEqual([
			["calendar.invitation.updated", null, ada.id],
			["calendar.rsvp.changed", null, owner.id],
		]);
	});
});

describe("the publish of the change feed", () => {
	// A committed change must stay discoverable when the Worker stops before the delivery: the alarm sends it after
	// a restart, with the id that list_changes gives, and the pointer never passes a change that was not sent.
	it("sends each change after a failure and a restart, in order and with its stable id", async () => {
		await calendarStub(ada.id).enableChangeEvents(ada.id);
		const start = await head(ada);
		const wired = await wireCalendar(ada.id);
		wired.failHint = true;
		await ada.call("calendar.create_event", { title: "One", when: WHEN });
		await ada.call("calendar.create_event", { title: "Two", when: WHEN });
		await vi.waitFor(async () => expect(await calendarMeta(ada.id, "publish_attempts")).not.toBeNull());
		expect(wired.jobs).toEqual([]);
		expect(await calendarMeta(ada.id, "change_published")).toBeNull();

		// The object stops with no alarm. The next start sets one, because changes wait.
		await expect(
			runInDurableObject(calendarStub(ada.id), async (_instance, state) => {
				await state.storage.deleteAlarm();
				state.abort("Stop the calendar.");
			}),
		).rejects.toThrow("Stop the calendar.");
		const restarted = await wireCalendar(ada.id);
		expect(
			await runInDurableObject(calendarStub(ada.id), (_instance, state) => state.storage.getAlarm()),
		).not.toBeNull();

		// A queue send that fails keeps each change of its batch for the next round.
		restarted.failSend = true;
		await runInDurableObject(calendarStub(ada.id), async (_instance, state) => {
			state.storage.sql.exec("DELETE FROM meta WHERE key = 'publish_at'");
			await state.storage.setAlarm(Date.now());
		});
		await vi.waitFor(async () => expect(await calendarMeta(ada.id, "publish_attempts")).toBe("2"));
		expect(await calendarMeta(ada.id, "change_published")).toBeNull();
		restarted.failSend = false;
		const queue = restarted.jobs;
		await publishCalendarChanges(ada.id);
		const changes = await changesAfter(ada, start);
		expect(queue.map((job) => job.eventId)).toEqual(changes.map((change) => change.id));
		expect(queue[0]).toEqual({
			v: 1,
			kind: "calendar_event",
			calendarId: ada.id,
			eventType: "calendar.event.created",
			eventId: changes[0]?.id,
			occurredAt: Date.parse(changes[0]?.at ?? ""),
			calendarEventId: changes[0]?.event_id,
			occurrenceId: null,
			revision: 1,
			actorId: ada.id,
			cursor: changes[0]?.cursor,
		});
	});

	// A calendar with many changes to publish must not make an attendee wait for an invitation, or a reminder
	// wait for its time: one alarm publishes one batch, then delivers the outbox, and the next alarm continues.
	it("publishes one batch for each alarm, and delivers the outbox between two batches", async () => {
		await calendarStub(ada.id).enableChangeEvents(ada.id);
		const wired = await wireCalendar(ada.id);
		await runInDurableObject(calendarStub(ada.id), (_instance, state) => {
			const sql = state.storage.sql;
			for (let i = 0; i < 60; i++) {
				sql.exec(
					"INSERT INTO changes (id, type, event_id, revision, at) VALUES (?, 'calendar.event.updated', 'evt_many', 1, ?)",
					`chg_many_${i}`,
					Date.now(),
				);
			}
			const last = String(sql.exec<{ seq: number }>("SELECT MAX(seq) AS seq FROM changes").one().seq);
			sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('change_head', ?)", last);
		});
		// The create adds one change and one row of the outbox, and sets the alarm.
		await ada.call("calendar.create_event", meeting([grace.id]));
		await publishCalendarChanges(ada.id);
		expect(wired.batches).toEqual([
			{ size: 50, outbox: 1 },
			{ size: 11, outbox: 0 },
		]);
	});

	// The hint fails while the principal object is not available. The feed tries again later, but the meeting
	// must reach the attendee in that time: the outbox does not depend on the publish.
	it("delivers the outbox when the publish fails", async () => {
		const start = await head(grace);
		const wired = await wireCalendar(ada.id);
		wired.failHint = true;
		await ada.call("calendar.create_event", meeting([grace.id]));
		await settleCalendars(ada.id, grace.id);
		expect(typesOf(await changesAfter(grace, start))).toEqual(["calendar.invitation.received"]);
		expect(await calendarMeta(ada.id, "publish_attempts")).not.toBeNull();
		expect(await calendarMeta(ada.id, "change_published")).toBeNull();
	});

	// Without a subscription the feed sends no queue job: a calendar that nobody watches costs no queue message.
	it("sends no queue job before a subscription, and only the hint", async () => {
		const wired = await wireCalendar(grace.id);
		await grace.call("calendar.create_event", { title: "One", when: WHEN });
		await publishCalendarChanges(grace.id);
		expect(wired.jobs).toEqual([]);
	});
});

describe("the hint of the events socket", () => {
	// Both browser tabs update at once, and a credential that cannot read the calendar learns nothing about it.
	it("tells each socket with calendar.read that the calendar changed, and no other socket", async () => {
		const open = async (key: string) => {
			const reader = readSocket(
				await request(EVENTS_SOCKET_PATH, { headers: { upgrade: "websocket", ...bearer(key) } }),
			);
			expect(await reader.next()).toMatchObject({ type: "hello" });
			return reader;
		};
		const first = await open(ada.key);
		const second = await open(ada.key);
		const { api_key } = await ada.call("account.create_api_key", { label: "chat", scopes: ["chat.read"] });
		const chatOnly = await open(api_key.secret);
		await ada.call("calendar.create_event", { title: "One", when: WHEN });
		await publishCalendarChanges(ada.id);
		expect(await first.next()).toEqual({ type: "calendar.changed", calendar_id: ada.id });
		expect(await second.next()).toEqual({ type: "calendar.changed", calendar_id: ada.id });
		// The object sends one event to each socket in one step. The two calendar sockets got it, so a calendar
		// event for this socket would come before the pong.
		chatOnly.socket.send("ping");
		expect(await chatOnly.next()).toBe("pong");
	});
});

describe("migration 0041", () => {
	const statements = migration.split("--> statement-breakpoint");

	// The rebuild of webhook_subscriptions must keep each row, its sequence and the mirror triggers, and accept the
	// domain calendar. A second run must change nothing, as a fresh reset replays each migration.
	it("keeps the subscriptions, their sequences and triggers, and accepts the domain calendar", async () => {
		const { endpoint } = await ada.call("webhooks.create_endpoint", { url: "https://hooks.example.com/a" });
		await ada.call("drive.create_webhook_subscription", { endpoint_id: endpoint.id, event: "drive.item.created" });
		const before = await env.DIRECTORY.prepare("SELECT * FROM webhook_subscriptions ORDER BY sequence").all();
		for (const statement of statements) await env.DIRECTORY.prepare(statement).run();
		const after = await env.DIRECTORY.prepare("SELECT * FROM webhook_subscriptions ORDER BY sequence").all();
		expect(after.results).toEqual(before.results);
		const triggers = await env.DIRECTORY.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%webhooks_mirror_%' ORDER BY name",
		).all<{ name: string }>();
		expect(triggers.results.map((row) => row.name)).toEqual([
			"chat_webhooks_mirror_delete",
			"chat_webhooks_mirror_update",
			"webhooks_mirror_delete",
			"webhooks_mirror_update",
		]);
		const inserted = await env.DIRECTORY.prepare(
			`INSERT INTO webhook_subscriptions (id, endpoint_id, domain, event_type, target_id, credential_kind, created_at)
			VALUES ('sub_calendar', ?, 'calendar', 'calendar.rsvp.changed', ?, 'api_key', ?) RETURNING sequence`,
		)
			.bind(endpoint.id, ada.id, new Date().toISOString())
			.first<number>("sequence");
		expect(inserted).toBeGreaterThan(Number(before.results.at(-1)?.sequence ?? 0));
	});

	// An agent from before the migration that can read its calendar and create webhooks gets calendar.webhooks.
	// A narrow agent stays narrow.
	it("gives calendar.webhooks to an agent with calendar.read and mail.webhooks, one time", async () => {
		const grant = statements.find((statement) => statement.includes("'calendar.webhooks'")) ?? "";
		const setScopes = (id: string, scopes: string[]) =>
			env.DIRECTORY.prepare("UPDATE principals SET agent_scopes = ? WHERE id = ?")
				.bind(JSON.stringify(scopes), id)
				.run();
		const narrow = await createActor(owner, {
			kind: "agent",
			display_name: "Narrow",
			address: "narrow@dock.test",
			sponsor_id: ada.id,
		});
		await setScopes(bot.id, ["calendar.read", "mail.webhooks"]);
		await setScopes(narrow.id, ["calendar.read"]);
		await env.DIRECTORY.prepare(grant).run();
		await env.DIRECTORY.prepare(grant).run();
		const scopesOf = async (id: string) =>
			JSON.parse(
				(await env.DIRECTORY.prepare("SELECT agent_scopes FROM principals WHERE id = ?")
					.bind(id)
					.first<string>("agent_scopes")) ?? "[]",
			);
		expect(await scopesOf(bot.id)).toEqual(["calendar.read", "mail.webhooks", "calendar.webhooks"]);
		expect(await scopesOf(narrow.id)).toEqual(["calendar.read"]);
	});
});
