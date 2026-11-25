import { type BrowserContext, expect, test } from "@playwright/test";
import { signIn, unique } from "../support/chat.ts";
import { BASE_URL } from "../support/server.ts";

const JSON_HEADERS = { origin: BASE_URL, "content-type": "application/json" };

/** Calls a POST operation with the session of the context, and returns its result. */
async function post<T>(context: BrowserContext, path: string, data: unknown): Promise<T> {
	const response = await context.request.post(path, { headers: JSON_HEADERS, data });
	expect(response.ok(), `POST ${path}: ${response.status()} ${await response.text()}`).toBe(true);
	return (await response.json()) as T;
}

/** Delivers one message from outside through the local inbound endpoint of wrangler dev. */
async function receive(context: BrowserContext, from: string, to: string, subject: string): Promise<void> {
	const raw = [
		`From: ${from}`,
		`To: ${to}`,
		`Subject: ${subject}`,
		`Date: ${new Date().toUTCString()}`,
		`Message-ID: <${Date.now().toString(36)}${Math.random().toString(36).slice(2)}@outside.example>`,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"Hello from outside.",
		"",
	].join("\r\n");
	const query = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
	const response = await context.request.post(`/cdn-cgi/local/email?${query}`, { data: raw });
	expect(response.ok(), `inbound mail: ${response.status()} ${await response.text()}`).toBe(true);
}

// The Screener of a shared mailbox. The default of the organization is for each mailbox, so this test turns
// the Screener on in its own shared mailbox only, and the other tests that run at the same time get no change.
test("a member screens a new sender in, a second sender out, and brings the second back from the history", async ({
	browser,
}) => {
	const admin = await signIn(browser, "tomasz");
	const member = await signIn(browser, "rafael");
	const local = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	const name = unique("Leads");
	const address = `leads-${local}@example.com`;
	const welcome = unique("Welcome");
	const pitch = unique("Pitch");
	try {
		// Admin › Mail has the default of the organization.
		const adminPage = await admin.newPage();
		await adminPage.goto("/admin/mail");
		await expect(adminPage.getByRole("checkbox", { name: /Use the Screener in each mailbox/ })).toBeVisible();

		const me = await (await member.request.get("/api/v1/account")).json();
		const { team_mailbox: mailbox } = await post<{ team_mailbox: { id: string } }>(
			admin,
			"/api/v1/directory/team-mailboxes",
			{ display_name: name, address, member_ids: [me.principal.id] },
		);

		// The member turns the Screener on in the settings of the shared mailbox.
		const page = await member.newPage();
		await page.goto(`/mail/team/${mailbox.id}/settings`);
		const screener = page.getByRole("main").getByRole("combobox", { name: "Screener" });
		await expect(screener).toHaveText(/Use the default of the organization/);
		await screener.click();
		await page.getByRole("option", { name: "On", exact: true }).click();
		await expect(page.getByText("The Screener is on in this mailbox.")).toBeVisible();

		await receive(member, `New Customer <customer-${local}@outside.example>`, address, welcome);
		await receive(member, `pitch-${local}@outside.example`, address, pitch);

		// The sidebar shows the senders that wait. The inbox does not show their mail.
		await page.goto(`/mail/team/${mailbox.id}/inbox`);
		const item = page.getByRole("link", { name: /^Screener/ });
		await expect(async () => {
			await page.reload();
			await expect(item).toContainText("2", { timeout: 1000 });
		}).toPass({ timeout: 30_000 });
		await expect(page.getByText(welcome)).toHaveCount(0);

		await item.click();
		await expect(page).toHaveURL(new RegExp(`/mail/team/${mailbox.id}/screener$`));
		const view = page.getByRole("main");
		await expect(view.getByRole("heading", { level: 1, name: `${name}: Screener` })).toBeVisible();
		await view.getByRole("button", { name: `Screen in New Customer <customer-${local}@outside.example>` }).click();
		await expect(page.getByText(`Mail from customer-${local}@outside.example now comes to the inbox.`)).toBeVisible();
		await view.getByRole("button", { name: `Screen out pitch-${local}@outside.example` }).click();
		await expect(page.getByText("The sender is not told.")).toBeVisible();
		await expect(view.getByText("No sender waits.")).toBeVisible();

		// The history lists the sender that the member screened out, and brings the sender back.
		await view.getByRole("link", { name: "History" }).click();
		await expect(page).toHaveURL(new RegExp(`/mail/team/${mailbox.id}/screener/history$`));
		await expect(view.getByText(`pitch-${local}@outside.example`)).toBeVisible();
		await view.getByRole("button", { name: `Screen in pitch-${local}@outside.example` }).click();
		await expect(view.getByText("You screened out no sender.")).toBeVisible();

		// Both messages are in the inbox now.
		await page.getByRole("link", { name: "Back to the inbox" }).click();
		await expect(page.getByText(welcome)).toBeVisible();
		await expect(page.getByText(pitch)).toBeVisible();
	} finally {
		await admin.close();
		await member.close();
	}
});
