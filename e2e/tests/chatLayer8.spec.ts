import { expect, test } from "@playwright/test";
import { createRoom, openRoom, post, react, signIn, unique } from "../support/chat.ts";

test("pins, saved messages, activity feed, and quick switcher work end to end", async ({ browser }) => {
	const nadia = await signIn(browser, "nadia");
	const chidi = await signIn(browser, "chidi");
	try {
		const roomName = unique("Layer8 Core");
		const roomId = await createRoom(nadia, roomName, [chidi]);
		const targetName = unique("Layer8 Target");
		await createRoom(nadia, targetName);

		const text = unique("Quarterly checklist");
		const msg = await post(nadia, roomId, text);
		await react(chidi, roomId, msg.id, "👍");

		const page = await nadia.newPage();
		await openRoom(page, roomId);
		const row = page.locator(".chat-message").filter({ hasText: text });
		await expect(row).toBeVisible();

		// Pin the message and view it in the pins panel.
		await row.hover();
		await row.getByRole("button", { name: "Pin message" }).click();
		await expect(page.getByRole("button", { name: "Pinned messages: 1" })).toBeVisible();
		await page.getByRole("button", { name: "Pinned messages: 1" }).click();
		const pins = page.getByRole("complementary", { name: "Pinned messages" });
		await expect(pins).toContainText(text);
		await pins.getByRole("button", { name: "Close pins" }).click();

		// Save the message and view it on /chat/saved.
		await row.hover();
		await row.getByRole("button", { name: "Save message" }).click();
		await page.getByRole("link", { name: "Saved" }).click();
		await expect(page.getByRole("heading", { name: "Saved & Reminders" })).toBeVisible();
		await expect(page.locator(".chat-subview-body")).toContainText(text);

		// Open /chat/activity and verify the reaction from Chidi appears.
		await page.getByRole("link", { name: /^Activity/ }).click();
		await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
		await expect(page.locator(".chat-subview-body")).toContainText("reacted");

		// Use the quick switcher (Control+K) to jump to the second room.
		await page.keyboard.press("Control+k");
		const switcher = page.getByRole("dialog", { name: "Jump to room or person" });
		await expect(switcher).toBeVisible();
		await switcher.getByRole("textbox").fill(targetName);
		await switcher.getByRole("option", { name: new RegExp(targetName) }).click();
		await expect(page.getByRole("heading", { name: targetName })).toBeVisible();
	} finally {
		await nadia.close();
		await chidi.close();
	}
});

test("room archive shows read-only notice and admin chat manages rooms and slash commands", async ({ browser }) => {
	const nadia = await signIn(browser, "nadia");
	try {
		const roomName = unique("Layer8 Archive");
		const roomId = await createRoom(nadia, roomName);
		await post(nadia, roomId, "Final status note");

		const page = await nadia.newPage();
		await openRoom(page, roomId);

		// Archive the room from Room settings.
		await page.getByRole("button", { name: "Room settings" }).click();
		const dialog = page.getByRole("dialog", { name: "Room settings" });
		await dialog.getByRole("button", { name: "Archive room" }).click();
		await expect(dialog.getByRole("button", { name: "Unarchive room" })).toBeVisible();
		await dialog.getByRole("button", { name: "Close" }).click();
		await expect(page.locator(".chat-readonly-banner")).toContainText("archived");

		// Open /admin/chat and check archived room filter and slash command creation.
		await page.goto("/admin/chat");
		await expect(page.getByRole("heading", { name: "Chat", exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Archived", exact: true }).click();
		await expect(page.locator("main")).toContainText(roomName);

		const cmdName = `ping${Date.now().toString(36).slice(-4)}`;
		await page.getByRole("textbox", { name: "Command name" }).fill(cmdName);
		await page.getByRole("textbox", { name: "Command description" }).fill("Check chat rooms");
		await page.getByRole("textbox", { name: "Target operation" }).fill("chat.list_rooms");
		await page.getByRole("textbox", { name: "Input template JSON" }).fill("{}");
		await page.getByRole("button", { name: "Add command" }).click();
		await expect(page.locator("main")).toContainText(`/${cmdName}`);
	} finally {
		await nadia.close();
	}
});
