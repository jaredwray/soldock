import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { CalendarEvent, InputOf } from "@asterra/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import appleAllDay from "../../../fixtures/calendar/apple-request-all-day.ics?raw";
import googleCancel from "../../../fixtures/calendar/google-cancel.ics?raw";
import googleReply from "../../../fixtures/calendar/google-reply-accepted.ics?raw";
import googleTimed from "../../../fixtures/calendar/google-request-timed.ics?raw";
import googleUpdate from "../../../fixtures/calendar/google-update-timed.ics?raw";
import outlookTentative from "../../../fixtures/calendar/outlook-reply-tentative.ics?raw";
import outlookTimed from "../../../fixtures/calendar/outlook-request-timed.ics?raw";
import recurring from "../../../fixtures/calendar/recurring-request.ics?raw";
import { type ICalInvite, parseICalendar } from "../src/calendar/ical.ts";
import { sendCalendarMail } from "../src/mail/index.ts";
import {
	type Actor,
	api,
	base64,
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

const meeting = (attendees: InputOf<"calendar.create_event">["attendees"]): InputOf<"calendar.create_event"> => ({
	title: "Design review",
	when: { kind: "timed", start: "2026-12-03T15:00:00Z", end: "2026-12-03T16:00:00Z", time_zone: "UTC" },
	location: "Room 4",
	attendees,
});

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
		const { event } = await ada.call(
			"calendar.create_event",
			meeting([{ email: "Guest@Partner.example" }, { principal_id: owner.id }]),
		);
		expect(event.attendees.map((attendee) => [attendee.principal_id, attendee.email, attendee.response])).toEqual([
			[null, "guest@partner.example", "pending"],
			[owner.id, "owner@dock.test", "pending"],
		]);
		await deliverAll(ada.id, owner.id);
		expect(email.sent).toEqual([{ from: "ada@dock.test", to: "guest@partner.example" }]);
		const [sent] = await sentInvites(ada);
		expect(sent?.subject).toBe("Invitation: Design review");
		expect(sent?.ical).toMatchObject({
			method: "REQUEST",
			uid: event.uid,
			sequence: 0,
			title: "Design review",
			location: "Room 4",
			when: { kind: "timed", start: "2026-12-03T15:00:00.000Z", end: "2026-12-03T16:00:00.000Z" },
			organizer: { email: "ada@dock.test", name: "Ada Lovelace" },
			attendees: [
				{ email: "guest@partner.example", partstat: "NEEDS-ACTION" },
				{ email: "owner@dock.test", name: "Olive Owner", partstat: "NEEDS-ACTION" },
			],
		});
		// A long line is folded. The read of a text part gives LF line ends: mime.test.ts checks the CRLF of the bytes.
		expect(sent?.raw.replace(/\r?\n[ \t]/g, "")).toContain("RSVP=TRUE:mailto:guest@partner.example");
		// The internal attendee gets a copy on the calendar, and no mail.
		expect((await eventsOf(owner)).map((item) => item.uid)).toEqual([event.uid]);

		const { event: allDay } = await ada.call("calendar.create_event", {
			title: "Offsite",
			when: { kind: "all_day", start_date: "2026-12-10", end_date: "2026-12-12" },
			attendees: [{ email: "guest@partner.example" }],
		});
		await deliverAll(ada.id);
		const last = (await sentInvites(ada)).at(-1);
		expect(last?.raw).toMatch(/DTSTART;VALUE=DATE:20261210\r?\nDTEND;VALUE=DATE:20261212\r?\n/);
		expect(last?.ical).toMatchObject({
			uid: allDay.uid,
			when: { kind: "all_day", start_date: "2026-12-10", end_date: "2026-12-12" },
		});
	});

	it("keeps the UID for a change and a cancellation, and sends no mail for an answer inside the organization", async () => {
		const { event } = await ada.call(
			"calendar.create_event",
			meeting([{ email: "one@partner.example" }, { email: "two@partner.example" }, { principal_id: owner.id }]),
		);
		await deliverAll(ada.id, owner.id);
		await ada.call("calendar.update_event", {
			event_id: event.id,
			when: { kind: "timed", start: "2026-12-04T17:00:00Z", end: "2026-12-04T18:00:00Z", time_zone: "UTC" },
		});
		await deliverAll(ada.id, owner.id);
		const copy = (await eventsOf(owner)).find((item) => item.uid === event.uid) as CalendarEvent;
		await owner.call("calendar.respond_to_invitation", { event_id: copy.id, response: "accepted" });
		await deliverAll(owner.id, ada.id);
		expect(email.sent).toHaveLength(4);

		await ada.call("calendar.update_event", {
			event_id: event.id,
			attendees: [{ email: "one@partner.example" }, { principal_id: owner.id }],
		});
		await deliverAll(ada.id, owner.id);
		await ada.call("calendar.delete_event", { event_id: event.id });
		await deliverAll(ada.id, owner.id);

		const sent = await sentInvites(ada);
		const sequences = sent.map((item) => item.ical.sequence);
		expect(sent.every((item) => item.ical.uid === event.uid)).toBe(true);
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
		const botMail = await fakeEmailService(bot.id);
		// A new agent is internal-only.
		expect(await codeOf(bot.call("calendar.create_event", meeting([{ email: "guest@partner.example" }])))).toBe(
			"policy_denied",
		);
		expect(await eventsOf(bot)).toEqual([]);
		await ada.call("directory.update_agent_policy", {
			principal_id: bot.id,
			mode: "allowlist",
			allowlist: ["partner.example"],
		});
		const { event } = await bot.call("calendar.create_event", meeting([{ email: "guest@partner.example" }]));
		await deliverAll(bot.id);
		expect(botMail.sent).toEqual([{ from: "bot@dock.test", to: "guest@partner.example" }]);

		// After a change of the policy, a change of the meeting is refused, and a message that waits does not leave.
		await ada.call("directory.update_agent_policy", { principal_id: bot.id, mode: "internal-only" });
		expect(await codeOf(bot.call("calendar.update_event", { event_id: event.id, title: "Moved" }))).toBe(
			"policy_denied",
		);
		expect(
			await sendCalendarMail(env as Env, {
				senderId: bot.id,
				to: "guest@partner.example",
				subject: "Updated invitation: Design review",
				text: "Hello.",
				method: "REQUEST",
				ics: googleTimed,
				idempotencyKey: "asterra-calendar:policy:REQUEST:1:guest@partner.example",
			}),
		).toEqual({ status: "refused", reason: "policy" });
		await drainOutbox(bot.id);
		expect(botMail.sent).toHaveLength(1);

		// A key of a person without mail.send cannot invite outside the organization. Inside, it needs no mail.send.
		const calendarOnly = api(
			(await ada.call("account.create_api_key", { label: "cal", scopes: ["calendar.read", "calendar.write"] })).api_key
				.secret,
		);
		expect(await codeOf(calendarOnly("calendar.create_event", meeting([{ email: "guest@partner.example" }])))).toBe(
			"forbidden",
		);
		const { event: internal } = await calendarOnly("calendar.create_event", meeting([{ principal_id: owner.id }]));
		expect(internal.attendees).toHaveLength(1);

		// The cancellation of a meeting with an attendee outside goes by mail too: the key cannot delete it.
		const { event: outside } = await ada.call("calendar.create_event", meeting([{ email: "guest@partner.example" }]));
		expect(await codeOf(calendarOnly("calendar.delete_event", { event_id: outside.id }))).toBe("forbidden");
		expect((await ada.call("calendar.get_event", { event_id: outside.id })).event.attendees).toHaveLength(1);
	});
});

