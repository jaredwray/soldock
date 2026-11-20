import { expect, type Page, test } from "@playwright/test";
import { signIn, unique } from "../support/chat.ts";
import { createDoc, getDoc, openDoc } from "../support/docs.ts";

const MARKDOWN = [
	"# The plan",
	"Text with **bold words** and [a link](https://example.com/plan).",
	"- The first item\n- The second item",
	"```\nconst answer = 42;\n```",
].join("\n\n");

/** Sends a paste to the text of the doc, with each form that the clipboard has. */
async function paste(page: Page, forms: Record<string, string>) {
	await page.evaluate((entries) => {
		const transfer = new DataTransfer();
		for (const [type, value] of Object.entries(entries)) transfer.setData(type, value);
		const event = new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true });
		document.querySelector(".doc-body")?.dispatchEvent(event);
	}, forms);
}

/** The types of the blocks of the saved doc, when the server has a doc that passes `check`. */
async function savedBlocks(
	context: Parameters<typeof getDoc>[0],
	itemId: string,
	check: (types: string[]) => boolean,
): Promise<string[]> {
	let types: string[] = [];
	await expect
		.poll(
			async () => {
				types = ((await getDoc(context, itemId)).content.content ?? []).map((block) => block.type);
				return check(types);
			},
			{ timeout: 15_000 },
		)
		.toBe(true);
	return types;
}

test("pasted Markdown gets its formats, the doc saves them, and Undo gives the text back", async ({ browser }) => {
	const context = await signIn(browser, "nadia");
	const page = await context.newPage();
	const doc = await createDoc(context, unique("Markdown"));
	const body = await openDoc(page, doc);

	await body.click();
	await paste(page, { "text/plain": MARKDOWN });
	await expect(body.locator("h1")).toHaveText("The plan");
	await expect(body.locator("strong")).toHaveText("bold words");
	await expect(body.locator("a")).toHaveAttribute("href", "https://example.com/plan");
	await expect(body.locator("ul > li")).toHaveText(["The first item", "The second item"]);
	await expect(body.locator("pre")).toHaveText("const answer = 42;");
	// The marks of Markdown are not in the text.
	await expect(body).not.toContainText("**");
	expect(await savedBlocks(context, doc.id, (types) => types.includes("heading"))).toEqual([
		"heading",
		"paragraph",
		"bullet_list",
		"code_block",
	]);

	// One Undo gives the text as the clipboard had it. A second Undo removes the paste.
	await page.keyboard.press("ControlOrMeta+z");
	await expect(body.locator("h1")).toHaveCount(0);
	await expect(body.locator("p").first()).toHaveText("# The plan");
	await expect(body).toContainText("Text with **bold words** and [a link](https://example.com/plan).");
	await page.keyboard.press("ControlOrMeta+z");
	await expect(body).toHaveText("");
	await context.close();
});

test("a paste with Shift and a paste into a code block keep the text, and a code editor gives Markdown", async ({
	browser,
}) => {
	const context = await signIn(browser, "nadia");
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	const page = await context.newPage();
	const doc = await createDoc(context, unique("Markdown"));
	const body = await openDoc(page, doc);

	// The key of a paste without formats.
	await body.click();
	await page.evaluate((text) => navigator.clipboard.writeText(text), "# Not a heading\n\n**Not bold**");
	await page.keyboard.press("ControlOrMeta+Shift+v");
	await expect(body.locator("p")).toHaveText(["# Not a heading", "", "**Not bold**"]);
	await expect(body.locator("h1, strong")).toHaveCount(0);

	// The same clipboard without Shift.
	await page.keyboard.press("ControlOrMeta+a");
	await page.keyboard.press("ControlOrMeta+v");
	await expect(body.locator("h1")).toHaveText("Not a heading");
	await expect(body.locator("strong")).toHaveText("Not bold");

	// A copy from VS Code has HTML with the colors of the editor, and the language of the file.
	await page.keyboard.press("ControlOrMeta+a");
	await paste(page, {
		"text/plain": "## From the editor\n\n1. A numbered item",
		"text/html":
			'<div style="color:#ccc;font-family:monospace;white-space:pre"><div><span style="font-weight:bold">## From the editor</span></div><br><div><span>1. A numbered item</span></div></div>',
		"vscode-editor-data": JSON.stringify({ version: 1, isFromEmptySelection: false, mode: "markdown" }),
	});
	await expect(body.locator("h2")).toHaveText("From the editor");
	await expect(body.locator("ol > li")).toHaveText("A numbered item");
	await expect(body.locator("h1")).toHaveCount(0);

	// In a code block, Markdown is code, also from a code editor.
	await page.keyboard.press("ControlOrMeta+a");
	await page.keyboard.press("Delete");
	await page.getByRole("button", { name: "Code block", exact: true }).click();
	await paste(page, {
		"text/plain": "# A comment\n**kwargs",
		"text/html": "<div><span># A comment</span></div><div><span>**kwargs</span></div>",
		"vscode-editor-data": JSON.stringify({ version: 1, isFromEmptySelection: false, mode: "markdown" }),
	});
	await expect(body.locator("pre")).toHaveText("# A comment\n**kwargs");
	await expect(body.locator("h1, strong")).toHaveCount(0);
	await context.close();
});
