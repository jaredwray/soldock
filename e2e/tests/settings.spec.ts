import { expect, test } from "@playwright/test";
import { signIn, unique } from "../support/chat.ts";
import { BASE_URL } from "../support/server.ts";

test("the settings page scrolls inside its main area and never scrolls the document to blank space", async ({
	browser,
}) => {
	const context = await signIn(browser, "meiling");
	const label = unique("Scroll hook");
	const created = await context.request.post("/api/v1/webhooks/endpoints", {
		headers: { origin: BASE_URL, "content-type": "application/json" },
		data: { url: "https://hooks.example.com/scroll-check", label },
	});
	expect(created.ok(), `endpoint: ${await created.text()}`).toBe(true);
	const { endpoint } = (await created.json()) as { endpoint: { id: string } };

	try {
		const page = await context.newPage();
		await page.goto("/settings");
		await expect(page.getByRole("row").filter({ hasText: label })).toBeVisible();

		const metrics = await page.evaluate(() => {
			const root = document.documentElement;
			const main = document.querySelector<HTMLElement>(".page-main");
			if (!main) throw new Error("Missing .page-main");
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
		await context.request.delete(`/api/v1/webhooks/endpoints/${endpoint.id}`, {
			headers: { origin: BASE_URL },
		});
		await context.close();
	}
});
