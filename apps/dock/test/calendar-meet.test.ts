import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type InputOf, MEET_TOKEN_HEADER, meetCallPath } from "@asterra/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MeetingDO } from "../src/meet/meeting.ts";
import {
	type Actor,
	api,
	calendarOutbox,
	calendarStub,
	callTool,
	clearMeetSettings,
	codeOf,
	createActor,
	drainOutbox,
	fakeEmailService,
	fromBase64,
	ORIGIN,
	PASSWORD,
	seedOrg,
	setLegacyScopes,
	settleCalendars,
	signIn,
	withEnv,
} from "./helpers.ts";
import { fakeRealtime } from "./realtime-fake.ts";

// The Meet link of a calendar event. The calendar keeps the code with the event or the series. Its outbox makes the
// meeting in its MeetingDO, gives it the title, and cancels it when the link goes. The owner of the calendar is the
// host, also when a delegate adds the link.

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
	fakeRealtime();
});

type CreateInput = InputOf<"calendar.create_event">;

/** The result of `run`, and the audit lines that the Worker wrote while it ran. */
async function audited<T>(run: () => Promise<T>): Promise<{ result: T; lines: Record<string, unknown>[] }> {
	const spy = vi.spyOn(console, "log");
	try {
		const result = await run();
		const lines = spy.mock.calls
			.map(([line]) => (typeof line === "string" && line.startsWith("{") ? JSON.parse(line) : null))
			.filter((line): line is Record<string, unknown> => line?.audit === true);
		return { result, lines };
	} finally {
		spy.mockRestore();
	}
}

const review = (extra: Partial<CreateInput> = {}): CreateInput => ({
	title: "Design review",
	when: { kind: "timed", start: "2030-03-04T15:00:00Z", end: "2030-03-04T16:00:00Z", time_zone: "UTC" },
	meet: "create",
	...extra,
});

const MARCH = { time_min: "2030-03-01T00:00:00Z", time_max: "2030-04-01T00:00:00Z" } as const;

/** The state of a meeting for each person with its link: its title and its status, or the HTTP status. */
async function callInfo(code: string): Promise<{ status: number; title?: string; meeting?: string; origin?: string }> {
	const res = await withEnv({}, meetCallPath(code));
	if (!res.ok) return { status: res.status };
	const body = (await res.json()) as { title: string; status: string; origin: string };
	return { status: res.status, title: body.title, meeting: body.status, origin: body.origin };
}

async function joinAsGuest(code: string, name = "Casey Customer") {
	const res = await withEnv({}, `${meetCallPath(code)}/join`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ display_name: name }),
	});
	return { status: res.status, body: (await res.json().catch(() => null)) as { token: string } | null };
}

async function meetRows(principalId: string) {
	return (await calendarOutbox(principalId)).filter((row) => row.kind === "meet");
}

