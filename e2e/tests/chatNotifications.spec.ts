import { expect } from "@playwright/test";
import { createRoom, openRoom, unique } from "../support/chat.ts";
import { test } from "../support/chatDevices.ts";

test("a room keeps its notification level until the person selects the account default", async ({ device }) => {
	const person = await device("ingrid");
	const room = await createRoom(person, unique("Room notifications"));
	const page = await person.newPage();
	await openRoom(page, room);
	const button = page.getByRole("button", { name: "Room notifications" });
	const dialog = page.getByRole("dialog", { name: "Room notifications" });
	const level = dialog.getByRole("combobox", { name: "Notify me about" });
	await button.click();
	await expect(level).toHaveValue("");
	await level.selectOption("mentions");
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(dialog).toHaveCount(0);
	await page.reload();
	await button.click();
	await expect(level).toHaveValue("mentions");
	await level.selectOption("");
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(dialog).toHaveCount(0);
	const settings = await person.request.get("/api/v1/chat/notifications");
	expect((await settings.json()).settings.room_levels).not.toHaveProperty(room);
});
