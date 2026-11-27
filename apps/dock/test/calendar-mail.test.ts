import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { CalendarChange, CalendarEvent, InputOf } from "@asterra/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import appleAllDay from "../../../fixtures/calendar/apple-request-all-day.ics?raw";
import googleCancel from "../../../fixtures/calendar/google-cancel.ics?raw";
import googleReply from "../../../fixtures/calendar/google-reply-accepted.ics?raw";
import googleTimed from "../../../fixtures/calendar/google-request-timed.ics?raw";
import googleUpdate from "../../../fixtures/calendar/google-update-timed.ics?raw";
import outlookTentative from "../../../fixtures/calendar/outlook-reply-tentative.ics?raw";
import outlookTimed from "../../../fixtures/calendar/outlook-request-timed.ics?raw";
import recurring from "../../../fixtures/calendar/recurring-request.ics?raw";
import type { CalendarDO } from "../src/calendar/calendar.ts";
import { type ICalInvite, parseICalendar } from "../src/calendar/ical.ts";
import { storedTime } from "../src/calendar/time.ts";
import { sendCalendarMail } from "../src/mail/index.ts";
import {
	type Actor,
	api,
	base64,
	calendarOutbox,
	calendarStub,
	callTool,
	codeOf,
	drainOutbox,
	type FakeEmailService,
	fakeEmailService,
	fromBase64,
	inject,
	seedOrg,
	settleCalendars,
} from "./helpers.ts";

let owner: Actor;
let ada: Actor;
let bot: Actor;

beforeEach(async () => {
	({ owner, ada, bot } = await seedOrg());
});

const RANGE = { time_min: "2026-11-01T00:00:00Z", time_max: "2027-01-31T00:00:00Z" } as const;

const meeting = (emails: string[], attendeeIds: string[] = []): InputOf<"calendar.create_event"> => ({
	title: "Design review",
	when: { kind: "timed", start: "2026-12-03T15:00:00Z", end: "2026-12-03T16:00:00Z", time_zone: "UTC" },
	location: "Room 4",
	attendee_emails: emails,
	attendee_ids: attendeeIds,
});

/** Pauses the deliveries of the mailbox of a principal, as a directory reset does, or starts them again. */
function pauseMailbox(principalId: string, on: boolean) {
	return runInDurableObject(env.MAILBOX.get(env.MAILBOX.idFromName(principalId)), (_instance, state) => {
		if (on) state.storage.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('delivery_pause', '1')");
		else state.storage.sql.exec("DELETE FROM meta WHERE key = 'delivery_pause'");
	});
}

/** The messages by mail that wait in the outbox of a calendar. */
async function waitingMail(principalId: string) {
	return (await calendarOutbox(principalId)).filter((row) => row.kind === "mail");
}

/** Waits until the calendar of Ada tried one time to send a message to the paused mailbox. */
async function firstAttempt() {
	await vi.waitFor(async () => expect((await waitingMail(ada.id))[0]?.attempts).toBe(1));
}

/** A key of Ada with the calendar scopes and these scopes, and without mail.send. */
async function calendarOnlyKey(more: readonly ("mail.read" | "mail.modify")[] = []) {
	return api(
		(
			await ada.call("account.create_api_key", {
				label: "cal",
				scopes: ["calendar.read", "calendar.write", ...more],
			})
		).api_key.secret,
	);
}

/** The changes of the calendar of an actor after a cursor, oldest first. */
async function changesAfter(actor: Actor, cursor: string): Promise<CalendarChange[]> {
	return (await actor.call("calendar.list_changes", { cursor })).changes;
}

/** A DMARC pass for the domain of an address, as the receiving server records it. */
const pass = (address: string) => {
	const domain = address.split("@")[1];
	return `mx.cloudflare.net; spf=pass smtp.mailfrom=${domain}; dkim=pass header.d=${domain}; dmarc=pass header.from=${domain}`;
};

let mails = 0;

/**
 * An iTIP mail as a client writes it: a text part and a `text/calendar` part with the method in
 * `multipart/alternative`. The calendar part is base64 UTF-8. `auth` is the Authentication-Results header.
 */
function invitationMail(input: {
	from: string;
	to: string;
	subject: string;
	ics: string;
	auth?: string | null;
}): string {
	mails++;
	const method = /METHOD:(\w+)/.exec(input.ics)?.[1] ?? "REQUEST";
	const lines = [
		...(input.auth === null ? [] : [`Authentication-Results: ${input.auth ?? pass(input.from)}`]),
		`From: ${input.from}`,
		`To: ${input.to}`,
		`Subject: ${input.subject}`,
		`Date: ${new Date().toUTCString()}`,
		`Message-ID: <invite-${mails}-${Math.random().toString(36).slice(2)}@sender.example>`,
		"MIME-Version: 1.0",
		`Content-Type: multipart/alternative; boundary="alt${mails}"`,
		"",
		`--alt${mails}`,
		"Content-Type: text/plain; charset=utf-8",
		"",
		"You have an invitation.",
		`--alt${mails}`,
		`Content-Type: text/calendar; charset=utf-8; method=${method}`,
		"Content-Transfer-Encoding: base64",
		"",
		...(base64(input.ics).match(/.{1,76}/g) ?? []),
		`--alt${mails}--`,
		"",
	];
	return lines.join("\r\n");
}

/** Sets DTSTAMP to a time, so a reply is newer than the invitation of the test. */
const stamped = (ics: string, ms: number) =>
	ics.replace(
		/DTSTAMP:\d{8}T\d{6}Z/,
		`DTSTAMP:${new Date(ms)
			.toISOString()
			.replace(/[-:]/g, "")
			.replace(/\.\d{3}/, "")}`,
	);

/** The message of a thread of an actor with this subject, newest first. */
async function messageWith(actor: Actor, subject: string, query = "in:anywhere"): Promise<string> {
	const { threads } = await actor.call("mail.list_threads", { query });
	const thread = threads.find((item) => item.subject === subject);
	if (!thread) throw new Error(`no thread ${subject}`);
	const { messages } = await actor.call("mail.get_thread", { thread_id: thread.id });
	return messages.at(-1)?.id as string;
}

/** The calendar parts of the mail that an actor sent, oldest first, with the subject and the recipient. */
async function sentInvites(actor: Actor): Promise<{ subject: string; to: string; ical: ICalInvite; raw: string }[]> {
	const { threads } = await actor.call("mail.list_threads", { query: "in:sent" });
	const out: { subject: string; to: string; ical: ICalInvite; raw: string; at: string }[] = [];
	for (const thread of threads) {
		const { messages } = await actor.call("mail.get_thread", { thread_id: thread.id });
		for (const message of messages) {
			const part = message.attachments.find((attachment) => attachment.mime_type.startsWith("text/calendar"));
			if (!part) continue;
			const { content_base64 } = await actor.call("mail.get_attachment", { message_id: message.id, index: part.index });
			const raw = fromBase64(content_base64);
			out.push({
				subject: message.subject,
				to: message.to[0]?.address ?? "",
				ical: parseICalendar(raw) as ICalInvite,
				raw,
				at: message.received_at,
			});
		}
	}
	return out.sort((a, b) => a.at.localeCompare(b.at)).map(({ at: _at, ...rest }) => rest);
}

