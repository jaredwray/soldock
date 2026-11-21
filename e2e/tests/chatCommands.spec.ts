import { expect } from "@playwright/test";
import { composer, createRoom, newest, openRoom, unique } from "../support/chat.ts";
import { test } from "../support/chatDevices.ts";

test("a room command changes the topic and the composer keeps the command private", async ({ device }) => {
	const member = await device("tomasz");
	const name = unique("Commands");
	const roomId = await createRoom(member, name, []);
	const page = await member.newPage();
	await openRoom(page, roomId);
	const box = composer(page, name);
	await box.fill("/topic Review the new draft");
	await box.press("Enter");
	await expect(page.locator(".chat-topic")).toHaveText("Review the new draft");
	await expect(box).toHaveText("");
	expect(await newest(member, roomId)).toEqual([]);
	await box.fill("/hooks");
	await box.press("Enter");
	const dialog = page.getByRole("dialog", { name: "Incoming webhooks" });
	await dialog.getByLabel("Webhook name").fill("Build status");
	await dialog.getByRole("button", { name: "Create webhook" }).click();
	await expect(dialog.getByLabel("Webhook URL")).toHaveValue(/\/hooks\/chat\//);
	await expect(dialog.getByLabel("Signing secret")).toHaveValue(/\S+/);
	await dialog.getByRole("button", { name: "Revoke" }).click();
	await expect(dialog.getByLabel("Signing secret")).toHaveCount(0);
});
