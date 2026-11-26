import { CALENDAR_LIMITS } from "@asterra/contracts";
import { describe, expect, it } from "vitest";
import appleAllDay from "../../../fixtures/calendar/apple-request-all-day.ics?raw";
import appleTimed from "../../../fixtures/calendar/apple-request-timed.ics?raw";
import floating from "../../../fixtures/calendar/floating-request.ics?raw";
import googleCancel from "../../../fixtures/calendar/google-cancel.ics?raw";
import googleReply from "../../../fixtures/calendar/google-reply-accepted.ics?raw";
import googleAllDay from "../../../fixtures/calendar/google-request-all-day.ics?raw";
import googleTimed from "../../../fixtures/calendar/google-request-timed.ics?raw";
import googleUpdate from "../../../fixtures/calendar/google-update-timed.ics?raw";
import outlookCancel from "../../../fixtures/calendar/outlook-cancel.ics?raw";
import outlookDeclined from "../../../fixtures/calendar/outlook-reply-declined.ics?raw";
import outlookTimed from "../../../fixtures/calendar/outlook-request-timed.ics?raw";
import recurring from "../../../fixtures/calendar/recurring-request.ics?raw";
import unknownZone from "../../../fixtures/calendar/unknown-tzid-request.ics?raw";
import { buildICalendar, type ICalOutput, parseICalendar } from "../src/calendar/ical.ts";

const parse = (text: string) => {
	const invite = parseICalendar(text);
	if (!invite) throw new Error("the fixture did not parse");
	return invite;
};

