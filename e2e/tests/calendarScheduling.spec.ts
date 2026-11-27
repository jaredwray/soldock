import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { createAgent, deleteAgents } from "../support/agents.ts";
import { signIn, unique } from "../support/chat.ts";
import { BASE_URL } from "../support/server.ts";

const JSON_HEADERS = { origin: BASE_URL, "content-type": "application/json" };

// Free/busy and delegated scheduling. Ingrid shares her busy times with Rafael. Rafael finds a time with her in
// the event dialog, and then lets an agent schedule for him. The browser is in New York.
test.use({ timezoneId: "America/New_York" });

/** A random day in a far year, so no other test and no seed event uses it. */
function farDay(): string {
	const year = 2090 + Math.floor(Math.random() * 10);
	const day = 1 + Math.floor(Math.random() * 28);
	return `${year}-01-${String(day).padStart(2, "0")}`;
}

async function principalId(context: BrowserContext): Promise<string> {
	const response = await context.request.get("/api/v1/account");
	expect(response.ok()).toBe(true);
	return ((await response.json()) as { principal: { id: string } }).principal.id;
}

interface ApiEvent {
	id: string;
	title: string;
	organizer: { principal_id: string } | null;
	created_by: string | null;
}

/** The events of one day in New York with this title, from the server. */
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

/** Opens Calendar › Sharing and gives a principal access. */
async function giveAccess(page: Page, name: RegExp, access: "See when I am busy" | "Schedule for me") {
	await page.goto("/calendar");
	await page.getByRole("button", { name: "Sharing" }).click();
	const dialog = page.getByRole("dialog", { name: "Share your calendar" });
	await dialog.getByRole("combobox", { name: "Person or agent" }).click();
	await page.getByRole("option", { name }).click();
	await dialog.getByRole("combobox", { name: "Access", exact: true }).click();
	await page.getByRole("option", { name: access }).click();
	await dialog.getByRole("button", { name: "Give access" }).click();
	await expect(dialog.getByRole("list", { name: "People and agents with access" }).getByText(name)).toBeVisible();
	return dialog;
}

