import { expect, test } from "@playwright/test";
import { createRoom, openRoom, post, reply, searchTexts, signIn, unique } from "../support/chat.ts";

// Search in Chat (jaredwray/soldock#75). Each test makes its own rooms, and a word that no other test uses.

/** A word that no other message has: a search finds words, so the word has letters and digits only. */
const word = (prefix: string) => unique(prefix).replace(/\s/g, "");

test("the search of a room header finds a message of that room, marks the word, and opens the message", async ({
	browser,
}) => {
	const tomasz = await signIn(browser, "tomasz");
	const name = unique("Search room");
	const other = unique("Other room");
	const roomId = await createRoom(tomasz, name);
	const otherId = await createRoom(tomasz, other);
	const needle = word("needle");
	const message = await post(tomasz, roomId, `The plan has the ${needle} in it.`);
	await post(tomasz, otherId, `A different room has the ${needle} too.`);
	const page = await tomasz.newPage();
	await openRoom(page, roomId);

	const box = page.getByRole("searchbox", { name: `Search in ${name}` });
	await box.fill(needle.toUpperCase());
	await box.press("Enter");
	// The Search view has the query and the room in its path, and searches that room only.
	await expect(page).toHaveURL(new RegExp(`/chat/search\\?q=${needle.toUpperCase()}&room=${roomId}$`));
	const results = page.getByRole("list", { name: "Search results" }).getByRole("link");
	await expect(results).toHaveCount(1);
	await expect(results.first()).toContainText(`The plan has the ${needle} in it.`);
	// The found word is marked, in the letter case of the message.
	await expect(results.first().locator("mark")).toHaveText([needle]);

	// A second submit of the same query searches again: the path stays, and a new message shows.
	await post(tomasz, roomId, `A later message has the ${needle} too.`);
	await page.getByRole("searchbox", { name: `Search in ${name}` }).press("Enter");
	await expect(results).toHaveCount(2);

	await results.filter({ hasText: "The plan has the" }).click();
	await expect(page).toHaveURL(new RegExp(`/chat/${roomId}/${message.seq}$`));
	await expect(page.locator(".chat-message-marked .chat-text")).toHaveText(message.text);
});

test("Ctrl+F opens the search of all rooms from the Chat page, a result of a reply opens its thread, and the search stays in the recent searches", async ({
	browser,
}) => {
	const tomasz = await signIn(browser, "tomasz");
	const nadia = await signIn(browser, "nadia");
	const name = unique("Search threads");
	const roomId = await createRoom(tomasz, name, [nadia]);
	const needle = word("thread");
	const parent = await post(nadia, roomId, unique("start of the thread"));
	const answer = await reply(nadia, roomId, parent.id, `A reply with the ${needle}.`);
	// The index of all rooms gets a message a short time after its post.
	await expect.poll(() => searchTexts(tomasz, needle)).toEqual([answer.text]);

	const page = await tomasz.newPage();
	await page.goto("/chat");
	await expect(page.getByRole("heading", { name: "Your rooms and direct messages" })).toBeVisible();
	await page.keyboard.press("Control+f");
	await expect(page).toHaveURL(/\/chat\/search$/);
	const box = page.getByRole("searchbox", { name: "Search your messages" });
	await expect(box).toBeFocused();
	await box.fill(`${needle} from:nadia is:thread`);
	await box.press("Enter");

	const results = page.getByRole("list", { name: "Search results" }).getByRole("link");
	await expect(results).toHaveCount(1);
	// A result of all rooms names its room. The filters are no words, so only the word is marked.
	await expect(results.first()).toContainText(name);
	await expect(results.first()).toContainText("in a thread");
	await expect(results.first().locator("mark")).toHaveText([needle]);
	await results.first().click();
	await expect(page).toHaveURL(new RegExp(`/chat/${roomId}/${parent.seq}/${answer.seq}$`));
	await expect(page.getByRole("complementary", { name: "Thread" })).toContainText(answer.text);

	// The Search view without a query shows the search from before. A click runs it again.
	await page.getByRole("link", { name: "Search", exact: true }).click();
	const recent = page.getByRole("region", { name: "Recent searches" });
	await recent.getByRole("link", { name: `${needle} from:nadia is:thread` }).click();
	await expect(results).toHaveCount(1);
	// "Clear" removes the recent searches of the person from the browser.
	await page.getByRole("link", { name: "Search", exact: true }).click();
	await recent.getByRole("button", { name: "Clear" }).click();
	await expect(recent).toHaveCount(0);
	await page.reload();
	await expect(page.getByRole("searchbox", { name: "Search your messages" })).toBeVisible();
	await expect(recent).toHaveCount(0);
});

test("a query that the server cannot read shows the reason", async ({ browser }) => {
	const tomasz = await signIn(browser, "tomasz");
	const page = await tomasz.newPage();
	await page.goto("/chat/search?q=has%3Apicture");
	await expect(page.getByRole("alert")).toContainText("has:picture is not known. Use has:link or has:file.");
});