describe("the iCalendar parser", () => {
	it("reads a timed invitation of Google Calendar, with its folded and escaped texts", () => {
		expect(parse(googleTimed)).toEqual({
			method: "REQUEST",
			uid: "4f7c2b1e9a0d3c8b@google.com",
			sequence: 0,
			stamp: Date.UTC(2026, 10, 26, 10, 15),
			title: "Façade review",
			description:
				"Quarterly review of the façade samples.\nBring the drawings, please.\n\n-::~:~::~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~::~:~::-",
			location: "Partner HQ, Room 5",
			when: {
				kind: "timed",
				start: "2026-12-03T15:00:00.000Z",
				end: "2026-12-03T16:00:00.000Z",
				time_zone: "UTC",
			},
			organizer: { email: "priya@partner.example", name: "Priya Natarajan" },
			attendees: [
				{ email: "ada@dock.test", name: "ada@dock.test", partstat: "NEEDS-ACTION" },
				{ email: "priya@partner.example", name: "Priya Natarajan", partstat: "ACCEPTED" },
			],
			recurring: false,
			cancelled: false,
		});
	});

	it("reads the change and the cancellation of the same meeting", () => {
		expect(parse(googleUpdate)).toMatchObject({
			uid: "4f7c2b1e9a0d3c8b@google.com",
			sequence: 1,
			when: { start: "2026-12-04T17:00:00.000Z", end: "2026-12-04T18:00:00.000Z" },
		});
		expect(parse(googleCancel)).toMatchObject({
			method: "CANCEL",
			uid: "4f7c2b1e9a0d3c8b@google.com",
			sequence: 2,
			cancelled: true,
		});
		expect(parse(outlookCancel)).toMatchObject({ method: "CANCEL", sequence: 1, cancelled: true });
	});

	it("gives the right instants for a Windows zone of Outlook and an IANA zone of Apple Calendar", () => {
		// 09:30 in New York in December is 14:30 UTC.
		expect(parse(outlookTimed)).toMatchObject({
			uid: "040000008200E00074C5B7101A82E00800000000A0B1C2D3E4F5A6B7000000000000000010000000F00E0D0C0B0A09080706050403020100",
			title: "Budget sync",
			description: "Agenda: budget, schedule, risks.",
			location: "Microsoft Teams Meeting",
			organizer: { email: "tunde.okafor@contoso.example", name: "Okafor, Tunde" },
			when: {
				kind: "timed",
				start: "2026-12-08T14:30:00.000Z",
				end: "2026-12-08T15:30:00.000Z",
				time_zone: "America/New_York",
			},
			recurring: false,
		});
		// 10:00 in Los Angeles in December is 18:00 UTC. The RRULE of the VTIMEZONE is not a recurring event.
		expect(parse(appleTimed)).toMatchObject({
			title: "Lighting walkthrough",
			organizer: { email: "sam@icloud.example", name: "Sam Rivera" },
			attendees: [
				{ email: "ada@dock.test", name: "Ada Lovelace", partstat: "NEEDS-ACTION" },
				{ email: "sam@icloud.example", name: "Sam Rivera", partstat: "ACCEPTED" },
			],
			when: {
				kind: "timed",
				start: "2026-12-09T18:00:00.000Z",
				end: "2026-12-09T19:30:00.000Z",
				time_zone: "America/Los_Angeles",
			},
			recurring: false,
		});
	});

	it("reads all-day events with the day after the last day as end_date", () => {
		expect(parse(googleAllDay).when).toEqual({ kind: "all_day", start_date: "2026-12-10", end_date: "2026-12-11" });
		expect(parse(appleAllDay).when).toEqual({ kind: "all_day", start_date: "2026-12-15", end_date: "2026-12-17" });
		const noEnd = googleAllDay.replace(/DTEND;VALUE=DATE:20261211\r\n/, "");
		expect(parse(noEnd).when).toEqual({ kind: "all_day", start_date: "2026-12-10", end_date: "2026-12-11" });
	});

	it("reads the one attendee of a reply of each client", () => {
		const uid = "evt_01M8CT4QHMEQCAWH7EPBBDJQPF";
		expect(parse(googleReply.replace("{UID}", uid))).toMatchObject({
			method: "REPLY",
			uid,
			attendees: [{ email: "priya@partner.example", name: "Priya Natarajan", partstat: "ACCEPTED" }],
		});
		expect(parse(outlookDeclined.replace("{UID}", uid))).toMatchObject({
			method: "REPLY",
			organizer: null,
			attendees: [{ email: "tunde.okafor@contoso.example", partstat: "DECLINED" }],
		});
	});

	it("marks a recurring meeting, and gives no time for a floating time or an unknown zone", () => {
		expect(parse(recurring).recurring).toBe(true);
		expect(parse(floating).when).toBeNull();
		expect(parse(unknownZone).when).toBeNull();
		const twoEvents = googleTimed.replace("END:VCALENDAR", "BEGIN:VEVENT\r\nUID:x\r\nEND:VEVENT\r\nEND:VCALENDAR");
		expect(parse(twoEvents).recurring).toBe(true);
	});

	it("refuses a text that is not a calendar, an event with no UID, and an oversized part", () => {
		expect(parseICalendar("Hello")).toBeNull();
		expect(parseICalendar("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n")).toBeNull();
		expect(parseICalendar(googleTimed.replace(/UID:[^\r\n]+\r\n/, ""))).toBeNull();
		const padding = `X-PAD:${"a".repeat(CALENDAR_LIMITS.icsBytes)}\r\n`;
		expect(parseICalendar(googleTimed.replace("BEGIN:VEVENT\r\n", `BEGIN:VEVENT\r\n${padding}`))).toBeNull();
	});

	it("cleans and cuts hostile text, and accepts only plain addresses", () => {
		const hostile = googleTimed
			.replace("SUMMARY:Façade review", `SUMMARY:${"x".repeat(20_000)}\u0007`)
			.replace("LOCATION:Partner HQ\\, Room 5", "LOCATION:Room\u00001")
			.replace("ORGANIZER;CN=Priya Natarajan:mailto:priya@partner.example", "ORGANIZER;CN=Evil:https://evil.example")
			.replace(
				"X-GOOGLE-CONFERENCE",
				'ATTENDEE;CN="Mallory\\r\\nORGANIZER:mailto:x@y.example":mailto:mallory@evil.example\r\nX-GOOGLE-CONFERENCE',
			);
		const invite = parse(hostile);
		expect(invite.title).toHaveLength(CALENDAR_LIMITS.titleChars);
		expect(invite.title).not.toMatch(/\p{Cc}/u);
		expect(invite.location).toBe("Room 1");
		expect(invite.organizer).toBeNull();
		expect(invite.attendees.map((attendee) => attendee.email)).toContain("mallory@evil.example");
		expect(invite.attendees.find((attendee) => attendee.email === "mallory@evil.example")?.name).not.toMatch(/\n/);
	});
});