describe("the Meet link of an event", () => {
	it("gives a new event a link that the owner hosts, one room for each retry, and a title that follows the event", async () => {
		const input = review({ idempotency_key: "review-1" });
		const [first, second] = await Promise.all([
			ada.call("calendar.create_event", input),
			ada.call("calendar.create_event", input),
		]);
		const code = first.event.meet?.code as string;
		expect(first.event.meet).toEqual({ code, join_url: `${ORIGIN}/meet/${code}` });
		expect(second.event).toEqual(first.event);
		expect((await ada.call("calendar.create_event", input)).event.meet?.code).toBe(code);
		// The same key with a request without the link makes nothing.
		expect(await codeOf(ada.call("calendar.create_event", { ...input, meet: undefined }))).toBe("conflict");
		expect(await callInfo(code)).toEqual({ status: 200, title: "Design review", meeting: "open", origin: "calendar" });
		const { meeting } = await ada.call("meet.get_meeting", { code });
		expect(meeting).toMatchObject({ origin: "calendar", event_id: first.event.id, host: { principal_id: ada.id } });
		expect(await meetRows(ada.id)).toEqual([]);

		// Two calls that add a link at the same time give one code. A second create keeps the link and the revision.
		const { event: plain } = await ada.call("calendar.create_event", review({ meet: undefined, title: "Plain" }));
		const [a, b] = await Promise.all([
			ada.call("calendar.update_event", { event_id: plain.id, meet: "create" }),
			ada.call("calendar.update_event", { event_id: plain.id, meet: "create" }),
		]);
		expect(a.event.meet?.code).toBe(b.event.meet?.code);
		expect(Math.max(a.event.revision, b.event.revision)).toBe(plain.revision + 1);

		// A new title reaches the meeting. A private event gives its meeting no title: each person with the link sees it.
		await ada.call("calendar.update_event", { event_id: first.event.id, title: "Roadmap review" });
		expect((await callInfo(code)).title).toBe("Roadmap review");
		await ada.call("calendar.update_event", { event_id: first.event.id, visibility: "private" });
		expect((await callInfo(code)).title).toBe("");
	});

	it("needs meet.write for an explicit link, and is off without the Realtime secrets", async () => {
		const narrow = api(
			(await ada.call("account.create_api_key", { label: "cal", scopes: ["calendar.read", "calendar.write"] })).api_key
				.secret,
		);
		expect(await codeOf(narrow("calendar.create_event", review()))).toBe("forbidden");
		expect((await ada.call("calendar.list_events", MARCH)).events).toEqual([]);
		const { event } = await narrow("calendar.create_event", review({ meet: undefined }));
		expect(await codeOf(narrow("calendar.update_event", { event_id: event.id, meet: "create" }))).toBe("forbidden");
		const { event: linked } = await ada.call("calendar.update_event", { event_id: event.id, meet: "create" });
		expect(await codeOf(narrow("calendar.update_event", { event_id: event.id, meet: "remove" }))).toBe("forbidden");
		// The delete of the event needs no meet scope, and stops the link.
		await narrow("calendar.delete_event", { event_id: event.id });
		expect((await callInfo(linked.meet?.code as string)).meeting).toBe("cancelled");

		await clearMeetSettings();
		expect(await codeOf(ada.call("calendar.create_event", review({ title: "No Meet" })))).toBe("unavailable");
		expect((await ada.call("calendar.list_events", MARCH)).events).toEqual([]);
	});

	it("lets a delegate add a link to the events that it adds, never makes it the host, and hides the other links", async () => {
		const { event: own } = await ada.call("calendar.create_event", review({ title: "Ada only" }));
		await ada.call("calendar.set_grant", { principal_id: grace.id, access: "schedule" });
		await ada.call("calendar.set_grant", { principal_id: bot.id, access: "schedule" });

		const {
			result: { event: added },
			lines: made,
		} = await audited(() => grace.call("calendar.create_event", review({ calendar_id: ada.id })));
		const code = added.meet?.code as string;
		expect(added.created_by).toBe(grace.id);
		const { meeting } = await ada.call("meet.get_meeting", { code });
		expect(meeting.host.principal_id).toBe(ada.id);
		// The audit names the meeting that the link made, the delegate and the calendar.
		expect(made.filter((line) => line.op === "meet.create_meeting")).toEqual([
			expect.objectContaining({ actor: grace.id, calendar: ada.id, target: meeting.id, result: "ok" }),
		]);
		expect(await codeOf(grace.call("meet.get_meeting", { code }))).toBe("forbidden");
		expect(await codeOf(grace.call("meet.end_meeting", { code }))).toBe("forbidden");

		// An agent with the grant, through MCP. An agent from before Meet without meet.write cannot.
		const tool = await callTool(bot.key, "calendar_create_event", review({ calendar_id: ada.id, title: "Bot call" }));
		expect(tool.isError).toBeFalsy();
		await setLegacyScopes(bot.id, ["account.read", "calendar.read", "calendar.write"]);
		expect(await codeOf(bot.call("calendar.create_event", review({ calendar_id: ada.id })))).toBe("forbidden");

		// The delegate cannot change the link of an event of the owner, and does not read it.
		expect(
			await codeOf(grace.call("calendar.update_event", { event_id: own.id, calendar_id: ada.id, meet: "remove" })),
		).toBe("forbidden");
		const seen = await grace.call("calendar.list_events", { ...MARCH, calendar_id: ada.id });
		const byId = new Map(seen.events.map((event) => [event.id, event]));
		expect(byId.get(own.id)).toMatchObject({ redacted: true, meet: null });
		expect(byId.get(added.id)?.meet?.code).toBe(code);
		expect((await grace.call("calendar.get_event", { event_id: own.id, calendar_id: ada.id })).event.meet).toBeNull();

		// A service account with the grant. Its token holds the account scopes, with meet.write.
		const { principal: service } = await owner.call("directory.create_service_account", {
			display_name: "Scheduler",
			address: "scheduler@dock.test",
		});
		const { api_key } = await owner.call("account.create_api_key", { principal_id: service.id, label: "jobs" });
		await ada.call("calendar.set_grant", { principal_id: service.id, access: "schedule" });
		const { event: booked } = await api(api_key.secret)(
			"calendar.create_event",
			review({ calendar_id: ada.id, title: "Booked" }),
		);
		const bookedCode = booked.meet?.code as string;
		expect((await ada.call("meet.get_meeting", { code: bookedCode })).meeting.host.principal_id).toBe(ada.id);

		// The delete of the delegate cancels the meeting, and the audit names it.
		const { lines: cancelled } = await audited(() =>
			grace.call("calendar.delete_event", { event_id: added.id, calendar_id: ada.id }),
		);
		expect(cancelled.filter((line) => line.op === "meet.cancel_meeting")).toEqual([
			expect.objectContaining({ actor: grace.id, calendar: ada.id, target: meeting.id, result: "ok" }),
		]);

		// A grant of busy times only gives no event at all.
		await ada.call("calendar.set_grant", { principal_id: grace.id, access: "free_busy" });
		expect(await codeOf(grace.call("calendar.create_event", review({ calendar_id: ada.id })))).toBe("forbidden");
	});

	it("keeps the link of a series for each occurrence, a move and a cancelled occurrence, and gives it to an attendee", async () => {
		const { event: series } = await ada.call(
			"calendar.create_event",
			review({ title: "Daily", recurrence: { frequency: "daily", interval: 1, count: 5 }, attendee_ids: [grace.id] }),
		);
		const code = series.meet?.code as string;
		const first = await ada.call("calendar.list_events", MARCH);
		const occurrences = first.events.filter((event) => event.id === series.id);
		expect(occurrences).toHaveLength(5);
		expect(new Set(occurrences.map((event) => event.meet?.code))).toEqual(new Set([code]));

		const [one, two] = occurrences;
		await ada.call("calendar.update_occurrence", {
			occurrence_id: one?.occurrence_id as string,
			when: { kind: "timed", start: "2030-03-04T17:00:00Z", end: "2030-03-04T18:00:00Z", time_zone: "UTC" },
		});
		await ada.call("calendar.cancel_occurrence", { occurrence_id: two?.occurrence_id as string });
		await ada.call("calendar.update_event", {
			event_id: series.id,
			when: { kind: "timed", start: "2030-03-04T09:00:00Z", end: "2030-03-04T10:00:00Z", time_zone: "UTC" },
		});
		const after = (await ada.call("calendar.list_events", MARCH)).events.filter((event) => event.id === series.id);
		expect(new Set(after.map((event) => event.meet?.code))).toEqual(new Set([code]));
		expect(await callInfo(code)).toMatchObject({ meeting: "open" });
		expect((await joinAsGuest(code)).status).toBe(201);

		// The copy of an attendee of the organization has the link.
		await settleCalendars(ada.id, grace.id);
		const copy = (await grace.call("calendar.get_event", { event_id: series.id })).event;
		expect(copy).toMatchObject({ role: "attendee", meet: { code } });
		// A removed link leaves the copy too.
		await ada.call("calendar.update_event", { event_id: series.id, meet: "remove" });
		await settleCalendars(ada.id, grace.id);
		expect((await grace.call("calendar.get_event", { event_id: series.id })).event.meet).toBeNull();
	});

	it("stops the link for a removed link or a deleted event: each participant leaves, and nobody joins again", async () => {
		const { event } = await ada.call("calendar.create_event", review());
		const code = event.meet?.code as string;
		const guest = await joinAsGuest(code);
		const { event: removed } = await ada.call("calendar.update_event", { event_id: event.id, meet: "remove" });
		expect(removed.meet).toBeNull();
		expect(await callInfo(code)).toMatchObject({ meeting: "cancelled" });
		expect((await joinAsGuest(code)).status).toBe(409);
		const state = await withEnv({}, `${meetCallPath(code)}/state`, {
			headers: { [MEET_TOKEN_HEADER]: guest.body?.token as string },
		});
		expect(((await state.json()) as { self: { end_reason: string } }).self.end_reason).toBe("cancelled");
		// "remove" again changes nothing. A new link is a new code, and the old one stays cancelled.
		const again = await ada.call("calendar.update_event", { event_id: event.id, meet: "remove" });
		expect(again.event.revision).toBe(removed.revision);
		const { event: relinked } = await ada.call("calendar.update_event", { event_id: event.id, meet: "create" });
		const next = relinked.meet?.code as string;
		expect(next).not.toBe(code);
		expect(await callInfo(code)).toMatchObject({ meeting: "cancelled" });
		await ada.call("calendar.delete_event", { event_id: event.id });
		expect(await callInfo(next)).toMatchObject({ meeting: "cancelled" });
	});

	it("sends a change of a meeting that failed from the alarm, and never opens a link that the event lost", async () => {
		const ensure = vi.spyOn(MeetingDO.prototype, "ensureForEvent").mockRejectedValueOnce(new Error("down"));
		const { event } = await ada.call("calendar.create_event", review());
		const code = event.meet?.code as string;
		expect(ensure).toHaveBeenCalledTimes(1);
		// The call returned the event with its link. The meeting waits in the outbox, with an alarm.
		expect((await meetRows(ada.id)).map((row) => row.id)).toEqual([`meet:${code}`]);
		// The alarm of the change feed can run now: getAlarm is null while a handler runs. The row keeps an alarm.
		await vi.waitFor(async () => {
			const alarm = await runInDurableObject(calendarStub(ada.id), (_instance, state) => state.storage.getAlarm());
			expect(alarm).not.toBeNull();
		});
		expect((await callInfo(code)).status).toBe(404);
		await settleCalendars(ada.id);
		expect(await callInfo(code)).toMatchObject({ meeting: "open" });

		// A failed make, then a removed link: the alarm finds no link, and cancels a code that never had a room.
		ensure.mockRejectedValueOnce(new Error("down"));
		const { event: late } = await ada.call("calendar.create_event", review({ title: "Late" }));
		const lateCode = late.meet?.code as string;
		const cancel = vi.spyOn(MeetingDO.prototype, "cancelForEvent").mockRejectedValueOnce(new Error("down"));
		await ada.call("calendar.update_event", { event_id: late.id, meet: "remove" });
		expect(cancel).toHaveBeenCalledTimes(1);
		await settleCalendars(ada.id);
		expect(await callInfo(lateCode)).toMatchObject({ meeting: "cancelled" });
		// A late make of that meeting does not open it again.
		const stub = env.MEETING.get(env.MEETING.idFromName(lateCode));
		await stub.ensureForEvent({
			id: "mtg_01M8CWB37GFFQSG2KQ9YEFTPT6",
			code: lateCode,
			hostId: ada.id,
			hostName: "Ada Lovelace",
			title: "Late",
			origin: "calendar",
			eventId: late.id,
			createdBy: ada.id,
		});
		expect(await callInfo(lateCode)).toMatchObject({ meeting: "cancelled" });
		expect((await joinAsGuest(lateCode)).status).toBe(409);
	});

	it("returns the view of its own change when a delete runs while the meeting is made", async () => {
		const { event } = await ada.call("calendar.create_event", review({ meet: undefined }));
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started = () => {};
		const waiting = new Promise<void>((resolve) => {
			started = resolve;
		});
		// The prototype can hold the spy of an earlier test. Its default calls the real method.
		const original = MeetingDO.prototype.ensureForEvent;
		vi.spyOn(MeetingDO.prototype, "ensureForEvent").mockImplementationOnce(async function (this: MeetingDO, input) {
			started();
			await gate;
			return original.call(this, input);
		});
		const linking = ada.call("calendar.update_event", { event_id: event.id, meet: "create" });
		await waiting;
		// The update waits on the meeting. The input gate is open, so the delete runs now.
		await ada.call("calendar.delete_event", { event_id: event.id });
		release();
		const { event: linked } = await linking;
		expect(linked).toMatchObject({ id: event.id, revision: event.revision + 1 });
		const code = linked.meet?.code as string;
		await settleCalendars(ada.id);
		expect(await callInfo(code)).toMatchObject({ meeting: "cancelled" });
	});

	it("puts the link in the invitation by mail, and an update without it after a removal", async () => {
		await fakeEmailService(ada.id);
		const title = "<img src=x onerror=1>; a,b";
		const { event } = await ada.call(
			"calendar.create_event",
			review({ title, attendee_emails: ["guest@partner.example"] }),
		);
		const url = event.meet?.join_url as string;
		await settleCalendars(ada.id);
		await drainOutbox(ada.id);
		const sent = await sentMail(ada);
		expect(sent).toHaveLength(1);
		const ics = (sent[0]?.ics ?? "").replace(/\r?\n[ \t]/g, "");
		expect(ics).toContain(`CONFERENCE;VALUE=URI;FEATURE=AUDIO,VIDEO;LABEL=Join the meeting:${url}`);
		expect(ics).toContain(`LOCATION:${url}`);
		expect(ics).toContain(`DESCRIPTION:Join the meeting: ${url}`);
		expect(ics).toContain("SUMMARY:<img src=x onerror=1>\\; a\\,b");
		expect(sent[0]?.text).toContain(`Join the meeting: ${url}`);
		// Each line of the file has at most 75 octets.
		expect((sent[0]?.ics ?? "").split(/\r?\n/).filter((line) => new TextEncoder().encode(line).length > 75)).toEqual(
			[],
		);

		await ada.call("calendar.update_event", { event_id: event.id, meet: "remove" });
		await settleCalendars(ada.id);
		await drainOutbox(ada.id);
		const update = (await sentMail(ada)).at(-1);
		expect(update?.subject.startsWith("Updated invitation")).toBe(true);
		expect(update?.ics).not.toContain("CONFERENCE");
		expect(update?.text).not.toContain("Join the meeting");
	});
});

