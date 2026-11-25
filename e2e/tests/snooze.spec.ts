import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { signIn, unique } from "../support/chat.ts";
import { BASE_URL } from "../support/server.ts";

const JSON_HEADERS = { origin: BASE_URL, "content-type": "application/json" };

/** Calls a POST operation with the session of the context, and returns its result. */
async function post<T>(context: BrowserContext, path: string, data: unknown): Promise<T> {
	const response = await context.request.post(path, { headers: JSON_HEADERS, data });
	expect(response.ok(), `POST ${path}: ${response.status()} ${await response.text()}`).toBe(true);
	return (await response.json()) as T;
}

/** A new shared mailbox with the member in it, so no other test sees its mail. */
async function newTeamMailbox(admin: BrowserContext, member: BrowserContext, prefix: string) {
	const name = unique(prefix);
	const address = `${prefix.toLowerCase()}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@example.com`;
	const me = await (await member.request.get("/api/v1/account")).json();
	const { team_mailbox: mailbox } = await post<{ team_mailbox: { id: string } }>(
		admin,
		"/api/v1/directory/team-mailboxes",
		{ display_name: name, address, member_ids: [me.principal.id] },
	);
	return { id: mailbox.id, address, name };
}

/** The subjects of the threads of a query in the mailbox, from the server. */
async function subjects(member: BrowserContext, mailboxId: string, query: string): Promise<string[]> {
	const response = await member.request.get(
		`/api/v1/mail/threads?mailbox_id=${mailboxId}&query=${encodeURIComponent(query)}&limit=100`,
	);
	return ((await response.json()).threads as { subject: string }[]).map((thread) => thread.subject);
}

/** Opens a list and waits until each subject shows. Local mail goes through the outbox, so it can come later. */
async function openList(page: Page, path: string, wanted: readonly string[]) {
	await expect(async () => {
		await page.goto(path);
		for (const subject of wanted) {
			await expect(page.getByRole("listitem").filter({ hasText: subject })).toBeVisible({ timeout: 1000 });
		}
	}).toPass({ timeout: 20_000 });
}

/** The parts of the Focus page that each test reads. */
function focusPage(page: Page) {
	const main = page.getByRole("main");
	const reply = main.getByRole("region", { name: "Reply" });
	return {
		main,
		subject: main.getByRole("heading", { level: 2 }),
		position: (text: string) => main.getByText(text, { exact: true }),
		reply,
		message: reply.getByRole("textbox", { name: "Message" }),
		undo: (notice: string) =>
			page.locator(".toast").filter({ hasText: notice }).getByRole("button", { name: "Undo" }).last(),
	};
}

