import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { signIn, unique } from "../support/chat.ts";
import { createDoc, openDoc } from "../support/docs.ts";

test("the Download menu names the format, and the browser gets a Markdown file", async ({ browser }) => {
	const context = await signIn(browser, "nadia");
	const page = await context.newPage();
	// The page gives the browser a Blob. This records the type of each Blob that gets an address.
	await page.addInitScript(() => {
		const types: string[] = [];
		const create = URL.createObjectURL.bind(URL);
		URL.createObjectURL = (object) => {
			if (object instanceof Blob) types.push(object.type);
			return create(object);
		};
		Object.assign(window, { savedTypes: types });
	});
	const name = unique("Report");
	const doc = await createDoc(context, name, "# The plan\n\nThe first step.");
	await openDoc(page, doc);

	// The button shows only an icon. Its menu tells the format before the browser saves a file.
	await page.getByRole("button", { name: "Download", exact: true }).click();
	const started = page.waitForEvent("download");
	await page.getByRole("menuitem", { name: "Download as Markdown (.md)", exact: true }).click();
	const download = await started;

	expect(download.suggestedFilename()).toBe(`${name}.md`);
	// The file has the type of Markdown, so the save dialog and the system know the format.
	const types = await page.evaluate(() => (window as unknown as { savedTypes: string[] }).savedTypes);
	expect(types).toEqual(["text/markdown;charset=utf-8"]);
	expect(await readFile(await download.path(), "utf8")).toContain("# The plan");
	await context.close();
});
