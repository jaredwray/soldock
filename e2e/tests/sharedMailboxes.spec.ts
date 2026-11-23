import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { signIn, unique } from "../support/chat.ts";
import { BASE_URL } from "../support/server.ts";

const JSON_HEADERS = { origin: BASE_URL, "content-type": "application/json" };

/** Calls a POST operation with the session of the context, and returns its result. */
async function post<T>(context: BrowserContext, path: string, data: unknown): Promise<T> {
	const response = await context.request.post(path, { headers: JSON_HEADERS, data });
	expect(response.ok(), `POST ${path}: ${response.status()} ${await response.text()}`).toBe(true);
	return (await response.json()) as T;
}

/** Selects a person or an agent in **Add a member** of the open card. */
async function selectCandidate(page: Page, card: ReturnType<Page["locator"]>, name: string): Promise<void> {
	await card.getByRole("combobox", { name: "Add a member" }).click();
	await page.getByRole("option", { name: new RegExp(`^${name}`) }).click();
}

// An owner or an admin decides what each member can do in a shared mailbox, in the settings of the mailbox.
// The rule is the same for a person and an agent. An agent gets its scopes with the membership, so nobody
// opens Admin › Members for a second change. The mail views of a person show only what the person can do.
test("an admin sets what a person and an agent can do in a shared mailbox, and the mail views of the person follow", async ({
	browser,
}) => {
	const admin = await signIn(browser, "tomasz");
	const nadia = await signIn(browser, "nadia");
	const local = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	const name = unique("Orders");
	const agentName = unique("Sorter");
	let agentId: string | null = null;
	try {
		// A new agent holds only account.read, and it has the limits of a new agent.
		const { principal: agent } = await post<{ principal: { id: string } }>(admin, "/api/v1/directory/principals", {
			kind: "agent",
			display_name: agentName,
			address: `sorter-${local}@example.com`,
			scopes: ["account.read"],
		});
		agentId = agent.id;
		const { team_mailbox: mailbox } = await post<{ team_mailbox: { id: string } }>(
			admin,
			"/api/v1/directory/team-mailboxes",
			{ display_name: name, address: `orders-${local}@example.com` },
		);

		const page = await admin.newPage();
		await page.goto("/admin/shared-mailboxes");
		const card = page.locator("details.admin-card").filter({ hasText: name });
		await card.locator("summary").click();
		const fresh = card.getByRole("group", { name: "The new member can" });
		for (const scope of ["Read", "Change", "Send"]) await expect(fresh.getByLabel(scope)).toBeChecked();

		// The admin adds Nadia, who can read and change the mailbox, but cannot send from it.
		await selectCandidate(page, card, "Nadia");
		await fresh.getByLabel("Send").uncheck();
		await card.getByRole("button", { name: "Add member" }).click();
		await expect(page.getByText(`can now read and change in ${name}.`)).toBeVisible();
		const nadiaCan = card.getByRole("group", { name: new RegExp(`^What Nadia .* can do in ${name}$`) });
		await expect(nadiaCan.getByLabel("Read")).toBeChecked();
		await expect(nadiaCan.getByLabel("Change")).toBeChecked();
		await expect(nadiaCan.getByLabel("Send")).not.toBeChecked();
		// The form goes back to each scope for the next member.
		await expect(fresh.getByLabel("Send")).toBeChecked();

		// The admin adds the agent with each scope. The agent gets the scopes on its account, and the mailbox
		// in its limits.
		await selectCandidate(page, card, agentName);
		await card.getByRole("button", { name: "Add member" }).click();
		await expect(
			page.getByText(`${agentName} now also holds mail.read, mail.modify, mail.send.`, { exact: false }),
		).toBeVisible();
		const access = await admin.request.get(`/api/v1/directory/agents/${agent.id}/access`);
		expect(await access.json()).toMatchObject({
			scopes: ["account.read", "mail.read", "mail.modify", "mail.send"],
			resources: { mailbox_ids: [agent.id, mailbox.id] },
			team_mailboxes: [{ id: mailbox.id, scopes: ["mail.read", "mail.modify", "mail.send"] }],
		});

		// Nadia sees the mailbox with no Compose button, and a notice says why.
		const mail = await nadia.newPage();
		await mail.goto(`/mail/team/${mailbox.id}/inbox`);
		await expect(mail.getByText("You can read and change this shared mailbox. You cannot send from it.")).toBeVisible();
		await expect(mail.getByRole("button", { name: "Compose" })).toHaveCount(0);
		await expect(mail.getByRole("button", { name: "New label" })).toBeVisible();

		// The admin clears Change. The last check box of a member is off: Remove takes the access away.
		// A click, not `uncheck`: the check box shows the saved scopes, so it changes after the answer of the server.
		await nadiaCan.getByLabel("Change").click();
		await expect(page.getByText(`can now read in ${name}.`)).toBeVisible();
		await expect(nadiaCan.getByLabel("Change")).not.toBeChecked();
		await expect(nadiaCan.getByLabel("Read")).toBeDisabled();
		await mail.reload();
		await expect(mail.getByText("You cannot change it or send from it", { exact: false })).toBeVisible();
		await expect(mail.getByRole("button", { name: "New label" })).toHaveCount(0);
		// The server refuses the send too, not only the page.
		const refused = await nadia.request.post("/api/v1/mail/messages", {
			headers: JSON_HEADERS,
			data: { mailbox_id: mailbox.id, to: ["tomasz@example.com"], text: "Hi" },
		});
		expect(refused.status()).toBe(403);
	} finally {
		if (agentId) {
			await admin.request.delete(`/api/v1/directory/principals/${agentId}`, { headers: { origin: BASE_URL } });
		}
		await admin.close();
		await nadia.close();
	}
});
