import { expect, test } from "@playwright/test";
import { signIn, unique } from "../support/chat.ts";
import { BASE_URL } from "../support/server.ts";

const JSON_HEADERS = { origin: BASE_URL, "content-type": "application/json" };

// The browser is in New York. The meeting is on a far day of February, so no other test and no seed event is on
// it, and New York has no change of the clock then.
test.use({ timezoneId: "America/New_York" });

function farDay(): string {
	const year = 2090 + Math.floor(Math.random() * 10);
	const day = 1 + Math.floor(Math.random() * 28);
	return `${year}-02-${String(day).padStart(2, "0")}`;
}

/** An invitation as a calendar client writes it, for a meeting from 15:00 to 16:00 UTC on a day. */
function invitation(uid: string, title: string, day: string): string {
	const date = day.replace(/-/g, "");
	return [
		"BEGIN:VCALENDAR",
		"PRODID:-//Example//Calendar//EN",
		"VERSION:2.0",
		"METHOD:REQUEST",
		"BEGIN:VEVENT",
		`UID:${uid}`,
		"SEQUENCE:0",
		`DTSTAMP:${date}T090000Z`,
		`DTSTART:${date}T150000Z`,
		`DTEND:${date}T160000Z`,
		`SUMMARY:${title}`,
		"LOCATION:Studio floor",
		"ORGANIZER;CN=Rafael Ortega:mailto:rafael@example.com",
		"ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Mei-Ling Zhou:mailto:meiling@example.com",
		"END:VEVENT",
		"END:VCALENDAR",
		"",
	].join("\r\n");
}

test("a person answers an invitation in Mail, and the meeting goes on the calendar", async ({ browser }) => {
	const person = await signIn(browser, "meiling");
	const sender = await signIn(browser, "rafael");
	try {
		const day = farDay();
		const title = unique("Lighting walkthrough");
		const uid = `${title.replace(/\W/g, "-")}@example.com`;
		const sent = await sender.request.post("/api/v1/mail/messages", {
			headers: JSON_HEADERS,
			data: {
				to: ["meiling@example.com"],
				subject: `Invitation: ${title}`,
				text: "You have an invitation.",
				attachments: [
					{ filename: "invite.ics", mime_type: "text/calendar", content_base64: btoa(invitation(uid, title, day)) },
				],
			},
		});
		expect(sent.ok(), await sent.text()).toBe(true);

		const page = await person.newPage();
		await page.goto("/mail/inbox");
		const row = page.getByRole("listitem").filter({ hasText: `Invitation: ${title}` });
		await expect(async () => {
			await page.reload();
			await expect(row).toBeVisible({ timeout: 1000 });
		}).toPass({ timeout: 20_000 });
		await row.getByRole("link").first().click();

		const card = page.getByRole("region", { name: "Invitation" });
		await expect(card.getByRole("heading", { name: title })).toBeVisible();
		await expect(card.getByText("10:00 AM – 11:00 AM")).toBeVisible();
		await expect(card.getByText("Studio floor")).toBeVisible();
		await expect(card.getByText("Organizer: Rafael Ortega (rafael@example.com)")).toBeVisible();
		await card.getByRole("group", { name: "Your answer" }).getByRole("button", { name: "Yes" }).click();
		await expect(page.getByText("Answer sent.")).toBeVisible();
		await expect(card.getByText("This meeting is on your calendar.")).toBeVisible();
		await expect(card.getByRole("button", { name: "Yes" })).toHaveAttribute("aria-pressed", "true");

		// After a reload the card shows the same state. Open in Calendar shows the meeting on its day.
		await page.reload();
		await expect(card.getByText("This meeting is on your calendar.")).toBeVisible();
		await expect(card.getByRole("button", { name: "Yes" })).toHaveAttribute("aria-pressed", "true");
		await card.getByRole("link", { name: "Open in Calendar" }).click();
		await expect(page).toHaveURL(new RegExp(`/calendar/week/${day}$`));
		const meeting = page.getByRole("button", { name: `${title}, 10:00 AM – 11:00 AM, Studio floor` });
		await expect(meeting).toBeVisible();

		// The meeting tells that it came by mail. The person removes it from the own calendar only.
		await meeting.click();
		const dialog = page.getByRole("dialog", { name: "Invitation" });
		await expect(dialog.getByRole("note")).toHaveText(/came by mail from outside your organization/);
		await dialog.getByRole("button", { name: "Remove from my calendar" }).click();
		await page.getByRole("dialog", { name: "Remove this meeting?" }).getByRole("button", { name: "Remove" }).click();
		await expect(page.getByText("Meeting removed.")).toBeVisible();
		await expect(meeting).toBeHidden();
	} finally {
		await person.close();
		await sender.close();
	}
});

test("an organizer invites an address outside the organization by mail", async ({ browser }) => {
	const organizer = await signIn(browser, "rafael");
	try {
		const day = farDay();
		const title = unique("Fabric sampling");
		const page = await organizer.newPage();
		await page.goto(`/calendar/week/${day}`);
		await page.getByRole("button", { name: "New event" }).click();
		const dialog = page.getByRole("dialog", { name: "New event" });
		await dialog.getByLabel("Title").fill(title);
		await dialog.getByLabel("Start date").fill(day);
		await dialog.getByLabel("Start time").fill("10:00");
		await dialog.getByLabel("End date").fill(day);
		await dialog.getByLabel("End time").fill("11:00");
		// Enter adds the address. It does not save the form.
		await dialog.getByLabel("Invite by mail").fill("Guest@Partner.test");
		await dialog.getByLabel("Invite by mail").press("Enter");
		await expect(dialog).toBeVisible();
		const people = dialog.getByRole("list", { name: "Attendees" });
		await expect(people.getByText("guest@partner.test (by mail)")).toBeVisible();
		await dialog.getByRole("button", { name: "Save" }).click();
		await expect(page.getByText("Event added.")).toBeVisible();

		// The event keeps the address, and the invitation is in Sent.
		await page.getByRole("button", { name: `${title}, 10:00 AM – 11:00 AM` }).click();
		const edit = page.getByRole("dialog", { name: "Edit event" });
		await expect(edit.getByRole("list", { name: "Attendees" }).getByText("guest@partner.test (by mail)")).toBeVisible();
		await expect(async () => {
			const response = await organizer.request.get("/api/v1/mail/threads?query=in%3Asent");
			expect(response.ok(), await response.text()).toBe(true);
			const { threads } = (await response.json()) as { threads: { subject: string }[] };
			expect(threads.map((thread) => thread.subject)).toContain(`Invitation: ${title}`);
		}).toPass({ timeout: 20_000 });
	} finally {
		await organizer.close();
	}
});
