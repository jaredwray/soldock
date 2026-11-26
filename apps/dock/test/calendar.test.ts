import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { CALENDAR_LIMITS, type InputOf } from "@asterra/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import calendarScopesMigration from "../migrations/0038_calendar_scopes.sql?raw";
import { type Actor, api, codeOf, createActor, request, seedOrg, setLegacyScopes } from "./helpers.ts";

let owner: Actor;
let ada: Actor;
let bot: Actor;

beforeEach(async () => {
	({ owner, ada, bot } = await seedOrg());
});

type CreateInput = InputOf<"calendar.create_event">;

const standup: CreateInput = {
	title: "Standup",
	when: {
		kind: "timed",
		start: "2026-12-01T09:00:00-05:00",
		end: "2026-12-01T09:15:00-05:00",
		time_zone: "america/new_york",
	},
	location: "Room 2",
};

const holiday = (start_date: string, end_date: string): CreateInput => ({
	title: "Holiday",
	when: { kind: "all_day", start_date, end_date },
});

const timed = (title: string, start: string, end: string): CreateInput => ({
	title,
	when: { kind: "timed", start, end, time_zone: "UTC" },
});

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

/** The titles of the events of a range, in order. */
async function titles(actor: Actor, time_min: string, time_max: string, time_zone?: string) {
	const { events } = await actor.call("calendar.list_events", {
		time_min,
		time_max,
		...(time_zone ? { time_zone } : {}),
	});
	return events.map((event) => event.title);
}

