import { type BrowserContext, expect, test } from "@playwright/test";
import { signIn, unique } from "../support/chat.ts";
import { BASE_URL } from "../support/server.ts";

const JSON_HEADERS = { origin: BASE_URL, "content-type": "application/json" };

// The browser is in New York, so the test also proves that the page sends the time zone and the instants of
// its clock. The tests share the calendar of one seed person: each one uses its own far week and its own title.
test.use({ timezoneId: "America/New_York" });

/** A day in a far week of a month, so no other test and no seed event uses it. */
function farDay(month: "01" | "02"): string {
	return `${2090 + Math.floor(Math.random() * 10)}-${month}-14`;
}

interface ApiEvent {
	id: string;
	title: string;
	location: string;
	when: { kind: string; start?: string; end?: string; time_zone?: string; start_date?: string; end_date?: string };
}

/** The events of one day in New York, from the server. */
async function eventsOn(context: BrowserContext, day: string): Promise<ApiEvent[]> {
	const params = new URLSearchParams({
		time_min: `${day}T00:00:00-05:00`,
		time_max: `${day}T23:59:59-05:00`,
		time_zone: "America/New_York",
	});
	const response = await context.request.get(`/api/v1/calendar/events?${params}`);
	expect(response.ok(), await response.text()).toBe(true);
	return ((await response.json()) as { events: ApiEvent[] }).events;
}

test("a person adds, changes and deletes an event in the week and the month views", async ({ browser }) => {
	const context = await signIn(browser, "meiling");
	try {
		const page = await context.newPage();
		await page.goto("/");
		await page.getByRole("navigation", { name: "Products" }).getByRole("link", { name: "Calendar" }).click();
		await expect(page).toHaveURL(/\/calendar$/);
		await expect(page.getByRole("heading", { name: "Calendar", level: 1 })).toBeVisible();

		const day = farDay("01");
		const title = unique("Lighting review");
		await page.goto(`/calendar/week/${day}`);
		await page.getByRole("button", { name: "New event" }).click();
		const dialog = page.getByRole("dialog", { name: "New event" });
		await dialog.getByLabel("Title").fill(title);
		await dialog.getByLabel("Start date").fill(day);
		await dialog.getByLabel("Start time").fill("10:00");
		await dialog.getByLabel("End date").fill(day);
		await dialog.getByLabel("End time").fill("11:30");
		await dialog.getByLabel("Location").fill("Studio floor");
		await expect(dialog.getByText("Times are in America/New_York.")).toBeVisible();
		await dialog.getByRole("button", { name: "Save" }).click();
		await expect(page.getByText("Event added.")).toBeVisible();
		await expect(dialog).toBeHidden();

		const event = page.getByRole("button", { name: `${title}, 10:00 AM – 11:30 AM, Studio floor` });
		await expect(event).toBeVisible();
		// The server has the instants of the clock of New York, in UTC, with the zone of the browser.
		const [stored] = await eventsOn(context, day);
		expect(stored).toMatchObject({
			title,
			location: "Studio floor",
			when: {
				kind: "timed",
				start: `${day}T15:00:00.000Z`,
				end: `${day}T16:30:00.000Z`,
				time_zone: "America/New_York",
			},
		});

		// The month view shows the same event on its day.
		await page.getByRole("navigation", { name: "Calendar view" }).getByRole("link", { name: "Month" }).click();
		await expect(page).toHaveURL(new RegExp(`/calendar/month/${day}$`));
		const cell = page.getByRole("region", { name: new RegExp(`January 14, ${day.slice(0, 4)}`) });
		await expect(cell.getByRole("button", { name: new RegExp(title) })).toBeVisible();

		// A change of the title stays after a reload.
		await cell.getByRole("button", { name: new RegExp(title) }).click();
		const edit = page.getByRole("dialog", { name: "Edit event" });
		await expect(edit.getByLabel("Start time")).toHaveValue("10:00");
		await edit.getByLabel("Title").fill(`${title} (moved)`);
		await edit.getByRole("button", { name: "Save" }).click();
		await expect(page.getByText("Event saved.")).toBeVisible();
		await page.reload();
		await expect(cell.getByRole("button", { name: new RegExp(`${title} \\(moved\\)`) })).toBeVisible();

		// Delete asks first. Cancel goes back to the form, and Delete removes the event.
		await cell.getByRole("button", { name: new RegExp(title) }).click();
		await page.getByRole("dialog", { name: "Edit event" }).getByRole("button", { name: "Delete" }).click();
		const confirm = page.getByRole("dialog", { name: "Delete this event?" });
		await confirm.getByRole("button", { name: "Cancel" }).click();
		await expect(page.getByRole("dialog", { name: "Edit event" })).toBeVisible();
		await page.getByRole("dialog", { name: "Edit event" }).getByRole("button", { name: "Delete" }).click();
		await page.getByRole("dialog", { name: "Delete this event?" }).getByRole("button", { name: "Delete" }).click();
		await expect(page.getByText("Event deleted.")).toBeVisible();
		await expect(cell.getByRole("button", { name: new RegExp(title) })).toBeHidden();
		expect(await eventsOn(context, day)).toEqual([]);
	} finally {
		await context.close();
	}
});

test("a phone shows the days with events as a list, and an all-day event on its own day", async ({ browser }) => {
	const context = await signIn(browser, "meiling");
	try {
		const day = farDay("02");
		const title = unique("Fabric delivery");
		const response = await context.request.post("/api/v1/calendar/events", {
			headers: JSON_HEADERS,
			data: { title, when: { kind: "all_day", start_date: day, end_date: `${day.slice(0, 8)}15` } },
		});
		expect(response.ok(), await response.text()).toBe(true);
		const { event } = (await response.json()) as { event: ApiEvent };

		const page = await context.newPage();
		await page.setViewportSize({ width: 390, height: 800 });
		await page.goto(`/calendar/week/${day}`);
		const date = new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
			weekday: "long",
			month: "long",
			day: "numeric",
			year: "numeric",
			timeZone: "UTC",
		});
		await expect(page.getByRole("heading", { name: date, level: 2 })).toBeVisible();
		await page.getByRole("button", { name: `${title}, All day` }).click();
		const edit = page.getByRole("dialog", { name: "Edit event" });
		await expect(edit.getByLabel("All day")).toBeChecked();
		await expect(edit.getByLabel("Last day")).toHaveValue(day);
		await edit.getByRole("button", { name: "Cancel" }).click();

		// The page has no horizontal scroll at the width of a phone.
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
		await context.request.delete(`/api/v1/calendar/events/${event.id}`, { headers: JSON_HEADERS, data: {} });
	} finally {
		await context.close();
	}
});
