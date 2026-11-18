import { expect, type Page, test } from "@playwright/test";
import {
	composer,
	createRoom,
	fill,
	markRead,
	newest,
	openRoom,
	post,
	postMarkdown,
	react,
	rowsWithText,
	signIn,
	unique,
	waitingRecords,
} from "../support/chat.ts";

// The Chat flows of jaredwray/soldock#101. Each test makes its own room, so the tests can run at the
// same time. The people come from the seed data.

/** The calls that post a message to a room. */
const postsOf = (roomId: string) => `**/api/v1/chat/rooms/${roomId}/messages`;

/**
 * Holds the calls of `method` to `url` until `release` runs. A test then sees the page before the
 * answer of the server: a local Worker answers in some milliseconds, faster than an assertion.
 */
async function hold(
	page: Page,
	url: string | ((url: URL) => boolean),
	method: string,
): Promise<{ release: () => void }> {
	let release = () => {};
	const released = new Promise<void>((done) => {
		release = done;
	});
	await page.route(url, async (route) => {
		if (route.request().method() !== method) return route.continue();
		await released;
		return route.continue();
	});
	return { release };
}

test("a send shows at once, and the room stores it one time", async ({ browser }) => {
	const tomasz = await signIn(browser, "tomasz");
	const nadia = await signIn(browser, "nadia");
	const name = unique("Send");
	const roomId = await createRoom(tomasz, name, [nadia]);
	const page = await tomasz.newPage();
	await openRoom(page, roomId);

	const text = unique("hello");
	const answer = await hold(page, postsOf(roomId), "POST");
	await composer(page, name).fill(text);
	await composer(page, name).press("Enter");
	// The row shows, and the box is empty, while the server has not answered.
	await expect(page.locator(".chat-message-pending").filter({ hasText: text })).toHaveCount(1);
	await expect(composer(page, name)).toHaveText("");
	answer.release();
	await expect
		.poll(async () => (await newest(nadia, roomId)).filter((message) => message.text === text).length)
		.toBe(1);
	await expect(page.locator(".chat-message-pending")).toHaveCount(0);
	await expect(rowsWithText(page, text)).toHaveCount(1);
});

test("a send whose answers get lost shows one time, with no Not sent row", async ({ browser }) => {
	const tomasz = await signIn(browser, "tomasz");
	const name = unique("Lost");
	const roomId = await createRoom(tomasz, name);
	const page = await tomasz.newPage();
	await openRoom(page, roomId);
	// The server stores the message, and each answer of the send is lost.
	await page.route(postsOf(roomId), async (route) => {
		if (route.request().method() !== "POST") return route.continue();
		await route.fetch();
		return route.abort("connectionreset");
	});

	const text = unique("lost answers");
	await composer(page, name).fill(text);
	await composer(page, name).press("Enter");
	// The outbox tries three more times, about 7 seconds. The room has the message with the key of the
	// send, so the send settles to that message, and its record leaves the store of the browser.
	await expect.poll(() => waitingRecords(page), { timeout: 20_000 }).toEqual([]);
	await expect(page.locator(".chat-message-pending, .chat-send-failed")).toHaveCount(0);
	await expect(rowsWithText(page, text)).toHaveCount(1);
	const stored = (await newest(tomasz, roomId)).filter((message) => message.text === text);
	expect(stored).toHaveLength(1);
	expect(stored[0]?.idempotency_key).not.toBeNull();
});

test("a send that fails shows Not sent, and Try again sends it one time", async ({ browser }) => {
	const tomasz = await signIn(browser, "tomasz");
	const name = unique("Offline");
	const roomId = await createRoom(tomasz, name);
	const page = await tomasz.newPage();
	await openRoom(page, roomId);

	await tomasz.setOffline(true);
	const text = unique("while offline");
	await composer(page, name).fill(text);
	await composer(page, name).press("Enter");
	const failed = page.locator(".chat-send-failed");
	await expect(failed).toBeVisible({ timeout: 20_000 });
	await expect(failed).toContainText("Not sent");

	await tomasz.setOffline(false);
	await failed.getByRole("button", { name: "Try again" }).click();
	await expect(failed).toHaveCount(0, { timeout: 10_000 });
	await expect
		.poll(async () => (await newest(tomasz, roomId)).filter((message) => message.text === text).length)
		.toBe(1);
	await expect(rowsWithText(page, text)).toHaveCount(1);
});

