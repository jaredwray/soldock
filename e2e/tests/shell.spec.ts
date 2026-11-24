import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { signIn } from "../support/chat.ts";

// The build gets the version of Asterra from the root package.json (apps/web/vite.config.ts).
const rootPackage: { version: string } = JSON.parse(
	readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);

test("the mark of Asterra in the rail shows the name and the version on hover", async ({ browser }) => {
	const context = await signIn(browser, "meiling");
	try {
		const page = await context.newPage();
		await page.goto("/");
		const mark = page
			.getByRole("navigation", { name: "Products" })
			.getByRole("link", { name: "Asterra, go to the inbox" });
		await expect(mark).toHaveAttribute("title", `Asterra - ${rootPackage.version}`);
	} finally {
		await context.close();
	}
});