describe("the events of a calendar", () => {
	it("keeps a timed event in UTC with its time zone, and lists it in its range", async () => {
		const { event } = await ada.call("calendar.create_event", standup);
		expect(event).toMatchObject({
			id: expect.stringMatching(/^evt_/),
			title: "Standup",
			description: "",
			location: "Room 2",
			revision: 1,
			when: {
				kind: "timed",
				start: "2026-12-01T14:00:00.000Z",
				end: "2026-12-01T14:15:00.000Z",
				time_zone: "America/New_York",
			},
		});
		expect((await ada.call("calendar.get_event", { event_id: event.id })).event).toEqual(event);
		const listed = await ada.call("calendar.list_events", {
			time_min: "2026-12-01T00:00:00-05:00",
			time_max: "2026-12-02T00:00:00-05:00",
		});
		expect(listed).toEqual({ events: [event], next_cursor: null });
	});

	it("puts an all-day event on its own days in each time zone", async () => {
		await ada.call("calendar.create_event", holiday("2026-12-01", "2026-12-02"));
		// The first and the last time zones of the day.
		for (const [zone, offset] of [
			["Pacific/Kiritimati", "+14:00"],
			["Etc/GMT+12", "-12:00"],
			["UTC", "Z"],
		] as const) {
			const day = (date: string) => `${date}T00:00:00${offset}`;
			expect(await titles(ada, day("2026-12-01"), day("2026-12-02"), zone), zone).toEqual(["Holiday"]);
			expect(await titles(ada, day("2026-11-30"), day("2026-12-01"), zone), zone).toEqual([]);
			expect(await titles(ada, day("2026-12-02"), day("2026-12-03"), zone), zone).toEqual([]);
		}
		// One hour of the day is enough.
		expect(await titles(ada, "2026-12-01T10:00:00Z", "2026-12-01T11:00:00Z")).toEqual(["Holiday"]);

		// Havana has no 00:00 on 2026-03-08: the clock goes from 00:00 to 01:00, and the day starts at 05:00 UTC.
		await ada.call("calendar.create_event", { ...holiday("2026-03-08", "2026-03-09"), title: "Havana" });
		expect(await titles(ada, "2026-03-07T05:00:00Z", "2026-03-08T05:00:00Z", "America/Havana")).toEqual([]);
		expect(await titles(ada, "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z", "America/Havana")).toEqual(["Havana"]);
	});

	it("lists a range that goes outside the years of events, in each year that the input accepts", async () => {
		await ada.call("calendar.create_event", { ...holiday("1970-01-01", "1970-01-02"), title: "First" });
		await ada.call("calendar.create_event", { ...holiday("2100-12-31", "2101-01-01"), title: "Last" });
		expect(await titles(ada, "0050-01-01T00:00:00Z", "0050-12-01T00:00:00Z", "America/New_York")).toEqual([]);
		expect(await titles(ada, "9999-01-01T00:00:00Z", "9999-12-31T23:59:59Z", "Pacific/Kiritimati")).toEqual([]);
		// The first day starts on 1969-12-31 at UTC+14, and the last day ends on 2101-01-01 at UTC-12.
		expect(await titles(ada, "1969-06-01T00:00:00Z", "1969-12-31T12:00:00Z", "Etc/GMT-14")).toEqual(["First"]);
		expect(await titles(ada, "1969-06-01T00:00:00Z", "1969-12-31T09:00:00Z", "Etc/GMT-14")).toEqual([]);
		expect(await titles(ada, "2101-01-01T11:00:00Z", "2101-06-01T00:00:00Z", "Etc/GMT+12")).toEqual(["Last"]);
		expect(await titles(ada, "2101-01-01T12:00:00Z", "2101-06-01T00:00:00Z", "Etc/GMT+12")).toEqual([]);
	});

	it("lists each event that overlaps the range, and no event that only touches it", async () => {
		await ada.call("calendar.create_event", timed("Ends at the start", "2026-12-01T08:00:00Z", "2026-12-01T09:00:00Z"));
		await ada.call("calendar.create_event", timed("Starts at the end", "2026-12-01T10:00:00Z", "2026-12-01T11:00:00Z"));
		await ada.call("calendar.create_event", timed("Inside", "2026-12-01T09:15:00Z", "2026-12-01T09:45:00Z"));
		await ada.call("calendar.create_event", timed("Long", "2026-02-04T00:00:00Z", "2026-12-25T00:00:00Z"));
		await ada.call("calendar.create_event", holiday("2026-02-04", "2027-02-01"));
		// An all-day event comes before the timed events that start on its first day.
		expect(await titles(ada, "2026-12-01T09:00:00Z", "2026-12-01T10:00:00Z")).toEqual(["Holiday", "Long", "Inside"]);
	});

	it("gives each event of a range once, in order, over pages", async () => {
		const ids: string[] = [];
		for (let n = 0; n < 5; n++) {
			ids.push(
				(await ada.call("calendar.create_event", timed(`Same ${n}`, "2026-12-01T09:00:00Z", "2026-12-01T10:00:00Z")))
					.event.id,
			);
		}
		ids.push(
			(await ada.call("calendar.create_event", timed("Later", "2026-12-01T11:00:00Z", "2026-12-01T12:00:00Z"))).event
				.id,
		);
		const range = { time_min: "2026-12-01T00:00:00Z", time_max: "2026-12-02T00:00:00Z", limit: 2 };
		const seen: string[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 10; page++) {
			const result = await ada.call("calendar.list_events", { ...range, ...(cursor ? { cursor } : {}) });
			seen.push(...result.events.map((event) => event.id));
			if (!result.next_cursor) break;
			cursor = result.next_cursor;
		}
		// Events with one start come in the order of their ids, which is the order of creation.
		expect(seen).toEqual(ids);
		expect(await codeOf(ada.call("calendar.list_events", { ...range, cursor: "not-a-cursor" }))).toBe("invalid");
	});

	it("refuses a time that is not good, with a text that tells why", async () => {
		const refusal = async (input: CreateInput) => {
			const error = await ada.call("calendar.create_event", input).then(
				() => null,
				(caught: { code: string; message: string }) => caught,
			);
			return error && { code: error.code, message: error.message };
		};
		expect(await refusal(timed("Backwards", "2026-12-01T10:00:00Z", "2026-12-01T09:00:00Z"))).toMatchObject({
			code: "invalid",
			message: expect.stringMatching(/after its start/),
		});
		expect(await refusal(holiday("2026-12-01", "2026-12-01"))).toMatchObject({
			code: "invalid",
			message: expect.stringMatching(/A one-day event on 2026-12-01 has end_date 2026-12-02/),
		});
		expect(await refusal(timed("Too long", "2026-01-01T00:00:00Z", "2027-01-03T00:00:00Z"))).toMatchObject({
			code: "invalid",
		});
		expect(await refusal(holiday("2026-02-30", "2026-03-01"))).toMatchObject({ code: "invalid" });
		expect(
			await refusal({ ...standup, when: { ...standup.when, time_zone: "Mars/Olympus" } as CreateInput["when"] }),
		).toMatchObject({ code: "invalid" });
		expect(await refusal({ ...standup, title: "x".repeat(CALENDAR_LIMITS.titleChars + 1) })).toMatchObject({
			code: "invalid",
		});
		expect(await refusal({ ...standup, title: "Line\nbreak" })).toMatchObject({ code: "invalid" });
		// Nothing was added.
		expect(await titles(ada, "2025-12-01T00:00:00Z", "2026-12-01T00:00:00Z")).toEqual([]);
		expect(await titles(ada, "2026-12-01T00:00:00Z", "2027-11-30T00:00:00Z")).toEqual([]);
	});
});