/** Delivers each waiting message of these calendars, then each queued mail of the mailboxes. */
async function deliverAll(...ids: string[]) {
	await settleCalendars(...ids);
	for (const id of ids) await drainOutbox(id);
}

async function eventsOf(actor: Actor): Promise<CalendarEvent[]> {
	return (await actor.call("calendar.list_events", RANGE)).events;
}

describe("invitations by mail to addresses outside the organization", () => {
	let email: FakeEmailService;
	beforeEach(async () => {
		email = await fakeEmailService(ada.id);
	});

	it("sends a standard iCalendar invitation for a timed and an all-day meeting", async () => {
		const { event } = await ada.call("calendar.create_event", meeting(["Guest@Partner.example"], [owner.id]));
		expect(event.external_attendees).toEqual([
			{ email: "guest@partner.example", display_name: "guest@partner.example", response: "needs_action" },
		]);
		expect(event.attendees.map((attendee) => [attendee.principal_id, attendee.response])).toEqual([
			[owner.id, "needs_action"],
		]);
		await deliverAll(ada.id, owner.id);
		expect(email.sent).toEqual([{ from: "ada@dock.test", to: "guest@partner.example" }]);
		const [sent] = await sentInvites(ada);
		expect(sent?.subject).toBe("Invitation: Design review");
		expect(sent?.ical).toMatchObject({
			method: "REQUEST",
			uid: event.id,
			title: "Design review",
			location: "Room 4",
			when: { kind: "timed", start: "2026-12-03T15:00:00.000Z", end: "2026-12-03T16:00:00.000Z" },
			organizer: { email: "ada@dock.test", name: "Ada Lovelace" },
			// The REQUEST lists the attendees by mail only: the calendar has no address of the attendees inside.
			attendees: [{ email: "guest@partner.example", partstat: "NEEDS-ACTION" }],
		});
		// A long line is folded. The read of a text part gives LF line ends: mime.test.ts checks the CRLF of the bytes.
		expect(sent?.raw.replace(/\r?\n[ \t]/g, "")).toContain("RSVP=TRUE:mailto:guest@partner.example");
		// The internal attendee gets a copy on the calendar, and no mail.
		const [copy] = await eventsOf(owner);
		expect(copy).toMatchObject({ id: event.id, role: "attendee", external_attendees: [], untrusted: false });

		const { event: allDay } = await ada.call("calendar.create_event", {
			title: "Offsite",
			when: { kind: "all_day", start_date: "2026-12-10", end_date: "2026-12-12" },
			attendee_emails: ["guest@partner.example"],
		});
		await deliverAll(ada.id);
		const last = (await sentInvites(ada)).at(-1);
		expect(last?.raw).toMatch(/DTSTART;VALUE=DATE:20261210\r?\nDTEND;VALUE=DATE:20261212\r?\n/);
		expect(last?.ical).toMatchObject({
			uid: allDay.id,
			when: { kind: "all_day", start_date: "2026-12-10", end_date: "2026-12-12" },
		});
	});

	it("keeps the UID for a change and a cancellation, and sends no mail for an answer inside the organization", async () => {
		const { event } = await ada.call(
			"calendar.create_event",
			meeting(["one@partner.example", "two@partner.example"], [owner.id]),
		);
		await deliverAll(ada.id, owner.id);
		await ada.call("calendar.update_event", {
			event_id: event.id,
			when: { kind: "timed", start: "2026-12-04T17:00:00Z", end: "2026-12-04T18:00:00Z", time_zone: "UTC" },
		});
		await deliverAll(ada.id, owner.id);
		await owner.call("calendar.respond_to_event", { event_id: event.id, response: "accepted" });
		await deliverAll(owner.id, ada.id);
		expect(email.sent).toHaveLength(4);
		// A change that an attendee by mail does not see sends no mail.
		await ada.call("calendar.update_event", { event_id: event.id, visibility: "private" });
		await deliverAll(ada.id, owner.id);
		expect(email.sent).toHaveLength(4);

		await ada.call("calendar.update_event", { event_id: event.id, attendee_emails: ["one@partner.example"] });
		await deliverAll(ada.id, owner.id);
		await ada.call("calendar.delete_event", { event_id: event.id });
		await deliverAll(ada.id, owner.id);

		const sent = await sentInvites(ada);
		const sequences = sent.map((item) => item.ical.sequence);
		expect(sent.every((item) => item.ical.uid === event.id)).toBe(true);
		expect(sent.slice(0, 4).map((item) => [item.ical.method, item.to, item.subject])).toEqual([
			["REQUEST", "one@partner.example", "Invitation: Design review"],
			["REQUEST", "two@partner.example", "Invitation: Design review"],
			["REQUEST", "one@partner.example", "Updated invitation: Design review"],
			["REQUEST", "two@partner.example", "Updated invitation: Design review"],
		]);
		// The removal of an attendee: a cancellation to that address only, and the new list to the other one.
		expect(sent.slice(4, 6).map((item) => [item.ical.method, item.to])).toEqual(
			expect.arrayContaining([
				["CANCEL", "two@partner.example"],
				["REQUEST", "one@partner.example"],
			]),
		);
		// The delete cancels the meeting for the attendee that stays.
		expect(sent.slice(6).map((item) => [item.ical.method, item.to, item.subject])).toEqual([
			["CANCEL", "one@partner.example", "Cancelled: Design review"],
		]);
		// Each newer message has a larger SEQUENCE.
		expect(sequences[2]).toBeGreaterThan(sequences[0] as number);
		expect(sequences[6]).toBeGreaterThan(sequences[4] as number);
		expect(sent.at(-1)?.ical.cancelled).toBe(true);
	});

	it("sends one message for one key, also when the send runs two times", async () => {
		const input = {
			senderId: ada.id,
			to: "guest@partner.example",
			subject: "Invitation: Twice",
			text: "Hello.",
			method: "REQUEST" as const,
			ics: googleTimed,
			idempotencyKey: "asterra-calendar:test:REQUEST:0:guest@partner.example",
		};
		expect(await sendCalendarMail(env as Env, input)).toEqual({ status: "sent" });
		expect(await sendCalendarMail(env as Env, input)).toEqual({ status: "duplicate" });
		await drainOutbox(ada.id);
		expect(email.sent).toHaveLength(1);
		expect(await sentInvites(ada)).toHaveLength(1);
	});

	it("honors the outbound policy of an agent and the scope mail.send", async () => {
		// An agent is not the organizer of an event with attendees on its own calendar.
		expect(await codeOf(bot.call("calendar.create_event", meeting(["guest@partner.example"])))).toBe("forbidden");
		expect(await eventsOf(bot)).toEqual([]);

		// With schedule access, the agent invites from the calendar of Ada, in the limits of its own policy.
		await ada.call("calendar.set_grant", { principal_id: bot.id, access: "schedule" });
		const fromBot = { ...meeting(["guest@partner.example"]), calendar_id: ada.id };
		expect(await codeOf(bot.call("calendar.create_event", fromBot))).toBe("policy_denied");
		expect(await eventsOf(ada)).toEqual([]);
		await ada.call("directory.update_agent_policy", {
			principal_id: bot.id,
			mode: "allowlist",
			allowlist: ["partner.example"],
		});
		const { event } = await bot.call("calendar.create_event", { ...fromBot, idempotency_key: "bot-invite" });
		await deliverAll(ada.id);
		expect(email.sent).toEqual([{ from: "ada@dock.test", to: "guest@partner.example" }]);
		// The Sent mail of Ada names the agent, so the outbox of the mailbox checks its policy before each delivery.
		const { threads } = await ada.call("mail.list_threads", { query: "in:sent" });
		const { messages } = await ada.call("mail.get_thread", { thread_id: threads[0]?.id as string });
		expect(messages.at(-1)?.sent_by).toMatchObject({ principal_id: bot.id, kind: "agent" });

		// After a change of the policy, a change of the meeting is refused, and a message of the agent that waits
		// does not leave.
		await ada.call("directory.update_agent_policy", { principal_id: bot.id, mode: "internal-only" });
		expect(
			await codeOf(bot.call("calendar.update_event", { event_id: event.id, calendar_id: ada.id, title: "Moved" })),
		).toBe("policy_denied");
		// A retry of the first create returns the first event: the policy of now does not refuse it.
		const retry = await bot.call("calendar.create_event", { ...fromBot, idempotency_key: "bot-invite" });
		expect(retry.event.id).toBe(event.id);
		expect(
			await sendCalendarMail(env as Env, {
				senderId: ada.id,
				actorId: bot.id,
				to: "guest@partner.example",
				subject: "Updated invitation: Design review",
				text: "Hello.",
				method: "REQUEST",
				ics: googleTimed,
				idempotencyKey: "asterra-calendar:policy:REQUEST:1:guest@partner.example",
			}),
		).toEqual({ status: "refused", reason: "policy" });
		await drainOutbox(ada.id);
		expect(email.sent).toHaveLength(1);

		// A key of a person without mail.send cannot invite outside the organization. Inside, it needs no mail.send.
		const calendarOnly = await calendarOnlyKey();
		expect(await codeOf(calendarOnly("calendar.create_event", meeting(["guest@partner.example"])))).toBe("forbidden");
		const { event: internal } = await calendarOnly("calendar.create_event", meeting([], [owner.id]));
		expect(internal.attendees).toHaveLength(1);

		// The cancellation of a meeting with an attendee outside goes by mail too: the key cannot delete it.
		const { event: outside } = await ada.call("calendar.create_event", meeting(["guest@partner.example"]));
		expect(await codeOf(calendarOnly("calendar.delete_event", { event_id: outside.id }))).toBe("forbidden");
		expect((await ada.call("calendar.get_event", { event_id: outside.id })).event.external_attendees).toHaveLength(1);
	});

	it("refuses a repeat, an address of the organization, and too many attendees", async () => {
		const weekly = { frequency: "weekly", interval: 1 } as const;
		expect(
			await codeOf(ada.call("calendar.create_event", { ...meeting(["guest@partner.example"]), recurrence: weekly })),
		).toBe("invalid");
		const { event } = await ada.call("calendar.create_event", meeting(["guest@partner.example"]));
		expect(await codeOf(ada.call("calendar.update_event", { event_id: event.id, recurrence: weekly }))).toBe("invalid");
		expect((await ada.call("calendar.get_event", { event_id: event.id })).event.recurrence).toBeNull();

		// A person of the organization is an attendee by id, not by mail.
		expect(await codeOf(ada.call("calendar.create_event", meeting(["Owner@Dock.test"])))).toBe("invalid");
		const many = Array.from({ length: 50 }, (_, index) => `guest${index}@partner.example`);
		expect(await codeOf(ada.call("calendar.create_event", meeting(many, [owner.id])))).toBe("invalid");
		await deliverAll(ada.id);
		// Only the first event sent an invitation.
		expect(email.sent).toEqual([{ from: "ada@dock.test", to: "guest@partner.example" }]);

		// The limit counts the people and the addresses together, also when an update gives only one of the lists.
		const { event: full } = await ada.call("calendar.create_event", meeting(many));
		expect(await codeOf(ada.call("calendar.update_event", { event_id: full.id, attendee_ids: [owner.id] }))).toBe(
			"invalid",
		);
		expect((await ada.call("calendar.get_event", { event_id: full.id })).event.attendees).toEqual([]);
	});

	it("writes a late answer into the invitation that waits in the outbox", async () => {
		const { event } = await ada.call("calendar.create_event", meeting(["priya@partner.example"]));
		await deliverAll(ada.id);
		// The change of the title waits in the outbox of the calendar while the mailbox is paused.
		await pauseMailbox(ada.id, true);
		await ada.call("calendar.update_event", { event_id: event.id, title: "Design review v2" });
		await firstAttempt();
		// The answer to the first invitation arrives now, through the mailbox hand-off.
		const applied = await runInDurableObject(calendarStub(ada.id), (instance) =>
			(instance as unknown as CalendarDO).applyMail(ada.id, {
				ics: stamped(googleReply.replaceAll("{UID}", event.id), Date.now() - 60_000),
				from: "priya@partner.example",
				verification: "verified",
				receivedAt: Date.now(),
			}),
		);
		expect(applied).toEqual({ applied: true });
		await pauseMailbox(ada.id, false);
		await deliverAll(ada.id);
		const last = (await sentInvites(ada)).at(-1);
		expect(last?.subject).toBe("Updated invitation: Design review v2");
		expect(last?.ical.attendees).toEqual([
			expect.objectContaining({ email: "priya@partner.example", partstat: "ACCEPTED" }),
		]);
	});

	it("asks the attendees by mail again after a new time", async () => {
		const { event } = await ada.call("calendar.create_event", meeting(["priya@partner.example"]));
		await deliverAll(ada.id);
		const asked = (await sentInvites(ada)).at(-1)?.ical.sequence as number;
		// A REPLY has the SEQUENCE of the REQUEST that it answers. Each DTSTAMP is after the arrival, so each reply
		// has the newest stamp, and only its SEQUENCE can make it old.
		const reply = (sequence: number, subject: string) =>
			inject(
				invitationMail({
					from: "priya@partner.example",
					to: "ada@dock.test",
					subject,
					ics: stamped(
						googleReply.replaceAll("{UID}", event.id).replace("SEQUENCE:0", `SEQUENCE:${sequence}`),
						Date.now() + 60_000,
					),
				}),
				"ada@dock.test",
				{ from: "priya@partner.example" },
			);
		await reply(asked, "Accepted");
		const response = async () =>
			(await ada.call("calendar.get_event", { event_id: event.id })).event.external_attendees[0]?.response;
		expect(await response()).toBe("accepted");
		await ada.call("calendar.update_event", {
			event_id: event.id,
			when: { kind: "timed", start: "2026-12-05T15:00:00Z", end: "2026-12-05T16:00:00Z", time_zone: "UTC" },
		});
		expect(await response()).toBe("needs_action");
		await deliverAll(ada.id);
		const askedAgain = (await sentInvites(ada)).at(-1)?.ical.sequence as number;
		expect(askedAgain).toBeGreaterThan(asked);
		// An answer to the first question arrives after the new time. It is for the old time.
		await reply(asked, "Accepted the old time");
		expect(await response()).toBe("needs_action");
		// A change that keeps the time asks no new question: the answer to the second question still applies.
		await ada.call("calendar.update_event", { event_id: event.id, title: "Design review v2" });
		await reply(askedAgain, "Accepted the new time");
		expect(await response()).toBe("accepted");
	});

	it("names the first message to an attendee an invitation, also after a change before the send", async () => {
		// The invitation waits in the outbox of the calendar while the mailbox is paused.
		await pauseMailbox(ada.id, true);
		const { event } = await ada.call("calendar.create_event", meeting(["priya@partner.example"]));
		await firstAttempt();
		// The change replaces the invitation that waits, with a larger SEQUENCE. The attendee got no mail before it.
		await ada.call("calendar.update_event", { event_id: event.id, title: "Design review v2" });
		await pauseMailbox(ada.id, false);
		await deliverAll(ada.id);
		await ada.call("calendar.update_event", { event_id: event.id, title: "Design review v3" });
		await deliverAll(ada.id);
		expect((await sentInvites(ada)).map((item) => item.subject)).toEqual([
			"Invitation: Design review v2",
			"Updated invitation: Design review v3",
		]);
	});

	it("does not send a message of a delegate that waits when the policy of the delegate changed", async () => {
		await ada.call("calendar.set_grant", { principal_id: bot.id, access: "schedule" });
		await ada.call("directory.update_agent_policy", {
			principal_id: bot.id,
			mode: "allowlist",
			allowlist: ["partner.example"],
		});
		// The invitation of the agent waits in the outbox of the calendar of Ada while her mailbox is paused.
		await pauseMailbox(ada.id, true);
		await bot.call("calendar.create_event", { ...meeting(["guest@partner.example"]), calendar_id: ada.id });
		await firstAttempt();
		await ada.call("directory.update_agent_policy", { principal_id: bot.id, mode: "internal-only" });
		await pauseMailbox(ada.id, false);
		await deliverAll(ada.id);
		// The row named the agent, so the send used the policy of now. The row is gone, and no mail left.
		expect(await waitingMail(ada.id)).toEqual([]);
		expect(await sentInvites(ada)).toEqual([]);
		expect(email.sent).toEqual([]);
	});
});

