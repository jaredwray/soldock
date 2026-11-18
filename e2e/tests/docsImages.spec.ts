import { expect, type Page, test } from "@playwright/test";
import { signIn, unique } from "../support/chat.ts";
import {
	call,
	createDoc,
	dropFiles,
	getDoc,
	imagesOf,
	openDoc,
	pngFile,
	savedImages,
	uploadImage,
} from "../support/docs.ts";
import { BASE_URL } from "../support/server.ts";

const SHOTS = process.env.SHOTS;

test("a dropped image file shows at once, goes into the doc, and stays after a reload", async ({ browser }) => {
	const context = await signIn(browser, "nadia");
	const page = await context.newPage();
	const doc = await createDoc(context, unique("Images"), "The first paragraph of the doc.\n\nThe second paragraph.");
	const body = await openDoc(page, doc);

	await dropFiles(page, ".doc-body", [{ name: "chart.png", type: "image/png", bytes: pngFile(640, 400) }]);
	const image = body.locator(".doc-image");
	await expect(image).toHaveCount(1);
	// The upload ends: the image has its id, and the picture shows.
	await expect(body.locator(".doc-image-pending")).toHaveCount(0);
	await expect(image).toHaveClass(/doc-image-loaded/);
	const [saved] = await savedImages(context, doc.id, (images) => images.length === 1);
	expect(saved).toMatchObject({ layout: "inline", width: 640 });
	expect((await getDoc(context, doc.id)).images).toMatchObject([{ mime_type: "image/png", width: 640, height: 400 }]);
	if (SHOTS) await page.screenshot({ path: `${SHOTS}/1-dropped.png` });

	await page.reload();
	await expect(body.locator(".doc-image")).toHaveClass(/doc-image-loaded/);
	const box = await body.locator(".doc-image-frame").boundingBox();
	expect(Math.round(box?.width ?? 0)).toBe(640);
	expect(Math.round(box?.height ?? 0)).toBe(400);
	if (SHOTS) await page.screenshot({ path: `${SHOTS}/2-reloaded.png` });
	await context.close();
});

const LOREM =
	"Soldock keeps each image of a doc in the doc. The text goes around an image at the left or at the right, or it stops above the image and continues below it. ".repeat(
		4,
	);

/** A doc with one image between two paragraphs of text, made through the API as an agent makes it. */
async function docWithImage(context: Awaited<ReturnType<typeof signIn>>, options = "") {
	const doc = await createDoc(context, unique("Images"));
	const image = await uploadImage(context, doc.id, pngFile(800, 600));
	await call(context, "POST", `/api/v1/docs/${doc.id}`, {
		markdown: `# The report\n\n![](image:${image.id}${options})${LOREM}\n\n${LOREM}`,
	});
	return { doc, image };
}

