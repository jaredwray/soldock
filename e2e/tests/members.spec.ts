import { expect, type Page, test } from "@playwright/test";
import { signIn, unique } from "../support/chat.ts";
import { BASE_URL } from "../support/server.ts";

/** Clicks the submit button of the New member dialog and returns the id of the new principal. */
async function submit(page: Page, button: string): Promise<string> {
	const response = page.waitForResponse(
		(r) => r.url().endsWith("/api/v1/directory/principals") && r.request().method() === "POST",
	);
	await page.getByRole("dialog", { name: "New member" }).getByRole("button", { name: button }).click();
	const created = await response;
	expect(created.ok(), await created.text()).toBe(true);
	return ((await created.json()) as { principal: { id: string } }).principal.id;
}

// An admin creates a person and an agent in Admin › Members. A person gets no API key. An agent gets a
// first key, which shows once.
test("an admin creates a person with no API key, and an agent with a first key", async ({ browser }) => {
	const context = await signIn(browser, "tomasz");
	const ids: string[] = [];
	const local = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	try {
		const page = await context.newPage();
		await page.goto("/admin/members");
		const dialog = page.getByRole("dialog", { name: "New member" });

		const person = unique("Cooper Wray");
		await page.getByRole("button", { name: "New member" }).click();
		await dialog.getByLabel("Display name").fill(person);
		await dialog.getByLabel("Address", { exact: true }).fill(`cooper-${local}@example.com`);
		await dialog.getByLabel("First password").fill("cooper local password");
		ids.push(await submit(page, "Create person"));
		await expect(dialog).toBeHidden();
		await expect(page.getByText(`${person} is ready. Give the first password to the person.`)).toBeVisible();
		await expect(page.getByRole("dialog")).toHaveCount(0);

		const agent = unique("Helper");
		await page.getByRole("button", { name: "New member" }).click();
		await dialog.getByLabel("Agent").check();
		await dialog.getByLabel("Display name").fill(agent);
		await dialog.getByLabel("Address", { exact: true }).fill(`helper-${local}@example.com`);
		ids.push(await submit(page, "Create agent"));
		const keyDialog = page.getByRole("dialog", { name: `${agent} is ready` });
		await expect(keyDialog.getByLabel("API key “First key”")).toHaveValue(/^sdk_/);
	} finally {
		// The agent first: a person who sponsors no agent can be deleted.
		for (const id of ids.reverse()) {
			await context.request.delete(`/api/v1/directory/principals/${id}`, { headers: { origin: BASE_URL } });
		}
		await context.close();
	}
});