describe("calendar.update_event and calendar.delete_event", () => {
	it("changes only the given fields, keeps the revision for no change, and refuses a stale revision", async () => {
		const { event } = await ada.call("calendar.create_event", { ...standup, description: "Notes" });
		const renamed = await ada.call("calendar.update_event", { event_id: event.id, title: "Daily standup" });
		expect(renamed.event).toMatchObject({
			title: "Daily standup",
			description: "Notes",
			location: "Room 2",
			when: event.when,
			revision: 2,
		});
		const same = await ada.call("calendar.update_event", {
			event_id: event.id,
			title: "Daily standup",
			location: "Room 2",
		});
		expect(same.event).toEqual(renamed.event);

		// A timed event becomes an all-day event: the whole time changes.
		const allDay = await ada.call("calendar.update_event", {
			event_id: event.id,
			when: { kind: "all_day", start_date: "2026-12-03", end_date: "2026-12-04" },
			base_revision: 2,
		});
		expect(allDay.event).toMatchObject({
			revision: 3,
			when: { kind: "all_day", start_date: "2026-12-03", end_date: "2026-12-04" },
		});
		expect(await titles(ada, "2026-12-03T00:00:00Z", "2026-12-04T00:00:00Z")).toEqual(["Daily standup"]);
		expect(await titles(ada, "2026-12-01T00:00:00Z", "2026-12-02T00:00:00Z")).toEqual([]);

		// A change from a revision that is not current changes nothing.
		expect(
			await codeOf(ada.call("calendar.update_event", { event_id: event.id, title: "Old", base_revision: 2 })),
		).toBe("conflict");
		expect((await ada.call("calendar.get_event", { event_id: event.id })).event).toEqual(allDay.event);
	});

	it("deletes an event, with dry_run first, and refuses a stale revision", async () => {
		const { event } = await ada.call("calendar.create_event", standup);
		expect(await ada.call("calendar.delete_event", { event_id: event.id, dry_run: true })).toEqual({
			event,
			dry_run: true,
		});
		expect((await ada.call("calendar.get_event", { event_id: event.id })).event).toEqual(event);
		expect(await codeOf(ada.call("calendar.delete_event", { event_id: event.id, base_revision: 2 }))).toBe("conflict");
		expect(await ada.call("calendar.delete_event", { event_id: event.id, base_revision: 1 })).toEqual({
			event,
			dry_run: false,
		});
		expect(await codeOf(ada.call("calendar.get_event", { event_id: event.id }))).toBe("not_found");
		expect(await codeOf(ada.call("calendar.delete_event", { event_id: event.id }))).toBe("not_found");
	});

	it("refuses a new event over the limit of a calendar, and counts a delete", async () => {
		const { event } = await ada.call("calendar.create_event", standup);
		const calendar = env.CALENDAR.get(env.CALENDAR.idFromName(ada.id));
		await runInDurableObject(calendar, (_instance, state) => {
			state.storage.sql.exec("UPDATE meta SET value = ? WHERE key = 'event_count'", String(CALENDAR_LIMITS.events));
		});
		expect(await codeOf(ada.call("calendar.create_event", standup))).toBe("invalid");
		await ada.call("calendar.delete_event", { event_id: event.id });
		await ada.call("calendar.create_event", standup);
	});
});