test("a message that waits stays after a reload, and goes out one time", async ({ browser }) => {
	const tomasz = await signIn(browser, "tomasz");
	const name = unique("Reload");
	const roomId = await createRoom(tomasz, name);
	const page = await tomasz.newPage();
	await openRoom(page, roomId);
	// The send never gets to the server before the reload.
	await page.route(postsOf(roomId), (route) => (route.request().method() === "POST" ? undefined : route.continue()));

	const text = unique("reload during a send");
	await composer(page, name).fill(text);
	await composer(page, name).press("Enter");
	await expect(page.locator(".chat-message-pending")).toHaveCount(1);
	await page.unrouteAll({ behavior: "ignoreErrors" });
	await page.reload();

	await expect
		.poll(async () => (await newest(tomasz, roomId)).filter((message) => message.text === text).length)
		.toBe(1);
	await expect.poll(() => waitingRecords(page)).toEqual([]);
	await expect(rowsWithText(page, text)).toHaveCount(1);
	await expect(page.locator(".chat-message-pending, .chat-send-failed")).toHaveCount(0);
});

test("a change and a delete show at once, and come back after a refusal", async ({ browser }) => {
	const tomasz = await signIn(browser, "tomasz");
	const name = unique("Edits");
	const roomId = await createRoom(tomasz, name);
	const first = unique("edit me");
	const message = await post(tomasz, roomId, first);
	const page = await tomasz.newPage();
	await openRoom(page, roomId);
	const row = page.locator(".chat-message").filter({ hasText: first });

	// A refused change: the edit box opens again with the new text, so the person does not write it
	// again, and the room keeps the old text.
	await page.route("**/api/v1/chat/rooms/*/messages/*/edit", (route) => route.abort());
	await row.hover();
	await row.getByRole("button", { name: /Change your message/ }).click();
	const editBox = page.getByRole("textbox", { name: "New text of the message" });
	await editBox.fill("refused text");
	await page.getByRole("button", { name: "Save" }).click();
	await expect(editBox).toHaveText("refused text");
	expect((await newest(tomasz, roomId)).find((entry) => entry.id === message.id)?.text).toBe(first);

	// The change goes through: the new text shows at once, with the edited mark.
	await page.unrouteAll({ behavior: "ignoreErrors" });
	const editAnswer = await hold(page, "**/api/v1/chat/rooms/*/messages/*/edit", "POST");
	await editBox.fill("changed text");
	await page.getByRole("button", { name: "Save" }).click();
	const changed = page.locator(".chat-message").filter({ hasText: "changed text" });
	await expect(changed.locator(".chat-edited")).toBeVisible();
	expect((await newest(tomasz, roomId)).find((entry) => entry.id === message.id)?.text).toBe(first);
	editAnswer.release();
	await expect
		.poll(async () => (await newest(tomasz, roomId)).find((entry) => entry.id === message.id)?.text)
		.toBe("changed text");

	// A refused delete: the message shows again.
	await page.route("**/api/v1/chat/rooms/*/messages/*", (route) =>
		route.request().method() === "DELETE" ? route.abort() : route.continue(),
	);
	await changed.hover();
	await changed.getByRole("button", { name: /Delete the message/ }).click();
	await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
	// The text has the edited mark after it, so the test finds the row by a part of its text.
	await expect(changed).toHaveCount(1);

	// The delete goes through: the message shows as deleted at once.
	await page.unrouteAll({ behavior: "ignoreErrors" });
	const deleteAnswer = await hold(page, "**/api/v1/chat/rooms/*/messages/*", "DELETE");
	await changed.hover();
	await changed.getByRole("button", { name: /Delete the message/ }).click();
	await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
	await expect(changed).toHaveCount(0);
	expect((await newest(tomasz, roomId)).find((entry) => entry.id === message.id)?.deleted).toBe(false);
	deleteAnswer.release();
	await expect
		.poll(async () => (await newest(tomasz, roomId)).find((entry) => entry.id === message.id)?.deleted)
		.toBe(true);
});

