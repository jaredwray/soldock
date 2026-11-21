import { expect } from "@playwright/test";
import { composer, createRoom, openRoom, post, unique } from "../support/chat.ts";
import { test } from "../support/chatDevices.ts";

test("switch rooms with the keyboard, navigate messages and keep a sidebar section after reload", async ({
	device,
}) => {
	const actor = await device("tomasz");
	const start = unique("Start");
	const first = await createRoom(actor, start, []);
	const name = unique("Switch");
	const second = await createRoom(actor, name, []);
	await post(actor, second, "First entry");
	await post(actor, second, "Second entry");
	const page = await actor.newPage();
	await openRoom(page, first);
	await composer(page, start).press("Control+k");
	const dialog = page.getByRole("dialog", { name: "Switch rooms or people" });
	const box = dialog.getByRole("searchbox");
	await expect(box).toBeFocused();
	await box.fill(name);
	await expect(dialog.getByRole("link", { name: new RegExp(name) })).toBeVisible();
	await box.press("Enter");
	const log = page.getByRole("log", { name: `Messages of ${name}` });
	await log.focus();
	await log.press("ArrowDown");
	await expect(log.locator("[data-row]").first()).toBeFocused();
	await page.keyboard.press("ArrowDown");
	await expect(log.locator("[data-row]").last()).toBeFocused();
	await page.getByRole("button", { name: "Organize sidebar" }).click();
	const section = unique("Favorites");
	await page.getByLabel("Section", { exact: true }).fill(section);
	await page.getByRole("button", { name: "Save section" }).click();
	await expect(page.getByRole("list", { name: section }).getByRole("link", { name })).toBeVisible();
	await page.reload();
	await expect(page.getByRole("list", { name: section }).getByRole("link", { name })).toBeVisible();
});
