import { expect, type Page, test } from "@playwright/test";
import { composer, createRoom, openRoom, signIn, unique } from "../support/chat.ts";
import { pngFile } from "../support/docs.ts";

// The files of a message (jaredwray/soldock#74). A file uploads to the drive of the author from the box,
// and each member of the room downloads it from the message. Each test makes its own room.

/** The file input of the box for a new message. The paperclip opens it. */
const fileInput = (page: Page) => page.locator('.chat-composer input[type="file"]');

test("a file from the box goes with the message, and a member downloads it", async ({ browser }) => {
	const tomasz = await signIn(browser, "tomasz");
	const nadia = await signIn(browser, "nadia");
	const name = unique("Files");
	const roomId = await createRoom(tomasz, name, [nadia]);
	const page = await tomasz.newPage();
	await openRoom(page, roomId);

	const content = `The plan for ${unique("Monday")}.\n`;
	await fileInput(page).setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from(content) });
	const chip = page.locator(".chat-attachment").filter({ hasText: "notes.txt" });
	await expect(chip).toHaveClass(/chat-attachment-ready/);
	await expect(chip.getByRole("progressbar")).toHaveCount(0);

	const text = unique("see the file");
	await composer(page, name).fill(text);
	await composer(page, name).press("Enter");
	// The file leaves the box at the send.
	await expect(page.locator(".chat-attachment")).toHaveCount(0);

	const row = page.locator(".chat-message:not(.chat-message-pending)").filter({ hasText: text });
	const link = row.locator("a.chat-file-link");
	await expect(link).toHaveAttribute("download", "notes.txt");
	const href = await link.getAttribute("href");
	expect(href).toMatch(new RegExp(`^/dl/chat/${roomId}/`));
	// A member of the room gets the bytes of the file.
	const download = await nadia.request.get(href ?? "");
	expect(download.status()).toBe(200);
	expect(await download.text()).toBe(content);
});

test("a picture goes without text, and shows its small picture from the browser", async ({ browser }) => {
	const tomasz = await signIn(browser, "tomasz");
	const name = unique("Pictures");
	const roomId = await createRoom(tomasz, name);
	const page = await tomasz.newPage();
	await openRoom(page, roomId);

	await fileInput(page).setInputFiles({ name: "plan.png", mimeType: "image/png", buffer: pngFile(400, 300) });
	await expect(page.locator(".chat-attachment").filter({ hasText: "plan.png" })).toHaveClass(/chat-attachment-ready/);
	// A message with only files has no text.
	await composer(page, name).press("Enter");

	const picture = page.locator(".chat-message:not(.chat-message-pending) .chat-file-image img");
	await expect(picture).toHaveAttribute("alt", "plan.png");
	// The small picture gives the box of the picture: 400 × 300 fits 360 × 280 as 360 × 270.
	await expect(picture).toHaveAttribute("src", /variant=preview$/);
	await expect(picture).toHaveAttribute("width", "360");
	await expect(picture).toHaveAttribute("height", "270");
	await expect.poll(() => picture.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
});
