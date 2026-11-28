import { type Browser, type BrowserContext, expect, test } from "@playwright/test";
import { signIn, unique } from "../support/chat.ts";
import {
	expectMediaFlows,
	expectMediaStopped,
	launchMediaBrowser,
	mediaContext,
	signInMedia,
} from "../support/meet.ts";
import { BASE_URL } from "../support/server.ts";

// The Meet link of a calendar event. The organizer adds the link in the event dialog and invites a customer by
// mail. The customer has no account: the customer opens the link from the invitation in a different browser, and
// the organizer admits the customer. A new time keeps the link. The delete of the event ends the call for each
// participant, and the link then does not work. A second test: a delegate adds the link in the calendar of a
// colleague, and the colleague is the host. The browser is in New York.

const JSON_HEADERS = { origin: BASE_URL, "content-type": "application/json" };
const NEW_YORK = { timezoneId: "America/New_York" };

// Each test runs browsers with synthetic media and the stand-in SFU at once.
test.describe.configure({ timeout: 120_000 });
test.use(NEW_YORK);

let hostBrowser: Browser;
let guestBrowser: Browser;

test.beforeAll(async () => {
	hostBrowser = await launchMediaBrowser();
	guestBrowser = await launchMediaBrowser();
});

test.afterAll(async () => {
	await hostBrowser?.close();
	await guestBrowser?.close();
});

/** A random day of March in a far year, so no other test and no seed event uses it. */
function farDay(): string {
	const year = 2090 + Math.floor(Math.random() * 10);
	const day = 1 + Math.floor(Math.random() * 28);
	return `${year}-03-${String(day).padStart(2, "0")}`;
}

interface ApiEvent {
	id: string;
	title: string;
	meet: { code: string; join_url: string } | null;
}

/** The events of one day in New York with this title, from the server. */
async function eventsOn(context: BrowserContext, day: string, title: string, calendarId?: string) {
	const params = new URLSearchParams({
		time_min: `${day}T00:00:00-04:00`,
		time_max: `${day}T23:59:59-04:00`,
		time_zone: "America/New_York",
		...(calendarId ? { calendar_id: calendarId } : {}),
	});
	const response = await context.request.get(`/api/v1/calendar/events?${params}`);
	expect(response.ok(), await response.text()).toBe(true);
	return ((await response.json()) as { events: ApiEvent[] }).events.filter((event) => event.title === title);
}

async function principalId(context: BrowserContext): Promise<string> {
	const response = await context.request.get("/api/v1/account");
	expect(response.ok()).toBe(true);
	return ((await response.json()) as { principal: { id: string } }).principal.id;
}

/** The plain text of the invitation in the Sent mail of the person. */
async function sentInvitation(context: BrowserContext, title: string): Promise<string> {
	let text = "";
	await expect(async () => {
		const list = await context.request.get("/api/v1/mail/threads?query=in%3Asent");
		expect(list.ok(), await list.text()).toBe(true);
		const { threads } = (await list.json()) as { threads: { id: string; subject: string }[] };
		const thread = threads.find((entry) => entry.subject === `Invitation: ${title}`);
		expect(thread, "the invitation in Sent").toBeDefined();
		const read = await context.request.get(`/api/v1/mail/threads/${thread?.id}`);
		expect(read.ok(), await read.text()).toBe(true);
		const { messages } = (await read.json()) as { messages: { body: { text: string | null } }[] };
		text = messages.at(-1)?.body.text ?? "";
		expect(text).toContain("Join the meeting: ");
	}).toPass({ timeout: 20_000 });
	return text;
}

