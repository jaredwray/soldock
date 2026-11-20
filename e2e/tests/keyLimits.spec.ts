import { expect, test } from "@playwright/test";
import { createRoom, signIn, unique } from "../support/chat.ts";

// A person makes an API key in Settings that works only in one room and on one kind of mail. The key
// then has exactly these limits on the REST API: the form and the server agree on the limits.
test("a key from Settings with a Chat limit and a Mail search works only in its limits", async ({
	browser,
	request,
}) => {
	const nadia = await signIn(browser, "nadia");
	const inside = unique("limit-in");
	const insideId = await createRoom(nadia, inside);
	const outsideId = await createRoom(nadia, unique("limit-out"));
	const page = await nadia.newPage();
	await page.goto("/settings");

	const keys = page.getByRole("region", { name: "Your API keys" });
	const label = unique("Limited key");
	await keys.getByLabel("New key label").fill(label);
	const limits = keys.getByRole("group", { name: "Resource limits" });
	await limits.getByRole("checkbox", { name: /^Chat/ }).check();
	await limits.getByRole("checkbox", { name: `#${inside}` }).check();
	await limits.getByRole("checkbox", { name: /^Mail/ }).check();
	await limits.getByLabel("Only the mail that this search finds").fill("label:invoices");
	// A key with a limit cannot hold the scopes that make a credential without limits.
	await expect(keys.getByRole("checkbox", { name: /^account\.keys/ })).toBeDisabled();
	await keys.getByRole("button", { name: "Create key" }).click();

	const dialog = page.getByRole("dialog", { name: "Copy the new API key" });
	await expect(dialog).toContainText("Limit for Chat: 1 room");
	const secret = await dialog.getByLabel(`API key “${label}”`).inputValue();
	expect(secret).toMatch(/^sdl_/);
	await dialog.getByRole("button", { name: "Done" }).click();
	const row = keys.getByRole("row").filter({ hasText: label });
	await expect(row).toContainText("Limit for Mail: search label:invoices");
	await expect(row).toContainText("Limit for Chat: 1 room");

	const headers = { authorization: `Bearer ${secret}` };
	const whoami = (await (await request.get("/api/v1/account", { headers })).json()) as { limits: unknown };
	expect(whoami.limits).toEqual({ mail: { query: "label:invoices" }, chat: { room_ids: [insideId] } });
	expect((await request.get(`/api/v1/chat/rooms/${insideId}/messages`, { headers })).status()).toBe(200);
	expect((await request.get(`/api/v1/chat/rooms/${outsideId}/messages`, { headers })).status()).toBe(404);
	await nadia.close();
});