describe("the iCalendar builder", () => {
	const base: ICalOutput = {
		method: "REQUEST",
		uid: "evt_01M8CT4QHMEQCAWH7EPBBDJQPF",
		sequence: 3,
		stamp: Date.UTC(2026, 10, 26, 12, 0, 0),
		fields: {
			title: "Review; plans, costs \\ next steps",
			description: "Line one\nLine two",
			location: "Room 4",
			all_day: false,
			start_at: Date.UTC(2026, 11, 3, 15),
			end_at: Date.UTC(2026, 11, 3, 16),
			start_date: null,
			end_date: null,
		},
		organizer: { email: "ada@dock.test", name: 'Ada "The Countess" Lovelace: Org' },
		attendees: [
			{ email: "priya@partner.example", name: "Priya Natarajan", partstat: "NEEDS-ACTION" },
			{ email: "bot@dock.test", name: "Billing Bot", partstat: "ACCEPTED" },
		],
	};

	it("writes a request that the parser reads back to the same values", () => {
		const text = buildICalendar(base);
		expect(text).toContain("METHOD:REQUEST\r\n");
		expect(text).toContain("SUMMARY:Review\\; plans\\, costs \\\\ next steps\r\n");
		expect(text).toContain('ORGANIZER;CN="Ada The Countess Lovelace: Org":mailto:ada@dock.test\r\n');
		const lines = text.split("\r\n");
		expect(lines.at(-1)).toBe("");
		for (const line of lines) expect(new TextEncoder().encode(line).byteLength).toBeLessThanOrEqual(75);
		expect(parse(text)).toEqual({
			method: "REQUEST",
			uid: base.uid,
			sequence: 3,
			stamp: base.stamp,
			title: base.fields.title,
			description: base.fields.description,
			location: "Room 4",
			when: { kind: "timed", start: "2026-12-03T15:00:00.000Z", end: "2026-12-03T16:00:00.000Z", time_zone: "UTC" },
			organizer: { email: "ada@dock.test", name: "Ada The Countess Lovelace: Org" },
			attendees: [
				{ email: "priya@partner.example", name: "Priya Natarajan", partstat: "NEEDS-ACTION" },
				{ email: "bot@dock.test", name: "Billing Bot", partstat: "ACCEPTED" },
			],
			recurring: false,
			cancelled: false,
		});
		// Only an attendee who did not answer gets RSVP=TRUE.
		expect(text.replace(/\r\n /g, "")).toMatch(/PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN="Priya Natarajan":mailto:priya/);
		expect(text.replace(/\r\n /g, "")).not.toMatch(/PARTSTAT=ACCEPTED;RSVP/);
	});

	it("writes an all-day cancellation and a reply", () => {
		const allDay = {
			...base.fields,
			all_day: true,
			start_date: "2026-12-10",
			end_date: "2026-12-12",
		};
		const cancel = buildICalendar({ ...base, method: "CANCEL", fields: allDay });
		expect(cancel).toContain("DTSTART;VALUE=DATE:20261210\r\nDTEND;VALUE=DATE:20261212\r\n");
		expect(parse(cancel)).toMatchObject({
			method: "CANCEL",
			cancelled: true,
			when: { kind: "all_day", start_date: "2026-12-10", end_date: "2026-12-12" },
		});
		const reply = buildICalendar({
			...base,
			method: "REPLY",
			attendees: [{ email: "ada@dock.test", name: "Ada Lovelace", partstat: "TENTATIVE" }],
		});
		expect(parse(reply)).toMatchObject({
			method: "REPLY",
			attendees: [{ email: "ada@dock.test", partstat: "TENTATIVE" }],
		});
		expect(reply).not.toContain("RSVP");
	});
});
