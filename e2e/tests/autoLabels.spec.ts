import { expect, test } from "@playwright/test";
import { signIn } from "../support/chat.ts";
import { BASE_URL } from "../support/server.ts";

const JSON_HEADERS = { origin: BASE_URL, "content-type": "application/json" };
const ICS = [
	"BEGIN:VCALENDAR",
	"METHOD:REQUEST",
	"BEGIN:VEVENT",
	"SUMMARY:Roadmap review",
	"DTSTART:20261201T150000Z",
	"END:VEVENT",
	"END:VCALENDAR",
].join("\r\n");

// Inbox auto labels with no AI call: a calendar invitation gets Meeting from the rules at delivery. The
// person sees the auto mark, removes the label from the thread, and auto labels learn from it.
test("a calendar invitation gets Meeting with the auto mark, and a person removes it", async ({ browser }) => {
	const admin = await signIn(browser, "tomasz");
	const person = await signIn(browser, "meiling");
	const sender = await signIn(browser, "rafael");
	try {
		const ai = await admin.request.post("/api/v1/ai/settings", {
			headers: JSON_HEADERS,
			data: {
				enabled: true,
				account_id: "0123456789abcdef0123456789abcdef",
				gateway_id: "asterra-e2e",
				allowed_models: ["@cf/meta/llama-3.3-70b-instruct-fp8-fast"],
				features: { mail_auto_label: { enabled: true, model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" } },
			},
		});
		expect(ai.ok(), await ai.text()).toBe(true);

		const page = await person.newPage();
		await page.goto("/mail/inbox");
		await page.getByRole("button", { name: "Auto labels" }).click();
		const dialog = page.getByRole("dialog", { name: "Auto labels" });
		// The check box shows the saved state, so it changes when the answer of the server comes.
		const master = dialog.getByRole("checkbox", { name: /Use auto labels in this mailbox/ });
		await master.click();
		await expect(master).toBeChecked();
		await expect(dialog.getByRole("checkbox", { name: /^Meeting/ })).toBeChecked();
		await dialog.getByRole("button", { name: "Done" }).click();

		const subject = `Roadmap review ${Date.now().toString(36)}`;
		const sent = await sender.request.post("/api/v1/mail/messages", {
			headers: JSON_HEADERS,
			data: {
				to: ["meiling@example.com"],
				subject,
				text: "The invitation is attached.",
				attachments: [{ filename: "invite.ics", mime_type: "text/calendar", content_base64: btoa(ICS) }],
			},
		});
		expect(sent.ok(), await sent.text()).toBe(true);

		const row = page.getByRole("listitem").filter({ hasText: subject });
		await expect(async () => {
			await page.reload();
			await expect(row.getByTitle("Meeting – Applied by auto labels")).toBeVisible({ timeout: 1000 });
		}).toPass({ timeout: 20_000 });

		await row.getByRole("link").first().click();
		const chips = page.getByRole("list", { name: "Labels" }).first();
		await expect(chips.getByText("Meeting (auto label)")).toBeAttached();
		await chips.getByRole("button", { name: "Remove the label Meeting" }).click();
		await expect(page.getByText("Label removed. Auto labels learn from this.")).toBeVisible();
		await expect(chips.getByText("Meeting")).toHaveCount(0);
	} finally {
		await admin.close();
		await person.close();
		await sender.close();
	}
});
