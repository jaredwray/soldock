import { expect, test } from "@playwright/test";
import { signIn, unique } from "../support/chat.ts";
import { BASE_URL } from "../support/server.ts";

// An admin makes a service account with scopes in Admin › Members, gives it a token with a lifetime, sees
// the call of the token in the activity log, changes the permissions of the account, and revokes the token.
test("an admin creates a service account with scopes and a 7-day token, sees its activity, rotates it, changes its permissions and revokes it", async ({
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
		await dialog.getByLabel("Address", { exact: true }).fill(`${local}@example.com`);
		await dialog.getByLabel("Description").fill("Posts build results");
		// The account starts with account.read. The admin adds a scope: the scopes are on the account.
		await expect(dialog.getByRole("checkbox", { name: /^account\.read/ })).toBeChecked();
		await dialog.getByRole("checkbox", { name: /^mail\.read/ }).check();
		await dialog.getByRole("button", { name: "Create service account" }).click();
		await expect(dialog).toBeHidden();

		await page.getByRole("button", { name: /^Service accounts/ }).click();
		await page.getByRole("link", { name: new RegExp(`^${name}`) }).click();
		const member = page.getByRole("main");
		await expect(member.getByLabel("Description", { exact: true })).toHaveValue("Posts build results");
		await expect(member.getByText("by Tomasz Wieczorek").first()).toBeVisible();
		const tokens = member.getByRole("table", { name: /^Tokens of/ });
		const activity = member.getByRole("table", { name: /^Activity of/ });

		// The Permissions part shows the scopes of the account. The token form has no scopes.
		await expect(member.getByRole("checkbox", { name: /^mail\.read/ })).toBeChecked();
		await expect(member.getByRole("checkbox", { name: /^chat\.read/ })).not.toBeChecked();
		// The form selects 90 days first. Choose 7 days.
		await member.getByLabel("New token label").fill("GitHub Actions");
		await member.getByRole("combobox", { name: "Expires" }).click();
		await page.getByRole("option", { name: "7 days" }).click();
		await member.getByRole("button", { name: "Create token" }).click();
		const secretDialog = page.getByRole("dialog", { name: "Copy the new token" });
		await expect(secretDialog.getByText("Expires: In 7 days")).toBeVisible();
		const secret = await secretDialog.getByLabel("API key “GitHub Actions”").inputValue();
		await secretDialog.getByRole("button", { name: "Done" }).click();
		await expect(tokens.getByRole("row").filter({ hasText: "GitHub Actions" })).toContainText("In 7 days");

		// A call with the token acts as the service account, and shows in the log.
		const whoami = await context.request.get("/api/v1/account", { headers: { authorization: `Bearer ${secret}` } });
		expect(whoami.status()).toBe(200);
		const body = (await whoami.json()) as { principal: { id: string; kind: string }; scopes: string[] };
		expect(body.principal.kind).toBe("service");
		// The token has the scopes of the account.
		expect(body.scopes).toEqual(["account.read", "mail.read"]);
		accountId = body.principal.id;
		await expect(async () => {
			await member.getByRole("button", { name: "Refresh" }).click();
			await expect(activity.getByRole("row").filter({ hasText: "account.whoami" })).toBeVisible({ timeout: 1000 });
		}).toPass();
		await expect(member.getByText("Live tokens")).toBeVisible();

		// A rotation gives a new secret. The old one works for the overlap, until somebody stops it.
		await member.getByRole("button", { name: "Rotate token GitHub Actions" }).click();
		await page.getByRole("dialog").getByRole("button", { name: "Rotate" }).click();
		const rotatedDialog = page.getByRole("dialog", { name: "Copy the new secret of the token" });
		await expect(rotatedDialog.getByText(/The old secret works until/)).toBeVisible();
		const rotated = await rotatedDialog.getByLabel("API key “GitHub Actions”").inputValue();
		await rotatedDialog.getByRole("button", { name: "Done" }).click();
		await expect(tokens.getByRole("row").filter({ hasText: "GitHub Actions" })).toContainText("Old secret works until");
		const both = await Promise.all(
			[secret, rotated].map((value) =>
				context.request.get("/api/v1/account", { headers: { authorization: `Bearer ${value}` } }),
			),
		);
		expect(both.map((response) => response.status())).toEqual([200, 200]);
		await member.getByRole("button", { name: "Stop the old secret of token GitHub Actions now" }).click();
		await expect(tokens.getByRole("row").filter({ hasText: "GitHub Actions" })).not.toContainText("Old secret works");
		const old = await context.request.get("/api/v1/account", { headers: { authorization: `Bearer ${secret}` } });
		expect(old.status()).toBe(401);

		// A change of the permissions applies to the token at once, without a new secret.
		await member.getByRole("checkbox", { name: /^chat\.read/ }).check();
		await member.getByRole("button", { name: "Save permissions" }).click();
		await expect(page.getByText(`Permissions of ${name} saved.`)).toBeVisible();
		const changed = await context.request.get("/api/v1/account", { headers: { authorization: `Bearer ${rotated}` } });
		expect(await changed.json()).toMatchObject({ scopes: ["account.read", "mail.read", "chat.read"] });

		await member.getByRole("button", { name: "Revoke token GitHub Actions" }).click();
		await page.getByRole("dialog").getByRole("button", { name: "Revoke token" }).click();
		await expect(tokens.getByRole("row").filter({ hasText: "GitHub Actions" })).toContainText("Revoked");
		const after = await context.request.get("/api/v1/account", { headers: { authorization: `Bearer ${rotated}` } });
		expect(after.status()).toBe(401);
	} finally {
		if (accountId) {
			await context.request.delete(`/api/v1/directory/principals/${accountId}`, { headers: { origin: BASE_URL } });
		}
		await context.close();
	}
});
