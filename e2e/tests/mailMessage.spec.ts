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

// The header of an open message. The copy button next to the address of the sender shows when the pointer is on
// the header, and puts the address alone on the clipboard. The button is outside the toggle, so a click on it
// keeps the message open. The toggle covers the header: a click on the date closes the message, and a click on
// the recipients, which cover the bottom of the header, does not.
test("a member copies the address of the sender from the header of an open message", async ({ browser }) => {
	const admin = await signIn(browser, "tomasz");
	const member = await signIn(browser, "rafael");
	const local = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	const address = `copy-${local}@example.com`;
	const sender = `ada-${local}@outside.example`;
	const subject = unique("Copy the sender");
	try {
		await member.grantPermissions(["clipboard-read", "clipboard-write"]);
		const me = await (await member.request.get("/api/v1/account")).json();
		const { team_mailbox: mailbox } = await post<{ team_mailbox: { id: string } }>(
			admin,
			"/api/v1/directory/team-mailboxes",
			{ display_name: unique("Copy"), address, member_ids: [me.principal.id] },
		);
		await receive(member, `Ada Sender <${sender}>`, address, subject);

		const page = await member.newPage();
		await expect(async () => {
			await page.goto(`/mail/team/${mailbox.id}/inbox`);
			await expect(page.getByText(subject)).toBeVisible({ timeout: 1000 });
		}).toPass({ timeout: 30_000 });
		await page.getByText(subject).click();

		const message = page.getByRole("main").getByRole("article");
		const toggle = message.getByRole("button", { name: "Ada Sender", exact: true });
		const copy = message.getByRole("button", { name: `Copy the address ${sender}` });
		await expect(toggle).toHaveAttribute("aria-expanded", "true");
		await expect(copy).toHaveCSS("opacity", "0");

		await toggle.hover();
		await expect(copy).toHaveCSS("opacity", "1");
		await copy.click();
		await expect(message.getByRole("button", { name: `Copied ${sender}` })).toBeVisible();
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(sender);
		await expect(toggle).toHaveAttribute("aria-expanded", "true");

		await message.getByText(address, { exact: true }).click();
		await expect(toggle).toHaveAttribute("aria-expanded", "true");

		// A real click at the date: the toggle is on top of the date, so a click on the date element is not possible.
		const date = await message.locator("time").boundingBox();
		if (!date) throw new Error("The date of the message is not on the page.");
		await page.mouse.click(date.x + date.width / 2, date.y + date.height / 2);
		await expect(message.getByRole("button", { expanded: false })).toBeVisible();
		await expect(message.getByRole("button", { name: /^(Copy the address|Copied) / })).toHaveCount(0);
	} finally {
		await admin.close();
		await member.close();
	}
});
