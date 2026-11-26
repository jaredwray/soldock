import { type InputOf, OWN_KEY_SCOPES } from "@asterra/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Actor, api, codeOf, createActor, PASSWORD, seedOrg, setLegacyScopes } from "./helpers.ts";

// The grants of a calendar: the owner lets a person, an agent or a service account see the busy times
// (free_busy) or schedule (schedule). The object of the calendar checks the grant on each call, so a removed
// grant ends the access at once. An owner or an admin gets no access without a grant.

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

const meeting = (title: string, start: string, end: string, extra: Partial<CreateInput> = {}): CreateInput => ({
	title,
	when: { kind: "timed", start, end, time_zone: "UTC" },
	...extra,
});

const DAY = { time_min: "2030-03-04T00:00:00Z", time_max: "2030-03-05T00:00:00Z" } as const;

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

/** A key of a person with these scopes only. */
async function narrowKey(actor: Actor, scopes: InputOf<"account.create_api_key">["scopes"]) {
	return api((await actor.call("account.create_api_key", { label: "narrow", scopes })).api_key.secret);
}

/** A new service account and its token. */
async function serviceAccount() {
	const { principal } = await owner.call("directory.create_service_account", {
		display_name: "Scheduler",
		address: "scheduler@dock.test",
	});
	const { api_key } = await owner.call("account.create_api_key", { principal_id: principal.id, label: "token" });
	return { id: principal.id, call: api(api_key.secret) };
}

describe("the grants of a calendar", () => {
	it("lets the owner give, change and remove a grant, and audits only a change", async () => {
		expect(await ada.call("calendar.list_grants")).toEqual({ grants: [] });
		const lines = await auditLines(async () => {
			await ada.call("calendar.set_grant", { principal_id: bot.id, access: "free_busy" });
			await ada.call("calendar.set_grant", { principal_id: bot.id, access: "free_busy" });
			await ada.call("calendar.set_grant", { principal_id: bot.id, access: "schedule" });
			await ada.call("calendar.set_grant", { principal_id: grace.id, access: "free_busy" });
		});
		expect(lines.map((line) => [line.op, line.target])).toEqual([
			["calendar.set_grant", `${bot.id}:free_busy`],
			["calendar.set_grant", `${bot.id}:schedule`],
			["calendar.set_grant", `${grace.id}:free_busy`],
		]);
		const { grants } = await ada.call("calendar.list_grants");
		expect(grants.map((grant) => [grant.principal_id, grant.access])).toEqual([
			[bot.id, "schedule"],
			[grace.id, "free_busy"],
		]);
		const removed = await auditLines(async () => {
			await ada.call("calendar.remove_grant", { principal_id: bot.id });
			await ada.call("calendar.remove_grant", { principal_id: bot.id });
		});
		expect(removed.map((line) => line.op)).toEqual(["calendar.remove_grant"]);
		expect((await ada.call("calendar.list_grants")).grants.map((grant) => grant.principal_id)).toEqual([grace.id]);
	});

	it("refuses a grant to the owner, to an unknown principal, and a grant by an agent", async () => {
		expect(await codeOf(ada.call("calendar.set_grant", { principal_id: ada.id, access: "schedule" }))).toBe("invalid");
		const unknown = "prn_01JD0000000000000000000099";
		expect(await codeOf(ada.call("calendar.set_grant", { principal_id: unknown, access: "schedule" }))).toBe(
			"not_found",
		);
		// Only a person gives grants: an agent can never widen its own access.
		expect(await codeOf(bot.call("calendar.set_grant", { principal_id: grace.id, access: "schedule" }))).toBe(
			"forbidden",
		);
		expect(await codeOf(bot.call("calendar.list_grants"))).toBe("forbidden");
	});

	it("needs calendar.share, and gives no access that the credential does not hold", async () => {
		expect(OWN_KEY_SCOPES).toContain("calendar.share");
		const noShare = await narrowKey(ada, ["calendar.read", "calendar.write"]);
		expect(await codeOf(noShare("calendar.set_grant", { principal_id: bot.id, access: "free_busy" }))).toBe(
			"forbidden",
		);
		const readShare = await narrowKey(ada, ["calendar.read", "calendar.share"]);
		expect(await codeOf(readShare("calendar.set_grant", { principal_id: bot.id, access: "schedule" }))).toBe(
			"forbidden",
		);
		await readShare("calendar.set_grant", { principal_id: bot.id, access: "free_busy" });
		// An owner or an admin cannot make a key of a different person that gives grants.
		expect(
			await codeOf(
				owner.call("account.create_api_key", { principal_id: ada.id, label: "x", scopes: ["calendar.share"] }),
			),
		).toBe("forbidden");
	});
});