test("a page of older messages comes before the list, and the list stays at the same message", async ({ browser }) => {
	const people = await Promise.all(
		(["tomasz", "nadia", "chidi", "meiling"] as const).map((person) => signIn(browser, person)),
	);
	const [tomasz] = people;
	if (!tomasz) throw new Error("no context");
	const name = unique("Older");
	const roomId = await createRoom(tomasz, name, people.slice(1));
	await fill(people, roomId, 70);
	const page = await tomasz.newPage();
	await openRoom(page, roomId);
	await expect(rowsWithText(page, "m70")).toHaveCount(1);
	await expect(rowsWithText(page, "m20")).toHaveCount(0);

	const list = page.locator(".chat-scroll");
	await list.evaluate((element) => {
		element.scrollTop = 0;
	});
	const offsetOf = (text: string) =>
		page.evaluate((needle) => {
			const scroll = document.querySelector(".chat-scroll") as HTMLElement;
			const row = [...document.querySelectorAll<HTMLElement>(".chat-message")].find(
				(element) => element.querySelector(".chat-text")?.textContent === needle,
			);
			return row ? Math.round(row.getBoundingClientRect().top - scroll.getBoundingClientRect().top) : null;
		}, text);
	const before = await offsetOf("m21");
	await page.getByRole("button", { name: "Show older messages" }).click();
	await expect(rowsWithText(page, "m1")).toHaveCount(1);
	await expect(page.getByRole("button", { name: "Show older messages" })).toHaveCount(0);
	expect(await offsetOf("m21")).toBe(before);
});

test("the New messages line marks the first new message, and the button goes to the newest one", async ({
	browser,
}) => {
	const tomasz = await signIn(browser, "tomasz");
	const nadia = await signIn(browser, "nadia");
	const chidi = await signIn(browser, "chidi");
	const name = unique("Unread");
	const roomId = await createRoom(tomasz, name, [nadia, chidi]);
	await fill([nadia, chidi], roomId, 40);
	const page = await tomasz.newPage();
	await openRoom(page, roomId);

	// Each message came after the person joined, so the line is before the first one.
	const line = page.locator(".chat-new");
	await expect(line).toHaveCount(1);
	const firstAfterLine = await page.evaluate(() => {
		let next = document.querySelector(".chat-new")?.nextElementSibling;
		while (next && !next.classList.contains("chat-message")) next = next.nextElementSibling;
		return next?.querySelector(".chat-text")?.textContent ?? null;
	});
	expect(firstAfterLine).toBe("m1");

	// The person reads older messages. A new message comes: the button tells of it.
	await page.locator(".chat-scroll").evaluate((element) => {
		element.scrollTop = 0;
	});
	const jump = page.locator(".chat-jump");
	await expect(jump).toBeVisible();
	await post(nadia, roomId, "late message");
	await expect(jump).toContainText("1 new message");
	await jump.click();
	await expect(jump).toHaveCount(0);
	await expect(rowsWithText(page, "late message")).toBeInViewport();
});

test("the draft of a room stays after a change of room and a reload, and a sign-out removes it", async ({
	browser,
}) => {
	const tomasz = await signIn(browser, "tomasz");
	const first = unique("Draft one");
	const second = unique("Draft two");
	const firstId = await createRoom(tomasz, first);
	const secondId = await createRoom(tomasz, second);
	const page = await tomasz.newPage();
	await openRoom(page, firstId);

	await composer(page, first).fill("a draft that stays");
	await page.getByRole("link", { name: second }).first().click();
	await expect(composer(page, second)).toHaveText("");
	await page.getByRole("link", { name: first }).first().click();
	await expect(composer(page, first)).toHaveText("a draft that stays");
	await page.reload();
	await expect(composer(page, first)).toHaveText("a draft that stays");

	// A send removes the draft.
	await openRoom(page, secondId);
	await composer(page, second).fill("a draft to send");
	await composer(page, second).press("Enter");
	await expect(composer(page, second)).toHaveText("");
	await page.reload();
	await expect(composer(page, second)).toHaveText("");

	// A sign-out removes each draft from the browser.
	await page.evaluate(() => fetch("/auth/sign-out", { method: "POST" }));
	await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible({ timeout: 15_000 });
	const drafts = await page.evaluate(() =>
		Object.keys(localStorage).filter((key) => key.startsWith("soldock:chat-drafts:")),
	);
	expect(drafts).toEqual([]);
});

