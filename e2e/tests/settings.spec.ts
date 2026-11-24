import { expect, test } from "@playwright/test";
import { signIn, unique } from "../support/chat.ts";
import { BASE_URL } from "../support/server.ts";

// Settings has a side navigation, as Admin does. Each section has its own path.
test("the settings sidebar opens one section at a time, and a reload keeps the section", async ({ browser }) => {
	const context = await signIn(browser, "meiling");
	try {
		const page = await context.newPage();
		await page.goto("/settings");
		await expect(page).toHaveURL(/\/settings\/account$/);
		await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();

		const nav = page.getByRole("navigation", { name: "Settings sections" });
		await expect(nav.getByRole("link")).toHaveText(["Account", "Notifications", "Security", "API keys"]);
		await expect(nav.getByRole("link", { name: "Account" })).toHaveAttribute("aria-current", "page");

		await nav.getByRole("link", { name: "Security" }).click();
		await expect(page).toHaveURL(/\/settings\/security$/);
		await expect(page.getByRole("heading", { level: 1, name: "Security" })).toBeVisible();
		await expect(page.getByRole("heading", { name: "Password" })).toBeVisible();
		await expect(page.getByRole("heading", { name: "Sign out" })).toHaveCount(0);
		await expect(nav.getByRole("link", { name: "Security" })).toHaveAttribute("aria-current", "page");
		await expect(page).toHaveTitle(/Security – Settings – Asterra$/);

		await page.reload();
		await expect(page.getByRole("heading", { level: 1, name: "Security" })).toBeVisible();
	} finally {
		await context.close();
	}
});

test("the settings page scrolls inside its main area and never scrolls the document to blank space", async ({
	browser,
}) => {
	const context = await signIn(browser, "meiling");
	const label = unique("Scroll key");
	const created = await context.request.post("/api/v1/account/api-keys", {
		headers: { origin: BASE_URL, "content-type": "application/json" },
		data: { label, scopes: ["account.read"] },
	});
	expect(created.ok(), `key: ${await created.text()}`).toBe(true);
	const { api_key: apiKey } = (await created.json()) as { api_key: { id: string } };

	try {
		const page = await context.newPage();
		await page.goto("/settings/api-keys");
		await expect(page.getByRole("row").filter({ hasText: label })).toBeVisible();

		const metrics = await page.evaluate(() => {
			const root = document.documentElement;
			const main = document.querySelector<HTMLElement>(".section-main");
			if (!main) throw new Error("Missing .section-main");
			window.scrollTo(0, root.scrollHeight);
			const scrollYAfterWindowScroll = window.scrollY;
			main.scrollTop = main.scrollHeight;
			const rail = document.querySelector<HTMLElement>(".rail")?.getBoundingClientRect();
			return {
				docScrollHeight: root.scrollHeight,
				docClientHeight: root.clientHeight,
				scrollYAfterWindowScroll,
				mainScrollHeight: main.scrollHeight,
				mainClientHeight: main.clientHeight,
				mainScrollTop: main.scrollTop,
				railBottom: rail ? Math.round(rail.bottom) : 0,
			};
		});

		expect(metrics.mainScrollHeight).toBeGreaterThan(metrics.mainClientHeight);
		expect(metrics.mainScrollTop).toBeGreaterThan(0);
		expect(metrics.docScrollHeight).toBe(metrics.docClientHeight);
		expect(metrics.scrollYAfterWindowScroll).toBe(0);
		expect(metrics.railBottom).toBe(metrics.docClientHeight);
	} finally {
		await context.request.post(`/api/v1/account/api-keys/${apiKey.id}/revoke`, {
			headers: { origin: BASE_URL },
		});
		await context.close();
	}
});
