import { expect, type Page, test } from "@playwright/test";
import {
	composer,
	createRoom,
	fill,
	newest,
	openRoom,
	post,
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
async function hold(page: Page, url: string, method: string): Promise<{ release: () => void }> {
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
	await expect(composer(page, name)).toHaveValue("");
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
	await page.locator(".chat-edit-draft").fill("refused text");
	await page.getByRole("button", { name: "Save" }).click();
	await expect(page.locator(".chat-edit-draft")).toHaveValue("refused text");
	expect((await newest(tomasz, roomId)).find((entry) => entry.id === message.id)?.text).toBe(first);

	// The change goes through: the new text shows at once, with the edited mark.
	await page.unrouteAll({ behavior: "ignoreErrors" });
	const editAnswer = await hold(page, "**/api/v1/chat/rooms/*/messages/*/edit", "POST");
	await page.locator(".chat-edit-draft").fill("changed text");
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
	await expect(composer(page, second)).toHaveValue("");
	await page.getByRole("link", { name: first }).first().click();
	await expect(composer(page, first)).toHaveValue("a draft that stays");
	await page.reload();
	await expect(composer(page, first)).toHaveValue("a draft that stays");

	// A send removes the draft.
	await openRoom(page, secondId);
	await composer(page, second).fill("a draft to send");
	await composer(page, second).press("Enter");
	await expect(composer(page, second)).toHaveValue("");
	await page.reload();
	await expect(composer(page, second)).toHaveValue("");

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
