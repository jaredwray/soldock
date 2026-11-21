import { expect } from "@playwright/test";
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
	await Promise.all([openRoom(first, room), openRoom(second, room)]);
	await laptop.setOffline(true);
	await composer(first, name).fill("A local change");
	await expect(first.getByText(/Draft sync failed/)).toBeVisible();
	const stored = second.waitForResponse(
		(response) => response.url().endsWith("/draft") && response.request().method() === "POST" && response.ok(),
	);
	await composer(second, name).fill("A second change");
	await stored;
	await laptop.setOffline(false);
	await expect(first.getByRole("button", { name: "Keep this draft" })).toBeVisible();
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