describe("answers by mail from attendees outside the organization", () => {
	it("applies the newest answer of an attendee, and nothing from a different sender", async () => {
		await fakeEmailService(ada.id);
		const { event } = await ada.call(
			"calendar.create_event",
			meeting(["priya@partner.example", "tunde.okafor@contoso.example"]),
		);
		const cursor = (await ada.call("calendar.list_changes", {})).cursor;
		// Each DTSTAMP below is before the arrival of its mail. A DTSTAMP from before the invitation is not old: the
		// clock of a sender can be slow.
		const later = Date.now() - 240_000;
		const reply = stamped(googleReply.replaceAll("{UID}", event.id), later);
		const mail = invitationMail({
			from: "priya@partner.example",
			to: "ada@dock.test",
			subject: "Accepted",
			ics: reply,
		});
		await inject(mail, "ada@dock.test", { from: "priya@partner.example" });
		const responses = async () =>
			Object.fromEntries(
				(await ada.call("calendar.get_event", { event_id: event.id })).event.external_attendees.map((attendee) => [
					attendee.email,
					attendee.response,
				]),
			);
		expect(await responses()).toEqual({
			"priya@partner.example": "accepted",
			"tunde.okafor@contoso.example": "needs_action",
		});
		// The same mail again, as a retry of the queue or of the sender: one message and the same state.
		await inject(mail, "ada@dock.test", { from: "priya@partner.example" });
		expect(await responses()).toMatchObject({ "priya@partner.example": "accepted" });

		// An older answer after a newer one changes nothing.
		const older = stamped(
			outlookTentative.replaceAll("{UID}", event.id).replace("tunde.okafor@contoso.example", "priya@partner.example"),
			later - 120_000,
		);
		await inject(
			invitationMail({ from: "priya@partner.example", to: "ada@dock.test", subject: "Old", ics: older }),
			"ada@dock.test",
		);
		expect(await responses()).toMatchObject({ "priya@partner.example": "accepted" });

		// The answer of Tunde from the address of Priya, from a failed DMARC check, and from an address that is not an
		// attendee change nothing.
		const tunde = stamped(outlookTentative.replaceAll("{UID}", event.id), later + 60_000);
		await inject(
			invitationMail({ from: "priya@partner.example", to: "ada@dock.test", subject: "Forged", ics: tunde }),
			"ada@dock.test",
		);
		await inject(
			invitationMail({
				from: "tunde.okafor@contoso.example",
				to: "ada@dock.test",
				subject: "Spam",
				ics: tunde,
				auth: "mx.cloudflare.net; spf=fail; dkim=fail; dmarc=fail header.from=contoso.example",
			}),
			"ada@dock.test",
		);
		const stranger = stamped(
			googleReply.replaceAll("{UID}", event.id).replaceAll("priya@partner.example", "eve@evil.example"),
			later + 60_000,
		);
		await inject(
			invitationMail({ from: "eve@evil.example", to: "ada@dock.test", subject: "Stranger", ics: stranger }),
			"ada@dock.test",
		);
		expect(await responses()).toEqual({
			"priya@partner.example": "accepted",
			"tunde.okafor@contoso.example": "needs_action",
		});

		// The real answer of Tunde applies.
		await inject(
			invitationMail({ from: "tunde.okafor@contoso.example", to: "ada@dock.test", subject: "Tentative", ics: tunde }),
			"ada@dock.test",
		);
		expect(await responses()).toEqual({
			"priya@partner.example": "accepted",
			"tunde.okafor@contoso.example": "tentative",
		});
		// One record for each answer that changed, with no actor: the retry, the old answer and the refusals write none.
		expect((await changesAfter(ada, cursor)).map((change) => [change.type, change.event_id, change.actor_id])).toEqual([
			["calendar.rsvp.changed", event.id, null],
			["calendar.rsvp.changed", event.id, null],
		]);
	});

	it("applies an answer with no DMARC result", async () => {
		const { event } = await ada.call("calendar.create_event", meeting(["priya@partner.example"]));
		const answer = (partstat: string, auth: string | null) =>
			inject(
				invitationMail({
					from: "priya@partner.example",
					to: "ada@dock.test",
					subject: partstat,
					ics: stamped(googleReply.replaceAll("{UID}", event.id).replace("PARTSTAT=ACCEPTED", partstat), Date.now()),
					auth,
				}),
				"ada@dock.test",
			);
		const response = async () =>
			(await ada.call("calendar.get_event", { event_id: event.id })).event.external_attendees[0]?.response;
		// Many servers of small domains send no DMARC result. The organizer still gets the answer.
		await answer("PARTSTAT=ACCEPTED", null);
		expect(await response()).toBe("accepted");
	});
});