// Snooze: a conversation leaves the inbox until a time that the person picks, and waits in the Snoozed list
// with a count in the sidebar. The Snooze button opens a list of times, so one more click snoozes. The dialog
// has the same times and a field for a date and a time. Unsnooze puts
// a conversation back in the inbox, and its Undo gives the snooze back with the same time. The server test
// covers the return to the inbox at the time.
test("a member snoozes mail until a time, changes the time, and ends a snooze", async ({ browser }) => {
	const admin = await signIn(browser, "tomasz");
	const member = await signIn(browser, "rafael");
	try {
		const mailbox = await newTeamMailbox(admin, member, "Partners");
		const first = unique("Contract terms");
		const second = unique("Event venue");
		const address = mailbox.address;
		await post(admin, "/api/v1/mail/messages", { to: [address], subject: first, text: "Can you check clause 4?" });
		await post(admin, "/api/v1/mail/messages", { to: [address], subject: second, text: "Which venue do you like?" });
		/** The time of the snooze of each snoozed conversation, by subject, from the server. */
		const snoozed = async () => {
			const response = await member.request.get(`/api/v1/mail/threads?mailbox_id=${mailbox.id}&query=in%3Asnoozed`);
			const { threads } = (await response.json()) as { threads: { subject: string; snoozed_until: string }[] };
			return Object.fromEntries(threads.map((thread) => [thread.subject, thread.snoozed_until]));
		};

		const page = await member.newPage();
		const inbox = `/mail/team/${mailbox.id}/inbox`;
		const firstRow = page.getByRole("listitem").filter({ hasText: first });
		const secondRow = page.getByRole("listitem").filter({ hasText: second });
		await openList(page, inbox, [first, second]);
		const dialog = page.getByRole("dialog", { name: "Snooze until" });

		// From an open conversation: Snooze opens a list of times, with no dialog. A time of the list sends the
		// conversation out of the inbox and back to the list.
		await firstRow.getByRole("link").click();
		// The conversation gets the focus when it shows, and a list that is open then closes. So the member
		// opens the list after the conversation shows.
		await expect(page.getByText("Can you check clause 4?")).toBeVisible();
		/** Tomorrow, 8:00, in the time zone of the browser, which is the time zone of the runner. */
		const tomorrowMorning = () => {
			const date = new Date();
			date.setDate(date.getDate() + 1);
			date.setHours(8, 0, 0, 0);
			return date.toISOString();
		};
		// The day can change between the click and the check, so the time of each side of the click is correct.
		const before = tomorrowMorning();
		await page.getByRole("combobox", { name: "Snooze", exact: true }).click();
		await page.getByRole("option", { name: /^Tomorrow/ }).click();
		await expect(dialog).toHaveCount(0);
		await expect(page.getByText(/^Conversation snoozed until .+\.$/)).toBeVisible();
		await expect(page).toHaveURL(new RegExp(`${inbox}$`));
		await expect(firstRow).toHaveCount(0);
		await expect.poll(async () => Object.keys(await snoozed())).toEqual([first]);
		const tomorrow = (await snoozed())[first] as string;
		expect([before, tomorrowMorning()]).toContain(tomorrow);

		// From the list, with the keyboard: the b key on the row at the cursor opens the dialog. The person gives a
		// date and a time. The dialog refuses a time that is not later than now, and stays open.
		await expect(secondRow).toBeVisible();
		await page.keyboard.press("b");
		const field = dialog.getByLabel("Pick a date and a time");
		await field.fill("2020-01-06T09:30");
		await dialog.getByRole("button", { name: "Snooze", exact: true }).click();
		await expect(dialog.getByRole("alert")).toHaveText("Pick a date and a time that are later than now.");
		await field.fill("2031-01-06T09:30");
		await dialog.getByRole("button", { name: "Snooze", exact: true }).click();
		await expect(secondRow).toHaveCount(0);
		const picked = new Date(2031, 0, 6, 9, 30).toISOString();
		await expect.poll(snoozed).toEqual({ [first]: tomorrow, [second]: picked });
		await expect(page.getByText("The inbox of this team mailbox is empty.")).toBeVisible();

		// The sidebar counts the snoozed conversations, and each row of the Snoozed list shows its time.
		const nav = page.getByRole("navigation", { name: "Mailboxes, folders and labels" });
		await nav.getByRole("link", { name: /^Snoozed\s*2 conversations$/ }).click();
		await expect(page).toHaveURL(new RegExp(`/mail/team/${mailbox.id}/snoozed$`));
		await expect(firstRow).toContainText("Snoozed until");
		await expect(secondRow).toContainText("Snoozed until");

		// Unsnooze puts the conversation back in the inbox. Undo gives the snooze back, with the time from before.
		await secondRow.getByRole("checkbox").check();
		await page.getByRole("button", { name: "Unsnooze" }).click();
		await expect(secondRow).toHaveCount(0);
		await expect.poll(() => subjects(member, mailbox.id, "in:inbox")).toEqual([second]);
		await page
			.locator(".toast")
			.filter({ hasText: "Conversation moved to the inbox." })
			.getByRole("button", { name: "Undo" })
			.click();
		await expect(page.getByText("Action undone.")).toBeVisible();
		await expect.poll(snoozed).toEqual({ [first]: tomorrow, [second]: picked });
		await expect(secondRow).toBeVisible();

		// A snooze of a snoozed conversation changes its time, and the conversation stays in the list. The last
		// option of the Snooze list opens the dialog.
		await firstRow.getByRole("checkbox").check();
		await page.getByRole("combobox", { name: "Snooze until a different time" }).click();
		await page.getByRole("option", { name: "Pick a date and time…" }).click();
		await field.fill("2031-02-03T10:00");
		await dialog.getByRole("button", { name: "Snooze", exact: true }).click();
		await expect.poll(snoozed).toEqual({ [first]: new Date(2031, 1, 3, 10, 0).toISOString(), [second]: picked });
		await expect(firstRow).toBeVisible();
		expect(await subjects(member, mailbox.id, "in:inbox")).toEqual([]);
	} finally {
		await admin.close();
		await member.close();
	}
});

