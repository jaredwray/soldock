import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { signIn, unique } from "../support/chat.ts";
import { BASE_URL } from "../support/server.ts";

const JSON_HEADERS = { origin: BASE_URL, "content-type": "application/json" };

// Two people in two browsers, each with their own session: the organizer and the teammate that the organizer
// invites. The browsers are in New York. The test uses a far day and its own title, so no other test and no
// seed event is on the same day.
test.use({ timezoneId: "America/New_York" });

/** A random day of February in a far year: New York has no change of the clock in February. */
function farDay(): string {
	const year = 2090 + Math.floor(Math.random() * 10);
	const day = 1 + Math.floor(Math.random() * 28);
	return `${year}-02-${String(day).padStart(2, "0")}`;
}

interface ApiEvent {
	id: string;
	uid: string;
	title: string;
	is_organizer: boolean;
	my_response: string | null;
	attendees: { email: string; response: string }[];
	when: { kind: string; start?: string; end?: string };
}

/** The events of one day in New York with the title, from the server, with the session of the context. */
async function eventsOn(context: BrowserContext, day: string, title: string): Promise<ApiEvent[]> {
	const params = new URLSearchParams({
		time_min: `${day}T00:00:00-05:00`,
		time_max: `${day}T23:59:59-05:00`,
		time_zone: "America/New_York",
	});
	const response = await context.request.get(`/api/v1/calendar/events?${params}`);
	expect(response.ok(), await response.text()).toBe(true);
	return ((await response.json()) as { events: ApiEvent[] }).events.filter((event) => event.title === title);
}

/** The start times of the events with the title on the day, on each calendar. Polls until `expected`. */
async function expectStarts(contexts: BrowserContext[], day: string, title: string, expected: string[]) {
	for (const context of contexts) {
		await expect
			.poll(async () => (await eventsOn(context, day, title)).map((event) => event.when.start), { timeout: 15_000 })
			.toEqual(expected);
	}
}

async function openWeek(page: Page, day: string) {
	await page.goto(`/calendar/week/${day}`);
	await expect(page.getByRole("heading", { name: "Calendar", level: 1 })).toBeVisible();
}

test("a person invites a teammate, who accepts, and the meeting moves and goes away on both calendars", async ({
	browser,
}) => {
	const organizer = await signIn(browser, "nadia");
	const teammate = await signIn(browser, "chidi");
	try {
		const day = farDay();
		const title = unique("Facade review");
		const organizerPage = await organizer.newPage();
		const teammatePage = await teammate.newPage();

		// The organizer finds the teammate by name and invites them.
		await openWeek(organizerPage, day);
		await organizerPage.getByRole("button", { name: "New event" }).click();
		const dialog = organizerPage.getByRole("dialog", { name: "New event" });
		await dialog.getByLabel("Title").fill(title);
		await dialog.getByLabel("Start date").fill(day);
		await dialog.getByLabel("Start time").fill("10:00");
		await dialog.getByLabel("End date").fill(day);
		await dialog.getByLabel("End time").fill("11:00");
		const people = dialog.getByRole("combobox", { name: "Attendees" });
		await people.fill("Chidi");
		await dialog.getByRole("option", { name: /Chidi Okonkwo/ }).click();
		const chosen = dialog.getByRole("list", { name: "Attendees" });
		await expect(chosen.getByText("chidi@example.com")).toBeVisible();
		await expect(chosen.getByText("Invitation when you save")).toBeVisible();
		await dialog.getByRole("button", { name: "Save" }).click();
		await expect(organizerPage.getByText("Invitations sent.")).toBeVisible();
		await expectStarts([organizer, teammate], day, title, [`${day}T15:00:00.000Z`]);

		// The teammate sees a pending invitation, which looks different from an accepted meeting.
		await openWeek(teammatePage, day);
		const pending = teammatePage.getByRole("button", {
			name: `${title}, 10:00 AM – 11:00 AM, invitation, not answered`,
		});
		await expect(pending).toBeVisible();
		await expect(pending).toHaveClass(/cal-event-pending/);
		await pending.click();
		const invitation = teammatePage.getByRole("dialog", { name: "Invitation" });
		await expect(invitation.getByText("Organizer: Nadia Rahman (nadia@example.com)")).toBeVisible();
		// The attendee cannot change or delete the meeting of the organizer.
		await expect(invitation.getByRole("button", { name: "Save" })).toHaveCount(0);
		await expect(invitation.getByRole("button", { name: /Delete|Cancel meeting/ })).toHaveCount(0);
		await invitation.getByRole("group", { name: "Your answer" }).getByRole("button", { name: "Yes" }).click();
		await expect(teammatePage.getByText("Answer sent.")).toBeVisible();
		const accepted = teammatePage.getByRole("button", { name: `${title}, 10:00 AM – 11:00 AM` });
		await expect(accepted).toBeVisible();
		await expect(accepted).not.toHaveClass(/cal-event-pending/);

		// The organizer sees the answer.
		await expect
			.poll(async () => (await eventsOn(organizer, day, title))[0]?.attendees.map((attendee) => attendee.response), {
				timeout: 15_000,
			})
			.toEqual(["accepted"]);
		await organizerPage.reload();
		await organizerPage.getByRole("button", { name: `${title}, 10:00 AM – 11:00 AM` }).click();
		const edit = organizerPage.getByRole("dialog", { name: "Edit event" });
		await expect(edit.getByRole("list", { name: "Attendees" }).getByText("Yes", { exact: true })).toBeVisible();

		// The organizer moves the meeting. Each calendar has exactly one meeting, at the new time.
		await edit.getByLabel("Start time").fill("13:00");
		await edit.getByLabel("End time").fill("14:00");
		await edit.getByRole("button", { name: "Save" }).click();
		await expect(organizerPage.getByText("Event saved.")).toBeVisible();
		await expectStarts([organizer, teammate], day, title, [`${day}T18:00:00.000Z`]);
		await teammatePage.reload();
		await expect(teammatePage.getByRole("button", { name: `${title}, 1:00 PM – 2:00 PM` })).toHaveCount(1);
		await expect(teammatePage.getByRole("button", { name: new RegExp(`${title}, 10:00 AM`) })).toHaveCount(0);
		await expect(organizerPage.getByRole("button", { name: `${title}, 1:00 PM – 2:00 PM` })).toHaveCount(1);

		// The organizer cancels. Neither calendar shows the meeting.
		await organizerPage.getByRole("button", { name: `${title}, 1:00 PM – 2:00 PM` }).click();
		await organizerPage
			.getByRole("dialog", { name: "Edit event" })
			.getByRole("button", { name: "Cancel meeting" })
			.click();
		const confirm = organizerPage.getByRole("dialog", { name: "Cancel this meeting?" });
		await expect(confirm.getByText("from the calendar of each attendee")).toBeVisible();
		await confirm.getByRole("button", { name: "Cancel meeting" }).click();
		await expect(organizerPage.getByText("Meeting cancelled.")).toBeVisible();
		await expectStarts([organizer, teammate], day, title, []);
		await teammatePage.reload();
		await expect(teammatePage.getByRole("button", { name: new RegExp(title) })).toHaveCount(0);
		await expect(organizerPage.getByRole("button", { name: new RegExp(title) })).toHaveCount(0);
	} finally {
		await organizer.close();
		await teammate.close();
	}
});