test("the image toolbar changes the layout, the size, the alt text and the caption", async ({ browser }) => {
	const context = await signIn(browser, "nadia");
	const page = await context.newPage();
	const { doc } = await docWithImage(context, "?width=300");
	const body = await openDoc(page, doc);
	const image = body.locator(".doc-image");
	await expect(image).toHaveClass(/doc-image-loaded/);

	// A click selects the image, and the image toolbar takes the place of the formatting toolbar.
	await image.locator(".doc-image-frame").click();
	const toolbar = page.getByRole("toolbar", { name: "Image" });
	await expect(toolbar).toBeVisible();
	await expect(page.getByRole("toolbar", { name: "Formatting" })).toHaveCount(0);
	await expect(toolbar.getByRole("button", { name: "In line" })).toHaveAttribute("aria-pressed", "true");

	await toolbar.getByRole("button", { name: "Wrap text" }).click();
	await expect(image).toHaveCSS("float", "left");
	// The text goes around the image: the first line of the paragraph starts at the right of the image.
	const frame = await image.locator(".doc-image-frame").boundingBox();
	const paragraph = await body.locator("p").first().boundingBox();
	expect(frame && paragraph && paragraph.height > frame.height).toBe(true);
	if (SHOTS) await page.screenshot({ path: `${SHOTS}/3-wrap-left.png` });

	await toolbar.getByRole("button", { name: "Image at the right" }).click();
	await expect(image).toHaveCSS("float", "right");
	// The text cannot go around an image in the center.
	await expect(toolbar.getByRole("button", { name: "Image in the center" })).toHaveAttribute("aria-disabled", "true");

	await toolbar.getByRole("combobox", { name: "Size of the image" }).click();
	await page.getByRole("option", { name: "50% of the text width" }).click();
	const half = Math.round(((await body.boundingBox())?.width ?? 0) / 2);
	await expect
		.poll(async () => Math.round((await image.locator(".doc-image-frame").boundingBox())?.width ?? 0))
		.toBe(half);

	await toolbar.getByRole("button", { name: "Alt text" }).click();
	const dialog = page.getByRole("dialog", { name: "Alt text" });
	await dialog.getByLabel("Description of the image").fill("Four squares in four colors");
	await dialog.getByRole("button", { name: "Apply" }).click();
	await expect(image.locator("img")).toHaveAttribute("alt", "Four squares in four colors");

	// The caption is a line below the picture. The person types in it, and Enter goes back to the text.
	await toolbar.getByRole("button", { name: "Caption" }).click();
	const caption = image.getByRole("textbox", { name: "Caption of the image" });
	await expect(caption).toBeFocused();
	await page.keyboard.type("Sales by quarter");
	await page.keyboard.press("Enter");
	await expect(body).toBeFocused();
	if (SHOTS) await page.screenshot({ path: `${SHOTS}/4-wrap-right-caption.png` });

	const [saved] = await savedImages(context, doc.id, (images) => images[0]?.caption === "Sales by quarter");
	expect(saved).toMatchObject({
		layout: "wrap_right",
		width: half,
		alt: "Four squares in four colors",
		caption: "Sales by quarter",
	});

	await toolbar.getByRole("button", { name: "Break text" }).click();
	await toolbar.getByRole("button", { name: "Image in the center" }).click();
	await expect(image).toHaveCSS("float", "none");
	if (SHOTS) await page.screenshot({ path: `${SHOTS}/5-break-center.png` });
	await savedImages(context, doc.id, (images) => images[0]?.layout === "break_center");

	// Undo brings back the layout of before.
	await page.keyboard.press("ControlOrMeta+z");
	await page.keyboard.press("ControlOrMeta+z");
	await savedImages(context, doc.id, (images) => images[0]?.layout === "wrap_right");

	await image.locator(".doc-image-frame").click();
	await toolbar.getByRole("button", { name: "Remove image" }).click();
	await expect(image).toHaveCount(0);
	await expect(page.getByRole("toolbar", { name: "Formatting" })).toBeVisible();
	await savedImages(context, doc.id, (images) => images.length === 0);
	await context.close();
});

test("a corner of a selected image changes its size, and the image keeps its shape", async ({ browser }) => {
	const context = await signIn(browser, "nadia");
	const page = await context.newPage();
	const { doc } = await docWithImage(context, "?width=400");
	const body = await openDoc(page, doc);
	const frame = body.locator(".doc-image-frame");
	await expect(body.locator(".doc-image")).toHaveClass(/doc-image-loaded/);
	await frame.click();
	const handle = body.locator(".doc-image-handle-se");
	await expect(handle).toBeVisible();
	const box = await handle.boundingBox();
	if (!box) throw new Error("the corner is not on the page");
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2 - 100, box.y + box.height / 2 - 60, { steps: 5 });
	// While the corner moves, the image shows its size in pixels.
	await expect(body.locator(".doc-image-size")).toHaveText("300 × 225");
	if (SHOTS) await page.screenshot({ path: `${SHOTS}/6-resizing.png` });
	await page.mouse.up();
	const resized = await frame.boundingBox();
	expect([Math.round(resized?.width ?? 0), Math.round(resized?.height ?? 0)]).toEqual([300, 225]);
	const [saved] = await savedImages(context, doc.id, (images) => images[0]?.width === 300);
	expect(saved?.layout).toBe("inline");
	// The image stays selected, so the person can continue with the toolbar.
	await expect(page.getByRole("toolbar", { name: "Image" })).toBeVisible();
	await context.close();
});