// Focus shows the conversations of a list one at a time, each with its newest message. Reply opens the composer
// in the page, and after a send the next conversation shows with its reply open. Done takes a conversation out
// of the list without a reply, and Undo shows it again. When no conversation stays, a finish state shows what
// the person cleared. This test uses Starred: Done there removes the star.
test("a member answers starred mail in Focus", async ({ browser }) => {
	const admin = await signIn(browser, "tomasz");
	const member = await signIn(browser, "rafael");
	try {
		const mailbox = await newTeamMailbox(admin, member, "Partners");
		const first = unique("Contract terms");
		const second = unique("Event venue");
		const third = unique("Team lunch");
		const address = mailbox.address;
		await post(admin, "/api/v1/mail/messages", { to: [address], subject: first, text: "Can you check clause 4?" });
		await post(admin, "/api/v1/mail/messages", { to: [address], subject: second, text: "Which venue do you like?" });
		await post(admin, "/api/v1/mail/messages", { to: [address], subject: third, text: "Pizza or sushi on Friday?" });

		const page = await member.newPage();
		const inbox = `/mail/team/${mailbox.id}/inbox`;
		await openList(page, inbox, [first, second, third]);
		for (const subject of [first, second, third]) {
			const row = page.getByRole("listitem").filter({ hasText: subject });
			await row.getByRole("button", { name: "Star" }).click();
			await expect(row.getByRole("button", { name: "Star" })).toHaveAttribute("title", "Starred");
		}
		await expect.poll(async () => (await subjects(member, mailbox.id, "is:starred")).length).toBe(3);

		await page.goto(`/mail/team/${mailbox.id}/starred`);
		await page.getByRole("main").getByRole("link", { name: "Focus", exact: true }).click();
		await expect(page).toHaveURL(new RegExp(`/mail/team/${mailbox.id}/starred/focus$`));
		const focus = focusPage(page);
		const { main, subject, reply, message } = focus;
		await expect(main.getByRole("heading", { level: 1, name: `${mailbox.name}: Focus` })).toBeVisible();
		// One conversation shows: the newest, with its newest message and its body.
		await expect(subject).toHaveText(third);
		await expect(main.getByText("Pizza or sushi on Friday?")).toBeVisible();
		await expect(focus.position("1 of 3")).toBeVisible();

		// r opens the reply in the page, not in a dialog, with the focus in the message.
		await page.keyboard.press("r");
		await expect(message).toBeFocused();
		await expect(page.getByRole("dialog")).toHaveCount(0);
		// Escape closes a reply with no text, and the focus goes to the subject. j and k move between conversations.
		await page.keyboard.press("Escape");
		await expect(reply).toHaveCount(0);
		await expect(subject).toBeFocused();
		await page.keyboard.press("j");
		await expect(subject).toHaveText(second);
		await expect(focus.position("2 of 3")).toBeVisible();
		// After a key, the focus is on the subject, and the live region says where the person is.
		await expect(subject).toBeFocused();
		await expect(main.locator('p[aria-live="polite"]')).toHaveText(
			`Conversation 2 of 3: ${second}, from Tomasz Wieczorek.`,
		);
		await page.keyboard.press("k");
		await expect(subject).toHaveText(third);
		await expect(main.getByRole("button", { name: "Previous conversation" })).toHaveAttribute("aria-disabled", "true");
		await page.keyboard.press("r");
		await expect(message).toBeFocused();
		await message.pressSequentially("Pizza, please.");
		// While the reply has text, the keys do nothing, so a key never discards it. b opens no Snooze dialog.
		await subject.focus();
		for (const key of ["j", "e", "b", "!"]) await page.keyboard.press(key);
		await expect(subject).toHaveText(third);
		await expect(message).toContainText("Pizza, please.");
		await expect(page.getByRole("dialog")).toHaveCount(0);

		// Ctrl+Enter in the link dialog of the editor does not send the message. The reply and its text stay.
		await reply.getByRole("button", { name: "Link" }).click();
		const linkDialog = page.getByRole("dialog", { name: "Add link" });
		await linkDialog.getByRole("textbox", { name: "Web address or email" }).press("Control+Enter");
		await linkDialog.getByRole("button", { name: "Cancel" }).click({ timeout: 5000 });
		await expect(linkDialog).toHaveCount(0);

		// While the reply has text, the Back link, Next, Done and a time of the Snooze list ask first. A No keeps
		// the conversation and the text.
		const snoozeTomorrow = {
			click: async () => {
				await main.getByRole("combobox", { name: /^Snooze/ }).click();
				await page.getByRole("option", { name: /^Tomorrow/ }).click();
			},
		};
		for (const control of [
			main.getByRole("link", { name: "Back to Starred" }),
			main.getByRole("button", { name: "Next conversation" }),
			main.getByRole("button", { name: /^Done/ }),
			snoozeTomorrow,
		]) {
			let question = "";
			page.once("dialog", (dialog) => {
				question = dialog.message();
				void dialog.dismiss();
			});
			await control.click();
			expect(question).toBe("Discard your reply?");
			await expect(message).toContainText("Pizza, please.");
		}
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await expect(page).toHaveURL(/\/starred\/focus$/);
		await expect(subject).toHaveText(third);

		// Ctrl+Enter sends. The next conversation shows, with its reply open and the focus in the message.
		await message.focus();
		await page.keyboard.press("Control+Enter");
		await expect(subject).toHaveText(second);
		await expect(message).toBeFocused();
		await expect(focus.position("1 of 2")).toBeVisible();
		await expect(main.getByText("1 done", { exact: true })).toBeVisible();
		await expect(page.getByText("Message sent.")).toHaveCount(0);

		// Done takes the conversation out without a reply, and the next one shows. Undo shows it again.
		await page.keyboard.press("Escape");
		await expect(reply).toHaveCount(0);
		await main.getByRole("button", { name: /^Done/ }).click();
		await expect(subject).toHaveText(first);
		await expect(focus.position("1 of 1")).toBeVisible();
		await focus.undo("Star removed.").click();
		await expect(page.getByText("Action undone.")).toBeVisible();
		await expect(subject).toHaveText(second);
		await expect(focus.position("1 of 2")).toBeVisible();
		await expect(reply).toHaveCount(0);

		// e is Done. Done on the last one shows the finish state with what the member cleared.
		await page.keyboard.press("e");
		await expect(subject).toHaveText(first);
		await main.getByRole("button", { name: /^Done/ }).click();
		await expect(main.getByText("All caught up.", { exact: true })).toBeVisible();
		await expect(main.getByText("You answered 1 conversation and marked 2 as done.", { exact: true })).toBeVisible();
		const session = main.getByRole("region", { name: "In this session" });
		await expect(session.getByRole("link", { name: third })).toBeVisible();
		await expect(main).toBeFocused();

		// A reply keeps the star, and Done removed the two other stars. The page shows the finish state before the
		// server confirms the last Done.
		await expect.poll(() => subjects(member, mailbox.id, "is:starred")).toEqual([third]);
	} finally {
		await admin.close();
		await member.close();
	}
});

