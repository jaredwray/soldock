import { expect, test } from "@playwright/test";
import { signIn } from "../support/chat.ts";
import { FAKE_APP_ID, FAKE_APP_SECRET, FAKE_TURN_KEY_ID, FAKE_TURN_KEY_TOKEN } from "../support/fake-sfu.ts";

// Admin › Meet: global-setup.ts saved the values of the stand-in SFU here, as an admin does. The admin sees the saved
// state and never a secret, tests the values against the stand-in, and saves the App Secret again. A member has no
// Meet section. The test removes no value, because the Meet tests run at the same time on the same Worker.
test.skip(process.env.MEET_LIVE === "1", "The live run uses the Worker secrets, not the settings.");

test("an admin sees and tests the Realtime values of Meet, and a member has no Meet section", async ({ browser }) => {
	const admin = await signIn(browser, "tomasz");
	const member = await signIn(browser, "chidi");
	try {
		const page = await admin.newPage();
		await page.goto("/admin/meet");
		await expect(page.getByRole("heading", { name: "Meet", level: 1 })).toBeVisible();
		await expect(page.getByRole("status").filter({ hasText: "Meet is ready." })).toBeVisible();
		await expect(page.getByLabel("App ID", { exact: true })).toHaveValue(FAKE_APP_ID);
		await expect(page.getByLabel("TURN Key ID", { exact: true })).toHaveValue(FAKE_TURN_KEY_ID);
		// Each secret is saved, and the page never shows it.
		await expect(page.getByText("A secret is saved. Asterra never shows it again.")).toHaveCount(2);
		const body = page.locator("body");
		await expect(body).not.toContainText(FAKE_APP_SECRET);
		await expect(body).not.toContainText(FAKE_TURN_KEY_TOKEN);

		// The test makes one session and one TURN credential on the stand-in.
		await page.getByRole("button", { name: "Test connection" }).click();
		await expect(page.getByText(/SFU app: Cloudflare answered in \d+ ms\./)).toBeVisible();
		await expect(page.getByText(/TURN key: Cloudflare answered in \d+ ms\./)).toBeVisible();

		// A new ID needs its secret: the form says so before a request.
		await page.getByLabel("App ID", { exact: true }).fill("f0000000000000000000000000000001");
		await page.getByRole("button", { name: "Save Meet settings" }).click();
		await expect(page.getByRole("alert")).toHaveText("Paste the App Secret of the new App ID.");
		await page.getByRole("button", { name: "Discard changes" }).click();

		// Replace the App Secret with the same value. Meet stays ready.
		await page.getByRole("button", { name: "Replace the App Secret" }).click();
		await page.getByLabel("App Secret", { exact: true }).fill(FAKE_APP_SECRET);
		await page.getByRole("button", { name: "Save Meet settings" }).click();
		await expect(page.getByText("The Meet settings are saved.")).toBeVisible();
		await expect(page.getByLabel("App Secret", { exact: true })).toHaveCount(0);
		await expect(page.getByRole("status").filter({ hasText: "Meet is ready." })).toBeVisible();

		const other = await member.newPage();
		await other.goto("/admin/meet");
		await expect(other.getByText("Only owners and admins can use this section.")).toBeVisible();
		await expect(
			other.getByRole("navigation", { name: "Admin sections" }).getByRole("link", { name: "Meet" }),
		).toHaveCount(0);
	} finally {
		await admin.close();
		await member.close();
	}
});