describe("the meeting of a calendar event", () => {
	it("does not end for lack of activity, and the end of the host stops the call and keeps the link", async () => {
		const { event } = await ada.call("calendar.create_event", review());
		const code = event.meet?.code as string;
		const stub = env.MEETING.get(env.MEETING.idFromName(code));
		// An open meeting of an event with nobody in it has no alarm: the calendar owns its life.
		await runInDurableObject(stub, async (_instance, state) => {
			expect(await state.storage.getAlarm()).toBeNull();
		});
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec("UPDATE meeting SET last_activity_at = 0");
		});
		await runDurableObjectAlarm(stub);
		expect(await callInfo(code)).toMatchObject({ meeting: "open" });

		const cookie = await signIn("ada@dock.test");
		const host = await withEnv({}, `${meetCallPath(code)}/join`, {
			method: "POST",
			headers: { "content-type": "application/json", cookie, origin: ORIGIN },
			body: "{}",
		});
		expect(host.status).toBe(201);
		const guest = await joinAsGuest(code);
		const { meeting } = await ada.call("meet.end_meeting", { code });
		expect(meeting).toMatchObject({ status: "open", waiting: 0, admitted: 0 });
		const state = await withEnv({}, `${meetCallPath(code)}/state`, {
			headers: { [MEET_TOKEN_HEADER]: guest.body?.token as string },
		});
		expect(((await state.json()) as { self: { state: string; end_reason: string } }).self).toMatchObject({
			state: "left",
			end_reason: "ended",
		});
		// The link works again, for the next occurrence of a series.
		expect((await joinAsGuest(code, "Next Week")).status).toBe(201);
	});
});

/** The mail that an actor sent, with the text part and the iCalendar file, oldest first. */
async function sentMail(actor: Actor): Promise<{ subject: string; text: string; ics: string }[]> {
	const { threads } = await actor.call("mail.list_threads", { query: "in:sent" });
	const out: { subject: string; text: string; ics: string; at: string }[] = [];
	for (const thread of threads) {
		const { messages } = await actor.call("mail.get_thread", { thread_id: thread.id });
		for (const message of messages) {
			const part = message.attachments.find((attachment) => attachment.mime_type.startsWith("text/calendar"));
			if (!part) continue;
			const { content_base64 } = await actor.call("mail.get_attachment", { message_id: message.id, index: part.index });
			out.push({
				subject: message.subject,
				text: message.body.text ?? "",
				ics: fromBase64(content_base64),
				at: message.received_at,
			});
		}
	}
	return out.sort((a, b) => a.at.localeCompare(b.at)).map(({ at: _at, ...rest }) => rest);
}