// Focus works in each list. In the inbox, a send also archives the conversation, b snoozes it, !
// marks it as spam, and the primary button is Archive (e). In Starred, the primary button is Done, and a reply
// keeps the star. A conversation that the person cleared does not come back in this visit.
test("a member clears the inbox and Starred in Focus", async ({ browser }) => {
	const admin = await signIn(browser, "tomasz");
	const member = await signIn(browser, "rafael");
	try {
		const mailbox = await newTeamMailbox(admin, member, "Operations");
		const oldest = unique("Budget review");
		const older = unique("Supplier offer");
		const newer = unique("Office move");
		const newest = unique("Hiring plan");
		const send = (subject: string, text: string) =>
			post(admin, "/api/v1/mail/messages", { to: [mailbox.address], subject, text });
		await send(oldest, "Can you approve the budget?");
		await send(older, "A great offer for you.");
		await send(newer, "Which day suits the move?");
		await send(newest, "Do we hire two people?");

		const page = await member.newPage();
		const inbox = `/mail/team/${mailbox.id}/inbox`;
		await openList(page, inbox, [oldest, older, newer, newest]);
		// A star on the oldest conversation, for Starred at the end.
		const oldestRow = page.getByRole("listitem").filter({ hasText: oldest });
		await oldestRow.getByRole("button", { name: "Star" }).click();
		await expect(oldestRow.getByRole("button", { name: "Star" })).toHaveAttribute("title", "Starred");

		// In Starred, the primary button is Done. A starred conversation in the inbox also has Archive, with Undo.
		const focus = focusPage(page);
		const { main, subject, message } = focus;
		await page.goto(`/mail/team/${mailbox.id}/starred/focus`);
		await expect(subject).toHaveText(oldest);
		await expect(main.getByRole("button", { name: /^Done/ })).toBeVisible();
		await main.getByRole("button", { name: /^Archive/ }).click();
		await expect(main.getByText("You archived 1 conversation.", { exact: true })).toBeVisible();
		await focus.undo("Conversation archived.").click();
		await expect(subject).toHaveText(oldest);
		await expect.poll(() => subjects(member, mailbox.id, "in:inbox")).toContain(oldest);

		await page.goto(inbox);
		await main.getByRole("link", { name: "Focus", exact: true }).click();
		await expect(page).toHaveURL(new RegExp(`${inbox}/focus$`));
		await expect(main.getByRole("heading", { level: 1, name: `${mailbox.name}: Focus` })).toBeVisible();
		await expect(subject).toHaveText(newest);
		await expect(focus.position("1 of 4")).toBeVisible();

		// A send archives the conversation, and the next one shows with its reply open.
		await page.keyboard.press("r");
		await expect(message).toBeFocused();
		await message.pressSequentially("Yes, two people.");
		await page.keyboard.press("Control+Enter");
		await expect(subject).toHaveText(newer);
		await expect(message).toBeFocused();
		await expect(focus.position("1 of 3")).toBeVisible();

		// b snoozes the conversation, as in the list of the inbox. The dialog asks for the time.
		await page.keyboard.press("Escape");
		await page.keyboard.press("b");
		await page
			.getByRole("dialog", { name: "Snooze until" })
			.getByRole("button", { name: /^Tomorrow/ })
			.click();
		await expect(subject).toHaveText(older);
		await expect(page.getByText(/^Conversation snoozed until .+\.$/)).toBeVisible();

		// Next and Previous move between the conversations, stop at the ends, and keep the focus.
		const next = main.getByRole("button", { name: "Next conversation" });
		const previous = main.getByRole("button", { name: "Previous conversation" });
		await next.click();
		await expect(subject).toHaveText(oldest);
		await expect(focus.position("2 of 2")).toBeVisible();
		await expect(next).toHaveAttribute("aria-disabled", "true");
		await expect(next).toBeFocused();
		await previous.click();
		await expect(subject).toHaveText(older);
		await expect(previous).toBeFocused();

		// ! marks the conversation as spam, and the next one shows.
		await page.keyboard.press("!");
		await expect(subject).toHaveText(oldest);
		// Undo while the reply on screen has text puts the conversation back into the order only. The reply stays.
		await page.keyboard.press("r");
		await expect(message).toBeFocused();
		await message.pressSequentially("One moment.");
		await focus.undo("Conversation marked as spam.").click();
		await expect(page.getByText("Action undone.")).toBeVisible();
		await expect(subject).toHaveText(oldest);
		await expect(message).toContainText("One moment.");
		await expect(focus.position("2 of 2")).toBeVisible();
		await expect.poll(() => subjects(member, mailbox.id, "in:spam")).toEqual([]);
		// Previous asks before it discards the reply. A Yes shows the conversation that came back.
		page.once("dialog", (dialog) => void dialog.accept());
		await previous.click();
		await expect(subject).toHaveText(older);
		await main.getByRole("button", { name: /^Report spam/ }).click();
		await expect(subject).toHaveText(oldest);

		// In the inbox, the primary button is Archive, and e archives.
		await expect(main.getByRole("button", { name: /^Archive/ })).toBeVisible();
		await expect(main.getByRole("button", { name: /^Done/ })).toHaveCount(0);
		await page.keyboard.press("e");
		await expect(main.getByText("All caught up.", { exact: true })).toBeVisible();
		await expect(
			main.getByText("You answered 1 conversation, archived 1, snoozed 1 and marked 1 as spam.", {
				exact: true,
			}),
		).toBeVisible();
		await expect.poll(() => subjects(member, mailbox.id, "in:inbox")).toEqual([]);
		expect(await subjects(member, mailbox.id, "in:snoozed")).toEqual([newer]);
		expect(await subjects(member, mailbox.id, "in:spam")).toEqual([older]);

		// In Starred, the primary button is Done. A reply keeps the star, and the conversation does not come back.
		await page.goto(`/mail/team/${mailbox.id}/starred/focus`);
		await expect(subject).toHaveText(oldest);
		await expect(main.getByRole("button", { name: /^Done/ })).toBeVisible();
		// The conversation is not in the inbox now, so no second Archive shows.
		await expect(main.getByRole("button", { name: /^Archive/ })).toHaveCount(0);
		await page.keyboard.press("r");
		await expect(message).toBeFocused();
		await message.pressSequentially("Approved.");
		await page.keyboard.press("Control+Enter");
		await expect(main.getByText("You answered 1 conversation.", { exact: true })).toBeVisible();
		await expect.poll(() => subjects(member, mailbox.id, "is:starred")).toEqual([oldest]);
		await expect(main.getByText("All caught up.", { exact: true })).toBeVisible();
	} finally {
		await admin.close();
		await member.close();
	}
});