describe("who schedules in the calendar of a different person", () => {
	it("lets only a principal with schedule access use calendar_id, for each kind of caller", async () => {
		const service = await serviceAccount();
		const callers = [
			["a person", grace.id, grace.call],
			["an agent", bot.id, bot.call],
			["a service account", service.id, service.call],
		] as const;
		for (const [label, id, call] of callers) {
			const create = () =>
				call(
					"calendar.create_event",
					meeting(label, "2030-03-04T10:00:00Z", "2030-03-04T11:00:00Z", { calendar_id: ada.id }),
				);
			const list = () => call("calendar.list_events", { ...DAY, calendar_id: ada.id });
			expect(await codeOf(create()), `${label} without a grant`).toBe("forbidden");
			expect(await codeOf(list()), `${label} without a grant`).toBe("forbidden");
			await ada.call("calendar.set_grant", { principal_id: id, access: "free_busy" });
			expect(await codeOf(create()), `${label} with free_busy`).toBe("forbidden");
			expect(await codeOf(list()), `${label} with free_busy`).toBe("forbidden");
			await ada.call("calendar.set_grant", { principal_id: id, access: "schedule" });
			const { event } = await create();
			expect(event, label).toMatchObject({ calendar_id: ada.id, organizer_id: ada.id, created_by: id });
			await call("calendar.update_event", { event_id: event.id, calendar_id: ada.id, location: "Room 4" });
			await call("calendar.delete_event", { event_id: event.id, calendar_id: ada.id });
		}
	});

	it("gives an owner, an admin and the sponsor of an agent no access without a grant", async () => {
		const { event } = await ada.call(
			"calendar.create_event",
			meeting("Private plan", "2030-03-04T10:00:00Z", "2030-03-04T11:00:00Z"),
		);
		expect(await codeOf(owner.call("calendar.get_event", { event_id: event.id, calendar_id: ada.id }))).toBe(
			"forbidden",
		);
		// The calendar of an agent takes no grant, so it is no target, also for its sponsor.
		expect(await codeOf(ada.call("calendar.list_events", { ...DAY, calendar_id: bot.id }))).toBe("not_found");
		expect(
			await codeOf(ada.call("calendar.list_events", { ...DAY, calendar_id: "prn_01JD0000000000000000000099" })),
		).toBe("not_found");
		// The grant of an archived person does not count while the person is archived.
		await grace.call("calendar.set_grant", { principal_id: ada.id, access: "schedule" });
		expect((await ada.call("calendar.list_events", { ...DAY, calendar_id: grace.id })).events).toEqual([]);
		await owner.call("directory.archive_principal", { principal_id: grace.id });
		expect(await codeOf(ada.call("calendar.list_events", { ...DAY, calendar_id: grace.id }))).toBe("not_found");
	});

	it("keeps the scopes of a key of a person: a delegated key without calendar.write cannot schedule", async () => {
		await ada.call("calendar.set_grant", { principal_id: grace.id, access: "schedule" });
		const readOnly = await narrowKey(grace, ["calendar.read"]);
		expect((await readOnly("calendar.list_events", { ...DAY, calendar_id: ada.id })).events).toEqual([]);
		expect(
			await codeOf(
				readOnly(
					"calendar.create_event",
					meeting("Sync", "2030-03-04T10:00:00Z", "2030-03-04T11:00:00Z", { calendar_id: ada.id }),
				),
			),
		).toBe("forbidden");
	});

	it("lets the grant alone decide for an agent, as for a mailbox delegate", async () => {
		// An agent from before Calendar has no calendar scope: its own calendar is closed to it.
		await setLegacyScopes(bot.id, ["account.read", "mail.read"]);
		expect(await codeOf(bot.call("calendar.list_events", DAY))).toBe("forbidden");
		await ada.call("calendar.set_grant", { principal_id: bot.id, access: "schedule" });
		const { event } = await bot.call(
			"calendar.create_event",
			meeting("Sync", "2030-03-04T10:00:00Z", "2030-03-04T11:00:00Z", { calendar_id: ada.id }),
		);
		expect(event.created_by).toBe(bot.id);
		expect(await codeOf(bot.call("calendar.list_events", DAY))).toBe("forbidden");
	});
});