test("the crop dialog selects the part of the image that shows, with the keyboard", async ({ browser }) => {
	const context = await signIn(browser, "nadia");
	const page = await context.newPage();
	const { doc } = await docWithImage(context, "?width=400&layout=break_left");
	const body = await openDoc(page, doc);
	const frame = body.locator(".doc-image-frame");
	await expect(body.locator(".doc-image")).toHaveClass(/doc-image-loaded/);
	await frame.click();
	await page.getByRole("toolbar", { name: "Image" }).getByRole("button", { name: "Crop" }).click();
	const dialog = page.getByRole("dialog", { name: "Crop image" });
	await expect(dialog.locator(".doc-crop-picture")).toBeVisible();
	await expect(dialog.getByText("The whole image shows.")).toBeVisible();

	// The left side goes 50% to the right, and the top side goes 50% down: the yellow quarter stays.
	const left = dialog.getByRole("button", { name: /^Left side/ });
	await left.focus();
	for (let press = 0; press < 5; press++) await page.keyboard.press("Shift+ArrowRight");
	const top = dialog.getByRole("button", { name: /^Top side/ });
	await top.focus();
	for (let press = 0; press < 5; press++) await page.keyboard.press("Shift+ArrowDown");
	await expect(dialog.getByText("400 × 300 pixels of the image show.")).toBeVisible();
	if (SHOTS) await page.screenshot({ path: `${SHOTS}/7-crop-dialog.png` });
	await dialog.getByRole("button", { name: "Apply" }).click();

	// The picture keeps its scale: the half of the width shows, so the image has the half of its width.
	const cropped = await frame.boundingBox();
	expect([Math.round(cropped?.width ?? 0), Math.round(cropped?.height ?? 0)]).toEqual([200, 150]);
	const [saved] = await savedImages(context, doc.id, (images) => images[0]?.crop !== undefined);
	expect(saved).toMatchObject({ width: 200, crop: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } });
	if (SHOTS) await page.screenshot({ path: `${SHOTS}/8-cropped.png` });

	// The doc keeps the whole file, so a later crop can show it all again.
	await page.getByRole("toolbar", { name: "Image" }).getByRole("button", { name: "Crop" }).click();
	await dialog.getByRole("button", { name: "Show the whole image" }).click();
	await dialog.getByRole("button", { name: "Apply" }).click();
	const whole = await savedImages(context, doc.id, (images) => images[0]?.crop === undefined);
	expect(whole[0]?.width).toBe(400);
	await context.close();
});

/** Sends a paste to the text of the doc, with the HTML and the files that a clipboard can hold. */
async function paste(page: Page, data: { html?: string; files?: { name: string; type: string; bytes: Buffer }[] }) {
	await page.evaluate(
		({ html, files }) => {
			const transfer = new DataTransfer();
			if (html !== null) transfer.setData("text/html", html);
			for (const file of files) {
				const bytes = Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0));
				transfer.items.add(new File([bytes], file.name, { type: file.type }));
			}
			const event = new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true });
			document.querySelector(".doc-body")?.dispatchEvent(event);
		},
		{
			html: data.html ?? null,
			files: (data.files ?? []).map((file) => ({ ...file, base64: file.bytes.toString("base64"), bytes: undefined })),
		},
	);
}

