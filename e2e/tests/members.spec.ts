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

// An admin creates a person and an agent in Admin › Members. A person gets no API key. An agent gets its
// scopes and a first key, which shows once. The key has the scopes of the agent, and a change of the
// permissions on the agent card applies to the key at once.
test("an admin creates a person with no API key, and an agent with scopes and a first key, and changes the permissions of the agent", async ({
	browser,
}) => {
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
		// The agent starts with account.read. The admin adds a scope: the scopes are on the agent, not on a key.
		await expect(dialog.getByRole("checkbox", { name: /^account\.read/ })).toBeChecked();
		await expect(dialog.getByRole("checkbox", { name: /^chat\.read/ })).not.toBeChecked();
		await dialog.getByRole("checkbox", { name: /^mail\.read/ }).check();
		// A new agent is limited to its own mailbox and its own drive, unless the admin clears the limit.
		await expect(dialog.getByLabel("Limit this agent to its own mailbox and its own drive")).toBeChecked();
		const agentId = await submit(page, "Create agent");
		ids.push(agentId);
		const keyDialog = page.getByRole("dialog", { name: `${agent} is ready` });
		const secret = await keyDialog.getByLabel("API key “First key”").inputValue();
		expect(secret).toMatch(/^sdk_/);
		await keyDialog.getByRole("button", { name: "Done" }).click();
		const scopesOfKey = async () => {
			const response = await context.request.get("/api/v1/account", { headers: { authorization: `Bearer ${secret}` } });
			expect(response.status()).toBe(200);
			return (await response.json()) as { scopes: string[]; resources: unknown };
		};
		const first = await scopesOfKey();
		expect(first.scopes.sort()).toEqual(["account.read", "mail.read"]);
		expect(first.resources).toEqual({ mailbox_ids: [agentId], drive_ids: [agentId], room_ids: [] });

		// The Permissions part of the agent card changes the scopes and the limits of the agent. The first key
		// gets them at its next call, without a new secret.
		await page.getByRole("button", { name: /^Agents/ }).click();
		const card = page.locator("details.admin-card").filter({ hasText: agent });
		await card.locator("summary").click();
		await expect(card.getByRole("checkbox", { name: /^mail\.read/ })).toBeChecked();
		await card.getByRole("checkbox", { name: /^chat\.read/ }).check();
		// The form shows the limits of the new agent. The admin removes the own drive from them.
		await expect(card.getByLabel("Limit this agent to specific mailboxes, drives and rooms")).toBeChecked();
		await expect(card.getByLabel(/^Own mailbox/)).toBeChecked();
		await card.getByLabel("Own drive").uncheck();
		await card.getByRole("button", { name: "Save permissions" }).click();
		// The exact text: before the save, the limits also name the own drive.
		await expect(card.getByText(`Only: Own mailbox (helper-${local}@example.com)`, { exact: true })).toBeVisible();
		const changed = await scopesOfKey();
		expect(changed.scopes.sort()).toEqual(["account.read", "chat.read", "mail.read"]);
		expect(changed.resources).toEqual({ mailbox_ids: [agentId], drive_ids: [], room_ids: [] });
	} finally {
		// The agent first: a person who sponsors no agent can be deleted.
		for (const id of ids.reverse()) {
			await context.request.delete(`/api/v1/directory/principals/${id}`, { headers: { origin: BASE_URL } });
		}
		await context.close();
	}
});

// The limit of a new agent is the default. An admin who clears the check box gets an agent without limits.
test("an admin clears the limit in the New member dialog, and the new agent has no limits", async ({ browser }) => {
	const context = await signIn(browser, "tomasz");
	let agentId: string | null = null;
	try {
		const page = await context.newPage();
		await page.goto("/admin/members");
		const dialog = page.getByRole("dialog", { name: "New member" });
		const agent = unique("Roamer");
		await page.getByRole("button", { name: "New member" }).click();
		await dialog.getByLabel("Agent").check();
		await dialog.getByLabel("Display name").fill(agent);
		const local = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		await dialog.getByLabel("Address", { exact: true }).fill(`roamer-${local}@example.com`);
		await dialog.getByLabel("Limit this agent to its own mailbox and its own drive").uncheck();
		agentId = await submit(page, "Create agent");
		const keyDialog = page.getByRole("dialog", { name: `${agent} is ready` });
		const secret = await keyDialog.getByLabel("API key “First key”").inputValue();
		await keyDialog.getByRole("button", { name: "Done" }).click();
		const whoami = await context.request.get("/api/v1/account", { headers: { authorization: `Bearer ${secret}` } });
		expect(((await whoami.json()) as { resources: unknown }).resources).toBeNull();

		// The card shows no limit. When the admin sets the limit, the form selects what the agent reaches now,
		// so the check box alone does not stop the agent.
		await page.getByRole("button", { name: /^Agents/ }).click();
		const card = page.locator("details.admin-card").filter({ hasText: agent });
		await card.locator("summary").click();
		const limit = card.getByLabel("Limit this agent to specific mailboxes, drives and rooms");
		await expect(limit).not.toBeChecked();
		await limit.check();
		await expect(card.getByLabel(/^Own mailbox/)).toBeChecked();
		await expect(card.getByLabel("Own drive")).toBeChecked();
	} finally {
		if (agentId) {
			await context.request.delete(`/api/v1/directory/principals/${agentId}`, { headers: { origin: BASE_URL } });
		}
		await context.close();
	}
});
