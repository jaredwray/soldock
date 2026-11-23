import { expect, type Locator, test } from "@playwright/test";
import { signIn } from "../support/chat.ts";

/** Turns a switch on. The auto-label test can turn AI on at the same time, so a switch can be on already. */
async function turnOn(control: Locator): Promise<void> {
	if ((await control.getAttribute("aria-checked")) !== "true") await control.click();
	await expect(control).toHaveAttribute("aria-checked", "true");
}

// Admin › AI: an admin connects the AI Gateway, turns on AI and inbox auto labels, allows a model and sets
// the budget. The admin saves an API token, sees that the page never shows it again, and removes it, so the
// local Worker makes no AI call. A member has no AI section. The test only turns AI on, so the auto-label
// test can run at the same time.
test("an admin connects the AI Gateway and turns on inbox auto labels", async ({ browser }) => {
	const admin = await signIn(browser, "tomasz");
	const member = await signIn(browser, "chidi");
	try {
		const page = await admin.newPage();
		await page.goto("/admin/ai");
		await expect(page.getByRole("heading", { name: "AI", level: 1 })).toBeVisible();
		await expect(page.getByLabel("API token")).toHaveValue("");

		await page.getByLabel("Cloudflare account ID").fill("0123456789abcdef0123456789abcdef");
		await page.getByLabel("AI Gateway ID").fill("asterra-e2e");
		await page.getByLabel("API token").fill("e2e-token_0123456789-abcdefgh");
		await page.getByRole("checkbox", { name: /Llama 3\.3 70B/ }).check();
		await turnOn(page.getByRole("switch", { name: "Use AI in this organization" }));
		await turnOn(page.getByRole("switch", { name: "Inbox auto labels" }));
		await page.getByLabel("Monthly budget (USD)").fill("25");
		await page.getByRole("button", { name: "Save AI settings" }).click();
		await expect(page.getByText("AI settings saved.")).toBeVisible();

		await page.reload();
		await expect(page.getByLabel("Cloudflare account ID")).toHaveValue("0123456789abcdef0123456789abcdef");
		await expect(page.getByLabel("AI Gateway ID")).toHaveValue("asterra-e2e");
		await expect(page.getByRole("switch", { name: "Use AI in this organization" })).toHaveAttribute(
			"aria-checked",
			"true",
		);
		await expect(page.getByRole("switch", { name: "Inbox auto labels" })).toHaveAttribute("aria-checked", "true");
		await expect(page.getByLabel("Monthly budget (USD)")).toHaveValue("25");
		// The token is saved, and the page never shows it again.
		await expect(page.getByText("A token is saved. Asterra never shows it again.")).toBeVisible();
		await expect(page.getByLabel("API token")).toHaveCount(0);
		await expect(page.locator("body")).not.toContainText("e2e-token_0123456789-abcdefgh");
		// Remove it: the status says why AI makes no calls, and the rules of auto labels still apply.
		await page.getByRole("button", { name: "Remove", exact: true }).click();
		await page.getByRole("button", { name: "Save AI settings" }).click();
		await expect(page.getByLabel("API token")).toHaveValue("");
		await expect(page.getByRole("status").filter({ hasText: "No API token is saved" })).toBeVisible();
		// The test makes no AI call: the usage of the month shows its empty state.
		await expect(page.getByRole("heading", { name: /^Usage in / })).toBeVisible();
		await expect(page.getByText("of $25.00")).toBeVisible();

		const other = await member.newPage();
		await other.goto("/admin/ai");
		await expect(other.getByText("Only owners and admins can use this section.")).toBeVisible();
		await expect(other.getByRole("link", { name: "AI", exact: true })).toHaveCount(0);
	} finally {
		await admin.close();
		await member.close();
	}
});