test("a pasted picture, and a picture in pasted HTML, go into the doc as its own images", async ({ browser }) => {
	const context = await signIn(browser, "nadia");
	const page = await context.newPage();
	const doc = await createDoc(context, unique("Images"), "Start.");
	const body = await openDoc(page, doc);
	// The page must never load a pasted address: the editor uploads the bytes.
	const outside: string[] = [];
	page.on("request", (request) => {
		if (!request.url().startsWith(BASE_URL) && !request.url().startsWith("blob:")) outside.push(request.url());
	});

	// A screenshot: the clipboard has a file and no text.
	await body.click();
	await page.keyboard.press("ControlOrMeta+End");
	await paste(page, { files: [{ name: "image.png", type: "image/png", bytes: pngFile(200, 100) }] });
	await expect(body.locator(".doc-image-loaded:not(.doc-image-pending)")).toHaveCount(1);

	// A copy from a web page: text, and a picture as a data address with a width and alt text.
	const data = `data:image/png;base64,${pngFile(300, 300, 40).toString("base64")}`;
	await paste(page, {
		html: `<p>Pasted text <img src="${data}" alt="The logo" width="120" onerror="window.hacked = true"> end.</p>`,
	});
	await expect(body.locator(".doc-image-loaded:not(.doc-image-pending)")).toHaveCount(2);
	await expect(body).toContainText("Pasted text");
	const saved = await savedImages(context, doc.id, (images) => images.length === 2);
	expect(saved[1]).toMatchObject({ alt: "The logo", width: 120, layout: "inline" });
	expect((await getDoc(context, doc.id)).images.map((image) => [image.width, image.height])).toEqual([
		[200, 100],
		[300, 300],
	]);
	expect(await page.evaluate(() => (window as { hacked?: boolean }).hacked)).toBeUndefined();
	expect(outside).toEqual([]);
	await context.close();
});

test("a picture with a web address in pasted HTML goes through the server, and a failure removes it", async ({
	browser,
}) => {
	const context = await signIn(browser, "nadia");
	const page = await context.newPage();
	const doc = await createDoc(context, unique("Images"), "Start.");
	const body = await openDoc(page, doc);
	const outside: string[] = [];
	page.on("request", (request) => {
		if (!request.url().startsWith(BASE_URL) && !request.url().startsWith("blob:")) outside.push(request.url());
	});
	const imports: unknown[] = [];
	await page.route("**/api/v1/docs/*/images/import", async (route) => {
		imports.push(route.request().postDataJSON());
		await route.fulfill({
			status: 503,
			contentType: "application/problem+json",
			body: JSON.stringify({
				title: "Service unavailable",
				status: 503,
				code: "unavailable",
				detail: "The web address did not answer.",
			}),
		});
	});
	await body.click();
	await paste(page, {
		html: '<p>From the web <img src="https://images.example.com/photo.png?size=2" alt="Photo"></p>',
	});
	await expect(page.getByText("The image did not go into the doc.")).toBeVisible();
	await expect(body.locator(".doc-image")).toHaveCount(0);
	await expect(body).toContainText("From the web");
	// The server got the address. The browser did not load it.
	expect(imports).toMatchObject([{ url: "https://images.example.com/photo.png?size=2" }]);
	expect(outside).toEqual([]);
	await context.close();
});

test("the Insert image menu adds an image from this computer and from Drive", async ({ browser }) => {
	const context = await signIn(browser, "nadia");
	const page = await context.newPage();
	const doc = await createDoc(context, unique("Images"), "Start.");
	const name = `${unique("photo")}.png`;
	await call(context, "POST", "/api/v1/drive/files", {
		name,
		mime_type: "image/png",
		content_base64: pngFile(320, 240, 20).toString("base64"),
	});
	const body = await openDoc(page, doc);
	const toolbar = page.getByRole("toolbar", { name: "Formatting" });

	const chooser = page.waitForEvent("filechooser");
	await toolbar.getByRole("button", { name: "Insert image" }).click();
	await page.getByRole("menuitem", { name: "Upload from this computer" }).click();
	await (await chooser).setFiles({ name: "local.png", mimeType: "image/png", buffer: pngFile(100, 50) });
	await expect(body.locator(".doc-image-loaded:not(.doc-image-pending)")).toHaveCount(1);

	await toolbar.getByRole("button", { name: "Insert image" }).click();
	await page.getByRole("menuitem", { name: "From Drive" }).click();
	const dialog = page.getByRole("dialog", { name: "Image from Drive" });
	await dialog.getByRole("button", { name }).click();
	if (SHOTS) await page.screenshot({ path: `${SHOTS}/9-drive-dialog.png` });
	await dialog.getByRole("button", { name: "Insert image" }).click();
	await expect(body.locator(".doc-image-loaded:not(.doc-image-pending)")).toHaveCount(2);
	await savedImages(context, doc.id, (images) => images.length === 2);
	expect((await getDoc(context, doc.id)).images.map((image) => [image.width, image.height]).sort()).toEqual([
		[100, 50],
		[320, 240],
	]);
	await context.close();
});

