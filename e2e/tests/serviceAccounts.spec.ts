import { expect, test } from "@playwright/test";
import { signIn, unique } from "../support/chat.ts";
import { BASE_URL } from "../support/server.ts";

// An admin makes a service account in Admin › Members, gives it a token with a lifetime, sees the call of
// the token in the activity log, and revokes the token.
test("an admin creates a service account, a token for 7 days, sees its activity and revokes it", async ({
	browser,
}) => {
	const context = await signIn(browser, "tomasz");
	const name = unique("CI Pipeline");
	const local = `ci-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	let accountId: string | null = null;
	try {
		const page = await context.newPage();
		await page.goto("/admin/members");

		await page.getByRole("button", { name: "New member" }).click();
		const dialog = page.getByRole("dialog", { name: "New member" });
		await dialog.getByLabel("Service account").check();
		await dialog.getByLabel("Display name").fill(name);
		await dialog.getByLabel("Address").fill(`${local}@example.com`);
		await dialog.getByLabel("Description").fill("Posts build results");
		await dialog.getByRole("button", { name: "Create service account" }).click();
		await expect(dialog).toBeHidden();

		await page.getByRole("button", { name: /^Service accounts/ }).click();
		const card = page.locator("details.admin-card").filter({ hasText: name });
		await card.locator("summary").click();
		await expect(card.getByLabel("Description", { exact: true })).toHaveValue("Posts build results");
		await expect(card.getByText("by Tomasz Wieczorek").first()).toBeVisible();
		const tokens = card.getByRole("table", { name: /^Tokens of/ });
		const activity = card.getByRole("table", { name: /^Activity of/ });

		// The form selects 90 days first. Choose 7 days.
		await card.getByLabel("New token label").fill("GitHub Actions");
		await card.getByRole("combobox", { name: "Expires" }).click();
		await page.getByRole("option", { name: "7 days" }).click();
		await card.getByRole("button", { name: "Create token" }).click();
		const secretDialog = page.getByRole("dialog", { name: "Copy the new token" });
		await expect(secretDialog.getByText("Expires: In 7 days")).toBeVisible();
		const secret = await secretDialog.getByLabel("API key “GitHub Actions”").inputValue();
		await secretDialog.getByRole("button", { name: "Done" }).click();
		await expect(tokens.getByRole("row").filter({ hasText: "GitHub Actions" })).toContainText("In 7 days");

		// A call with the token acts as the service account, and shows in the log.
		const whoami = await context.request.get("/api/v1/account", { headers: { authorization: `Bearer ${secret}` } });
		expect(whoami.status()).toBe(200);
		const body = (await whoami.json()) as { principal: { id: string; kind: string } };
		expect(body.principal.kind).toBe("service");
		accountId = body.principal.id;
		await expect(async () => {
			await card.getByRole("button", { name: "Refresh" }).click();
			await expect(activity.getByRole("row").filter({ hasText: "account.whoami" })).toBeVisible({ timeout: 1000 });
		}).toPass();
		await expect(card.getByText("Scopes of live tokens")).toBeVisible();

		await card.getByRole("button", { name: "Revoke token GitHub Actions" }).click();
		await page.getByRole("dialog").getByRole("button", { name: "Revoke token" }).click();
		await expect(tokens.getByRole("row").filter({ hasText: "GitHub Actions" })).toContainText("Revoked");
		await expect(card.getByText("No live token. The account cannot call the API.")).toBeVisible();
		const after = await context.request.get("/api/v1/account", { headers: { authorization: `Bearer ${secret}` } });
		expect(after.status()).toBe(401);
	} finally {
		if (accountId) {
			await context.request.delete(`/api/v1/directory/principals/${accountId}`, { headers: { origin: BASE_URL } });
		}
		await context.close();
	}
});