describe("what a delegate sees", () => {
	it("shows the time of each event, the title of an event that is not private, and all of its own events", async () => {
		await ada.call("calendar.create_event", {
			...meeting("Board review", "2030-03-04T09:00:00Z", "2030-03-04T10:00:00Z"),
			description: "Numbers for Q1",
			location: "Room 1",
			attendees: [grace.id],
		});
		await ada.call("calendar.create_event", {
			...meeting("Doctor", "2030-03-04T12:00:00Z", "2030-03-04T13:00:00Z"),
			description: "Second visit",
			location: "Clinic",
			visibility: "private",
		});
		await ada.call("calendar.set_grant", { principal_id: bot.id, access: "schedule" });
		const { event: own } = await bot.call("calendar.create_event", {
			...meeting("Planning", "2030-03-04T15:00:00Z", "2030-03-04T16:00:00Z"),
			description: "Agenda",
			calendar_id: ada.id,
			visibility: "private",
		});

		const { events } = await bot.call("calendar.list_events", { ...DAY, calendar_id: ada.id });
		expect(
			events.map((event) => [event.title, event.description, event.location, event.attendees, event.redacted]),
		).toEqual([
			["Board review", "", "", [], true],
			["", "", "", [], true],
			["Planning", "Agenda", "", [], false],
		]);
		const text = JSON.stringify(events);
		for (const secret of ["Numbers for Q1", "Room 1", grace.id, "Doctor", "Second visit", "Clinic"]) {
			expect(text).not.toContain(secret);
		}
		// REST gives the same form, and the delegate cannot change an event that it did not add.
		const [board, doctor] = events;
		expect((await bot.call("calendar.get_event", { event_id: doctor?.id ?? "", calendar_id: ada.id })).event).toEqual(
			doctor,
		);
		expect(
			await codeOf(
				bot.call("calendar.update_event", { event_id: board?.id ?? "", calendar_id: ada.id, title: "Mine" }),
			),
		).toBe("forbidden");
		expect(await codeOf(bot.call("calendar.delete_event", { event_id: board?.id ?? "", calendar_id: ada.id }))).toBe(
			"forbidden",
		);
		// The owner sees each field of each event, also of the event of the delegate.
		const mine = await ada.call("calendar.list_events", DAY);
		expect(mine.events.map((event) => [event.title, event.redacted])).toEqual([
			["Board review", false],
			["Doctor", false],
			["Planning", false],
		]);
		expect(mine.events.find((event) => event.id === own.id)?.created_by).toBe(bot.id);
	});
});

describe("the end of a grant", () => {
	it("refuses the next call of the delegate at once, and audits the refused change", async () => {
		await ada.call("calendar.set_grant", { principal_id: bot.id, access: "schedule" });
		const { event } = await bot.call(
			"calendar.create_event",
			meeting("Sync", "2030-03-04T10:00:00Z", "2030-03-04T11:00:00Z", { calendar_id: ada.id }),
		);
		await ada.call("calendar.remove_grant", { principal_id: bot.id });
		const lines = await auditLines(async () => {
			expect(
				await codeOf(
					bot.call(
						"calendar.create_event",
						meeting("Again", "2030-03-04T12:00:00Z", "2030-03-04T13:00:00Z", { calendar_id: ada.id }),
					),
				),
			).toBe("forbidden");
		});
		expect(lines).toEqual([expect.objectContaining({ op: "calendar.create_event", actor: bot.id, result: "denied" })]);
		expect(
			await codeOf(bot.call("calendar.update_event", { event_id: event.id, calendar_id: ada.id, title: "x" })),
		).toBe("forbidden");
		expect(await codeOf(bot.call("calendar.delete_event", { event_id: event.id, calendar_id: ada.id }))).toBe(
			"forbidden",
		);
		expect(await codeOf(bot.call("calendar.list_events", { ...DAY, calendar_id: ada.id }))).toBe("forbidden");
		// The events that the delegate added stay.
		expect((await ada.call("calendar.get_event", { event_id: event.id })).event.title).toBe("Sync");
	});
});

describe("the audit of a delegate", () => {
	it("names the delegate as the actor and the owner as the calendar", async () => {
		await ada.call("calendar.set_grant", { principal_id: bot.id, access: "schedule" });
		const delegated = await auditLines(() =>
			bot.call(
				"calendar.create_event",
				meeting("Sync", "2030-03-04T10:00:00Z", "2030-03-04T11:00:00Z", { calendar_id: ada.id }),
			),
		);
		expect(delegated).toEqual([
			expect.objectContaining({ op: "calendar.create_event", actor: bot.id, actorKind: "agent", calendar: ada.id }),
		]);
		const own = await auditLines(() =>
			ada.call("calendar.create_event", meeting("Mine", "2030-03-04T12:00:00Z", "2030-03-04T13:00:00Z")),
		);
		expect(own).toHaveLength(1);
		expect(own[0]).not.toHaveProperty("calendar");
	});
});