test("a file that is not an image does not go into the doc, and the browser does not open it", async ({ browser }) => {
	const context = await signIn(browser, "nadia");
	const page = await context.newPage();
	const doc = await createDoc(context, unique("Images"), "Start.");
	const body = await openDoc(page, doc);
	const url = page.url();
	await dropFiles(page, ".doc-body", [{ name: "report.pdf", type: "application/pdf", bytes: Buffer.from("%PDF-1.7") }]);
	await expect(page.getByText("Only PNG, JPEG, GIF and WebP images can go into a doc.")).toBeVisible();
	await expect(body.locator(".doc-image")).toHaveCount(0);
	// A drop on the paper around the text is handled too.
	await dropFiles(page, ".doc-scroll", [{ name: "chart.png", type: "image/png", bytes: pngFile(64, 64) }], {
		x: 300,
		y: 500,
	});
	await expect(body.locator(".doc-image-loaded:not(.doc-image-pending)")).toHaveCount(1);
	expect(page.url()).toBe(url);
	await context.close();
});

test("a viewer sees the images of a doc and cannot change them", async ({ browser }) => {
	const owner = await signIn(browser, "nadia");
	const viewer = await signIn(browser, "tomasz");
	const { doc, image } = await docWithImage(owner, '?width=300&layout=break_center "The caption"');
	// The own doc of the viewer gives the id of the viewer.
	const viewerId = (await createDoc(viewer, unique("Own"))).spaceId;
	await call(owner, "POST", `/api/v1/drive/items/${doc.id}/permissions`, { principal_id: viewerId, role: "viewer" });

	const page = await viewer.newPage();
	const body = await openDoc(page, doc);
	const shown = body.locator(".doc-image");
	await expect(shown).toHaveClass(/doc-image-loaded/);
	await expect(shown.getByRole("textbox", { name: "Caption of the image" })).toHaveValue("The caption");
	await expect(shown.getByRole("textbox", { name: "Caption of the image" })).not.toBeEditable();
	await shown.locator(".doc-image-frame").click();
	await expect(page.getByRole("toolbar", { name: "Image" })).toHaveCount(0);
	await expect(body.locator(".doc-image-handle-se")).toBeHidden();
	// The server refuses an upload of the viewer.
	const refused = await viewer.request.post(`/api/v1/docs/${doc.id}/images?space_id=${doc.spaceId}`, {
		headers: { origin: BASE_URL, "content-type": "application/json" },
		data: { space_id: doc.spaceId, content_base64: pngFile(8, 8).toString("base64") },
	});
	expect(refused.status()).toBe(403);
	expect(imagesOf(await getDoc(owner, doc.id))[0]?.id).toBe(image.id);
	await owner.close();
	await viewer.close();
});

test("a copy of an image goes from one doc to a different doc, with its options", async ({ browser }) => {
	const context = await signIn(browser, "nadia");
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	const page = await context.newPage();
	const { doc: source, image } = await docWithImage(context, '?width=240&layout=wrap_right "Copied caption"');
	const target = await createDoc(context, unique("Target"), "Start.");

	let body = await openDoc(page, source);
	await expect(body.locator(".doc-image")).toHaveClass(/doc-image-loaded/);
	await body.locator(".doc-image-frame").click();
	await page.keyboard.press("ControlOrMeta+c");

	body = await openDoc(page, target);
	await body.click();
	await page.keyboard.press("ControlOrMeta+v");
	await expect(body.locator(".doc-image-loaded:not(.doc-image-pending)")).toHaveCount(1);
	const [saved] = await savedImages(context, target.id, (images) => images.length === 1);
	expect(saved).toMatchObject({ id: image.id, width: 240, layout: "wrap_right", caption: "Copied caption" });
	// The target has its own copy of the bytes.
	expect((await getDoc(context, target.id)).images.map((entry) => entry.id)).toEqual([image.id]);
	await context.close();
});
