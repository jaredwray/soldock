import { type BrowserContext, expect, type Page } from "@playwright/test";
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
	await page.goto("/settings");
	const signOut = page.getByRole("button", { name: "Sign out", exact: true });
	await expect(signOut).toBeVisible();
	const key = await saveLocalDraft(page, next.id, "Keep this draft");
	await page.route("**/auth/sign-out", async (route) => {
		const result = await route.fetch();
		expect(result.status()).toBe(204);
		await original.addCookies(await replacement.cookies());
		await route.fulfill({ response: result });
	});
	await signOut.click();
	await expect(page.getByRole("button", { name: `Account: ${next.display_name}` })).toBeVisible();
	expect(await principal(original)).toEqual(next);
	expect(await page.evaluate((key) => localStorage.getItem(key), key)).toContain("Keep this draft");
});
