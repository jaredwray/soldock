import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { signIn } from "../support/chat.ts";

const TO = "ingrid@example.com";

/**
 * Delivers one message from outside through the local inbound endpoint of wrangler dev. `results` is
 * the Authentication-Results header that the receiving server wrote.
 */
async function receive(context: BrowserContext, from: string, subject: string, results: string): Promise<void> {
	const raw = [
		`Authentication-Results: mx.cloudflare.net; ${results}`,
		`From: ${from}`,
		`To: ${TO}`,
		`Subject: ${subject}`,
		`Date: ${new Date().toUTCString()}`,
		`Message-ID: <${Date.now().toString(36)}${Math.random().toString(36).slice(2)}@outside.example>`,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"Please pay the invoice today.",
		"",
	].join("\r\n");
	const query = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(TO)}`;
	const response = await context.request.post(`/cdn-cgi/local/email?${query}`, { data: raw });
	expect(response.ok(), `inbound mail: ${response.status()} ${await response.text()}`).toBe(true);
}

/** Opens the conversation with the word in its subject. The inbound queue delivers it, so it can come later. */
async function openMessage(context: BrowserContext, page: Page, word: string): Promise<void> {
	const query = `in:anywhere ${word}`;
	let id = "";
	await expect(async () => {
		const response = await context.request.get(`/api/v1/mail/threads?query=${encodeURIComponent(query)}`);
		const { threads } = (await response.json()) as { threads: { id: string }[] };
		expect(threads).toHaveLength(1);
		id = threads[0]?.id as string;
	}).toPass({ timeout: 20_000 });
	await page.goto(`/mail/search/${id}?q=${encodeURIComponent(query)}`);
}

// The notice of external mail tells the verdict of the server on the sender in plain words. The SPF, DKIM
// and DMARC results are in its details.
test("external mail shows a verdict on its sender, and the results of the checks in the details", async ({
	browser,
}) => {
	const person = await signIn(browser, "ingrid");
	const local = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	const from = `Dana <dana-${local}@Outside.example>`;
	try {
		await receive(person, from, `Invoice nopolicy${local}`, "spf=none; dkim=pass; dmarc=none");
		await receive(person, from, `Invoice proved${local}`, "spf=pass; dkim=pass; dmarc=pass");
		await receive(person, from, `Invoice forged${local}`, "spf=fail; dkim=none; dmarc=fail");
		const page = await person.newPage();

		// A DKIM pass alone proves nothing about the From address.
		await openMessage(person, page, `nopolicy${local}`);
		const unverified = page.getByRole("paragraph").filter({ hasText: "Unverified sender." });
		await expect(unverified).toBeVisible();
		await expect(unverified).toContainText("No check confirms that this message came from outside.example.");
		const checks = page.getByRole("list", { name: "Sender checks" });
		await expect(checks).toBeHidden();
		await page.getByText("Details", { exact: true }).click();
		await expect(checks.getByRole("listitem")).toHaveText([
			/Domain policy.*outside\.example publishes no policy.*DMARC: none/,
			/Signature.*DKIM: pass/,
			/Sending server.*SPF: none/,
		]);

		// A verified sender is not a safe message. The notice keeps the caution.
		await openMessage(person, page, `proved${local}`);
		const verified = page.getByRole("paragraph").filter({ hasText: "Verified sender." });
		await expect(verified).toContainText("This message came from outside.example.");
		await expect(verified).toContainText("be careful with links, attachments and requests");

		// A DMARC failure goes to Spam. One notice tells both facts.
		await openMessage(person, page, `forged${local}`);
		const failed = page.getByRole("paragraph").filter({ hasText: "Sender check failed." });
		await expect(failed).toContainText("The sender is probably forged. The message is in Spam.");
		await expect(page.getByText("This message is in Spam.")).toHaveCount(0);
	} finally {
		await person.close();
	}
});
