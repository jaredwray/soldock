import { expect, test } from "@playwright/test";
import { signIn } from "../support/chat.ts";

const PUBLIC_KEY = /^B[A-Za-z0-9_-]{86}$/;

// Admin › Chat: an admin turns on device notifications with a contact address. The server makes the key pair,
// and the card shows the public key. The admin replaces the keys through the dialog, then turns
// notifications off again, so the local Worker sends nothing to a push service.
test("an admin turns on device notifications, replaces the keys and turns them off", async ({ browser }) => {
	const admin = await signIn(browser, "tomasz");
	try {
		const page = await admin.newPage();
		const memberKey = async () => {
			const response = await admin.request.get("/api/v1/chat/notifications");
			expect(response.ok()).toBe(true);
			return ((await response.json()) as { vapid_public_key: string | null }).vapid_public_key;
		};
		await page.goto("/admin/chat");
		await expect(page.getByRole("heading", { name: "Device notifications" })).toBeVisible();
		await expect(page.getByText(/^Off\./)).toBeVisible();
		const turnOn = page.getByRole("button", { name: "Turn on notifications" });
		await expect(turnOn).toBeDisabled();
		expect(await memberKey()).toBeNull();

		await page.getByLabel("Contact address").fill("mailto:admin@example.com");
		await turnOn.click();
		await expect(page.getByText("Chat notifications to devices are on.")).toBeVisible();
		const publicKey = page.getByLabel("Public key");
		await expect(publicKey).toHaveValue(PUBLIC_KEY);
		const first = await publicKey.inputValue();
		expect(await memberKey()).toBe(first);

		// The settings come from the server after a reload.
		await page.reload();
		await expect(page.getByLabel("Contact address")).toHaveValue("mailto:admin@example.com");
		await expect(publicKey).toHaveValue(first);

		await page.getByRole("button", { name: "Replace keys" }).click();
		const dialog = page.getByRole("dialog", { name: "Replace the keys?" });
		await dialog.getByRole("button", { name: "Replace keys" }).click();
		await expect(dialog).toBeHidden();
		await expect(page.getByText("The new key pair is in use.")).toBeVisible();
		await expect(publicKey).toHaveValue(PUBLIC_KEY);
		await expect(publicKey).not.toHaveValue(first);
		expect(await memberKey()).toBe(await publicKey.inputValue());

		await page.getByRole("button", { name: "Turn off" }).click();
		await expect(page.getByText("Chat notifications to devices are off.")).toBeVisible();
		await expect(page.getByText(/^Off\./)).toBeVisible();
		await expect(page.getByRole("button", { name: "Turn on notifications" })).toBeEnabled();
		expect(await memberKey()).toBeNull();
	} finally {
		await admin.close();
	}
});
