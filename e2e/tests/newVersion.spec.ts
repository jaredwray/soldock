import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { signIn } from "../support/chat.ts";
import { BASE_URL } from "../support/server.ts";

// A deploy removes the chunks of the previous build. A tab of that build then cannot load a page that
// is a separate chunk, for example Drive.

const DRIVE_CHUNK = /\/assets\/DriveApp-[\w-]+\.js$/;

/** Counts the loads of a full page in the tab, from its first request. */
function countPageLoads(page: Page): () => number {
	let loads = 0;
	page.on("request", (request) => {
		if (request.isNavigationRequest() && request.frame() === page.mainFrame()) loads += 1;
	});
	return () => loads;
}

/** Opens the inbox, then returns the Drive link of the rail. */
async function openMail(page: Page) {
	await page.goto("/mail");
	const drive = page.getByRole("navigation", { name: "Products" }).getByRole("link", { name: "Drive" });
	await expect(drive).toBeVisible();
	return drive;
}

test("a page chunk that a deploy removed reloads the page one time, into the new version", async ({ browser }) => {
	const context = await signIn(browser, "nadia");
	const page = await context.newPage();
	const drive = await openMail(page);

	const pageLoads = countPageLoads(page);
	// Until the reload, the page is the old build. The server sends index.html for a file that the deploy removed.
	// After the reload, the page is the new build, which names the chunks that the server has.
	await page.route(DRIVE_CHUNK, (route) =>
		pageLoads() === 0 ? route.fulfill({ contentType: "text/html", body: "<!doctype html>" }) : route.continue(),
	);
	// The index.html of the deploy names a different entry script.
	await page.route(`${BASE_URL}/`, async (route) => {
		const response = await route.fetch();
		const html = await response.text();
		await route.fulfill({ response, body: html.replace(/\/assets\/index-[\w-]+\.js/, "/assets/index-NextDeploy.js") });
	});

	await drive.click();
	await expect(page.getByRole("heading", { level: 1, name: "My Drive" })).toBeVisible();
	await expect(page).toHaveURL(/\/drive$/);
	expect(pageLoads()).toBe(1);
	await context.close();
});

test("a page chunk that does not load in the current version asks for a reload, and the page does not reload", async ({
	browser,
}) => {
	const context = await signIn(browser, "nadia");
	const page = await context.newPage();
	const drive = await openMail(page);

	// The connection fails. The server still serves the build of the page.
	await page.route(DRIVE_CHUNK, (route) => route.abort("internetdisconnected"));
	const pageLoads = countPageLoads(page);

	await drive.click();
	await expect(page.getByRole("heading", { level: 1, name: "This page did not load" })).toBeVisible();
	expect(pageLoads()).toBe(0);
	await context.close();
});
