import { expect } from "@playwright/test";
import { createRoom, openRoom, post, unique } from "../support/chat.ts";
import { test } from "../support/chatDevices.ts";

test("an admin adds a custom emoji that another member can read and use", async ({ device }) => {
	const owner = await device("nadia");
	const member = await device("chidi");
	const emoji = unique("ship").replaceAll(" ", "_");
	const room = await createRoom(owner, unique("Studio"), [member]);
	await post(owner, room, `Launch :${emoji}:`);
	const admin = await owner.newPage();
	await openRoom(admin, room);
	const row = admin.locator(".chat-message").filter({ hasText: "Launch" });
	await row.hover();
	await row.getByRole("button", { name: /^Add a reaction/ }).click();
	const picker = admin.getByRole("dialog", { name: "Add a reaction" });
	await picker.getByText("Manage custom emoji").click();
	await picker.getByLabel("Name", { exact: true }).fill(emoji);
	await picker.locator('input[type="file"]').setInputFiles({
		name: "ship.png",
		mimeType: "image/png",
		buffer: Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPQyvf5DwADkQHlohpSOwAAAABJRU5ErkJggg==",
			"base64",
		),
	});
	await picker.getByRole("button", { name: "Add emoji", exact: true }).click();
	await expect(picker.getByRole("button", { name: emoji, exact: true })).toBeVisible();
	const page = await member.newPage();
	await openRoom(page, room);
	const posted = page.locator(".chat-message").filter({ hasText: "Launch" });
	await expect(posted.getByRole("img", { name: `:${emoji}:` })).toHaveJSProperty("naturalWidth", 1);
	await posted.hover();
	await posted.getByRole("button", { name: /^Add a reaction/ }).click();
	await page.getByRole("searchbox", { name: "Find an emoji" }).fill(emoji);
	await page.getByRole("button", { name: emoji, exact: true }).click();
	await expect(posted.getByRole("button", { name: `:${emoji}:: 1 reaction, with yours` })).toBeVisible();
});
