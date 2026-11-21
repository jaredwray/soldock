import { type BrowserContext, expect, type Page, type Route } from "@playwright/test";
import { test } from "../support/chatDevices.ts";

async function principal(device: BrowserContext): Promise<{ id: string; display_name: string }> {
	const response = await device.request.get("/api/v1/account");
	expect(response.ok()).toBe(true);
	return (await response.json()).principal;
}

async function saveLocalDraft(page: Page, id: string, text: string): Promise<string> {
	const key = `soldock:chat-drafts:${id}`;
	await page.evaluate(
		({ key, text }) => {
			localStorage.setItem(key, JSON.stringify({ rm_local: { text, at: Date.now() } }));
		},
		{ key, text },
	);
	return key;
}

test("a login that replaces the cookie during the discard prompt keeps its session and local drafts", async ({
	device,
}) => {
	const original = await device("nadia");
	const replacement = await device("rafael");
	const [first, next] = await Promise.all([principal(original), principal(replacement)]);
	const page = await original.newPage();
	await page.goto("/settings");
	const signOut = page.getByRole("button", { name: "Sign out", exact: true });
	await expect(signOut).toBeVisible();
	await saveLocalDraft(page, first.id, "Unsaved draft");
	const key = await saveLocalDraft(page, next.id, "Rafael's private draft");
	await page.route("**/draft", (route) => route.abort());

	// A suspended tab may miss the other login's storage event while its native dialog is open.
	page.once("dialog", async (dialog) => {
		await original.addCookies(await replacement.cookies());
		await dialog.accept();
	});
	const response = page.waitForResponse((r) => r.url().endsWith("/auth/sign-out"));
	await signOut.click();
	expect((await response).status()).toBe(409);
	await expect(page.getByRole("button", { name: `Account: ${next.display_name}` })).toBeVisible();
	expect(await principal(original)).toEqual(next);
	expect(await page.evaluate((key) => localStorage.getItem(key), key)).toContain("Rafael's private draft");
});

test("a late response for the old session preserves a login made while sign-out was in flight", async ({ device }) => {
	const original = await device("nadia");
	const replacement = await device("rafael");
	const next = await principal(replacement);
	const page = await original.newPage();
	// Hold a Settings request from the old session until the Worker has revoked its cookie.
	const pendingKeys = Promise.withResolvers<Route>();
	await page.route("**/api/v1/account/api-keys", (route) => pendingKeys.resolve(route), { times: 1 });
	await page.goto("/settings");
	const signOut = page.getByRole("button", { name: "Sign out", exact: true });
	await expect(signOut).toBeVisible();
	const key = await saveLocalDraft(page, next.id, "Keep this draft");
	const earlier = await pendingKeys.promise;
	const lateUnauthorized = Promise.withResolvers<void>();
	await page.route("**/auth/sign-out", async (route) => {
		const result = await route.fetch();
		expect(result.status()).toBe(204);
		const refused = await earlier.fetch();
		expect(refused.status()).toBe(401);
		await original.addCookies(await replacement.cookies());
		await route.fulfill({ response: result });
		const account = page.getByRole("button", { name: `Account: ${next.display_name}` });
		// The replacement session is already on screen when the old response reaches the app.
		await expect(account).toBeVisible();
		await earlier.fulfill({ response: refused });
		lateUnauthorized.resolve();
	});
	await signOut.click();
	await lateUnauthorized.promise;
	await page.getByRole("button", { name: `Account: ${next.display_name}` }).click();
	await expect(page.getByRole("link", { name: "Profile and status" })).toBeVisible();
	expect(await principal(original)).toEqual(next);
	expect(await page.evaluate((key) => localStorage.getItem(key), key)).toContain("Keep this draft");
});

test("a stale tab cannot sign out a newer login for the same person without a storage event", async ({ device }) => {
	const stale = await device("nadia");
	const replacement = await device("nadia");
	const who = await principal(stale);
	const page = await stale.newPage();
	await page.goto("/settings");
	const signOut = page.getByRole("button", { name: "Sign out", exact: true });
	await expect(signOut).toBeVisible();
	await saveLocalDraft(page, who.id, "Recover this draft");
	await page.route("**/draft", (route) => route.abort());
	page.once("dialog", async (dialog) => {
		// This replaces the browser cookie without notifying the suspended page.
		await stale.addCookies(await replacement.cookies());
		await dialog.accept();
	});
	const reply = page.waitForResponse((r) => r.url().endsWith("/auth/sign-out"));
	await signOut.click();
	expect((await reply).status()).toBe(409);
	await expect(page.getByRole("button", { name: `Account: ${who.display_name}` })).toBeVisible();
	expect(await principal(replacement)).toEqual(who);
	expect(await page.evaluate((id) => localStorage.getItem(`soldock:chat-drafts:${id}`), who.id)).toContain(
		"Recover this draft",
	);

	// Once the UI has reconciled the replacement login, a new click can sign out that session.
	page.once("dialog", (dialog) => dialog.accept());
	await signOut.click();
	await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
	expect((await replacement.request.get("/api/v1/account")).status()).toBe(401);
});