test("a room that opens again shows its last list before the answer of the server", async ({ browser }) => {
	const tomasz = await signIn(browser, "tomasz");
	const name = unique("Cache");
	const other = unique("Other");
	const roomId = await createRoom(tomasz, name);
	await createRoom(tomasz, other);
	await post(tomasz, roomId, "a message in the cache");
	const page = await tomasz.newPage();
	await openRoom(page, roomId);
	await expect(rowsWithText(page, "a message in the cache")).toHaveCount(1);
	await page.getByRole("link", { name: other }).first().click();
	await expect(composer(page, other)).toBeVisible();

	// Each read of the room is slow now.
	await page.route(`**/api/v1/chat/rooms/${roomId}*`, async (route) => {
		if (route.request().method() === "GET") await new Promise((done) => setTimeout(done, 3000));
		return route.continue();
	});
	await page.getByRole("link", { name }).first().click();
	await expect(rowsWithText(page, "a message in the cache")).toHaveCount(1, { timeout: 1500 });
	await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("a link to one message opens the room at that message and marks it", async ({ browser }) => {
	const people = await Promise.all(
		(["tomasz", "nadia", "chidi", "meiling"] as const).map((person) => signIn(browser, person)),
	);
	const [tomasz] = people;
	if (!tomasz) throw new Error("no context");
	const name = unique("Link");
	const roomId = await createRoom(tomasz, name, people.slice(1));
	await fill(people, roomId, 70);
	const page = await tomasz.newPage();

	await page.goto(`/chat/${roomId}/5`);
	const marked = page.locator(".chat-message-marked");
	await expect(marked).toHaveCount(1);
	await expect(marked.locator(".chat-text")).toHaveText("m5");
	await expect(marked).toBeInViewport();
	// The list is at older messages now. The button goes to the newest messages.
	await page.locator(".chat-jump").click();
	await expect(rowsWithText(page, "m70")).toBeInViewport();
});

// Layer 3 (jaredwray/soldock#72): the sidebar follows the events socket of the person, without a poll.
test("the sidebar count of a room that is not open goes up and clears without a poll of the list", async ({
	browser,
}) => {
	const tomasz = await signIn(browser, "tomasz");
	const nadia = await signIn(browser, "nadia");
	const open = unique("Open");
	const busy = unique("Busy");
	const openId = await createRoom(tomasz, open, [nadia]);
	const busyId = await createRoom(tomasz, busy, [nadia]);
	const page = await nadia.newPage();
	// The events socket is live after its hello. The test counts the reads of the list after that.
	const live = page
		.waitForEvent("websocket", (socket) => socket.url().endsWith("/ws/events"))
		.then((socket) => socket.waitForEvent("framereceived", (frame) => String(frame.payload).includes('"hello"')));
	await openRoom(page, openId);
	await live;
	let reads = 0;
	page.on("request", (request) => {
		if (request.method() === "GET" && new URL(request.url()).pathname === "/api/v1/chat/rooms") reads += 1;
	});
	// The hello asks for the list one time. Wait for that read, then count from zero.
	await expect(page.getByRole("link", { name: busy })).toBeVisible();
	reads = 0;

	await post(tomasz, busyId, "One");
	await post(tomasz, busyId, "Two");
	const link = page.getByRole("link", { name: busy });
	await expect(link.locator(".chat-nav-count")).toContainText("2");
	await expect(link).toContainText("2 unread messages");

	// A different device of the same person reads the room. The count goes away on this page.
	await markRead(nadia, busyId);
	await expect(link.locator(".chat-nav-count")).toHaveCount(0);
	expect(reads).toBe(0);
});

// Layer 8 (jaredwray/soldock#77): stars. No other test uses Ingrid, so her Starred part has only this room.
test("a star moves a room to Starred, a second page of the person gets it without a poll, and Remove star moves it back", async ({
	browser,
}) => {
	const ingrid = await signIn(browser, "ingrid");
	const name = unique("Favorite");
	const roomId = await createRoom(ingrid, name);
	const page = await ingrid.newPage();
	const other = await ingrid.newPage();
	const live = other
		.waitForEvent("websocket", (socket) => socket.url().endsWith("/ws/events"))
		.then((socket) => socket.waitForEvent("framereceived", (frame) => String(frame.payload).includes('"hello"')));
	await other.goto("/chat");
	await live;
	await expect(other.getByRole("list", { name: "Rooms" }).getByRole("link", { name })).toBeVisible();
	let reads = 0;
	other.on("request", (request) => {
		if (request.method() === "GET" && new URL(request.url()).pathname === "/api/v1/chat/rooms") reads += 1;
	});
	await openRoom(page, roomId);
	// The reads of the list of this page answer late. A click while a read runs must not get lost.
	const lateList = await hold(page, (url) => url.pathname === "/api/v1/chat/rooms", "GET");

	await page.getByRole("button", { name: "Star", exact: true }).click();
	await expect(page.getByRole("button", { name: "Remove star" })).toHaveAttribute("aria-pressed", "true");
	for (const shown of [page, other]) {
		await expect(shown.getByRole("list", { name: "Starred" }).getByRole("link", { name })).toBeVisible();
		await expect(shown.getByRole("list", { name: "Rooms" }).getByRole("link", { name })).toHaveCount(0);
	}
	// The second page got the star from the events socket, not from a read of the list.
	expect(reads).toBe(0);

	await page.getByRole("button", { name: "Remove star" }).click();
	await expect(page.getByRole("button", { name: "Star", exact: true })).toHaveAttribute("aria-pressed", "false");
	lateList.release();
	for (const shown of [page, other]) {
		await expect(shown.getByRole("list", { name: "Rooms" }).getByRole("link", { name })).toBeVisible();
		await expect(shown.getByRole("heading", { name: "Starred" })).toHaveCount(0);
	}
});

// Layer 4 (jaredwray/soldock#73): reactions.
test("the quick reactions add and remove a reaction, and the next room puts the emoji that the person uses most first", async ({
	browser,
}) => {
	const tomasz = await signIn(browser, "tomasz");
	const nadia = await signIn(browser, "nadia");
	const name = unique("Quick");
	const roomId = await createRoom(tomasz, name, [nadia]);
	await post(tomasz, roomId, "first message");
	await post(tomasz, roomId, "second message");
	const page = await nadia.newPage();
	await openRoom(page, roomId);
	const quick = (row: ReturnType<typeof page.locator>) =>
		row.locator(".chat-quick-reaction").evaluateAll((buttons) => buttons.map((button) => button.textContent));

	// A person without reactions gets the default emoji. A click adds the reaction, and a second click removes it.
	const first = page.locator(".chat-message").filter({ hasText: "first message" });
	await first.hover();
	expect(await quick(first)).toEqual(["👍", "❤️", "😂"]);
	const thumbs = first.getByRole("button", { name: "React with thumbs up" });
	// A second click while the call runs does nothing: one call, and one use of the emoji.
	const reactionCalls: string[] = [];
	page.on("request", (request) => {
		if (request.method() === "POST" && request.url().endsWith("/reactions")) reactionCalls.push(request.url());
	});
	const answer = await hold(page, "**/api/v1/chat/rooms/*/messages/*/reactions", "POST");
	await thumbs.click();
	await thumbs.click();
	answer.release();
	await expect(first.getByRole("button", { name: "thumbs up: 1 reaction, with yours" })).toBeVisible();
	expect(reactionCalls).toHaveLength(1);
	await expect(thumbs).toHaveAttribute("aria-pressed", "true");
	await thumbs.click();
	await expect(first.getByRole("button", { name: /^thumbs up:/ })).toHaveCount(0);
	await expect(thumbs).toHaveAttribute("aria-pressed", "false");

	// Two reactions with 🎉 from the list. The buttons of this room stay as they are.
	for (const row of [first, page.locator(".chat-message").filter({ hasText: "second message" })]) {
		await row.hover();
		await row.getByRole("button", { name: /^Add a reaction/ }).click();
		await page.getByRole("searchbox", { name: "Find an emoji" }).fill("party");
		await page.getByRole("searchbox", { name: "Find an emoji" }).press("Enter");
		await expect(row.getByRole("button", { name: "party popper: 1 reaction, with yours" })).toBeVisible();
	}
	expect(await quick(first)).toEqual(["👍", "❤️", "😂"]);

	// The next room: 🎉 (two uses) comes first, then 👍 (one use), then a default emoji.
	await page.reload();
	await expect(page.locator(".chat-composer")).toBeVisible();
	await first.hover();
	expect(await quick(first)).toEqual(["🎉", "👍", "❤️"]);
});

test("a reaction from the picker shows on the message, a reaction of a different person arrives live, and a click removes it", async ({
	browser,
}) => {
	const tomasz = await signIn(browser, "tomasz");
	const nadia = await signIn(browser, "nadia");
	const name = unique("React");
	const roomId = await createRoom(tomasz, name, [nadia]);
	// Earlier messages put the message at the end of a full scroll area, where a list that opens
	// downward is cut off.
	await fill([tomasz, nadia], roomId, 14);
	const message = await post(tomasz, roomId, "We ship on Friday.");
	const page = await nadia.newPage();
	await openRoom(page, roomId);

	const row = page.locator(".chat-message").filter({ hasText: "We ship on Friday." });
	await row.hover();
	await row.getByRole("button", { name: /^Add a reaction/ }).click();
	await page.getByRole("searchbox", { name: "Find an emoji" }).fill("party");
	await page.getByRole("searchbox", { name: "Find an emoji" }).press("Enter");
	const party = row.getByRole("button", { name: "party popper: 1 reaction, with yours" });
	await expect(party).toHaveAttribute("aria-pressed", "true");
	const opener = row.getByRole("button", { name: /^Add a reaction/ });
	// After a pick, the focus is on the button that opened the list again.
	await expect(opener).toBeFocused();

	// The message is the newest one, at the end of the list. The emoji of the list must show, not be
	// cut off by the end of the scroll area, and a click takes one.
	await opener.click();
	const picker = page.getByRole("dialog", { name: "Add a reaction" });
	await expect(picker).toBeInViewport({ ratio: 1 });
	const thumbs = picker.getByRole("button", { name: "thumbs up" });
	await thumbs.click();
	await expect(row.getByRole("button", { name: "thumbs up: 1 reaction, with yours" })).toBeVisible();

	// The button closes the list it opened. Escape closes it too, and gives the focus back.
	await opener.click();
	await expect(page.getByRole("dialog", { name: "Add a reaction" })).toBeVisible();
	await opener.click();
	await expect(page.getByRole("dialog", { name: "Add a reaction" })).toHaveCount(0);
	await opener.click();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog", { name: "Add a reaction" })).toHaveCount(0);
	await expect(opener).toBeFocused();

	// The reaction of a different person comes through the socket of the room.
	await react(tomasz, roomId, message.id, "🎉");
	await expect(row.getByRole("button", { name: "party popper: 2 reactions, with yours" })).toBeVisible();

	await row.getByRole("button", { name: "party popper: 2 reactions, with yours" }).click();
	await expect(row.getByRole("button", { name: "party popper: 1 reaction" })).toHaveAttribute("aria-pressed", "false");
	const stored = (await newest(nadia, roomId)).find((one) => one.id === message.id) as unknown as {
		reactions: { emoji: string; count: number }[];
	};
	// The oldest reaction that stays is the 👍 of Nadia, so it comes first.
	expect(stored.reactions).toEqual([
		expect.objectContaining({ emoji: "👍", count: 1 }),
		expect.objectContaining({ emoji: "🎉", count: 1 }),
	]);
});

// Layer 4 (jaredwray/soldock#73): rich text.
test("a message shows its formats, shows HTML as text, and the box makes formats that an edit keeps", async ({
	browser,
}) => {
	const tomasz = await signIn(browser, "tomasz");
	const nadia = await signIn(browser, "nadia");
	const name = unique("Format");
	const roomId = await createRoom(tomasz, name, [nadia]);
	await postMarkdown(
		tomasz,
		roomId,
		"Ship **today**, *carefully*, with `make ship`.\n\n- [notes](https://example.com/notes)\n- ~~old plan~~\n\n> quoted",
	);
	await post(tomasz, roomId, "<script>alert(1)</script> <b>not bold</b>");
	const page = await nadia.newPage();
	await openRoom(page, roomId);

	const formatted = page.locator(".chat-message").filter({ hasText: "Ship today" });
	await expect(formatted.locator(".chat-text strong")).toHaveText("today");
	await expect(formatted.locator("em")).toHaveText("carefully");
	await expect(formatted.locator("code")).toHaveText("make ship");
	await expect(formatted.locator("s")).toHaveText("old plan");
	await expect(formatted.locator("blockquote")).toHaveText("quoted");
	const link = formatted.getByRole("link", { name: "notes" });
	await expect(link).toHaveAttribute("href", "https://example.com/notes");
	await expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
	// Plain text is text: no element comes from it.
	const raw = page.locator(".chat-message").filter({ hasText: "not bold" });
	await expect(raw.locator(".chat-text")).toContainText("<script>alert(1)</script> <b>not bold</b>");
	await expect(raw.locator(".chat-text b, .chat-text script")).toHaveCount(0);

	// Shift+Enter makes a new line in the box, and the message keeps it as a line break.
	await composer(page, name).fill("line one");
	await composer(page, name).press("Shift+Enter");
	await composer(page, name).pressSequentially("line two");
	await composer(page, name).press("Enter");
	const lines = page.locator(".chat-message").filter({ hasText: "line one" });
	await expect(lines.locator(".chat-text br")).toHaveCount(1);
	await expect(lines.locator(".chat-text")).toHaveText("line oneline two");

	// Markdown shortcuts work while the person types: **that** becomes bold.
	const box = composer(page, name);
	await box.pressSequentially("I can do **that**");
	await expect(box.locator("strong")).toHaveText("that");
	await box.press("Enter");
	const mine = page.locator(".chat-message").filter({ hasText: "I can do that" });
	await expect(mine.locator(".chat-text strong")).toHaveText("that");

	// An edit opens with the formats of the message, not with Markdown. The toolbar changes the formats.
	await mine.hover();
	await mine.getByRole("button", { name: /^Change your message/ }).click();
	const editBox = page.getByRole("textbox", { name: "New text of the message" });
	await expect(editBox).toHaveText("I can do that");
	await expect(editBox.locator("strong")).toHaveText("that");
	await editBox.press("End");
	const tools = page.locator(".chat-edit").getByRole("toolbar", { name: "Formatting" });
	await expect(tools.getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "true");
	await tools.getByRole("button", { name: "Bold" }).click();
	await editBox.pressSequentially(" ");
	await tools.getByRole("button", { name: "Italic" }).click();
	await editBox.pressSequentially("now");
	await page.getByRole("button", { name: "Save" }).click();
	const edited = page.locator(".chat-message").filter({ hasText: "I can do that now" });
	await expect(edited.locator(".chat-text em")).toHaveText("now");
	await expect(edited.locator(".chat-text strong")).toHaveText("that");
});

test("the box takes an emoji from its list, and turns a full code into its emoji", async ({ browser }) => {
	const tomasz = await signIn(browser, "tomasz");
	const name = unique("Emoji");
	const roomId = await createRoom(tomasz, name);
	const page = await tomasz.newPage();
	await openRoom(page, roomId);
	const box = composer(page, name);

	// ":" and two characters open the list. The arrow keys move in it, and Enter takes an emoji without a send.
	await box.pressSequentially("ship it :par");
	const list = page.getByRole("listbox", { name: "Emoji" });
	await expect(list.getByRole("option").first()).toHaveAccessibleName("party popper");
	// A screen reader hears the number of emoji in the list.
	const count = await list.getByRole("option").count();
	await expect(page.getByRole("status").filter({ hasText: "Use the arrow keys" })).toHaveText(
		new RegExp(`^${count} emoji\\.`),
	);
	await box.press("ArrowDown");
	await expect(list.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
	await box.press("ArrowUp");
	await box.press("Enter");
	await expect(list).toHaveCount(0);
	await expect(box).toHaveText(/^ship it 🎉\s$/);

	// A full code becomes its emoji. A time keeps its ":".
	await box.pressSequentially(":+1: at 10:30");
	await expect(list).toHaveCount(0);
	await expect(box).toHaveText("ship it 🎉 👍 at 10:30");
	await box.press("Enter");
	await expect(page.locator(".chat-message .chat-text").filter({ hasText: "ship it 🎉 👍 at 10:30" })).toBeVisible();
});

test("the box makes lists, quotes and code blocks with Markdown shortcuts, and takes a mention from its list", async ({
	browser,
}) => {
	const tomasz = await signIn(browser, "tomasz");
	const nadia = await signIn(browser, "nadia");
	const name = unique("Box");
	const roomId = await createRoom(tomasz, name, [nadia]);
	const page = await nadia.newPage();
	await openRoom(page, roomId);
	const box = composer(page, name);

	// "- " makes a list. Shift+Enter makes the next item, and Enter sends.
	await box.pressSequentially("- first");
	await box.press("Shift+Enter");
	await box.pressSequentially("second");
	await expect(box.locator("ul li")).toHaveCount(2);
	await box.press("Enter");
	const list = page.locator(".chat-message").filter({ hasText: "first" });
	await expect(list.locator(".chat-text ul li")).toHaveText(["first", "second"]);
	await expect(box).toHaveText("");

	// "> " makes a quote. "```" makes a code block, which keeps its lines.
	await box.pressSequentially("> quoted words");
	await box.press("Enter");
	await expect(page.locator(".chat-message blockquote").filter({ hasText: "quoted words" })).toBeVisible();
	await box.pressSequentially("```");
	await expect(box.locator("pre")).toHaveCount(1);
	await box.pressSequentially("make a");
	await box.press("Shift+Enter");
	await box.pressSequentially("make b");
	await box.press("Enter");
	await expect(page.locator(".chat-message pre").filter({ hasText: "make a" })).toHaveText("make a\nmake b");

	// A mark in a word stays text: 2*3*4 is not italic.
	await box.pressSequentially("2*3*4 = 24");
	await expect(box.locator("em")).toHaveCount(0);

	// A paste of HTML keeps only the formats of a message: no script, no image, no unsafe link.
	await box.press("Control+a");
	await box.press("Delete");
	await box.evaluate((element) => {
		const data = new DataTransfer();
		data.setData(
			"text/html",
			'<p><b>bold</b> <a href="javascript:alert(1)">bad</a> <a href="https://example.com/ok">ok</a>' +
				'<img src="x" onerror="window.pasted = 1"><script>window.pasted = 2</script></p>',
		);
		data.setData("text/plain", "bold bad ok");
		element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
	});
	await expect(box.locator("strong")).toHaveText("bold");
	await expect(box.locator("a")).toHaveCount(1);
	await expect(box.locator("a")).toHaveAttribute("href", "https://example.com/ok");
	await expect(box.locator("img, script")).toHaveCount(0);
	expect(await page.evaluate(() => (window as { pasted?: number }).pasted)).toBeUndefined();

	// "@" opens the list of people. Enter takes a suggestion, and does not send.
	await box.press("Control+a");
	await box.press("Delete");
	await box.pressSequentially("thanks @tom");
	const suggestion = page.getByRole("option", { name: /Tomasz/ });
	await expect(suggestion).toBeVisible();
	await box.press("Enter");
	await expect(page.getByRole("listbox", { name: "People and agents to mention" })).toHaveCount(0);
	await expect(box).toHaveText(/^thanks @tomasz\s$/);
	await box.pressSequentially("for the review");
	await box.press("Enter");

	// Ctrl+Enter sends, also while the list is open.
	await box.pressSequentially("ping @to");
	await expect(page.getByRole("option", { name: /Tomasz/ })).toBeVisible();
	await box.press("Control+Enter");
	await expect(page.locator(".chat-message").filter({ hasText: "ping @to" })).toBeVisible();
	await expect(box).toHaveText("");
	const thanks = page.locator(".chat-message").filter({ hasText: "thanks @tomasz for the review" });
	await expect(thanks.getByRole("link", { name: "@tomasz" })).toBeVisible();
	// The box sent a mention node: the room stores the id of the principal.
	const stored = (await newest(nadia, roomId)).find((one) => one.text === "thanks @tomasz for the review");
	expect(stored?.mentions).toHaveLength(1);

	// In the edit box, Escape closes the list of a mention first, and then the edit box.
	await thanks.hover();
	await thanks.getByRole("button", { name: /^Change your message/ }).click();
	const editBox = page.getByRole("textbox", { name: "New text of the message" });
	await editBox.press("End");
	await editBox.pressSequentially(" @to");
	const people = page.getByRole("listbox", { name: "People and agents to mention" });
	await expect(people).toBeVisible();
	await editBox.press("Escape");
	await expect(people).toHaveCount(0);
	await expect(editBox).toBeVisible();
	await editBox.press("Escape");
	await expect(editBox).toHaveCount(0);
});