// A poll has only the events of the open week. An open invitation that the organizer moves to a different week is
// not in the poll, but it is not cancelled: the dialog keeps its answers and shows the new time.
test("an open invitation follows a move to a different week, and tells a cancellation", async ({ browser }) => {
	const organizer = await signIn(browser, "nadia");
	const teammate = await signIn(browser, "chidi");
	try {
		const day = farDay();
		const later = new Date(Date.parse(`${day}T00:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10);
		const title = unique("Kiln walkthrough");
		const created = await organizer.request.post("/api/v1/calendar/events", {
			headers: JSON_HEADERS,
			data: {
				title,
				when: { kind: "timed", start: `${day}T15:00:00Z`, end: `${day}T16:00:00Z`, time_zone: "America/New_York" },
				attendees: [{ email: "chidi@example.com" }],
			},
		});
		expect(created.ok(), await created.text()).toBe(true);
		const { event } = (await created.json()) as { event: ApiEvent & { revision: number } };
		await expectStarts([teammate], day, title, [`${day}T15:00:00.000Z`]);

		const page = await teammate.newPage();
		await openWeek(page, day);
		await page.getByRole("button", { name: new RegExp(title) }).click();
		const dialog = page.getByRole("dialog", { name: "Invitation" });
		await expect(dialog.getByText("10:00 AM – 11:00 AM")).toBeVisible();

		const moved = await organizer.request.post(`/api/v1/calendar/events/${event.id}`, {
			headers: JSON_HEADERS,
			data: {
				when: { kind: "timed", start: `${later}T18:00:00Z`, end: `${later}T19:00:00Z`, time_zone: "America/New_York" },
			},
		});
		expect(moved.ok(), await moved.text()).toBe(true);
		await expectStarts([teammate], later, title, [`${later}T18:00:00.000Z`]);
		// A focus of the window loads the week again, as the poll does.
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		await expect(dialog.getByText("1:00 PM – 2:00 PM")).toBeVisible();
		await expect(dialog.getByRole("group", { name: "Your answer" }).getByRole("button", { name: "Yes" })).toBeVisible();
		await expect(dialog.getByText("The organizer cancelled this meeting or removed you from it.")).toHaveCount(0);

		const deleted = await organizer.request.delete(`/api/v1/calendar/events/${event.id}`, { headers: JSON_HEADERS });
		expect(deleted.ok(), await deleted.text()).toBe(true);
		await expectStarts([teammate], later, title, []);
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		await expect(dialog.getByText("The organizer cancelled this meeting or removed you from it.")).toBeVisible();
		await expect(dialog.getByRole("group", { name: "Your answer" })).toHaveCount(0);
	} finally {
		await organizer.close();
		await teammate.close();
	}
});