// A search keeps a conversation after Archive, so a refresh gives no new one. Before the person reaches the end of
// the first page, the page gets the next page. It shows "All caught up." only at the end of the list.
test("Focus gets the next page of a search before the end of the first page", async ({ browser }) => {
	const admin = await signIn(browser, "tomasz");
	const member = await signIn(browser, "rafael");
	try {
		const mailbox = await newTeamMailbox(admin, member, "Archive");
		const word = `batch${Date.now().toString(36)}`;
		for (let index = 0; index < 51; index += 1) {
			await post(admin, "/api/v1/mail/messages", { to: [mailbox.address], subject: `${word} ${index}`, text: "Hi" });
		}
		// Local mail goes through the outbox of the sender, so it can come a little later.
		await expect.poll(async () => (await subjects(member, mailbox.id, word)).length, { timeout: 30_000 }).toBe(51);

		const page = await member.newPage();
		await page.goto(`/mail/team/${mailbox.id}/search/focus?q=${word}`);
		const focus = focusPage(page);
		const { main, subject } = focus;
		await expect(subject).toHaveText(`${word} 50`);
		// A search has no label count, so the total has a plus while more can come.
		await expect(focus.position("1 of 50+")).toBeVisible();
		for (let done = 1; done <= 50; done += 1) {
			await page.keyboard.press("e");
			await expect(main.getByText(`${done} done`, { exact: true })).toBeVisible();
		}
		// The oldest conversation is on the next page.
		await expect(subject).toHaveText(`${word} 0`);
		await expect(main.getByText("All caught up.", { exact: true })).toHaveCount(0);
		await page.keyboard.press("e");
		await expect(main.getByText("All caught up.", { exact: true })).toBeVisible();
	} finally {
		await admin.close();
		await member.close();
	}
});

