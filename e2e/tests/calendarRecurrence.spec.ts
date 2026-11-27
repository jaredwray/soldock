import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { signIn, unique } from "../support/chat.ts";
import { BASE_URL } from "../support/server.ts";

// "Our team meets every other Tuesday at 9 a.m. Seattle time. I can move one meeting, and everyone gets
// reminded at the right time." The browser is in Los Angeles. The series starts two weeks before the clock
// goes back, so it spans the change.
test.use({ timezoneId: "America/Los_Angeles" });

const JSON_HEADERS = { origin: BASE_URL, "content-type": "application/json" };
const LA = "America/Los_Angeles";

function addDays(day: string, days: number): string {
	return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The Tuesday 12 days before the clock goes back (the first Sunday of November) in a far year. */
function firstMeeting(): { first: string; afterChange: string } {
	const year = 2090 + Math.floor(Math.random() * 10);
	const november = new Date(Date.UTC(year, 10, 1));
	const sunday = addDays(november.toISOString().slice(0, 10), (7 - november.getUTCDay()) % 7);
	return { first: addDays(sunday, -12), afterChange: addDays(sunday, 2) };
}

interface ApiEvent {
	id: string;
	title: string;
	occurrence_id: string | null;
	my_response: string | null;
	when: { kind: string; start?: string };
}

async function api<T>(context: BrowserContext, method: "GET" | "POST", path: string, data?: unknown): Promise<T> {
	const response = await context.request.fetch(path, { method, headers: JSON_HEADERS, data: data ?? undefined });
	expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
	return (await response.json()) as T;
}

async function starts(context: BrowserContext, from: string, title: string): Promise<string[]> {
	const params = new URLSearchParams({
		time_min: `${from}T00:00:00Z`,
		time_max: `${addDays(from, 60)}T00:00:00Z`,
		time_zone: LA,
	});
	const { events } = await api<{ events: ApiEvent[] }>(context, "GET", `/api/v1/calendar/events?${params}`);
	return events.filter((event) => event.title === title).map((event) => event.when.start ?? "");
}

/** Opens the week of a day and the event with a title at a time. */
async function openEvent(page: Page, day: string, title: string, time: string) {
	await page.goto(`/calendar/week/${day}`);
	await page.getByRole("button", { name: new RegExp(`^${title}, ${time}`) }).click();
}

test("a biweekly meeting: one move, one cancel, the views of the organizer and the attendee, and free/busy", async ({
	browser,
}) => {
	const organizer = await signIn(browser, "nadia");
	const attendee = await signIn(browser, "tomasz");
	try {
		const { first, afterChange } = firstMeeting();
		const title = unique("Team sync");
		const page = await organizer.newPage();
		await page.goto(`/calendar/week/${first}`);
		await page.getByRole("button", { name: "New event" }).click();
		const dialog = page.getByRole("dialog", { name: "New event" });
		await dialog.getByLabel("Title").fill(title);
		await dialog.getByLabel("Start date").fill(first);
		await dialog.getByLabel("Start time").fill("09:00");
		await dialog.getByLabel("End date").fill(first);
		await dialog.getByLabel("End time").fill("10:00");
		await dialog.getByLabel("Repeats").click();
		await page.getByRole("option", { name: "Every 2 weeks" }).click();
		await dialog.getByLabel("Attendees").click();
		await page.getByRole("option", { name: /Tomasz Wieczorek/ }).click();
		await expect(dialog.getByRole("list", { name: "Attendees" })).toContainText("Tomasz Wieczorek");
		await dialog.getByRole("button", { name: "Save" }).click();
		await expect(page.getByText("Event added.")).toBeVisible();

		// Move the meeting after the change of the clock to 11:00, for this event only.
		await openEvent(page, afterChange, title, "9:00 AM");
		const edit = page.getByRole("dialog", { name: "Edit event" });
		await edit.getByLabel("Start time").fill("11:00");
		await edit.getByLabel("End time").fill("12:00");
		await edit.getByRole("button", { name: "Save" }).click();
		const change = page.getByRole("dialog", { name: "Change a repeated event" });
		await expect(change.getByLabel("This event")).toBeChecked();
		await change.getByRole("button", { name: "Change" }).click();
		await expect(page.getByText("Event saved.")).toBeVisible();
		await expect(page.getByRole("button", { name: new RegExp(`^${title}, 11:00 AM`) })).toBeVisible();

		// Cancel the next meeting, for this event only.
		await openEvent(page, addDays(afterChange, 14), title, "9:00 AM");
		await page.getByRole("dialog", { name: "Edit event" }).getByRole("button", { name: "Delete" }).click();
		await page.getByRole("dialog", { name: "Delete a repeated event" }).getByRole("button", { name: "Delete" }).click();
		await expect(page.getByText("Event cancelled.")).toBeVisible();
		await expect(page.getByRole("button", { name: new RegExp(`^${title}`) })).toHaveCount(0);

		const expected = [
			`${first}T16:00:00.000Z`, // 09:00 PDT
			`${afterChange}T19:00:00.000Z`, // moved to 11:00 PST
			`${addDays(afterChange, 28)}T17:00:00.000Z`, // 09:00 PST
			`${addDays(afterChange, 42)}T17:00:00.000Z`,
		];
		expect((await starts(organizer, first, title)).slice(0, 4)).toEqual(expected);
		// The copy of the attendee follows through the outbox of the organizer.
		await expect.poll(async () => (await starts(attendee, first, title)).slice(0, 4)).toEqual(expected);

		// The attendee sees the same weeks in the browser.
		const theirs = await attendee.newPage();
		await theirs.goto(`/calendar/week/${afterChange}`);
		await expect(theirs.getByRole("button", { name: new RegExp(`^${title}, 11:00 AM`) })).toBeVisible();
		await theirs.goto(`/calendar/week/${addDays(afterChange, 14)}`);
		await expect(theirs.getByRole("button", { name: new RegExp(`^${title}`) })).toHaveCount(0);

		// The attendee declines one meeting. The organizer sees the response, and free/busy has no busy time there.
		await openEvent(theirs, addDays(afterChange, 28), title, "9:00 AM");
		const invitation = theirs.getByRole("dialog", { name: "Invitation" });
		await expect(invitation).toContainText("From Nadia Rahman. Every 2 weeks.");
		await invitation.getByRole("button", { name: "Decline" }).click();
		await theirs
			.getByRole("dialog", { name: "Decline a repeated event" })
			.getByRole("button", { name: "Decline" })
			.click();
		await expect(theirs.getByText("You declined the event.")).toBeVisible();

		const whoami = await api<{ principal: { id: string } }>(attendee, "GET", "/api/v1/account");
		await expect
			.poll(async () => {
				const params = new URLSearchParams({
					principal_ids: whoami.principal.id,
					time_min: `${first}T00:00:00Z`,
					time_max: `${addDays(first, 60)}T00:00:00Z`,
				});
				const { calendars } = await api<{ calendars: { busy: { start: string }[] }[] }>(
					organizer,
					"GET",
					`/api/v1/calendar/free_busy?${params}`,
				);
				return calendars[0]?.busy.map((interval) => interval.start).filter((start) => expected.includes(start));
			})
			.toEqual([expected[0], expected[1], expected[3]]);
	} finally {
		await organizer.close();
		await attendee.close();
	}
});

test("a reminder shows in the open page and in the Activity of each participant, one time", async ({ browser }) => {
	const organizer = await signIn(browser, "nadia");
	const attendee = await signIn(browser, "tomasz");
	try {
		const page = await attendee.newPage();
		await page.goto("/calendar");
		await expect(page.getByRole("heading", { name: "Calendar", level: 1 })).toBeVisible();
		const whoami = await api<{ principal: { id: string } }>(attendee, "GET", "/api/v1/account");
		// The meeting starts in 3 minutes. The default reminder is 10 minutes before, so it is due at once.
		const title = unique("Quick check");
		const start = Date.now() + 3 * 60_000;
		await api(organizer, "POST", "/api/v1/calendar/events", {
			title,
			when: {
				kind: "timed",
				start: new Date(start).toISOString(),
				end: new Date(start + 15 * 60_000).toISOString(),
				time_zone: LA,
			},
			attendee_ids: [whoami.principal.id],
		});
		await expect(page.getByText(new RegExp(`^${title} starts at`))).toBeVisible({ timeout: 20_000 });

		const reminders = async (context: BrowserContext) => {
			const { items } = await api<{ items: { preview: string }[] }>(
				context,
				"GET",
				"/api/v1/chat/activity?filter=calendar_reminder",
			);
			return items.filter((item) => item.preview === title).length;
		};
		await expect.poll(() => reminders(organizer)).toBe(1);
		await expect.poll(() => reminders(attendee)).toBe(1);
		await page.goto("/chat/activity");
		await page.getByRole("tab", { name: "Event reminders" }).click();
		await expect(page.getByText(title)).toHaveCount(1);
	} finally {
		await organizer.close();
		await attendee.close();
	}
});