describe("answers by mail from attendees outside the organization", () => {
	it("applies the newest answer of an attendee, and nothing from a different sender", async () => {
		await fakeEmailService(ada.id);
		const { event } = await ada.call(
			"calendar.create_event",
			meeting([{ email: "priya@partner.example" }, { email: "tunde.okafor@contoso.example" }]),
		);
		// The attendees were invited ten minutes ago, so each DTSTAMP below is after the invitation and before the
		// arrival of the mail.
		const now = Date.now();
		await runInDurableObject(calendarStub(ada.id), (_instance, state) => {
			state.storage.sql.exec("UPDATE attendees SET added_at = ?", now - 600_000);
		});
		const later = now - 240_000;
		const reply = stamped(googleReply.replaceAll("{UID}", event.uid), later);
		const mail = invitationMail({
			from: "priya@partner.example",
			to: "ada@dock.test",
			subject: "Accepted",
			ics: reply,
		});
		await inject(mail, "ada@dock.test", { from: "priya@partner.example" });
		const responses = async () =>
			Object.fromEntries(
				(await ada.call("calendar.get_event", { event_id: event.id })).event.attendees.map((attendee) => [
					attendee.email,
					attendee.response,
				]),
			);
		expect(await responses()).toEqual({
			"priya@partner.example": "accepted",
			"tunde.okafor@contoso.example": "pending",
		});
		// The same mail again, as a retry of the queue or of the sender: one message and the same state.
		await inject(mail, "ada@dock.test", { from: "priya@partner.example" });
		expect(await responses()).toMatchObject({ "priya@partner.example": "accepted" });

		// An older answer after a newer one changes nothing.
		const older = stamped(
			outlookTentative.replaceAll("{UID}", event.uid).replace("tunde.okafor@contoso.example", "priya@partner.example"),
			later - 120_000,
		);
		await inject(
			invitationMail({ from: "priya@partner.example", to: "ada@dock.test", subject: "Old", ics: older }),
			"ada@dock.test",
		);
		expect(await responses()).toMatchObject({ "priya@partner.example": "accepted" });

		// The answer of Tunde from the address of Priya, from a failed DMARC check, and from an address that is not an
		// attendee change nothing.
		const tunde = stamped(outlookTentative.replaceAll("{UID}", event.uid), later + 60_000);
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
			googleReply.replaceAll("{UID}", event.uid).replaceAll("priya@partner.example", "eve@evil.example"),
			later + 60_000,
		);
		await inject(
			invitationMail({ from: "eve@evil.example", to: "ada@dock.test", subject: "Stranger", ics: stranger }),
			"ada@dock.test",
		);
		expect(await responses()).toEqual({
			"priya@partner.example": "accepted",
			"tunde.okafor@contoso.example": "pending",
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

		const answered = await ada.call("calendar.respond_to_mail_invitation", {
			message_id: messageId,
			response: "accepted",
		});
		expect(answered.event).toMatchObject({
			uid: "4f7c2b1e9a0d3c8b@google.com",
			title: "Façade review",
			is_organizer: false,
			untrusted: true,
			my_response: "accepted",
			organizer: { principal_id: null, email: "priya@partner.example", self: false },
		});
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
		expect((await eventsOf(ada)).filter((item) => item.uid === "4f7c2b1e9a0d3c8b@google.com")).toHaveLength(1);
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
		const startOf = async () => (await eventsOf(ada)).find((item) => item.uid === event?.uid)?.when;

		// A change from a different sender, from a sender that the server did not verify, or with a different
		// organizer changes nothing.
		await receive(googleUpdate, "Forged update", "mallory@evil.example");
		await receive(googleUpdate, "Unverified update", "priya@partner.example", null);
		await receive(googleUpdate.replaceAll("priya@partner.example", "other@partner.example"), "Other organizer");
		expect(await startOf()).toMatchObject({ start: "2026-12-03T15:00:00.000Z" });
		const forged = await receive(googleCancel, "Forged cancel", "mallory@evil.example");
		expect(await startOf()).toBeDefined();
		// The card of a cancellation that changed nothing does not tell that the meeting is cancelled.
		expect((await ada.call("calendar.get_mail_invitation", { message_id: forged })).invitation).toMatchObject({
			method: "cancel",
			state: "on_calendar",
			can_respond: false,
		});

		// The real change moves the meeting with no call, and keeps the answer.
		await receive(googleUpdate, "Updated invitation: Façade review");
		const moved = (await eventsOf(ada)).find((item) => item.uid === event?.uid);
		expect(moved).toMatchObject({ when: { start: "2026-12-04T17:00:00.000Z" }, my_response: "accepted" });
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

	// The answer on the copy goes to the organizer by mail, so it has the rules of a send.
	it("needs mail.send to change the answer on a copy by mail", async () => {
		const messageId = await receive(googleTimed, "Invitation: Façade review");
		const { event } = await ada.call("calendar.respond_to_mail_invitation", {
			message_id: messageId,
			response: "accepted",
		});
		const calendarOnly = api(
			(await ada.call("account.create_api_key", { label: "cal", scopes: ["calendar.read", "calendar.write"] })).api_key
				.secret,
		);
		const event_id = event?.id as string;
		expect(await codeOf(calendarOnly("calendar.respond_to_invitation", { event_id, response: "declined" }))).toBe(
			"forbidden",
		);
		expect((await ada.call("calendar.get_event", { event_id })).event.my_response).toBe("accepted");
		await deliverAll(ada.id);
		expect(email.sent).toHaveLength(1);
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
		await ada.call("calendar.delete_event", { event_id: event?.id as string });
		await deliverAll(ada.id);
		expect(email.sent).toHaveLength(before);
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
