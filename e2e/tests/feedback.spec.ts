import { expect, test } from "@playwright/test";
import { signIn } from "../support/chat.ts";
import { call, pngFile } from "../support/docs.ts";

// Feedback: it is off by default, so a member sees no Feedback button. An admin turns it on in Admin › General and
// saves a GitHub token. The member then opens the dialog from the rail, attaches a screenshot file (a real upload),
// checks the preview of the public issue, and sends it. The local Worker cannot reach GitHub, so the test answers
// the submit request itself. A member has no General section. The test turns feedback off at the end, because the
// setting is for the whole organization.
test("an admin turns on feedback, and a member sends a report with a screenshot", async ({ browser }) => {
	const admin = await signIn(browser, "tomasz");
	const member = await signIn(browser, "chidi");
	try {
		const memberPage = await member.newPage();
		// The rail decides from feedback.get_status, so the check waits for its answer.
		const status = memberPage.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/feedback");
		await memberPage.goto("/mail/inbox");
		expect(await (await status).json()).toMatchObject({ enabled: false, can_submit: false });
		await expect(memberPage.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
		await expect(memberPage.getByRole("button", { name: "Feedback" })).toHaveCount(0);

		const page = await admin.newPage();
		await page.goto("/admin/general");
		await expect(page.getByRole("heading", { name: "General", level: 1 })).toBeVisible();
		await expect(page.getByText("Feedback is off. People see no Feedback button.")).toBeVisible();
		await page.getByRole("checkbox", { name: /Let people send feedback/ }).check();
		await page.getByLabel("GitHub token").fill(`ghp_${"e".repeat(36)}`);
		await page.getByRole("button", { name: "Save feedback settings" }).click();
		await expect(page.getByText("The feedback settings are saved.")).toBeVisible();
		await page.reload();
		await expect(page.getByRole("checkbox", { name: /Let people send feedback/ })).toBeChecked();
		await expect(page.getByText("A token is saved. Asterra never shows it again.")).toBeVisible();
		await expect(page.locator("body")).not.toContainText("eeeeeeeeeeee");

		const other = await member.newPage();
		await other.goto("/admin/general");
		await expect(other.getByText("Only owners and admins can use this section.")).toBeVisible();

		await memberPage.reload();
		await memberPage.getByRole("button", { name: "Feedback" }).click();
		const dialog = memberPage.getByRole("dialog", { name: "Send feedback" });
		await expect(dialog.getByText("This report becomes a public GitHub issue in")).toBeVisible();
		await dialog.getByLabel("Title").fill("The inbox does not load");
		await dialog.getByLabel("What happened, and what did you expect?").fill("I see a blank page.");
		await dialog.locator('input[type="file"]').setInputFiles({
			name: "screenshot.png",
			mimeType: "image/png",
			buffer: pngFile(40, 30),
		});
		await expect(dialog.getByRole("img", { name: "Attachment 1" })).toBeVisible();
		await expect(dialog.getByText("Uploading…")).toHaveCount(0);

		const preview = dialog.locator(".feedback-preview pre");
		await dialog.getByText("Preview of the public issue").click();
		await expect(preview).toContainText("[Bug] The inbox does not load");
		await expect(preview).toContainText("| Name | Chidi Okonkwo |");
		await expect(preview).toContainText("![Screenshot 1](");
		await expect(preview).not.toContainText("chidi@example.com");
		await dialog.getByRole("checkbox", { name: /My address/ }).check();
		await expect(preview).toContainText("chidi@example.com");
		await dialog.getByRole("checkbox", { name: /My address/ }).uncheck();

		const send = dialog.getByRole("button", { name: "Send" });
		await expect(send).toBeDisabled();
		await dialog.getByRole("checkbox", { name: /I examined the text/ }).check();
		await expect(send).toBeEnabled();

		let sentBody: Record<string, unknown> | null = null;
		await memberPage.route("**/api/v1/feedback/reports", async (route) => {
			sentBody = route.request().postDataJSON() as Record<string, unknown>;
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					report_id: "fbr_01JD3V0Y9XG8Q2W4E6R8T0Y2U4",
					delivery: "issue",
					issue_number: 42,
					issue_url: "https://github.com/jaredwray/soldock/issues/42",
				}),
			});
		});
		await send.click();
		await expect(dialog.getByRole("link", { name: "Open issue #42" })).toBeVisible();
		expect(sentBody).toMatchObject({
			kind: "bug",
			title: "The inbox does not load",
			include: { name: true, email: false },
			context: { page: "mail" },
		});
		expect((sentBody as unknown as { attachments: unknown[] }).attachments).toHaveLength(1);
	} finally {
		await call(admin, "POST", "/api/v1/feedback/settings", { enabled: false, github_token: null });
		await admin.close();
		await member.close();
	}
});
