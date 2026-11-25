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

// Reply later: a conversation leaves the inbox and waits in its own list, with a count in the sidebar and a
// pile at the end of the inbox. Focus shows the waiting conversations one at a time, each with its newest
// message. Reply opens the composer in the page, a send takes the conversation out of Reply later, and the next
// conversation shows with its reply open. Done takes a conversation out without a reply, and Undo shows it
// again. When no conversation stays, a finish state shows what the person cleared.
test("a member puts mail in Reply later and answers it in Focus", async ({ browser }) => {
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
		const firstRow = page.getByRole("listitem").filter({ hasText: first });
		const secondRow = page.getByRole("listitem").filter({ hasText: second });
		const thirdRow = page.getByRole("listitem").filter({ hasText: third });
		await openList(page, inbox, [first, second, third]);

		// From an open conversation: Reply later sends it out of the inbox and back to the list.
		await firstRow.getByRole("link").click();
		await page.getByRole("button", { name: "Reply later" }).click();
		await expect(page.getByText("Conversation moved to Reply later.")).toBeVisible();
		await expect(page).toHaveURL(new RegExp(`${inbox}$`));
		await expect(firstRow).toHaveCount(0);
		const pile = page.getByRole("region", { name: "Reply later" });
		await expect(pile).toContainText("1 conversation waits for an answer");

		// From the list, with the keyboard: the l key on the row at the cursor.
		await expect(secondRow).toBeVisible();
		await page.keyboard.press("l");
		await expect(secondRow).toHaveCount(0);
		await expect(pile).toContainText("2 conversations wait for an answer");
		// A row that has the focus has the cursor.
		await thirdRow.getByRole("link").focus();
		await page.keyboard.press("l");
		await expect(thirdRow).toHaveCount(0);
		await expect(pile).toContainText("3 conversations wait for an answer");
		const nav = page.getByRole("navigation", { name: "Mailboxes, folders and labels" });
		await expect(nav.getByRole("link", { name: /^Reply later\s*3 to answer$/ })).toBeVisible();

		await pile.getByRole("link", { name: "Focus in Reply later" }).click();
		await expect(page).toHaveURL(new RegExp(`/mail/team/${mailbox.id}/reply-later/focus$`));
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
		await page.keyboard.press("k");
		await expect(subject).toHaveText(third);
		await expect(main.getByRole("button", { name: "Previous conversation" })).toHaveAttribute("aria-disabled", "true");
		await page.keyboard.press("r");
		await expect(message).toBeFocused();
		await message.pressSequentially("Pizza, please.");

		// Ctrl+Enter in the link dialog of the editor does not send the message. The reply and its text stay.
		await reply.getByRole("button", { name: "Link" }).click();
		const linkDialog = page.getByRole("dialog", { name: "Add link" });
		await linkDialog.getByRole("textbox", { name: "Web address or email" }).press("Control+Enter");
		await linkDialog.getByRole("button", { name: "Cancel" }).click({ timeout: 5000 });
		await expect(linkDialog).toHaveCount(0);

		// While the reply has text, the Back link, Next and Done ask first. A No keeps the conversation and the text.
		for (const control of [
			main.getByRole("link", { name: "Back to Reply later" }),
			main.getByRole("button", { name: "Next conversation" }),
			main.getByRole("button", { name: /^Done/ }),
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
		await expect(page).toHaveURL(/\/reply-later\/focus$/);
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
		await focus.undo("Conversation removed from Reply later.").click();
		await expect(page.getByText("Action undone.")).toBeVisible();
		await expect(subject).toHaveText(second);
		await expect(focus.position("1 of 2")).toBeVisible();
		await expect(reply).toHaveCount(0);

		// l is Done in Reply later. Done on the last one shows the finish state with what the member cleared.
		await page.keyboard.press("l");
		await expect(subject).toHaveText(first);
		await main.getByRole("button", { name: /^Done/ }).click();
		await expect(main.getByText("All caught up.", { exact: true })).toBeVisible();
		await expect(main.getByText("You answered 1 conversation and marked 2 as done.", { exact: true })).toBeVisible();
		const session = main.getByRole("region", { name: "In this session" });
		await expect(session.getByRole("link", { name: third })).toBeVisible();
		await expect(main).toBeFocused();

		// The server has no conversation in Reply later now, and none is back in the inbox. The page shows the finish
		// state before the server confirms the last Done.
		await expect.poll(() => subjects(member, mailbox.id, "in:reply_later")).toEqual([]);
		await page.goto(inbox);
		await expect(page.getByText("The inbox of this team mailbox is empty.")).toBeVisible();
		await expect(page.getByRole("region", { name: "Reply later" })).toHaveCount(0);
	} finally {
		await admin.close();
		await member.close();
	}
});

// Focus works in each list. In the inbox, a send also archives the conversation, l moves it to Reply later, !
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

		const focus = focusPage(page);
		const { main, subject, message } = focus;
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

		// l moves the conversation to Reply later, as in the list of the inbox.
		await page.keyboard.press("Escape");
		await page.keyboard.press("l");
		await expect(subject).toHaveText(older);
		await expect(page.getByText("Conversation moved to Reply later.")).toBeVisible();

		// Next and Previous move between the conversations, and stop at the ends.
		await main.getByRole("button", { name: "Next conversation" }).click();
		await expect(subject).toHaveText(oldest);
		await expect(focus.position("2 of 2")).toBeVisible();
		await expect(main.getByRole("button", { name: "Next conversation" })).toHaveAttribute("aria-disabled", "true");
		await expect(main.getByRole("button", { name: "Next conversation" })).toBeFocused();
		await page.keyboard.press("k");
		await expect(subject).toHaveText(older);

		// ! marks the conversation as spam, and Undo shows it again. The Spam button does the same.
		await page.keyboard.press("!");
		await expect(subject).toHaveText(oldest);
		await focus.undo("Conversation marked as spam.").click();
		await expect(subject).toHaveText(older);
		await expect.poll(() => subjects(member, mailbox.id, "in:spam")).toEqual([]);
		await main.getByRole("button", { name: /^Report spam/ }).click();
		await expect(subject).toHaveText(oldest);

		// In the inbox, the primary button is Archive, and e archives.
		await expect(main.getByRole("button", { name: /^Archive/ })).toBeVisible();
		await expect(main.getByRole("button", { name: /^Done/ })).toHaveCount(0);
		await page.keyboard.press("e");
		await expect(main.getByText("All caught up.", { exact: true })).toBeVisible();
		await expect(
			main.getByText("You answered 1 conversation, archived 1, moved 1 to Reply later and marked 1 as spam.", {
				exact: true,
			}),
		).toBeVisible();
		await expect.poll(() => subjects(member, mailbox.id, "in:inbox")).toEqual([]);
		expect(await subjects(member, mailbox.id, "in:reply_later")).toEqual([newer]);
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
	} finally {
		await admin.close();
		await member.close();
	}
});