describe("the audit log of a calendar", () => {
	it("has one line for each change that writes, and none for a call that writes nothing", async () => {
		const input = { ...standup, idempotency_key: "audit-1" };
		let id = "";
		const created = await auditLines(async () => {
			id = (await ada.call("calendar.create_event", input)).event.id;
		});
		expect(created).toMatchObject([
			{ op: "calendar.create_event", actor: ada.id, actorKind: "human", target: id, result: "ok" },
		]);
		expect(created).toHaveLength(1);
		// A retry with the key adds nothing.
		expect(await auditLines(() => ada.call("calendar.create_event", input))).toEqual([]);

		const updated = await auditLines(() => ada.call("calendar.update_event", { event_id: id, title: "Daily" }));
		expect(updated).toMatchObject([{ op: "calendar.update_event", actor: ada.id, target: id, result: "ok" }]);
		expect(updated).toHaveLength(1);
		expect(await auditLines(() => ada.call("calendar.update_event", { event_id: id, title: "Daily" }))).toEqual([]);

		expect(await auditLines(() => ada.call("calendar.delete_event", { event_id: id, dry_run: true }))).toEqual([]);
		const deleted = await auditLines(() => ada.call("calendar.delete_event", { event_id: id }));
		expect(deleted).toMatchObject([{ op: "calendar.delete_event", actor: ada.id, target: id, result: "ok" }]);
		expect(deleted).toHaveLength(1);
	});
});

describe("idempotency of calendar.create_event", () => {
	it("returns the first event for a retry, and refuses the key with a different request", async () => {
		const first = await ada.call("calendar.create_event", { ...standup, idempotency_key: "standup-1" });
		const retry = await ada.call("calendar.create_event", { ...standup, idempotency_key: "standup-1" });
		expect(retry.event).toEqual(first.event);
		expect(
			await codeOf(ada.call("calendar.create_event", { ...standup, title: "Other", idempotency_key: "standup-1" })),
		).toBe("conflict");
		// The key of one principal is not the key of a different principal.
		const other = await bot.call("calendar.create_event", { ...standup, idempotency_key: "standup-1" });
		expect(other.event.id).not.toBe(first.event.id);

		// REST clients can send the key as a header.
		const post = () =>
			request("/api/v1/calendar/events", {
				method: "POST",
				headers: {
					authorization: `Bearer ${ada.key}`,
					"content-type": "application/json",
					"idempotency-key": "from-header",
				},
				body: JSON.stringify(timed("Header", "2026-12-01T12:00:00Z", "2026-12-01T13:00:00Z")),
			});
		const a = (await (await post()).json()) as { event: { id: string } };
		const b = (await (await post()).json()) as { event: { id: string } };
		expect(b.event.id).toBe(a.event.id);
		expect(await titles(ada, "2026-12-01T00:00:00Z", "2026-12-02T00:00:00Z")).toEqual(["Header", "Standup"]);
	});
});

