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

// The gear in the header of Mail opens the settings view of the open mailbox: AI, access, the default address
// and the signature. A member of a shared mailbox sets the signature that the members share, and the own address
// as the default From of the shared mailbox. The composer follows both, and its From can change the address.
test("a member sets the signature and the default address of a shared mailbox in its settings", async ({ browser }) => {
	const admin = await signIn(browser, "tomasz");
	const member = await signIn(browser, "rafael");
	const local = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	const name = unique("Orders");
	const address = `orders-${local}@example.com`;
	let mailboxId: string | null = null;
	try {
		const me = await (await member.request.get("/api/v1/account")).json();
		const { team_mailbox: mailbox } = await post<{ team_mailbox: { id: string } }>(
			admin,
			"/api/v1/directory/team-mailboxes",
			{ display_name: name, address, member_ids: [me.principal.id] },
		);
		mailboxId = mailbox.id;

		const page = await member.newPage();
		await page.goto(`/mail/team/${mailbox.id}/inbox`);
		// The gear opens the settings as a view of the mailbox, with its own path, in place of the list.
		await page.getByRole("link", { name: "Mailbox settings" }).click();
		await expect(page).toHaveURL(new RegExp(`/mail/team/${mailbox.id}/settings$`));
		const view = page.getByRole("main");
		await expect(view.getByRole("heading", { level: 1, name: `${name}: Settings` })).toBeVisible();
		await expect(view.getByText(`The settings of ${name} (${address}).`)).toBeVisible();
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await expect(view.getByRole("checkbox", { name: /Use AI in this mailbox/ })).toBeVisible();

		// A member who is not an owner or an admin sees who can use the mailbox, and cannot change it.
		const access = view.getByRole("region", { name: "Access" });
		await expect(access.getByText("An owner or an admin adds and removes members")).toBeVisible();
		await expect(access.getByText("Rafael Ortega")).toBeVisible();
		await expect(access.getByText("Can read, change and send")).toBeVisible();
		await expect(access.getByRole("button", { name: "Add member" })).toHaveCount(0);

		// The signature saves for the mailbox. Line breaks stay.
		const signature = view.getByRole("textbox", { name: "Signature" });
		await signature.fill(`The ${name} team\nexample.com/orders`);
		await view.getByRole("button", { name: "Save signature" }).click();
		await expect(page.getByText("Signature saved.")).toBeVisible();
		await expect(view.getByRole("button", { name: "Save signature" })).toBeDisabled();

		// The default address of a mailbox is a setting of the person. At first it is the address of the mailbox.
		const defaultAddress = view.getByRole("combobox", { name: "Default address" });
		await expect(defaultAddress).toHaveText(new RegExp(`${name}.*${address}`));
		await expect(view.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
		await defaultAddress.click();
		await page.getByRole("option", { name: /Rafael Ortega/ }).click();
		await view.getByRole("button", { name: "Save", exact: true }).click();
		await expect(page.getByText(`A new message in ${name} comes from ${me.principal.address}.`)).toBeVisible();
		// A reload keeps the view, because it has its own path.
		await page.reload();
		await expect(page.getByRole("main").getByRole("combobox", { name: "Default address" })).toHaveText(/Rafael Ortega/);
		await page.getByRole("link", { name: "Back to the inbox" }).click();
		await expect(page).toHaveURL(new RegExp(`/mail/team/${mailbox.id}/inbox$`));

		// A new message in the shared mailbox comes from the own address, without the signature of the mailbox.
		await page.getByRole("button", { name: "Compose" }).click();
		const composer = page.getByRole("dialog", { name: "New message" });
		const from = composer.getByRole("combobox", { name: "From:" });
		await expect(from).toHaveText(/Rafael Ortega/);
		await expect(composer.getByText(`The ${name} team`)).toHaveCount(0);
		// The From lists each address that the person can send from. The shared mailbox brings its signature,
		// after two empty lines.
		await from.click();
		await page.getByRole("option", { name: new RegExp(address) }).click();
		await expect(from).toHaveText(new RegExp(`${name}.*${address}`));
		await expect(composer.getByText(`The ${name} team`)).toBeVisible();
		await expect(composer.getByText("example.com/orders")).toBeVisible();
		// Only the signature is not a change, so the composer closes without a question.
		await composer.getByRole("button", { name: "Close" }).first().click();
		await expect(composer).toHaveCount(0);

		// A reply comes from the mailbox of its conversation, so its From is text and not a list.
		const subject = unique("Order question");
		await post(admin, "/api/v1/mail/messages", { to: [address], subject, text: "Where is my order?" });
		await expect(async () => {
			await page.reload();
			await page.getByRole("link", { name: new RegExp(subject) }).click({ timeout: 2_000 });
		}).toPass();
		await page.getByRole("button", { name: "Reply", exact: true }).first().click();
		const reply = page.getByRole("dialog", { name: "Reply" });
		await expect(reply.getByText(`${name} <${address}>`)).toBeVisible();
		await expect(reply.getByRole("combobox", { name: "From:" })).toHaveCount(0);
		await reply.getByRole("button", { name: "Close" }).first().click();
		await expect(reply).toHaveCount(0);

		// The settings are on the server: another member reads the same signature, and the default is the person's.
		const settings = await (await member.request.get(`/api/v1/mail/mailbox-settings?mailbox_id=${mailbox.id}`)).json();
		expect(settings).toMatchObject({ mailbox_id: mailbox.id, signature: `The ${name} team\nexample.com/orders` });
		const mine = await (await member.request.get("/api/v1/mail/settings")).json();
		expect(mine.default_from[mailbox.id]).toBe(me.principal.id);
	} finally {
		// The setting goes, so the settings of this person do not grow with each run.
		if (mailboxId) {
			await member.request.post("/api/v1/mail/settings", {
				headers: JSON_HEADERS,
				data: { default_from: { mailbox_id: mailboxId, from_mailbox_id: null } },
			});
		}
		await admin.close();
		await member.close();
	}
});

// A member who can only read a shared mailbox sees its settings and cannot change them. The server refuses
// the change too, so the view must not offer it.
test("a member without the change right sees the settings of a shared mailbox read only", async ({ browser }) => {
	const admin = await signIn(browser, "tomasz");
	const member = await signIn(browser, "nadia");
	const local = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	const name = unique("Returns");
	try {
		const me = await (await member.request.get("/api/v1/account")).json();
		const { team_mailbox: mailbox } = await post<{ team_mailbox: { id: string } }>(
			admin,
			"/api/v1/directory/team-mailboxes",
			{ display_name: name, address: `returns-${local}@example.com` },
		);
		await post(admin, `/api/v1/directory/team-mailboxes/${mailbox.id}/members`, {
			principal_id: me.principal.id,
			scopes: ["mail.read"],
		});

		const page = await member.newPage();
		await page.goto(`/mail/team/${mailbox.id}/settings`);
		const view = page.getByRole("main");
		await expect(view.getByRole("heading", { level: 1, name: `${name}: Settings` })).toBeVisible();
		await expect(view.getByRole("checkbox", { name: /Use AI in this mailbox/ })).toBeDisabled();
		await expect(view.getByText("Your membership does not let you change this mailbox.")).toBeVisible();
		const signature = view.getByRole("textbox", { name: "Signature" });
		await expect(signature).toHaveAttribute("readonly", "");
		await expect(signature).toHaveAttribute("placeholder", "No signature");
		await expect(view.getByRole("button", { name: "Save signature" })).toHaveCount(0);
		// The member cannot send from the mailbox, so it has no default address.
		await expect(view.getByText("Your membership does not let you send from this mailbox")).toBeVisible();
	} finally {
		await admin.close();
		await member.close();
	}
});
