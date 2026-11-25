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
// pile at the end of the inbox. Focus & Reply shows each waiting conversation with its newest message. One card
// is active. Reply opens the composer in the card, a send takes the conversation out of Reply later, and the
// reply of the next card opens. Done takes a conversation out without a reply. The last card leaves a finish
// state with what the person cleared. The test uses a new shared mailbox, so no other test sees its mail.
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
		const third = unique("Team lunch");
		await post(admin, "/api/v1/mail/messages", { to: [address], subject: first, text: "Can you check clause 4?" });
		await post(admin, "/api/v1/mail/messages", { to: [address], subject: second, text: "Which venue do you like?" });
		await post(admin, "/api/v1/mail/messages", { to: [address], subject: third, text: "Pizza or sushi on Friday?" });

		const page = await member.newPage();
		const inbox = `/mail/team/${mailbox.id}/inbox`;
		const firstRow = page.getByRole("listitem").filter({ hasText: first });
		const secondRow = page.getByRole("listitem").filter({ hasText: second });
		const thirdRow = page.getByRole("listitem").filter({ hasText: third });
		// Local mail goes through the outbox of the sender, so it can come a little later.
		await expect(async () => {
			await page.goto(inbox);
			await expect(firstRow).toBeVisible({ timeout: 1000 });
			await expect(secondRow).toBeVisible({ timeout: 1000 });
			await expect(thirdRow).toBeVisible({ timeout: 1000 });
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
		// A row that has the focus has the cursor.
		await thirdRow.getByRole("link").focus();
		await page.keyboard.press("l");
		await expect(thirdRow).toHaveCount(0);
		await expect(pile).toContainText("3 conversations wait for an answer");
		const nav = page.getByRole("navigation", { name: "Mailboxes, folders and labels" });
		await expect(nav.getByRole("link", { name: /^Reply later\s*3 to answer$/ })).toBeVisible();

		await pile.getByRole("link", { name: "Focus & Reply" }).click();
		await expect(page).toHaveURL(new RegExp(`/mail/team/${mailbox.id}/reply-later/focus$`));
		const main = page.getByRole("main");
		await expect(main.getByRole("heading", { level: 1, name: `${name}: Focus & Reply` })).toBeVisible();
		// Only the items of the list itself: a card holds lists too, such as the labels of its message.
		const cards = main.getByRole("list", { name: "Conversations in Reply later" }).locator(":scope > li");
		const firstCard = cards.filter({ has: page.getByRole("heading", { level: 2, name: first }) });
		const secondCard = cards.filter({ has: page.getByRole("heading", { level: 2, name: second }) });
		const thirdCard = cards.filter({ has: page.getByRole("heading", { level: 2, name: third }) });
		await expect(cards).toHaveCount(3);
		// Each card shows the newest message of its conversation, with its body. The newest conversation is first.
		await expect(firstCard.getByText("Can you check clause 4?")).toBeVisible();
		await expect(thirdCard).toHaveAttribute("aria-current", "true");
		await expect(main.getByText("3 left", { exact: true })).toBeVisible();

		// r opens the reply in the active card, not in a dialog, with the focus in the message.
		await page.keyboard.press("r");
		const thirdReply = thirdCard.getByRole("region", { name: "Reply" });
		const thirdMessage = thirdReply.getByRole("textbox", { name: "Message" });
		await expect(thirdMessage).toBeFocused();
		await expect(page.getByRole("dialog")).toHaveCount(0);
		// A card that the person leaves and comes back to opens its reply again with r.
		await page.keyboard.press("Escape");
		await expect(thirdReply).toHaveCount(0);
		await page.keyboard.press("j");
		await page.keyboard.press("k");
		await expect(thirdCard).toHaveAttribute("aria-current", "true");
		await page.keyboard.press("r");
		await expect(thirdMessage).toBeFocused();
		await thirdMessage.pressSequentially("Pizza, please.");

		// Ctrl+Enter in the link dialog of the editor does not send the message. The card and its text stay.
		await thirdReply.getByRole("button", { name: "Link" }).click();
		const linkDialog = page.getByRole("dialog", { name: "Add link" });
		await linkDialog.getByRole("textbox", { name: "Web address or email" }).press("Control+Enter");
		await linkDialog.getByRole("button", { name: "Cancel" }).click({ timeout: 5000 });
		await expect(linkDialog).toHaveCount(0);

		// The app asks before it leaves the page while the reply has text. A No keeps the page and the text.
		let question = "";
		page.once("dialog", (dialog) => {
			question = dialog.message();
			void dialog.dismiss();
		});
		await page.getByRole("link", { name: "Back to Reply later" }).click();
		expect(question).toBe("Discard your reply?");
		await expect(page).toHaveURL(/\/reply-later\/focus$/);
		await expect(thirdMessage).toContainText("Pizza, please.");

		// Done on a card with text in its reply asks too. A No keeps the card and the text.
		question = "";
		page.once("dialog", (dialog) => {
			question = dialog.message();
			void dialog.dismiss();
		});
		await thirdCard.getByRole("button", { name: /^Done/ }).click();
		expect(question).toBe("Discard your reply?");
		await expect(thirdMessage).toContainText("Pizza, please.");
		await expect(main.getByText("3 left", { exact: true })).toBeVisible();

		// Ctrl+Enter sends. The card leaves, and the reply of the next card opens with the focus in the message.
		await thirdMessage.focus();
		await page.keyboard.press("Control+Enter");
		await expect(thirdCard).toHaveCount(0);
		await expect(main.getByText("1 of 3 done · 2 left", { exact: true })).toBeVisible();
		await expect(
			secondCard.getByRole("region", { name: "Reply" }).getByRole("textbox", { name: "Message" }),
		).toBeFocused();
		await expect(page.getByText("Message sent.")).toHaveCount(0);

		// Escape closes a reply with no text, with no question. j moves to the next card and removes nothing.
		await page.keyboard.press("Escape");
		await expect(secondCard.getByRole("region", { name: "Reply" })).toHaveCount(0);
		await page.keyboard.press("j");
		await expect(firstCard).toHaveAttribute("aria-current", "true");
		await expect(cards).toHaveCount(2);

		// Done takes a conversation out without a reply. Undo puts the card back at its old place.
		await firstCard.getByRole("button", { name: /^Done/ }).click();
		await expect(firstCard).toHaveCount(0);
		await expect(main.getByText("2 of 3 done · 1 left", { exact: true })).toBeVisible();
		// An earlier toast can still show its own Undo, so the test takes the Undo of the Done toast.
		await page
			.locator(".toast")
			.filter({ hasText: "Conversation removed from Reply later." })
			.getByRole("button", { name: "Undo" })
			.click();
		await expect(page.getByText("Action undone.")).toBeVisible();
		await expect(cards).toHaveCount(2);
		await expect(cards.nth(1)).toContainText(first);
		await expect(main.getByText("1 of 3 done · 2 left", { exact: true })).toBeVisible();

		// l is Done for the active card. The last card leaves the finish state, with what the person cleared.
		await expect(secondCard).toHaveAttribute("aria-current", "true");
		await page.keyboard.press("l");
		await expect(secondCard).toHaveCount(0);
		// The reply of this card opened by itself after the send. After the exit motion, Undo makes a new card.
		// It comes back with its reply closed.
		await expect(cards).toHaveCount(1);
		await page
			.locator(".toast")
			.filter({ hasText: "Conversation removed from Reply later." })
			.getByRole("button", { name: "Undo" })
			.last()
			.click();
		await expect(secondCard.getByText("Which venue do you like?").first()).toBeVisible();
		await expect(cards.nth(0)).toContainText(second);
		await expect(secondCard.getByRole("button", { name: "Reply", exact: true })).toBeEnabled();
		await expect(secondCard.getByRole("region", { name: "Reply" })).toHaveCount(0);
		await secondCard.getByRole("button", { name: /^Done/ }).click();
		await expect(secondCard).toHaveCount(0);
		await firstCard.getByRole("button", { name: /^Done/ }).click();
		await expect(main.getByText("All caught up.")).toBeVisible();
		await expect(main.getByText("You answered 1 conversation and marked 2 as done.")).toBeVisible();
		const session = main.getByRole("region", { name: "In this session" });
		await expect(session.getByRole("link", { name: third })).toBeVisible();
		await expect(main.getByText("3 of 3 done", { exact: true })).toBeVisible();
		await expect(main).toBeFocused();

		// The server has no conversation in Reply later now, and none is back in the inbox.
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