test("a person finds a time with a teammate, and an agent schedules for the person until the grant ends", async ({
	browser,
	request,
}) => {
	const rafael = await signIn(browser, "rafael");
	const ingrid = await signIn(browser, "ingrid");
	const admin = await signIn(browser, "tomasz");
	const agentIds: string[] = [];
	const day = farDay();
	const title = unique("Site walk");
	const agentTitle = unique("Agent sync");
	const secret = unique("Dentist");
	const rafaelId = await principalId(rafael);
	const ingridId = await principalId(ingrid);
	try {
		// Ingrid shares her busy times with Rafael, and has a private event from 10:00 to 11:00.
		const ingridPage = await ingrid.newPage();
		const sharing = await giveAccess(ingridPage, /^Rafael/, "See when I am busy");
		await sharing.getByRole("button", { name: "Done" }).click();
		const privateEvent = await ingrid.request.post("/api/v1/calendar/events", {
			headers: JSON_HEADERS,
			data: {
				title: secret,
				visibility: "private",
				when: {
					kind: "timed",
					start: `${day}T10:00:00-05:00`,
					end: `${day}T11:00:00-05:00`,
					time_zone: "America/New_York",
				},
			},
		});
		expect(privateEvent.ok(), await privateEvent.text()).toBe(true);

		// Rafael adds Ingrid and Chidi to a new event, and opens Find a time.
		const page = await rafael.newPage();
		await page.goto(`/calendar/week/${day}`);
		await page.getByRole("button", { name: "New event" }).click();
		const dialog = page.getByRole("dialog", { name: "New event" });
		await dialog.getByLabel("Title").fill(title);
		await dialog.getByLabel("Start date").fill(day);
		for (const person of [/^Ingrid/, /^Chidi/]) {
			await dialog.getByRole("combobox", { name: "Attendees" }).click();
			await page.getByRole("option", { name: person }).click();
		}
		await dialog.getByRole("button", { name: "Find a time" }).click();
		const finder = dialog.getByRole("region", { name: "Find a time" });
		await finder.getByLabel("From", { exact: true }).fill(day);
		await finder.getByLabel("To", { exact: true }).fill(day);
		await finder.getByRole("button", { name: "Find times" }).click();

		// Ingrid shows the busy hour, not the title. Chidi shares nothing, so his time is unknown, never free.
		const ingridBusy = finder.getByRole("list", { name: /^Busy times of Ingrid/ });
		await expect(ingridBusy).toContainText("10:00 AM – 11:00 AM");
		await expect(finder).not.toContainText(secret);
		await expect(finder.getByRole("listitem").filter({ hasText: /^Chidi/ })).toContainText("Availability unknown");
		await expect(finder.getByRole("note")).toContainText(/does not know when Chidi/);

		// With an unknown calendar the panel suggests no time, until Rafael asks for the times of the others.
		const nineOClock = finder.getByRole("button", { name: /9:00 AM – 9:30 AM/ });
		await expect(finder.getByRole("button", { name: "Suggest times without them" })).toBeVisible();
		await expect(nineOClock).toHaveCount(0);
		await expect(finder.getByRole("button", { name: /AM – |PM – / })).toHaveCount(0);
		await finder.getByRole("button", { name: "Suggest times without them" }).click();
		await expect(finder.getByRole("note")).toContainText("free only for the other calendars");

		// The first suggestion is 9:00. A click fills the time of the event.
		await nineOClock.click();
		await expect(dialog.getByLabel("Start time")).toHaveValue("09:00");
		await expect(dialog.getByLabel("End time")).toHaveValue("09:30");
		await dialog.getByRole("button", { name: "Save" }).click();
		await expect(page.getByText("Event added.")).toBeVisible();

		// Ingrid gets one invitation, with Rafael as the organizer.
		await expect
			.poll(async () => (await eventsOn(ingrid, day, title)).map((event) => event.organizer?.principal_id))
			.toEqual([rafaelId]);

		// Rafael lets an agent schedule for him.
		const agent = await createAgent(admin, request, unique("Scheduler"));
		agentIds.push(agent.id);
		const grants = await giveAccess(page, /^Scheduler/, "Schedule for me");
		const found = await agent.callTool("calendar_find_times", {
			calendar_id: rafaelId,
			attendee_ids: ingridId,
			time_min: `${day}T00:00:00-05:00`,
			time_max: `${day}T23:59:59-05:00`,
			duration_minutes: 30,
			time_zone: "America/New_York",
			day_start: "11:00",
		});
		expect(found.isError).toBeUndefined();
		const slot = (found.structuredContent as { suggestions: { start: string; end: string }[] }).suggestions[0];
		expect(slot).toBeDefined();
		const created = await agent.callTool("calendar_create_event", {
			calendar_id: rafaelId,
			title: agentTitle,
			when: { kind: "timed", start: slot?.start, end: slot?.end, time_zone: "America/New_York" },
			attendee_ids: [ingridId],
		});
		expect(created.isError).toBeUndefined();
		await expect
			.poll(async () => (await eventsOn(ingrid, day, agentTitle)).map((event) => event.organizer?.principal_id))
			.toEqual([rafaelId]);

		// Rafael removes the grant: the next attempt of the agent is refused.
		await grants.getByRole("button", { name: /^Remove the access of Scheduler/ }).click();
		await expect(grants.getByText("Only you can see your calendar.")).toBeVisible();
		const refused = await agent.callTool("calendar_create_event", {
			calendar_id: rafaelId,
			title: `${agentTitle} again`,
			when: { kind: "timed", start: slot?.start, end: slot?.end, time_zone: "America/New_York" },
		});
		expect(refused.isError).toBe(true);
		expect(JSON.parse(refused.content[0]?.text ?? "{}")).toMatchObject({ code: "forbidden" });
	} finally {
		await deleteAgents(admin, agentIds);
		await ingrid.request.delete(`/api/v1/calendar/grants/${rafaelId}`, { headers: JSON_HEADERS, data: {} });
		for (const context of [rafael, ingrid, admin]) await context.close();
	}
});

