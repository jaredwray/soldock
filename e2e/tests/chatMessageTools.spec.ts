import { expect, type Route } from "@playwright/test";
import { composer, createRoom, openRoom, postMarkdown, unique } from "../support/chat.ts";
import { test } from "../support/chatDevices.ts";

test("a second device reads the draft and the first sees it clear after a scheduled send", async ({ device }) => {
	const first = await device("ingrid");
	const second = await device("ingrid");
	const name = unique("Draft");
	const roomId = await createRoom(first, name);
	const page = await first.newPage();
	await openRoom(page, roomId);
	const saved = page.waitForResponse(
		(response) => response.url().endsWith("/draft") && response.request().method() === "POST" && response.ok(),
	);
	await composer(page, name).fill("Ready for tomorrow");
	await saved;
	const other = await second.newPage();
	await openRoom(other, roomId);
	await expect(composer(other, name)).toHaveText("Ready for tomorrow");
	await other.getByRole("button", { name: "Schedule a text message" }).click();
	const dialog = other.getByRole("dialog");
	const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 16);
	await dialog.getByLabel("Local date and time").fill(tomorrow);
	const cleared = other.waitForResponse(
		(response) => response.url().endsWith("/draft") && response.request().method() === "POST" && response.ok(),
	);
	await dialog.getByRole("button", { name: "Schedule", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect(composer(other, name)).toHaveText("");
	await cleared;
	await page.reload();
	await expect(composer(page, name)).toHaveText("");
	await page.getByRole("button", { name: "Pins and scheduled messages" }).click();
	await page.getByRole("button", { name: "Scheduled", exact: true }).click();
	await expect(page.getByRole("dialog").getByText("Ready for tomorrow")).toBeVisible();
	await page.getByRole("button", { name: "Cancel send" }).click();
	await expect(page.getByRole("dialog").getByText("You have no scheduled messages in this room.")).toBeVisible();
});

test("a stale editor cannot copy private drafts across a replaced session", async ({ device }) => {
	const first = await device("nadia");
	const second = await device("rafael");
	const name = unique("Private draft");
	const room = await createRoom(first, name, [second]);
	const editor = await first.newPage();
	const other = await second.newPage();
	await Promise.all([openRoom(editor, room), openRoom(other, room)]);
	const saved = other.waitForResponse(
		(response) => response.url().endsWith("/draft") && response.request().method() === "POST" && response.ok(),
	);
	await composer(other, name).fill("Rafael's private draft");
	await saved;
	// A resumed tab can miss its session-change notification. The server sees the new cookie immediately.
	await first.addCookies(await second.cookies());
	await composer(editor, name).fill("Nadia's local draft");
	await expect(editor.getByText(/Your account changed/)).toBeVisible();
	await expect(composer(editor, name)).toHaveText("Nadia's local draft");
	await other.reload();
	await expect(composer(other, name)).toHaveText("Rafael's private draft");
});

test("sign-out saves a pending draft from a closed room and removes its local copy", async ({ device }) => {
	const laptop = await device("meiling");
	const phone = await device("meiling");
	const name = unique("Draft at sign-out");
	const room = await createRoom(laptop, name);
	const page = await laptop.newPage();
	await openRoom(page, room);
	await page.route("**/draft", (route) => route.abort());
	await composer(page, name).fill("Keep this across sign-out");
	await expect(page.getByText(/Draft sync failed/)).toBeVisible();
	await page.goto("/settings");
	await page.unroute("**/draft");
	await page.getByRole("button", { name: "Sign out", exact: true }).click();
	await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
	expect(
		await page.evaluate(() => Object.keys(localStorage).some((key) => key.startsWith("soldock:chat-drafts:"))),
	).toBe(false);
	const other = await phone.newPage();
	await openRoom(other, room);
	await expect(composer(other, name)).toHaveText("Keep this across sign-out");
});

test("a canceled sign-out preserves the revision of an open draft that was saved", async ({ device }) => {
	const laptop = await device("tomasz");
	const phone = await device("tomasz");
	const closedName = unique("Closed draft");
	const openName = unique("Open draft");
	const closedRoom = await createRoom(laptop, closedName);
	const open = await createRoom(laptop, openName);
	const draftPath = `/api/v1/chat/rooms/${open}/draft`;
	const page = await laptop.newPage();
	let allowOpenWrites = false;
	let allowReads = true;
	await page.route("**/rooms/*/draft*", (route) => {
		const request = route.request();
		const allow =
			request.method() === "GET" ? allowReads : allowOpenWrites && new URL(request.url()).pathname === draftPath;
		return allow ? route.continue() : route.abort();
	});

	await openRoom(page, closedRoom);
	await composer(page, closedName).fill("Pending in a closed room");
	await expect(page.getByText(/Draft sync failed/)).toBeVisible();
	await openRoom(page, open);
	await composer(page, openName).fill("Saved during sign-out");
	await expect(page.getByText(/Draft sync failed/)).toBeVisible();

	// Only the open draft can be saved. Hold background reads so they cannot repair the revision before the next edit.
	allowOpenWrites = true;
	allowReads = false;
	await page.getByRole("button", { name: /^Account:/ }).click();
	const cancel = page.waitForEvent("dialog").then((prompt) => prompt.dismiss());
	await Promise.all([
		cancel,
		page.getByRole("navigation", { name: "Products" }).getByRole("button", { name: "Sign out" }).click(),
	]);
	const remoteText = async () => (await (await phone.request.get(draftPath)).json()).body?.content[0].content[0].text;
	expect(await remoteText()).toBe("Saved during sign-out");
	await composer(page, openName).fill("New edit after cancel");
	allowReads = true;
	await expect.poll(remoteText).toBe("New edit after cancel");
});

test("a room pin is shared and a saved message stays private", async ({ device }) => {
	const owner = await device("rafael");
	const member = await device("meiling");
	const roomId = await createRoom(owner, unique("Pins"), [member]);
	const text = unique("Team decision");
	await postMarkdown(owner, roomId, text);
	const page = await owner.newPage();
	await openRoom(page, roomId);
	const row = page.locator(".chat-message").filter({ hasText: text });
	for (const action of ["Pin to room", "Save for later"]) {
		await row.hover();
		await row.getByRole("button", { name: "More message actions" }).click();
		await page.getByRole("dialog").getByRole("button", { name: action }).click();
		await expect(page.getByRole("dialog")).toHaveCount(0);
	}
	const reader = await member.newPage();
	await openRoom(reader, roomId);
	await reader.getByRole("button", { name: "Pins and scheduled messages" }).click();
	await expect(reader.getByRole("dialog").getByRole("link", { name: text })).toBeVisible();
	await reader.getByRole("dialog").getByRole("button", { name: "Close" }).click();
	await reader.getByRole("button", { name: "Saved and reminders" }).click();
	await expect(reader.getByRole("dialog").getByText("Loading…")).toHaveCount(0);
	await expect(reader.getByRole("dialog").getByRole("link", { name: text })).toHaveCount(0);
	await page.getByRole("button", { name: "Saved and reminders" }).click();
	await page.getByRole("dialog").getByRole("link", { name: text }).click();
	await expect(page).toHaveURL(new RegExp(`${roomId}/1$`));
});

test("a disconnected editor keeps its draft until the person resolves a conflict", async ({ device }) => {
	const laptop = await device("chidi");
	const phone = await device("chidi");
	const name = unique("Draft conflict");
	const room = await createRoom(laptop, name);
	const first = await laptop.newPage();
	const second = await phone.newPage();
	const draftPath = `/api/v1/chat/rooms/${room}/draft`;
	await Promise.all(
		[first, second].map(async (page) => {
			const initial = page.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === draftPath && response.request().method() === "GET" && response.ok(),
			);
			await openRoom(page, room);
			await initial;
		}),
	);
	await laptop.setOffline(true);
	await composer(first, name).fill("A local change");
	await expect(first.getByText(/Draft sync failed/)).toBeVisible();
	const stored = second.waitForResponse(
		(response) => response.url().endsWith("/draft") && response.request().method() === "POST" && response.ok(),
	);
	await composer(second, name).fill("A second change");
	await stored;
	// The reconnect can arrive in a background tab while its last offline attempt still waits for a response.
	const retry = Promise.withResolvers<Route>();
	await first.route(`**${draftPath}?*`, (route) => retry.resolve(route), { times: 1 });
	await first
		.getByText(/Draft sync failed/)
		.getByRole("button", { name: "Try again" })
		.click();
	const offlineRead = await retry.promise;
	// The network interface is online before its first request can reach the Worker.
	await first.route(`**${draftPath}?*`, (route) => route.abort("connectionreset"), { times: 1 });
	await first.evaluate(() => {
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
		window.addEventListener(
			"online",
			() => {
				document.documentElement.dataset.reconnected = "yes";
			},
			{ once: true },
		);
	});
	await laptop.setOffline(false);
	await expect(first.locator("html")).toHaveAttribute("data-reconnected", "yes");
	const recovered = first.waitForResponse(
		(response) =>
			new URL(response.url()).pathname === draftPath && response.request().method() === "GET" && response.ok(),
		{ timeout: 10_000 },
	);
	await offlineRead.abort("internetdisconnected");
	expect(await (await recovered).json()).toMatchObject({
		revision: 1,
		body: { content: [{ content: [{ text: "A second change" }] }] },
	});
	await expect(first.getByRole("button", { name: "Keep this draft" })).toBeVisible();
	await first.evaluate(() => Reflect.deleteProperty(document, "visibilityState"));
	await first.getByRole("button", { name: /^Account:/ }).click();
	const discard = first.waitForEvent("dialog").then(async (prompt) => {
		expect(prompt.message()).toContain("unsaved edits");
		await prompt.dismiss();
	});
	await Promise.all([
		discard,
		first.getByRole("navigation", { name: "Products" }).getByRole("button", { name: "Sign out" }).click(),
	]);
	await expect(composer(first, name)).toHaveText("A local change");
	await first.getByRole("button", { name: "Use the other draft" }).click();
	await expect(composer(first, name)).toHaveText("A second change");
	await first.reload();
	await expect(composer(first, name)).toHaveText("A second change");
});

