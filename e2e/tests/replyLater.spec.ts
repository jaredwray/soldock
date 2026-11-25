import { type BrowserContext, expect, test } from "@playwright/test";
import { signIn, unique } from "../support/chat.ts";
import { BASE_URL } from "../support/server.ts";

const JSON_HEADERS = { origin: BASE_URL, "content-type": "application/json" };

/** Calls a POST operation with the session of the context, and returns its result. */
async function post<T>(context: BrowserContext, path: string, data: unknown): Promise<T> {
	const response = await context.request.post(path, { headers: JSON_HEADERS, data });
	expect(response.ok(), `POST ${path}: ${response.status()} ${await response.text()}`).toBe(true);
	return (await response.json()) as T;
}

interface ThreadList {
	threads: { subject: string; message_count: number }[];
}

/** The threads of a query, as the REST API gives them to the context. */
async function threads(context: BrowserContext, query: string, mailboxId?: string): Promise<ThreadList["threads"]> {
	const params = new URLSearchParams({ query, ...(mailboxId ? { mailbox_id: mailboxId } : {}) });
	const response = await context.request.get(`/api/v1/mail/threads?${params}`);
	expect(response.ok()).toBe(true);
	return ((await response.json()) as ThreadList).threads;
}

// Reply later keeps the conversations that need an answer. The focus view shows only them, each with its reply
// in the page. A sent reply takes its conversation out (the server removes the label), and the reply of the next
// one opens. Done takes a conversation out without a reply. The conversations stay in the inbox all the time.
test("a member queues two conversations, answers one in the focus view and takes the other out", async ({
	browser,
}) => {
	const admin = await signIn(browser, "tomasz");
	const member = await signIn(browser, "chidi");
	const local = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	const name = unique("Help desk");
	const address = `help-${local}@example.com`;
	const first = unique("Invoice question");
	const second = unique("Shipping question");
	try {
		const me = await (await member.request.get("/api/v1/account")).json();
		const { team_mailbox: mailbox } = await post<{ team_mailbox: { id: string } }>(
			admin,
			"/api/v1/directory/team-mailboxes",
			{ display_name: name, address, member_ids: [me.principal.id] },
		);
		await post(admin, "/api/v1/mail/messages", { to: [address], subject: first, text: "Is the invoice paid?" });
		await post(admin, "/api/v1/mail/messages", { to: [address], subject: second, text: "When does it ship?" });

		const page = await member.newPage();
		const inbox = `/mail/team/${mailbox.id}/inbox`;
		await page.goto(inbox);
		await expect(async () => {
			await page.reload();
			await expect(page.getByRole("link", { name: new RegExp(first) })).toBeVisible({ timeout: 2_000 });
			await expect(page.getByRole("link", { name: new RegExp(second) })).toBeVisible({ timeout: 2_000 });
		}).toPass();

		// b puts the conversation at the keyboard cursor in Reply later. A row with the focus has the cursor.
		await page.getByRole("link", { name: new RegExp(second) }).focus();
		await page.keyboard.press("b");
		await expect(page.getByRole("link", { name: new RegExp(`${second}.*Reply later`) })).toBeVisible();
		// The button of the toolbar does the same for the open conversation.
		await page.getByRole("link", { name: new RegExp(first) }).click();
		await page.getByRole("button", { name: "Reply later", exact: true }).click();
		await expect(page.getByRole("button", { name: "Remove from Reply later" })).toBeVisible();

		// The sidebar counts each conversation in Reply later. Its view opens the focus view.
		const nav = page.getByRole("link", { name: /^Reply later/ });
		await expect(nav).toContainText("2 conversations");
		await nav.click();
		await expect(page.getByText("2 conversations wait for a reply.")).toBeVisible();
		await page.getByRole("link", { name: "Reply in focus view" }).click();
		await expect(page).toHaveURL(new RegExp(`/mail/team/${mailbox.id}/reply-later/focus$`));
		const view = page.getByRole("main");
		await expect(view.getByRole("heading", { level: 1, name: `${name}: Reply later` })).toBeVisible();
		await expect(view.getByText("2 left")).toBeVisible();

		// The reply opens in the page, under its conversation, and not in a dialog.
		const item = (subject: string) =>
			view.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 2, name: subject }) });
		await item(second).getByRole("button", { name: "Reply", exact: true }).click();
		const reply = item(second).getByRole("region", { name: "Reply" });
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await reply.getByRole("textbox", { name: "Message" }).pressSequentially("It ships on Monday.");
		await reply.getByRole("button", { name: "Send" }).click();

		// The answered conversation leaves, and the reply of the next one opens at once.
		await expect(item(second)).toHaveCount(0);
		await expect(view.getByText("1 left")).toBeVisible();
		const next = item(first).getByRole("region", { name: "Reply" });
		await expect(next.getByRole("textbox", { name: "Message" })).toBeFocused();
		// Discard closes the reply with no question: the person typed nothing. Done takes the conversation out.
		await next.getByRole("button", { name: "Discard" }).click();
		await item(first).getByRole("button", { name: "Done" }).click();
		await expect(page.getByText("Conversation removed from Reply later.")).toBeVisible();
		await expect(view.getByText("No conversation waits for a reply.")).toBeVisible();

		// Both conversations stay in the inbox. The server has no conversation in Reply later.
		await page.goto(inbox);
		await expect(page.getByRole("link", { name: new RegExp(first) })).toBeVisible();
		await expect(page.getByRole("link", { name: new RegExp(second) })).toBeVisible();
		expect(await threads(member, "label:REPLY_LATER", mailbox.id)).toEqual([]);
		// The reply reached the sender, in the thread of the question.
		await expect(async () => {
			const found = await threads(admin, `subject:"${second}"`);
			expect(found.map((thread) => thread.message_count)).toEqual([2]);
		}).toPass();
	} finally {
		await admin.close();
		await member.close();
	}
});
