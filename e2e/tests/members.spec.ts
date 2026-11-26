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
		// The address format of Admin › Mail is on at the start, with first.last: the address follows the name.
		const address = dialog.getByLabel("Address", { exact: true });
		const auto = `cooper.${person.split(" ").at(-1)}`;
		await expect(address).toHaveValue(auto);
		await expect(dialog.getByText(`${auto}@example.com is available.`)).toHaveClass("field-ok");
		// An address that a member has gets red text with the reason.
		await address.fill("tomasz");
		await expect(dialog.getByText("That address belongs to another member or a shared mailbox.")).toHaveClass(
			"field-error",
		);
		// The address that the admin types stays when the name changes.
		await address.fill(`cooper-${local}`);
		await dialog.getByLabel("Display name").fill(`${person} Jr`);
		await expect(address).toHaveValue(`cooper-${local}`);
		await dialog.getByLabel("Display name").fill(person);
		await expect(dialog.getByText(`cooper-${local}@example.com is available.`)).toBeVisible();
		// The domain is a list of the saved domains, not free text. It starts on the domain of the admin.
		await expect(dialog.getByRole("combobox", { name: "Email domain" })).toHaveText("example.com");
		// An invite link is the default. The admin can choose the first password instead.
		await dialog.getByLabel("Set a password").check();
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
		await expect(personAccess).toContainText("The person can do each thing in the own mailbox and the own drive.");
		await expect(personAccess.getByText("Live API keys")).toHaveCount(0);
		await expect(personAccess.getByText("Shared directly in Drive")).toHaveCount(0);
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

// An admin creates a person with an invite link instead of a first password. The link shows once. A new link from
// the page of the person replaces it. The person opens the new link in a browser without a session, chooses a
// password, and is signed in. Each link then stops.
test("a new person chooses the password from an invite link, and the link works one time", async ({ browser }) => {
	const admin = await signIn(browser, "tomasz");
	const visitor = await browser.newContext();
	let personId: string | null = null;
	const local = `grace-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	const address = `${local}@example.com`;
	const password = "grace local password";
	try {
		const page = await admin.newPage();
		await page.goto("/admin/members");
		const dialog = page.getByRole("dialog", { name: "New member" });
		const person = unique("Grace Hopper");
		await page.getByRole("button", { name: "New member" }).click();
		await dialog.getByLabel("Display name").fill(person);
		await dialog.getByLabel("Address", { exact: true }).fill(local);
		await expect(dialog.getByLabel("Invite link")).toBeChecked();
		await expect(dialog.getByLabel("First password")).toHaveCount(0);
		personId = await submit(page, "Create person");
		const created = page.getByRole("dialog", { name: `${person} is ready` });
		const first = await created.getByLabel("Invite link").inputValue();
		expect(first).toMatch(/\/invite#sdi_[A-Za-z0-9_-]{43}$/);
		await created.getByRole("button", { name: "Done" }).click();

		// A new link from Reset sign-in replaces the first one.
		await page.goto(`/admin/members/${personId}`);
		await page.getByRole("button", { name: "New invite link" }).click();
		const renewed = page.getByRole("dialog", { name: `Copy the invite link for ${person}` });
		const second = await renewed.getByLabel("Invite link").inputValue();
		expect(second).not.toBe(first);
		await renewed.getByRole("button", { name: "Done" }).click();

		const invited = await visitor.newPage();
		await invited.goto(first);
		await expect(invited.getByRole("heading", { name: "This invite link does not work" })).toBeVisible();

		await invited.goto(second);
		await expect(invited.getByRole("heading", { name: "Set your password" })).toBeVisible();
		await expect(invited.getByText(address)).toBeVisible();
		await invited.getByLabel("New password").fill(password);
		await invited.getByLabel("Type the password again").fill("a different password");
		await invited.getByRole("button", { name: "Set password and sign in" }).click();
		await expect(invited.getByRole("alert")).toHaveText("The two passwords are different.");
		await invited.getByLabel("Type the password again").fill(password);
		await invited.getByRole("button", { name: "Set password and sign in" }).click();
		// The app opens for the person, and the address bar no longer holds the link.
		await expect(invited.getByRole("heading", { name: "Set your password" })).toBeHidden();
		await expect(invited).not.toHaveURL(/invite/);
		const whoami = await visitor.request.get("/api/v1/account");
		expect(whoami.ok()).toBe(true);
		expect(((await whoami.json()) as { principal: { id: string } }).principal.id).toBe(personId);

		await invited.goto(second);
		await expect(invited.getByRole("heading", { name: "This invite link does not work" })).toBeVisible();
		const fresh = await browser.newContext();
		const signedIn = await fresh.request.post("/auth/session", {
			headers: { origin: BASE_URL, "content-type": "application/json" },
			data: { address, password },
		});
		expect(signedIn.status()).toBe(200);
		await fresh.close();
	} finally {
		if (personId)
			await admin.request.delete(`/api/v1/directory/principals/${personId}`, { headers: { origin: BASE_URL } });
		await visitor.close();
		await admin.close();
	}
});

// A person who is signed in opens an invite link for a different account. The first load of the page asks for the
// account with the old cookie, and its answer comes after the accept. Only the newest load shows its answer, so the
// app opens as the person of the link, not as the person from before.
test("an invite accepted in a signed-in browser opens the app as the new person, also after a late answer", async ({
	browser,
}) => {
	const admin = await signIn(browser, "tomasz");
	let personId: string | null = null;
	const local = `lin-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	try {
		const person = unique("Lin Wei");
		const created = await admin.request.post("/api/v1/directory/principals", {
			headers: { origin: BASE_URL },
			data: { kind: "human", display_name: person, address: `${local}@example.com` },
		});
		expect(created.ok(), await created.text()).toBe(true);
		const body = (await created.json()) as { principal: { id: string }; invite: { url: string } };
		personId = body.principal.id;
		const before = await (await admin.request.get("/api/v1/account")).text();

		// The first answer for the account waits until the load after the accept has its answer, and then gives the
		// person from before. So it comes last, as a slow answer can.
		const page = await admin.newPage();
		let newAnswered: () => void = () => {};
		const newAnswer = new Promise<void>((resolve) => {
			newAnswered = resolve;
		});
		let staleSent: () => void = () => {};
		const staleAnswer = new Promise<void>((resolve) => {
			staleSent = resolve;
		});
		let calls = 0;
		await page.route("**/api/v1/account", async (route) => {
			calls += 1;
			if (calls === 1) {
				await newAnswer;
				await route.fulfill({ status: 200, contentType: "application/json", body: before });
				staleSent();
				return;
			}
			await route.fulfill({ response: await route.fetch() });
			newAnswered();
		});

		await page.goto(body.invite.url);
		await page.getByLabel("New password").fill("lin local password");
		await page.getByLabel("Type the password again").fill("lin local password");
		await page.getByRole("button", { name: "Set password and sign in" }).click();
		await staleAnswer;
		// The page reads the late answer in its next tasks.
		await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
		await expect(page.getByRole("button", { name: `Account: ${person}` })).toBeVisible();
		await expect(page.getByRole("button", { name: /^Account: Tomasz/ })).toHaveCount(0);
	} finally {
		if (personId)
			await admin.request.delete(`/api/v1/directory/principals/${personId}`, { headers: { origin: BASE_URL } });
		await admin.close();
	}
});