// A conversation that the person cleared stays away until a new message comes in it.
test("a cleared conversation comes back in Focus when a new message comes", async ({ browser }) => {
	const admin = await signIn(browser, "tomasz");
	const member = await signIn(browser, "rafael");
	try {
		const mailbox = await newTeamMailbox(admin, member, "Desk");
		const first = unique("Parking");
		const second = unique("Printer");
		const sent = await post<{ message_id: string }>(admin, "/api/v1/mail/messages", {
			to: [mailbox.address],
			subject: first,
			text: "Where do I park?",
		});
		await post(admin, "/api/v1/mail/messages", { to: [mailbox.address], subject: second, text: "The printer jams." });

		const page = await member.newPage();
		const focus = focusPage(page);
		const { main, subject } = focus;
		await expect(async () => {
			await page.goto(`/mail/team/${mailbox.id}/inbox/focus`);
			await expect(focus.position("1 of 2")).toBeVisible({ timeout: 1000 });
		}).toPass({ timeout: 20_000 });

		await page.keyboard.press("j");
		await expect(subject).toHaveText(first);
		await main.getByRole("button", { name: /^Archive/ }).click();
		await expect(subject).toHaveText(second);
		await expect(focus.position("1 of 1")).toBeVisible();
		// After a change, the page gets the list again and reads the version of the mailbox. It reads the version
		// after the list. A message that comes between the two shows only after the next change. So the message
		// comes after that read.
		await expect(page.getByText("Conversation archived.")).toBeVisible();
		await page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/mail/profile", {
			timeout: 20_000,
		});
		await post(admin, "/api/v1/mail/messages", {
			to: [mailbox.address],
			reply_to_message_id: sent.message_id,
			text: "Also, is there a bike rack?",
		});
		// Local mail goes through the outbox of the sender, so the server can get the message a little later.
		await expect.poll(() => subjects(member, mailbox.id, "in:inbox"), { timeout: 30_000 }).toContain(first);
		// The poll of the mailbox gets the list again within 15 seconds. The new message brings the conversation back,
		// after the conversations that wait.
		await expect(focus.position("1 of 2")).toBeVisible({ timeout: 25_000 });
		await page.keyboard.press("j");
		await expect(subject).toHaveText(first);
		await expect(main.getByText("Also, is there a bike rack?")).toBeVisible();
		// The other message of the conversation shows on request.
		await main.getByRole("button", { name: "Show 1 more message" }).click();
		await expect(main.getByText("Where do I park?")).toBeVisible();
	} finally {
		await admin.close();
		await member.close();
	}
});
