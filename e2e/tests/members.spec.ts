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

// An admin creates a person and an agent in Admin › Members. A person gets no API key. An agent gets a first
// key, which shows once. The form has no scopes: each mailbox, room and drive decides what the agent can do. The
// page of the agent shows that access read only, with a link to the place where a person changes it, and a
// membership works at once with the key from before. The page of the person shows the access of the person too.
test("an admin creates a person with no API key, and an agent with a first key, and reads the access of each", async ({
	browser,
}) => {
	const context = await signIn(browser, "tomasz");
	const ids: string[] = [];
	let mailboxId: string | null = null;
	const local = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	try {
		const page = await context.newPage();
		await page.goto("/admin/members");
		const dialog = page.getByRole("dialog", { name: "New member" });

		const person = unique("Cooper Wray");
		await page.getByRole("button", { name: "New member" }).click();
		await dialog.getByLabel("Display name").fill(person);
		await dialog.getByLabel("Address", { exact: true }).fill(`cooper-${local}`);
		// The domain is a list of the saved domains, not free text. It starts on the domain of the admin.
		await expect(dialog.getByRole("combobox", { name: "Email domain" })).toHaveText("example.com");
		await dialog.getByLabel("First password").fill("cooper local password");
		ids.push(await submit(page, "Create person"));
		await expect(dialog).toBeHidden();
		await expect(page.getByText(`${person} is ready. Give the first password to the person.`)).toBeVisible();
		await expect(page.getByRole("dialog")).toHaveCount(0);

		const agent = unique("Helper");
		await page.getByRole("button", { name: "New member" }).click();
		await dialog.getByLabel("Agent").check();
		await dialog.getByLabel("Display name").fill(agent);
		await dialog.getByLabel("Address", { exact: true }).fill(`helper-${local}`);
		// The form has no scope editor.
		await expect(dialog.getByRole("checkbox")).toHaveCount(0);
		const agentId = await submit(page, "Create agent");
		ids.push(agentId);
		const keyDialog = page.getByRole("dialog", { name: `${agent} is ready` });
		const secret = await keyDialog.getByLabel("API key “First key”").inputValue();
		expect(secret).toMatch(/^sdk_/);
		await keyDialog.getByRole("button", { name: "Done" }).click();
		const bearer = { authorization: `Bearer ${secret}` };

		// An admin gives the agent Read and Send in a shared mailbox. The key from before sends from it at once.
		const created = await context.request.post("/api/v1/directory/team-mailboxes", {
			headers: { origin: BASE_URL },
			data: { display_name: unique("Support"), address: `support-${local}@example.com` },
		});
		expect(created.ok(), await created.text()).toBe(true);
		const mailbox = ((await created.json()) as { team_mailbox: { id: string; display_name: string } }).team_mailbox;
		mailboxId = mailbox.id;
		const send = () =>
			context.request.post("/api/v1/mail/messages", {
				headers: bearer,
				data: { mailbox_id: mailbox.id, to: ["tomasz@example.com"], subject: "Hello", text: "Hi" },
			});
		expect((await send()).status()).toBe(403);
		const granted = await context.request.post(`/api/v1/directory/team-mailboxes/${mailbox.id}/members`, {
			headers: { origin: BASE_URL },
			data: { principal_id: agentId, scopes: ["mail.read", "mail.send"] },
		});
		expect(granted.ok(), await granted.text()).toBe(true);
		expect((await send()).status()).toBe(200);

		// The row of the agent opens the page of the agent, on its own path. The Access part shows the mailbox and
		// what the agent can do there, with a link to the place where an admin changes it. No permissions editor.
		await page.getByRole("button", { name: /^Agents/ }).click();
		await page.getByRole("link", { name: new RegExp(`^${agent}`) }).click();
		await expect(page).toHaveURL(new RegExp(`/admin/members/${agentId}$`));
		const member = page.getByRole("main");
		await expect(member.getByRole("heading", { level: 1, name: agent })).toBeVisible();
		await expect(member.getByRole("button", { name: "Save permissions" })).toHaveCount(0);
		const access = member.getByRole("region", { name: "Access" });
		const row = access.getByRole("listitem").filter({ hasText: mailbox.display_name });
		await expect(row).toContainText("Can read and send");
		await expect(row.getByRole("link", { name: new RegExp(mailbox.display_name) })).toHaveAttribute(
			"href",
			"/admin/shared-mailboxes",
		);

		// The end of the membership ends the access at once, with the same key.
		const removed = await context.request.delete(`/api/v1/directory/team-mailboxes/${mailbox.id}/members/${agentId}`, {
			headers: { origin: BASE_URL },
		});
		expect(removed.ok(), await removed.text()).toBe(true);
		expect((await send()).status()).toBe(403);

		// Back gives the same list: the filter stays, and the row of the agent gets the focus.
		await page.getByRole("link", { name: "Back to Members" }).click();
		await expect(page).toHaveURL(/\/admin\/members$/);
		await expect(page.getByRole("button", { name: /^Agents/ })).toHaveAttribute("aria-pressed", "true");
		await expect(page.getByRole("link", { name: new RegExp(`^${agent}`) })).toBeFocused();

		// An admin also reads the access of a person. A person has no account scopes and no key list there.
		const personId = ids[0];
		const shared = await context.request.post(`/api/v1/directory/team-mailboxes/${mailbox.id}/members`, {
			headers: { origin: BASE_URL },
			data: { principal_id: personId, scopes: ["mail.read"] },
		});
		expect(shared.ok(), await shared.text()).toBe(true);
		await page.goto(`/admin/members/${personId}`);
		const personAccess = page.getByRole("main").getByRole("region", { name: "Access" });
		await expect(personAccess.getByRole("listitem").filter({ hasText: mailbox.display_name })).toContainText(
			"Can read",
		);
		await expect(personAccess).toContainText("The person can do each thing in their own mailbox and drive.");
		await expect(personAccess.getByText("Live API keys")).toHaveCount(0);
	} finally {
		if (mailboxId) {
			for (const id of ids) {
				await context.request.delete(`/api/v1/directory/team-mailboxes/${mailboxId}/members/${id}`, {
					headers: { origin: BASE_URL },
				});
			}
		}
		// The agent first: a person who sponsors no agent can be deleted.
		for (const id of ids.reverse()) {
			await context.request.delete(`/api/v1/directory/principals/${id}`, { headers: { origin: BASE_URL } });
		}
		await context.close();
	}
});
