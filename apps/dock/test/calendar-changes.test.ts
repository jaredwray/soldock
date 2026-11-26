import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { CALENDAR_LIMITS, type CalendarChange, EVENTS_SOCKET_PATH, type InputOf } from "@asterra/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import migration from "../migrations/0041_calendar_webhooks.sql?raw";
import {
	type Actor,
	api,
	bearer,
	breakCalendarDelivery,
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

const meeting = (attendees: InputOf<"calendar.create_event">["attendees"]): InputOf<"calendar.create_event"> => ({
	title: "Design review",
	when: WHEN,
	attendees,
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
 * events sockets fail, and `failSend` the queue send, as a stop of the Worker or a failed call does.
 */
async function wireCalendar(principalId: string) {
	const wired = { jobs: [] as Record<string, unknown>[], failHint: false, failSend: false };
	await runInDurableObject(calendarStub(principalId), (instance) => {
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
			send: async (body: Record<string, unknown>) => {
				if (wired.failSend) throw new Error("the queue is unavailable");
				wired.jobs.push(body);
			},
		} as unknown as Queue;
		target.env = { ...target.env, PRINCIPAL: principal, WEBHOOKS: queue };
	});
	return wired;
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
			changes.map(({ type, event_id, uid, revision, actor_id, calendar_id, occurrence_id }) => ({
				type,
				event_id,
				uid,
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
				uid: event.id,
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

	// The user story: an RSVP of one attendee is a change on the calendar of the organizer and of each other
	// attendee. The answer of the owner of a copy comes back in the next snapshot of the organizer: that echo must
	// not be a second change, or an agent that watches answers gets each answer two times.
	it("records invitations, answers, changes and the cancel on each calendar of a meeting", async () => {
		const [adaStart, graceStart, botStart] = [await head(ada), await head(grace), await head(bot)];
		const { event } = await ada.call(
			"calendar.create_event",
			meeting([{ principal_id: grace.id }, { principal_id: bot.id }]),
		);
		await settleCalendars(ada.id, grace.id, bot.id);
		const [copy] = await changesAfter(grace, graceStart);
		expect(copy).toMatchObject({ type: "calendar.invitation.received", uid: event.id, revision: 1, actor_id: ada.id });

		await grace.call("calendar.respond_to_invitation", { event_id: copy?.event_id ?? "", response: "accepted" });
		await settleCalendars(ada.id, grace.id, bot.id);
		expect(typesOf(await changesAfter(grace, graceStart))).toEqual([
			"calendar.invitation.received",
			"calendar.rsvp.changed",
		]);
		const organizer = await changesAfter(ada, adaStart);
		expect(organizer.at(-1)).toMatchObject({
			type: "calendar.rsvp.changed",
			event_id: event.id,
			revision: 1,
			actor_id: grace.id,
		});
		expect((await changesAfter(bot, botStart)).map(({ type, actor_id }) => [type, actor_id])).toEqual([
			["calendar.invitation.received", ada.id],
			["calendar.rsvp.changed", grace.id],
		]);

		await ada.call("calendar.update_event", { event_id: event.id, when: LATER });
		await settleCalendars(ada.id, grace.id, bot.id);
		await ada.call("calendar.delete_event", { event_id: event.id });
		await settleCalendars(ada.id, grace.id, bot.id);
		expect(typesOf(await changesAfter(ada, adaStart))).toEqual([
			"calendar.event.created",
			"calendar.rsvp.changed",
			"calendar.event.updated",
			"calendar.event.deleted",
		]);
		expect(typesOf(await changesAfter(grace, graceStart))).toEqual([
			"calendar.invitation.received",
			"calendar.rsvp.changed",
			"calendar.invitation.updated",
			"calendar.invitation.cancelled",
		]);
	});

	// The organizer removed an attendee and invited it again before the removal arrived. The answer of that
	// attendee goes back to pending on the copy of each other attendee. The attendee did not answer, so the record
	// must not name it as the actor: an agent that skips its own changes, or trusts the actor, would be misled.
	it("names the organizer for an answer that a new invitation reset on a different copy", async () => {
		const { event } = await ada.call(
			"calendar.create_event",
			meeting([{ principal_id: grace.id }, { principal_id: bot.id }]),
		);
		await settleCalendars(ada.id, grace.id, bot.id);
		const { events } = await bot.call("calendar.list_events", {
			time_min: "2026-12-01T00:00:00Z",
			time_max: "2026-12-08T00:00:00Z",
		});
		const botCopy = events.find((item) => item.uid === event.id);
		await bot.call("calendar.respond_to_invitation", { event_id: botCopy?.id ?? "", response: "accepted" });
		await settleCalendars(ada.id, grace.id, bot.id);
		const graceStart = await head(grace);

		const broken = await breakCalendarDelivery(ada.id);
		await ada.call("calendar.update_event", { event_id: event.id, attendees: [{ principal_id: grace.id }] });
		await ada.call("calendar.update_event", {
			event_id: event.id,
			attendees: [{ principal_id: grace.id }, { principal_id: bot.id }],
		});
		broken.fail = null;
		await settleCalendars(ada.id, grace.id, bot.id);
		const answers = (await changesAfter(grace, graceStart)).filter((change) => change.type === "calendar.rsvp.changed");
		expect(answers.map((change) => change.actor_id)).toEqual([ada.id]);
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
					"INSERT INTO changes (id, type, event_id, uid, revision, at) VALUES (?, 'calendar.event.updated', 'evt_old', 'evt_old', 1, ?)",
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

		// A queue send that fails after the first change keeps the second one for the next round.
		let sends = 0;
		restarted.failSend = false;
		const queue = restarted.jobs;
		await runInDurableObject(calendarStub(ada.id), (instance) => {
			const target = instance as unknown as { env: Env };
			target.env = {
				...target.env,
				WEBHOOKS: {
					send: async (body: Record<string, unknown>) => {
						sends += 1;
						if (sends === 2) throw new Error("the queue is unavailable");
						queue.push(body);
					},
				} as unknown as Queue,
			};
		});
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
			uid: changes[0]?.uid,
			occurrenceId: null,
			revision: 1,
			actorId: ada.id,
			cursor: changes[0]?.cursor,
		});
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
		// The publish ended before the ping, so a calendar event for this socket would come before the pong.
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