test("a forwarded copy links to its source and a reminder can be dismissed", async ({ device }) => {
	const user = await device("tomasz");
	const source = await createRoom(user, unique("Source"));
	const destination = await createRoom(user, unique("Destination"));
	const text = unique("Decision");
	const original = await postMarkdown(user, source, text);
	const page = await user.newPage();
	await openRoom(page, source);
	const row = page.locator(".chat-message").filter({ hasText: text });
	const dialog = page.getByRole("dialog");
	await row.hover();
	await row.getByRole("button", { name: "More message actions" }).click();
	await dialog.getByRole("button", { name: "Remind me" }).click();
	await dialog.getByLabel("Local date and time").fill(new Date(Date.now() + 86400000).toISOString().slice(0, 16));
	await dialog.getByRole("button", { name: "Set reminder" }).click();
	await expect(dialog).toHaveCount(0);
	await page.getByRole("button", { name: "Saved and reminders" }).click();
	await dialog.getByRole("button", { name: "Reminders", exact: true }).click();
	const reminder = dialog.getByRole("listitem").filter({ hasText: text });
	await reminder.getByRole("button", { name: "Dismiss" }).click();
	await expect(reminder).toHaveCount(0);
	await dialog.getByRole("button", { name: "Close" }).click();

	await row.hover();
	await row.getByRole("button", { name: "More message actions" }).click();
	await dialog.getByRole("button", { name: "Forward to room" }).click();
	await dialog.getByLabel("Destination room").selectOption(destination);
	await dialog.getByRole("button", { name: "Forward", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await openRoom(page, destination);
	const copy = page.locator(".chat-message").filter({ hasText: text });
	await expect(copy.getByText("Forwarded from", { exact: false })).toBeVisible();
	await copy.locator(`a[href="/chat/${source}/${original.seq}"]`).click();
	await expect(page.locator(".chat-message-marked")).toContainText(text);
});

test("a member who rejoins a room can start a draft after its server revision resets", async ({ device }) => {
	const owner = await device("nadia");
	const member = await device("ingrid");
	const name = unique("Rejoin");
	const room = await createRoom(owner, name, [member]);
	const page = await member.newPage();
	await openRoom(page, room);
	const written = () =>
		page.waitForResponse(
			(response) => response.url().endsWith("/draft") && response.request().method() === "POST" && response.ok(),
		);
	const first = written();
	await composer(page, name).fill("Before leaving");
	await first;
	await page.getByRole("button", { name: "Members: 2 members" }).click();
	await page.getByRole("button", { name: "Leave the room" }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await page.goto(`/chat/${room}`);
	await page.getByRole("button", { name: "Join the room" }).click();
	await expect(composer(page, name)).toHaveText("");
	const second = written();
	await composer(page, name).fill("After rejoining");
	await second;
	await page.reload();
	await expect(composer(page, name)).toHaveText("After rejoining");
});