test("an organizer adds a Meet link to an event, and a customer joins from the invitation mail", async () => {
	const organizer = await signInMedia(hostBrowser, "rafael", NEW_YORK);
	let customer: BrowserContext | undefined;
	let visitor: BrowserContext | undefined;
	try {
		const day = farDay();
		const title = unique("Quarterly review");
		const page = await organizer.newPage();
		await page.goto(`/calendar/week/${day}`);
		await page.getByRole("button", { name: "New event" }).click();
		const dialog = page.getByRole("dialog", { name: "New event" });
		await dialog.getByLabel("Title").fill(title);
		await dialog.getByLabel("Start date").fill(day);
		await dialog.getByLabel("Start time").fill("10:00");
		await dialog.getByLabel("End date").fill(day);
		await dialog.getByLabel("End time").fill("11:00");
		await dialog.getByLabel("Invite by mail").fill("customer@partner.test");
		await dialog.getByLabel("Invite by mail").press("Enter");
		// The link is part of the form: it is made on Save, and Undo takes it back.
		await dialog.getByRole("button", { name: "Create Meet link" }).click();
		await expect(dialog.getByText("A Meet link is added when you save.")).toBeVisible();
		await dialog.getByRole("button", { name: "Undo" }).click();
		await dialog.getByRole("button", { name: "Create Meet link" }).click();
		await dialog.getByRole("button", { name: "Save" }).click();
		await expect(page.getByText("Event added.")).toBeVisible();

		// The event has one link. The dialog shows Join meeting, and the invitation has the same link.
		await expect.poll(async () => (await eventsOn(organizer, day, title)).length).toBe(1);
		const [event] = await eventsOn(organizer, day, title);
		const meet = event?.meet;
		if (!meet) throw new Error("The event has no Meet link.");
		expect(meet.join_url).toBe(`${BASE_URL}/meet/${meet.code}`);
		await page.getByRole("button", { name: `${title}, 10:00 AM – 11:00 AM` }).click();
		const edit = page.getByRole("dialog", { name: "Edit event" });
		await expect(edit.getByRole("link", { name: "Join meeting" })).toHaveAttribute("href", `/meet/${meet.code}`);
		await edit.getByRole("button", { name: "Cancel" }).click();
		const mail = await sentInvitation(organizer, title);
		expect(mail.match(/Join the meeting: (\S+)/)?.[1]).toBe(meet.join_url);

		// The organizer starts the call. The customer opens the link from the mail in a different browser.
		const host = await organizer.newPage();
		await host.goto(`/meet/${meet.code}`);
		await expect(host.getByRole("heading", { name: title })).toBeVisible();
		await host.getByRole("button", { name: "Start the meeting" }).click();
		await expect(host.getByRole("button", { name: "Leave call" })).toBeVisible();
		customer = await mediaContext(guestBrowser, NEW_YORK);
		const guest = await customer.newPage();
		await guest.goto(meet.join_url);
		await guest.getByLabel("Your name").fill("Carmen Customer");
		await guest.getByRole("button", { name: "Ask to join" }).click();
		await expect(guest.getByText(/Waiting for .* to let you in/)).toBeVisible();
		await host.getByRole("button", { name: "Admit Carmen Customer" }).click();
		await expect(guest.getByRole("button", { name: "Leave call" })).toBeVisible();
		await expectMediaFlows(guest);
		await expectMediaFlows(host);

		// A new time keeps the link, and the call goes on.
		await page.getByRole("button", { name: `${title}, 10:00 AM – 11:00 AM` }).click();
		await edit.getByLabel("Start time").fill("13:00");
		await edit.getByLabel("End time").fill("14:00");
		await edit.getByRole("button", { name: "Save" }).click();
		await expect(page.getByText("Event saved.")).toBeVisible();
		await expect(page.getByRole("button", { name: `${title}, 1:00 PM – 2:00 PM` })).toBeVisible();
		expect((await eventsOn(organizer, day, title)).map((entry) => entry.meet?.code)).toEqual([meet.code]);
		await expectMediaFlows(guest);

		// The delete of the event ends the call for each participant, and the link does not work after it.
		await page.getByRole("button", { name: `${title}, 1:00 PM – 2:00 PM` }).click();
		await edit.getByRole("button", { name: "Delete" }).click();
		const confirm = page.getByRole("dialog", { name: "Delete this event?" });
		await expect(confirm).toContainText("The Meet link stops");
		await confirm.getByRole("button", { name: "Delete" }).click();
		await expect(page.getByText("Event deleted.")).toBeVisible();
		await expect(guest.getByRole("heading", { name: "The meeting was cancelled" })).toBeVisible({ timeout: 20_000 });
		await expect(host.getByRole("heading", { name: "The meeting was cancelled" })).toBeVisible();
		await expectMediaStopped(guest);
		visitor = await mediaContext(guestBrowser, NEW_YORK);
		const late = await visitor.newPage();
		await late.goto(meet.join_url);
		await expect(late.getByRole("heading", { name: "The meeting was cancelled" })).toBeVisible();
	} finally {
		await visitor?.close();
		await customer?.close();
		await organizer.close();
	}
});

test("a delegate adds a Meet link in the calendar of a colleague, and the colleague is the host", async ({
	browser,
}) => {
	// Chidi lets Mei-Ling schedule for him. No other test gives a grant between them.
	const chidi = await signIn(browser, "chidi");
	const meiling = await signIn(browser, "meiling");
	const chidiId = await principalId(chidi);
	const meilingId = await principalId(meiling);
	try {
		const grant = await chidi.request.post("/api/v1/calendar/grants", {
			headers: JSON_HEADERS,
			data: { principal_id: meilingId, access: "schedule" },
		});
		expect(grant.ok(), await grant.text()).toBe(true);
		const day = farDay();
		const title = unique("Supplier call");
		const page = await meiling.newPage();
		await page.goto(`/calendar/person/${chidiId}/week/${day}`);
		await page.getByRole("button", { name: "New event" }).click();
		const dialog = page.getByRole("dialog", { name: "New event" });
		await expect(dialog.getByText(/Chidi .* is the organizer/)).toBeVisible();
		await dialog.getByLabel("Title").fill(title);
		await dialog.getByLabel("Start date").fill(day);
		await dialog.getByLabel("Start time").fill("09:00");
		await dialog.getByLabel("End date").fill(day);
		await dialog.getByLabel("End time").fill("09:30");
		await dialog.getByRole("button", { name: "Create Meet link" }).click();
		await dialog.getByRole("button", { name: "Save" }).click();
		await expect(page.getByText("Event added.")).toBeVisible();

		// The event is in the calendar of Chidi, with the link. Chidi hosts the meeting.
		await expect
			.poll(async () => (await eventsOn(chidi, day, title)).map((event) => event.meet !== null))
			.toEqual([true]);
		const [event] = await eventsOn(chidi, day, title);
		const host = await chidi.newPage();
		await host.goto(`/meet/${event?.meet?.code}`);
		await expect(host.getByRole("button", { name: "Start the meeting" })).toBeVisible();
	} finally {
		await chidi.request.delete(`/api/v1/calendar/grants/${meilingId}`, { headers: { origin: BASE_URL } });
		await meiling.close();
		await chidi.close();
	}
});
