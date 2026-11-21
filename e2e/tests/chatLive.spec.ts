import { expect, test } from "@playwright/test";
import { composer, createRoom, markRead, openRoom, post, signIn, unique } from "../support/chat.ts";

test("a draft shows a typing indicator on another device and the indicator expires", async ({ browser }) => {
	const sender = await signIn(browser, "tomasz");
	const reader = await signIn(browser, "chidi");
	const name = unique("Typing");
	const room = await createRoom(sender, name, [reader]);
	const senderPage = await sender.newPage();
	const readerPage = await reader.newPage();
	async function showRoom(page: typeof senderPage) {
		const shown = page
			.waitForEvent("websocket", (socket) => socket.url().endsWith(`/ws/chat/rooms/${room}`))
			.then((socket) => socket.waitForEvent("framesent", (frame) => frame.payload === "show"));
		await openRoom(page, room);
		await shown;
	}
	await Promise.all([showRoom(senderPage), showRoom(readerPage)]);
	await composer(senderPage, name).fill("A draft that stays on this device");
	const indicator = readerPage.getByRole("status").filter({ hasText: /is typing/ });
	await expect(indicator).toContainText("Tomasz");
	await expect(indicator).toHaveCount(0);
	await expect(composer(senderPage, name)).toHaveText("A draft that stays on this device");
});

test("an unread chat changes the title and app badge outside Chat until another device reads it", async ({
	browser,
}) => {
	const sender = await signIn(browser, "nadia");
	const reader = await signIn(browser, "ingrid");
	const room = await createRoom(sender, unique("Tab count"), [reader]);
	const page = await reader.newPage();
	// Capture the operating system badge request at the browser boundary.
	await page.addInitScript(() => {
		Object.defineProperties(navigator, {
			setAppBadge: {
				value: async (count: number) => {
					document.documentElement.dataset.badge = String(count);
				},
			},
			clearAppBadge: {
				value: async () => {
					document.documentElement.dataset.badge = "0";
				},
			},
		});
	});
	const ready = page.waitForResponse(
		(response) => response.url().endsWith("/api/v1/chat/notifications") && response.ok(),
	);
	await page.goto("/settings");
	await ready;
	const getCount = async () => {
		const response = await reader.request.get("/api/v1/chat/notifications");
		expect(response.ok()).toBe(true);
		return ((await response.json()) as { unread_count: number }).unread_count;
	};
	const before = await getCount();
	await post(sender, room, "Can you take a look?");
	await expect.poll(getCount).toBe(before + 1);
	await expect(page).toHaveTitle(new RegExp(`^\\(${before + 1}\\) .+Asterra$`));
	await expect(page.locator("html")).toHaveAttribute("data-badge", String(before + 1));
	await markRead(reader, room);
	await expect(page).toHaveTitle(before ? new RegExp(`^\\(${before}\\) .+Asterra$`) : /^[^(].+Asterra$/);
	await expect(page.locator("html")).toHaveAttribute("data-badge", String(before));
});

test("a second tab reopens its notification session when the account changes", async ({ browser }) => {
	const context = await signIn(browser, "chidi");
	const editor = await context.newPage();
	const second = await context.newPage();
	await Promise.all([editor.goto("/settings"), second.goto("/chat")]);
	await expect(second.getByRole("button", { name: /^Account: Chidi/ })).toBeVisible();
	await editor.getByRole("button", { name: /^Account:/ }).click();
	await editor.getByRole("navigation", { name: "Products" }).getByRole("button", { name: "Sign out" }).click();
	await expect(second.getByRole("heading", { name: "Sign in" })).toBeVisible();
	await editor.getByLabel("Address").fill("nadia@example.com");
	await editor.getByLabel("Password").fill("nadia local password");
	await editor.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(second.getByRole("button", { name: /^Account: Nadia/ })).toBeVisible();
});