describe("invitations by mail from outside the organization", () => {
	let email: FakeEmailService;
	beforeEach(async () => {
		email = await fakeEmailService(ada.id);
	});

	const receive = async (ics: string, subject: string, from = "priya@partner.example", auth?: string | null) => {
		await inject(
			invitationMail({ from, to: "ada@dock.test", subject, ics, ...(auth === undefined ? {} : { auth }) }),
			"ada@dock.test",
			{ from },
		);
		return messageWith(ada, subject);
	};

	it("shows the invitation, adds the meeting on Yes, sends the answer, and adds no second event", async () => {
		const messageId = await receive(googleTimed, "Invitation: Façade review");
		const { invitation } = await ada.call("calendar.get_mail_invitation", { message_id: messageId });
		expect(invitation).toMatchObject({
			method: "request",
			uid: "4f7c2b1e9a0d3c8b@google.com",
			title: "Façade review",
			location: "Partner HQ, Room 5",
			when: { kind: "timed", start: "2026-12-03T15:00:00.000Z", end: "2026-12-03T16:00:00.000Z" },
			organizer: { email: "priya@partner.example", name: "Priya Natarajan" },
			sender: "priya@partner.example",
			sender_is_organizer: true,
			sender_verification: "verified",
			state: "new",
			can_respond: true,
			my_response: null,
			event_id: null,
			untrusted: true,
		});
		expect(invitation?.attendees.find((attendee) => attendee.self)?.email).toBe("ada@dock.test");
		// Nothing is on the calendar before an answer.
		expect(await eventsOf(ada)).toEqual([]);
		const cursor = (await ada.call("calendar.list_changes", {})).cursor;

		const answered = await ada.call("calendar.respond_to_mail_invitation", {
			message_id: messageId,
			response: "accepted",
		});
		expect(answered.event).toMatchObject({
			title: "Façade review",
			role: "attendee",
			untrusted: true,
			my_response: "accepted",
			organizer: null,
			external_organizer: { email: "priya@partner.example", display_name: "Priya Natarajan" },
		});
		expect(answered.event?.external_attendees).toEqual([
			{ email: "ada@dock.test", display_name: "ada@dock.test", response: "accepted" },
			{ email: "priya@partner.example", display_name: "Priya Natarajan", response: "accepted" },
		]);
		expect(answered.invitation).toMatchObject({
			state: "on_calendar",
			my_response: "accepted",
			event_id: answered.event?.id,
		});
		await deliverAll(ada.id);
		expect(email.sent).toEqual([{ from: "ada@dock.test", to: "priya@partner.example" }]);
		const [reply] = await sentInvites(ada);
		expect(reply?.subject).toBe("Accepted: Façade review");
		expect(reply?.ical).toMatchObject({
			method: "REPLY",
			uid: "4f7c2b1e9a0d3c8b@google.com",
			organizer: { email: "priya@partner.example" },
			attendees: [{ email: "ada@dock.test", partstat: "ACCEPTED" }],
		});

		// The same answer again, and a second mail with the same invitation: one event, no second answer.
		await ada.call("calendar.respond_to_mail_invitation", { message_id: messageId, response: "accepted" });
		const copyId = await receive(googleTimed, "Invitation: Façade review (copy)");
		const again = await ada.call("calendar.respond_to_mail_invitation", { message_id: copyId, response: "accepted" });
		expect(again.event?.id).toBe(answered.event?.id);
		await deliverAll(ada.id);
		expect(email.sent).toHaveLength(1);
		expect((await eventsOf(ada)).filter((item) => item.title === "Façade review")).toHaveLength(1);
		// The mail put the meeting on the calendar, so the record has no actor. The same answer again writes none.
		expect((await changesAfter(ada, cursor)).map((change) => [change.type, change.event_id, change.actor_id])).toEqual([
			["calendar.invitation.received", answered.event?.id, null],
		]);
	});

	it("reads an all-day invitation of Apple Calendar and a Windows zone of Outlook", async () => {
		const apple = await receive(appleAllDay, "Offsite", "sam@icloud.example");
		const outlook = await receive(outlookTimed, "Budget sync", "tunde.okafor@contoso.example");
		await ada.call("calendar.respond_to_mail_invitation", { message_id: apple, response: "tentative" });
		await ada.call("calendar.respond_to_mail_invitation", { message_id: outlook, response: "accepted" });
		const events = await eventsOf(ada);
		expect(events.map((event) => [event.title, event.when, event.my_response])).toEqual([
			[
				"Budget sync",
				{
					kind: "timed",
					start: "2026-12-08T14:30:00.000Z",
					end: "2026-12-08T15:30:00.000Z",
					time_zone: "America/New_York",
				},
				"accepted",
			],
			["Offsite", { kind: "all_day", start_date: "2026-12-15", end_date: "2026-12-17" }, "tentative"],
		]);
		await deliverAll(ada.id);
		expect((await sentInvites(ada)).map((item) => [item.to, item.ical.attendees[0]?.partstat])).toEqual(
			expect.arrayContaining([
				["sam@icloud.example", "TENTATIVE"],
				["tunde.okafor@contoso.example", "ACCEPTED"],
			]),
		);
	});

	it("applies a change and a cancellation only from the organizer that sent the invitation", async () => {
		const first = await receive(googleTimed, "Invitation: Façade review");
		const { event } = await ada.call("calendar.respond_to_mail_invitation", {
			message_id: first,
			response: "accepted",
		});
		const startOf = async () => (await eventsOf(ada)).find((item) => item.id === event?.id)?.when;
		const cursor = (await ada.call("calendar.list_changes", {})).cursor;

		// A change from a different sender, from a sender that the server did not verify, or with a different
		// organizer changes nothing.
		await receive(googleUpdate, "Forged update", "mallory@evil.example");
		const unverified = await receive(googleUpdate, "Unverified update", "priya@partner.example", null);
		await receive(googleUpdate.replaceAll("priya@partner.example", "other@partner.example"), "Other organizer");
		expect(await startOf()).toMatchObject({ start: "2026-12-03T15:00:00.000Z" });
		// An answer to the change from the sender that the server did not verify does not apply the change, and
		// sends no answer for it.
		expect((await ada.call("calendar.get_mail_invitation", { message_id: unverified })).invitation).toMatchObject({
			state: "on_calendar",
			sender_verification: "unverified",
			can_respond: false,
		});
		expect(
			await codeOf(ada.call("calendar.respond_to_mail_invitation", { message_id: unverified, response: "declined" })),
		).toBe("invalid");
		expect((await eventsOf(ada)).find((item) => item.id === event?.id)).toMatchObject({
			when: { start: "2026-12-03T15:00:00.000Z" },
			my_response: "accepted",
		});
		await deliverAll(ada.id);
		expect(email.sent).toHaveLength(1);
		const forged = await receive(googleCancel, "Forged cancel", "mallory@evil.example");
		expect(await startOf()).toBeDefined();
		// The card of a cancellation that changed nothing does not tell that the meeting is cancelled.
		expect((await ada.call("calendar.get_mail_invitation", { message_id: forged })).invitation).toMatchObject({
			method: "cancel",
			state: "on_calendar",
			can_respond: false,
		});

		// The real change moves the meeting with no call. A new time asks the owner again.
		await receive(googleUpdate, "Updated invitation: Façade review");
		const moved = (await eventsOf(ada)).find((item) => item.id === event?.id);
		expect(moved).toMatchObject({ when: { start: "2026-12-04T17:00:00.000Z" }, my_response: "needs_action" });
		const { invitation: old } = await ada.call("calendar.get_mail_invitation", { message_id: first });
		expect(old).toMatchObject({ state: "outdated", can_respond: false });

		// A cancellation of the same SEQUENCE from before the change is older than the change: it removes nothing.
		const sameSequence = googleCancel.replace("SEQUENCE:2", "SEQUENCE:1");
		await receive(sameSequence.replace("DTSTAMP:20261128T080000Z", "DTSTAMP:20261126T080000Z"), "Old cancel");
		expect(await startOf()).toMatchObject({ start: "2026-12-04T17:00:00.000Z" });

		// The real cancellation removes it, also with the SEQUENCE of the change and a newer DTSTAMP. The old
		// invitation after it cannot bring it back.
		await receive(sameSequence, "Cancelled: Façade review");
		expect(await eventsOf(ada)).toEqual([]);
		// The refused mails write no record.
		expect((await changesAfter(ada, cursor)).map((change) => [change.type, change.actor_id])).toEqual([
			["calendar.invitation.updated", null],
			["calendar.rsvp.changed", null],
			["calendar.invitation.cancelled", null],
		]);
		expect((await ada.call("calendar.get_mail_invitation", { message_id: first })).invitation?.state).toBe("cancelled");
		expect(
			await codeOf(ada.call("calendar.respond_to_mail_invitation", { message_id: first, response: "accepted" })),
		).toBe("conflict");
		const late = await receive(googleTimed, "Invitation: Façade review (late copy)");
		expect(
			await codeOf(ada.call("calendar.respond_to_mail_invitation", { message_id: late, response: "accepted" })),
		).toBe("conflict");
		expect(await eventsOf(ada)).toEqual([]);
	});

	it("keeps the answer when a change keeps the time, and shows a copy by mail to a delegate without addresses", async () => {
		const first = await receive(googleTimed, "Invitation: Façade review");
		const { event } = await ada.call("calendar.respond_to_mail_invitation", {
			message_id: first,
			response: "accepted",
		});
		const renamed = googleTimed
			.replace("SEQUENCE:0", "SEQUENCE:1")
			.replace("SUMMARY:Façade review", "SUMMARY:Façade samples")
			.replace("DTSTAMP:20261126T101500Z", "DTSTAMP:20261126T111500Z");
		await receive(renamed, "Updated invitation: Façade samples");
		expect((await ada.call("calendar.get_event", { event_id: event?.id as string })).event).toMatchObject({
			title: "Façade samples",
			my_response: "accepted",
		});

		await ada.call("calendar.set_grant", { principal_id: owner.id, access: "schedule" });
		const { events } = await owner.call("calendar.list_events", { ...RANGE, calendar_id: ada.id });
		expect(events).toEqual([
			expect.objectContaining({ id: event?.id, external_attendees: [], external_organizer: null, untrusted: true }),
		]);

		// The reminder of the copy has the title from the mail, so its Activity item is untrusted too.
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(new Date("2026-12-03T14:51:00Z"));
			await runDurableObjectAlarm(calendarStub(ada.id));
			await runDurableObjectAlarm(calendarStub(ada.id));
		} finally {
			vi.useRealTimers();
		}
		const { items } = await ada.call("chat.list_activity", { filter: "calendar_reminder" });
		expect(items.map((item) => [item.preview, item.untrusted])).toEqual([["Façade samples", true]]);
	});

	// The answer on the copy goes to the organizer by mail, so it has the rules of a send.
	it("needs mail.send to change the answer on a copy by mail", async () => {
		const messageId = await receive(googleTimed, "Invitation: Façade review");
		const { event } = await ada.call("calendar.respond_to_mail_invitation", {
			message_id: messageId,
			response: "accepted",
		});
		const calendarOnly = await calendarOnlyKey();
		const event_id = event?.id as string;
		const cursor = (await ada.call("calendar.list_changes", {})).cursor;
		expect(await codeOf(calendarOnly("calendar.respond_to_event", { event_id, response: "declined" }))).toBe(
			"forbidden",
		);
		// The answer on the card in Mail has the same rule: a key that reads the mail cannot send the answer.
		const reader = await calendarOnlyKey(["mail.read"]);
		expect(
			await codeOf(reader("calendar.respond_to_mail_invitation", { message_id: messageId, response: "declined" })),
		).toBe("forbidden");
		expect((await ada.call("calendar.get_event", { event_id })).event.my_response).toBe("accepted");
		// With mail.send, the new answer goes to the organizer.
		await ada.call("calendar.respond_to_event", { event_id, response: "declined" });
		await deliverAll(ada.id);
		expect(email.sent).toHaveLength(2);
		expect((await sentInvites(ada)).at(-1)?.ical.attendees[0]?.partstat).toBe("DECLINED");
		// The refused calls write no record. The record of the answer names the owner.
		expect((await changesAfter(ada, cursor)).map((change) => [change.type, change.event_id, change.actor_id])).toEqual([
			["calendar.rsvp.changed", event_id, ada.id],
		]);
	});

	it("adds nothing for No, and adds the meeting for a later Yes", async () => {
		const messageId = await receive(googleTimed, "Invitation: Façade review");
		const declined = await ada.call("calendar.respond_to_mail_invitation", {
			message_id: messageId,
			response: "declined",
		});
		expect(declined.event).toBeNull();
		expect(await eventsOf(ada)).toEqual([]);
		// The same No again sends no second mail.
		await ada.call("calendar.respond_to_mail_invitation", { message_id: messageId, response: "declined" });
		await deliverAll(ada.id);
		expect(email.sent).toHaveLength(1);
		expect((await sentInvites(ada))[0]?.ical.attendees[0]?.partstat).toBe("DECLINED");

		await ada.call("calendar.respond_to_mail_invitation", { message_id: messageId, response: "accepted" });
		expect((await eventsOf(ada)).map((event) => event.my_response)).toEqual(["accepted"]);
	});

	it("does not answer mail for a different address, a recurring meeting, or Spam", async () => {
		const other = await receive(googleTimed.replaceAll("ada@dock.test", "someone@dock.test"), "For someone else");
		const weekly = await receive(recurring, "Weekly sync");
		const spam = await receive(
			googleTimed,
			"Spam invitation",
			"priya@partner.example",
			"mx.cloudflare.net; spf=fail; dkim=fail; dmarc=fail header.from=partner.example",
		);
		for (const [id, state] of [
			[other, "not_invited"],
			[weekly, "unsupported"],
			[spam, "new"],
		] as const) {
			const { invitation } = await ada.call("calendar.get_mail_invitation", { message_id: id });
			expect(invitation, id).toMatchObject({ state, can_respond: false });
			expect(
				await codeOf(ada.call("calendar.respond_to_mail_invitation", { message_id: id, response: "accepted" })),
			).toBe("invalid");
		}
		// A message with no calendar part has no invitation. A message of a different mailbox is not found.
		await inject(
			invitationMail({ from: "a@b.example", to: "ada@dock.test", subject: "Plain", ics: "Hello" }),
			"ada@dock.test",
		);
		const plain = await messageWith(ada, "Plain");
		expect((await ada.call("calendar.get_mail_invitation", { message_id: plain })).invitation).toBeNull();
		expect(await codeOf(owner.call("calendar.get_mail_invitation", { message_id: plain }))).toBe("not_found");
		expect(await eventsOf(ada)).toEqual([]);
	});

	it("removes a meeting by mail from the own calendar only, and takes a newer invitation again", async () => {
		const messageId = await receive(googleTimed, "Invitation: Façade review");
		const { event } = await ada.call("calendar.respond_to_mail_invitation", {
			message_id: messageId,
			response: "accepted",
		});
		await deliverAll(ada.id);
		const before = email.sent.length;
		const event_id = event?.id as string;
		// A delegate with schedule access did not add the copy: it cannot remove it, and it cannot answer for Ada.
		await ada.call("calendar.set_grant", { principal_id: owner.id, access: "schedule" });
		expect(await codeOf(owner.call("calendar.delete_event", { event_id, calendar_id: ada.id }))).toBe("forbidden");
		expect(await codeOf(owner.call("calendar.respond_to_event", { event_id, response: "declined" }))).toBe("not_found");
		expect((await ada.call("calendar.get_event", { event_id })).event.my_response).toBe("accepted");
		const cursor = (await ada.call("calendar.list_changes", {})).cursor;
		await ada.call("calendar.delete_event", { event_id });
		await deliverAll(ada.id);
		expect(email.sent).toHaveLength(before);
		expect((await changesAfter(ada, cursor)).map((change) => [change.type, change.event_id, change.actor_id])).toEqual([
			["calendar.invitation.cancelled", event_id, ada.id],
		]);
		expect((await ada.call("calendar.get_mail_invitation", { message_id: messageId })).invitation?.state).toBe(
			"cancelled",
		);
		const newer = await receive(googleUpdate, "Updated invitation: Façade review");
		const again = await ada.call("calendar.respond_to_mail_invitation", { message_id: newer, response: "accepted" });
		expect(again.event).toMatchObject({ when: { start: "2026-12-04T17:00:00.000Z" } });
	});

	it("gives the same invitation and answer through MCP, with the notice for untrusted content", async () => {
		const messageId = await receive(googleTimed, "Invitation: Façade review");
		const read = await callTool(ada.key, "calendar_get_mail_invitation", { message_id: messageId });
		expect(read.isError).toBeFalsy();
		expect(read.structuredContent).toEqual(await ada.call("calendar.get_mail_invitation", { message_id: messageId }));
		expect(read.content.map((item) => item.text).join("\n")).toMatch(/untrusted/i);
		const answered = await callTool(ada.key, "calendar_respond_to_mail_invitation", {
			message_id: messageId,
			response: "tentative",
		});
		expect(answered.isError).toBeFalsy();
		expect((answered.structuredContent as { event: CalendarEvent }).event).toMatchObject({
			my_response: "tentative",
			untrusted: true,
		});
	});

	it("tries an answer again after a pause of the mailbox, and drops it when the meeting goes away", async () => {
		/** Answers Yes while the mailbox is paused. The answer waits in the outbox of the calendar. */
		const acceptWhilePaused = async (messageId: string) => {
			await pauseMailbox(ada.id, true);
			await ada.call("calendar.respond_to_mail_invitation", { message_id: messageId, response: "accepted" });
			await firstAttempt();
			await pauseMailbox(ada.id, false);
		};

		// A verified cancellation drops the answer that waits.
		await acceptWhilePaused(await receive(googleTimed, "Invitation: Façade review"));
		await receive(googleCancel, "Cancelled: Façade review");
		expect(await waitingMail(ada.id)).toEqual([]);
		// The owner removes a meeting by mail: its answer that waits goes too.
		await acceptWhilePaused(await receive(appleAllDay, "Offsite", "sam@icloud.example"));
		const offsite = (await eventsOf(ada)).find((event) => event.title === "Offsite") as CalendarEvent;
		await ada.call("calendar.delete_event", { event_id: offsite.id });
		expect(await waitingMail(ada.id)).toEqual([]);
		await deliverAll(ada.id);
		expect(email.sent).toEqual([]);

		// After the pause, an answer that waits goes out.
		await acceptWhilePaused(await receive(outlookTimed, "Budget sync", "tunde.okafor@contoso.example"));
		await deliverAll(ada.id);
		expect(email.sent).toEqual([{ from: "ada@dock.test", to: "tunde.okafor@contoso.example" }]);
	});

	it("refuses the uid of a cancelled meeting from a different organizer", async () => {
		const first = await receive(googleTimed, "Invitation: Façade review");
		await ada.call("calendar.respond_to_mail_invitation", { message_id: first, response: "accepted" });
		await receive(googleCancel, "Cancelled: Façade review");
		const reused = googleUpdate
			.replaceAll("priya@partner.example", "other@partner.example")
			.replace("SEQUENCE:1", "SEQUENCE:9");
		const second = await receive(reused, "Reused id", "other@partner.example");
		expect(
			await codeOf(ada.call("calendar.respond_to_mail_invitation", { message_id: second, response: "accepted" })),
		).toBe("conflict");
		expect(await eventsOf(ada)).toEqual([]);
	});

	it("stops the answer to an invitation after a verified cancellation with no copy", async () => {
		const first = await receive(googleTimed, "Invitation: Façade review");
		const card = async (messageId: string) =>
			(await ada.call("calendar.get_mail_invitation", { message_id: messageId })).invitation;
		// A cancellation from a different sender, and one from a sender that the server did not verify, stop nothing.
		await receive(googleCancel, "Forged cancel", "mallory@evil.example");
		await receive(googleCancel, "Unverified cancel", "priya@partner.example", null);
		expect(await card(first)).toMatchObject({ state: "new", can_respond: true });
		// The organizer cancels the meeting before Ada answers. The calendar has no copy to remove.
		await receive(googleCancel, "Cancelled: Façade review");
		expect(await card(first)).toMatchObject({ state: "cancelled", can_respond: false });
		expect(
			await codeOf(ada.call("calendar.respond_to_mail_invitation", { message_id: first, response: "accepted" })),
		).toBe("conflict");
		expect(await eventsOf(ada)).toEqual([]);
		// A newer invitation of the organizer can be accepted.
		const newer = await receive(googleUpdate.replace("SEQUENCE:1", "SEQUENCE:3"), "Invitation again");
		const again = await ada.call("calendar.respond_to_mail_invitation", { message_id: newer, response: "accepted" });
		expect(again.event).toMatchObject({ my_response: "accepted" });

		// A sender that names itself the organizer cannot stop the invitation of a different organizer with the UID.
		const uid = "7a1d9e0c5b2f4a68@google.com";
		const theirs = googleCancel
			.replace("4f7c2b1e9a0d3c8b@google.com", uid)
			.replace("mailto:priya@partner.example", "mailto:mallory@evil.example");
		await receive(theirs, "Cancel of a stranger", "mallory@evil.example");
		const second = await receive(googleTimed.replace("4f7c2b1e9a0d3c8b@google.com", uid), "Second invitation");
		expect(await card(second)).toMatchObject({ state: "new", can_respond: true });
		const answered = await ada.call("calendar.respond_to_mail_invitation", {
			message_id: second,
			response: "accepted",
		});
		expect(answered.event).toMatchObject({ my_response: "accepted" });
	});

	it("writes one response record when an answer applies a newer invitation with a new time", async () => {
		const first = await receive(googleTimed, "Invitation: Façade review");
		const { event } = await ada.call("calendar.respond_to_mail_invitation", {
			message_id: first,
			response: "accepted",
		});
		const cursor = (await ada.call("calendar.list_changes", {})).cursor;
		// The calendar did not get the mail of the change, for example because the Screener held it. The answer on its
		// card gives the newer invitation to the calendar.
		const invite = parseICalendar(googleUpdate) as ICalInvite;
		const time = storedTime(invite.when as NonNullable<ICalInvite["when"]>);
		if ("problem" in time) throw new Error(time.problem);
		const answer = (verification: "verified" | "unverified") =>
			runInDurableObject(calendarStub(ada.id), (instance) =>
				(instance as unknown as CalendarDO).respondToMail(
					{ ownerId: ada.id, actorId: ada.id, ownerMail: { email: "ada@dock.test", name: "Ada Lovelace" } },
					{
						invite,
						time,
						from: "priya@partner.example",
						verification,
						myEmail: "ada@dock.test",
						response: "tentative",
					},
				),
			);
		// The calendar is the last check: it does not take the newer invitation from a sender that is not verified.
		expect(await answer("unverified")).toMatchObject({ error: { code: "invalid" } });
		const result = await answer("verified");
		expect(result).toMatchObject({ changed: true, event: { start_at: Date.parse("2026-12-04T17:00:00Z") } });
		// The new time and the answer are one change of the response: one record, with the owner as the actor.
		expect((await changesAfter(ada, cursor)).map((change) => [change.type, change.event_id, change.actor_id])).toEqual([
			["calendar.invitation.updated", event?.id, null],
			["calendar.rsvp.changed", event?.id, ada.id],
		]);
		expect((await ada.call("calendar.get_event", { event_id: event?.id as string })).event.my_response).toBe(
			"tentative",
		);
	});

	it("lets an agent answer an invitation of its own mailbox only when its policy allows the organizer", async () => {
		const botMail = await fakeEmailService(bot.id);
		await inject(
			invitationMail({
				from: "priya@partner.example",
				to: "bot@dock.test",
				subject: "Invitation: Façade review",
				ics: googleTimed.replaceAll("ada@dock.test", "bot@dock.test"),
			}),
			"bot@dock.test",
			{ from: "priya@partner.example" },
		);
		const messageId = await messageWith(bot, "Invitation: Façade review");
		const answer = { message_id: messageId, response: "accepted" } as const;
		// The answer is a mail to the organizer. The policy of the agent does not allow that address.
		expect(await codeOf(bot.call("calendar.respond_to_mail_invitation", answer))).toBe("policy_denied");
		expect(await eventsOf(bot)).toEqual([]);
		expect(await waitingMail(bot.id)).toEqual([]);

		await ada.call("directory.update_agent_policy", {
			principal_id: bot.id,
			mode: "allowlist",
			allowlist: ["partner.example"],
		});
		const { event } = await bot.call("calendar.respond_to_mail_invitation", answer);
		expect(event).toMatchObject({ role: "attendee", my_response: "accepted", untrusted: true });
		await deliverAll(bot.id);
		// The answer goes from the own mailbox of the agent.
		expect(botMail.sent).toEqual([{ from: "bot@dock.test", to: "priya@partner.example" }]);
		expect((await sentInvites(bot))[0]?.ical.attendees).toEqual([
			expect.objectContaining({ email: "bot@dock.test", partstat: "ACCEPTED" }),
		]);
		expect(email.sent).toEqual([]);
	});

	it("answers an invitation to an alias from that alias", async () => {
		await owner.call("directory.add_mailbox_alias", { mailbox_id: ada.id, address: "countess@second.test" });
		const ics = googleTimed.replaceAll("ada@dock.test", "countess@second.test");
		await inject(
			invitationMail({ from: "priya@partner.example", to: "countess@second.test", subject: "To the alias", ics }),
			"countess@second.test",
			{ from: "priya@partner.example" },
		);
		const messageId = await messageWith(ada, "To the alias");
		const { invitation } = await ada.call("calendar.get_mail_invitation", { message_id: messageId });
		expect(invitation?.attendees.find((attendee) => attendee.self)?.email).toBe("countess@second.test");
		await ada.call("calendar.respond_to_mail_invitation", { message_id: messageId, response: "accepted" });
		await deliverAll(ada.id);
		// The attendee of the answer is its From address, so the organizer can match it.
		expect(email.sent).toEqual([{ from: "countess@second.test", to: "priya@partner.example" }]);
		expect((await sentInvites(ada))[0]?.ical.attendees).toEqual([
			expect.objectContaining({ email: "countess@second.test", partstat: "ACCEPTED" }),
		]);
	});

	it("gives an invitation to a team mailbox to no calendar", async () => {
		const { team_mailbox: support } = await owner.call("directory.create_team_mailbox", {
			display_name: "Support",
			address: "support@dock.test",
		});
		await inject(
			invitationMail({
				from: "priya@partner.example",
				to: "support@dock.test",
				subject: "Team invite",
				ics: googleTimed,
			}),
			"support@dock.test",
		);
		const owned = await runInDurableObject(
			calendarStub(support.id),
			(_instance, state) =>
				state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM meta WHERE key = 'owner_id'").one().n,
		);
		expect(owned).toBe(0);
	});
});