test("a person schedules in the calendar of a colleague from the calendar switcher, until the grant ends", async ({
	browser,
}) => {
	// Tomasz lets Ingrid schedule for him. The first test uses Ingrid only as a teammate of Rafael.
	const tomasz = await signIn(browser, "tomasz");
	const ingrid = await signIn(browser, "ingrid");
	const day = farDay();
	const title = unique("Vendor call");
	const secret = unique("Hospital");
	const board = unique("Board prep");
	const tomaszId = await principalId(tomasz);
	const ingridId = await principalId(ingrid);
	const created: string[] = [];
	try {
		const ownerPage = await tomasz.newPage();
		await giveAccess(ownerPage, /^Ingrid/, "Schedule for me");
		for (const data of [
			{ title: secret, visibility: "private", start: "10:00", end: "11:00", description: "" },
			{ title: board, visibility: "default", start: "13:00", end: "14:00", description: `${secret} numbers` },
		]) {
			const response = await tomasz.request.post("/api/v1/calendar/events", {
				headers: JSON_HEADERS,
				data: {
					title: data.title,
					visibility: data.visibility,
					description: data.description,
					when: {
						kind: "timed",
						start: `${day}T${data.start}:00-05:00`,
						end: `${day}T${data.end}:00-05:00`,
						time_zone: "America/New_York",
					},
				},
			});
			expect(response.ok(), await response.text()).toBe(true);
			created.push(((await response.json()) as { event: ApiEvent }).event.id);
		}

		// Ingrid opens the calendar of Tomasz from the switcher.
		const page = await ingrid.newPage();
		await page.goto(`/calendar/week/${day}`);
		await page.getByRole("combobox", { name: "Calendar" }).click();
		await page.getByRole("option", { name: /^Tomasz/ }).click();
		await expect(page).toHaveURL(new RegExp(`/calendar/person/${tomaszId}/week/${day}$`));
		await expect(page.getByText(/You schedule for Tomasz/)).toBeVisible();
		// The private event is "Busy". The other event shows its title, and no description.
		await expect(page.getByRole("button", { name: new RegExp(`^${board}`) })).toBeVisible();
		await expect(page.locator("main")).not.toContainText(secret);
		await page.getByRole("button", { name: /^Busy,/ }).click();
		const busy = page.getByRole("dialog", { name: "Busy" });
		await expect(busy.getByText(/You see only the time/)).toBeVisible();
		await expect(busy.getByRole("button", { name: "Save" })).toHaveCount(0);
		await busy.getByText("Close", { exact: true }).click();

		// A new event: Find a time runs as Tomasz, so his busy hour shows.
		await page.getByRole("button", { name: "New event" }).click();
		const dialog = page.getByRole("dialog", { name: "New event" });
		await expect(dialog.getByText(/Tomasz Wieczorek is the organizer/)).toBeVisible();
		await dialog.getByLabel("Title").fill(title);
		await dialog.getByLabel("Start date").fill(day);
		await dialog.getByRole("button", { name: "Find a time" }).click();
		const finder = dialog.getByRole("region", { name: "Find a time" });
		await finder.getByLabel("From", { exact: true }).fill(day);
		await finder.getByLabel("To", { exact: true }).fill(day);
		await finder.getByRole("button", { name: "Find times" }).click();
		await expect(finder.getByRole("list", { name: /^Busy times of Tomasz/ })).toContainText("10:00 AM – 11:00 AM");
		await finder.getByRole("button", { name: /9:00 AM – 9:30 AM/ }).click();
		await dialog.getByRole("button", { name: "Save" }).click();
		await expect(page.getByText("Event added.")).toBeVisible();

		// The event is in the calendar of Tomasz, with Tomasz as organizer and Ingrid as the delegate that added it.
		await expect
			.poll(async () =>
				(await eventsOn(tomasz, day, title)).map((event) => [event.organizer?.principal_id, event.created_by]),
			)
			.toEqual([[tomaszId, ingridId]]);
		expect(await eventsOn(ingrid, day, title)).toEqual([]);
		created.push(...(await eventsOn(tomasz, day, title)).map((event) => event.id));

		// Tomasz removes the access: the page of Ingrid shows that the calendar is not hers to use.
		const removed = await tomasz.request.delete(`/api/v1/calendar/grants/${ingridId}`, {
			headers: JSON_HEADERS,
			data: {},
		});
		expect(removed.ok()).toBe(true);
		await page.reload();
		await expect(page.getByRole("alert")).toContainText("You cannot use the calendar of");
		await expect(page.locator("main")).not.toContainText(board);
	} finally {
		await tomasz.request.delete(`/api/v1/calendar/grants/${ingridId}`, { headers: JSON_HEADERS, data: {} });
		for (const id of created) {
			await tomasz.request.delete(`/api/v1/calendar/events/${id}`, { headers: JSON_HEADERS, data: {} });
		}
		for (const context of [tomasz, ingrid]) await context.close();
	}
});
