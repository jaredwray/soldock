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

// Reply later: a conversation leaves the inbox and waits in its own list, with a count in the sidebar and a
// pile at the end of the inbox. Focus & Reply shows each waiting conversation with its newest message. A reply
// takes the conversation out of Reply later, and so does Done. The test uses a new shared mailbox, so no
// other test sees its mail.
test("a member puts mail in Reply later and answers it in Focus & Reply", async ({ browser }) => {
	const admin = await signIn(browser, "tomasz");
	const member = await signIn(browser, "rafael");
	try {
		const name = unique("Partners");
		const local = `partners-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		const address = `${local}@example.com`;
		const me = await (await member.request.get("/api/v1/account")).json();
		const { team_mailbox: mailbox } = await post<{ team_mailbox: { id: string } }>(
			admin,
			"/api/v1/directory/team-mailboxes",
			{ display_name: name, address, member_ids: [me.principal.id] },
		);
		const first = unique("Contract terms");
		const second = unique("Event venue");
		await post(admin, "/api/v1/mail/messages", { to: [address], subject: first, text: "Can you check clause 4?" });
		await post(admin, "/api/v1/mail/messages", { to: [address], subject: second, text: "Which venue do you like?" });

		const page = await member.newPage();
		const inbox = `/mail/team/${mailbox.id}/inbox`;
		const firstRow = page.getByRole("listitem").filter({ hasText: first });
		const secondRow = page.getByRole("listitem").filter({ hasText: second });
		// Local mail goes through the outbox of the sender, so it can come a little later.
		await expect(async () => {
			await page.goto(inbox);
			await expect(firstRow).toBeVisible({ timeout: 1000 });
			await expect(secondRow).toBeVisible({ timeout: 1000 });
		}).toPass({ timeout: 20_000 });

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
		const nav = page.getByRole("navigation", { name: "Mailboxes, folders and labels" });
		await expect(nav.getByRole("link", { name: /^Reply later\s*2 to answer$/ })).toBeVisible();

		await pile.getByRole("link", { name: "Focus & Reply" }).click();
		await expect(page).toHaveURL(new RegExp(`/mail/team/${mailbox.id}/reply-later/focus$`));
		const main = page.getByRole("main");
		await expect(main.getByRole("heading", { level: 1, name: `${name}: Focus & Reply` })).toBeVisible();
		// Only the items of the list itself: a card holds lists too, such as the labels of its message.
		const cards = main.getByRole("list", { name: "Conversations in Reply later" }).locator(":scope > li");
		const firstCard = cards.filter({ has: page.getByRole("heading", { level: 2, name: first }) });
		const secondCard = cards.filter({ has: page.getByRole("heading", { level: 2, name: second }) });
		await expect(cards).toHaveCount(2);
		// Each card shows the newest message of its conversation, with its body.
		await expect(firstCard.getByText("Can you check clause 4?")).toBeVisible();

		// A reply takes the conversation out of Reply later.
		await firstCard.getByRole("button", { name: "Reply", exact: true }).click();
		const composer = page.getByRole("dialog", { name: "Reply" });
		await composer.getByRole("textbox", { name: "Message" }).fill("Clause 4 is fine.");
		await composer.getByRole("button", { name: "Send" }).click();
		await expect(page.getByText("Message sent.")).toBeVisible();
		await expect(firstCard).toHaveCount(0);
		await expect(cards).toHaveCount(1);
		// The focus goes to the card in the place of the card that left, not to the start of the page.
		await expect(secondCard.getByRole("link", { name: second })).toBeFocused();

		// Done takes a conversation out without a reply, and Undo puts it back.
		await secondCard.getByRole("button", { name: /^Done/ }).click();
		await expect(main.getByText("No conversation waits for an answer.")).toBeVisible();
		// An earlier toast can still show its own Undo, so the test takes the Undo of the Done toast.
		await page
			.locator(".toast")
			.filter({ hasText: "Conversation removed from Reply later." })
			.getByRole("button", { name: "Undo" })
			.click();
		await expect(page.getByText("Action undone.")).toBeVisible();
		await expect(secondCard).toHaveCount(1);
		await secondCard.getByRole("button", { name: /^Done/ }).click();
		await expect(main.getByText("No conversation waits for an answer.")).toBeVisible();
		await expect(main).toBeFocused();

		// The server has no conversation in Reply later now, and neither one is back in the inbox.
		const waiting = await member.request.get(
			`/api/v1/mail/threads?mailbox_id=${mailbox.id}&query=${encodeURIComponent("in:reply_later")}`,
		);
		expect((await waiting.json()).threads).toEqual([]);
		await page.goto(inbox);
		await expect(page.getByText("The inbox of this team mailbox is empty.")).toBeVisible();
		await expect(page.getByRole("region", { name: "Reply later" })).toHaveCount(0);
	} finally {
		await admin.close();
		await member.close();
	}
});
