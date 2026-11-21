import { expect, test } from "@playwright/test";
import { signIn, unique } from "../support/chat.ts";

test("a person sets and clears a status that another person sees on the open profile", async ({ browser }) => {
	const author = await signIn(browser, "meiling");
	const viewer = await signIn(browser, "rafael");
	const profile = await author.newPage();
	await profile.goto("/chat");
	await profile.getByRole("button", { name: /^Account:/ }).click();
	await profile.getByRole("link", { name: "Profile and status" }).click();
	const change = profile.getByRole("button", { name: "Set status" });
	await expect(change).toBeEnabled();
	const other = await viewer.newPage();
	await other.goto(profile.url());
	const displayed = other.locator(".chat-profile-status");
	await expect(displayed).toContainText(/Active|Away|Offline/);
	await expect(other.getByRole("button", { name: "Set status" })).toHaveCount(0);

	await change.click();
	const dialog = profile.getByRole("dialog", { name: "Set status" });
	const text = unique("On a call");
	await dialog.getByLabel("Status", { exact: true }).fill(text);
	await dialog.getByLabel("Emoji").fill("🎧");
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(displayed).toContainText(`🎧 ${text}`, { timeout: 18_000 });

	await change.click();
	await dialog.getByRole("button", { name: "Clear status" }).click();
	await expect(displayed).not.toContainText(text, { timeout: 18_000 });
});