describe("who reaches a calendar", () => {
	it("gives each agent and service account its own calendar, and nobody the calendar of a different principal", async () => {
		const { event: adaEvent } = await ada.call("calendar.create_event", standup);
		const { event: botEvent } = await bot.call(
			"calendar.create_event",
			timed("Bot run", "2026-12-01T15:00:00Z", "2026-12-01T16:00:00Z"),
		);
		const { principal: service } = await owner.call("directory.create_service_account", {
			display_name: "CI Pipeline",
			address: "ci@dock.test",
		});
		const { api_key } = await owner.call("account.create_api_key", { principal_id: service.id, label: "ci" });
		const ci = api(api_key.secret);
		const { event: ciEvent } = await ci(
			"calendar.create_event",
			timed("Deploy", "2026-12-01T17:00:00Z", "2026-12-01T18:00:00Z"),
		);
		await ci("calendar.update_event", { event_id: ciEvent.id, location: "Region 1" });

		const day = ["2026-12-01T00:00:00Z", "2026-12-02T00:00:00Z"] as const;
		expect(await titles(ada, ...day)).toEqual(["Standup"]);
		expect(await titles(bot, ...day)).toEqual(["Bot run"]);
		expect(
			(await ci("calendar.list_events", { time_min: day[0], time_max: day[1] })).events.map((e) => e.title),
		).toEqual(["Deploy"]);

		// The id of an event of a different calendar is not found, for a read and for a change.
		expect(await codeOf(bot.call("calendar.get_event", { event_id: adaEvent.id }))).toBe("not_found");
		expect(await codeOf(bot.call("calendar.update_event", { event_id: adaEvent.id, title: "Mine" }))).toBe("not_found");
		expect(await codeOf(bot.call("calendar.delete_event", { event_id: adaEvent.id }))).toBe("not_found");
		expect(await codeOf(ada.call("calendar.get_event", { event_id: botEvent.id }))).toBe("not_found");
		// The sponsor and the owner of the organization do not read the calendar of an agent.
		expect(await codeOf(owner.call("calendar.get_event", { event_id: botEvent.id }))).toBe("not_found");
		// No field names a different calendar.
		const other = { event_id: adaEvent.id, calendar_id: ada.id } as unknown as InputOf<"calendar.get_event">;
		expect(await codeOf(bot.call("calendar.get_event", other))).toBe("invalid");
		expect((await ada.call("calendar.get_event", { event_id: adaEvent.id })).event).toEqual(adaEvent);
	});

	it("needs calendar.read to read and calendar.write to change, for a key of a person and for an agent", async () => {
		await ada.call("calendar.create_event", standup);
		const range = { time_min: "2026-12-01T00:00:00Z", time_max: "2026-12-02T00:00:00Z" };
		const readOnly = api(
			(await ada.call("account.create_api_key", { label: "read", scopes: ["calendar.read"] })).api_key.secret,
		);
		expect((await readOnly("calendar.list_events", range)).events).toHaveLength(1);
		expect(await codeOf(readOnly("calendar.create_event", standup))).toBe("forbidden");
		const none = api(
			(await ada.call("account.create_api_key", { label: "mail", scopes: ["mail.read"] })).api_key.secret,
		);
		expect(await codeOf(none("calendar.list_events", range))).toBe("forbidden");

		// An agent from before Calendar has the account scopes that it got at creation.
		await setLegacyScopes(bot.id, ["account.read", "mail.read"]);
		expect(await codeOf(bot.call("calendar.list_events", range))).toBe("forbidden");
		const { missing_scopes } = await bot.call("account.whoami");
		expect(missing_scopes.find((entry) => entry.scope === "calendar.read")?.operations).toEqual([
			"calendar.list_events",
			"calendar.get_event",
		]);
	});

	it("gives an agent from before Calendar the calendar scopes that match its mail scopes, one time", async () => {
		const make = async (address: string, scopes: string[]) => {
			const agent = await createActor(owner, { kind: "agent", display_name: address, address, sponsor_id: ada.id });
			await setLegacyScopes(agent.id, scopes);
			return agent.id;
		};
		const both = await make("both@dock.test", ["account.read", "mail.read", "mail.modify"]);
		const read = await make("read@dock.test", ["mail.read"]);
		const neither = await make("neither@dock.test", ["account.read"]);
		const broken = await make("broken@dock.test", []);
		await env.DIRECTORY.prepare("UPDATE principals SET agent_scopes = 'not json' WHERE id = ?").bind(broken).run();
		const statements = calendarScopesMigration.split("--> statement-breakpoint");
		for (let run = 0; run < 2; run++) {
			await env.DIRECTORY.batch(statements.map((sql) => env.DIRECTORY.prepare(sql)));
		}
		const scopesOf = async (id: string) =>
			(
				await env.DIRECTORY.prepare("SELECT agent_scopes FROM principals WHERE id = ?").bind(id).first<{
					agent_scopes: string;
				}>()
			)?.agent_scopes;
		expect(JSON.parse((await scopesOf(both)) ?? "null")).toEqual([
			"account.read",
			"mail.read",
			"mail.modify",
			"calendar.read",
			"calendar.write",
		]);
		expect(JSON.parse((await scopesOf(read)) ?? "null")).toEqual(["mail.read", "calendar.read"]);
		expect(JSON.parse((await scopesOf(neither)) ?? "null")).toEqual(["account.read"]);
		expect(await scopesOf(broken)).toBe("not json");
	});
});
