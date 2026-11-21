import { expect } from "@playwright/test";
import { createRoom, editorReady, openRoom, post, reply, unique } from "../support/chat.ts";
import { test } from "../support/chatDevices.ts";

test("a group direct message keeps its name and members after a reload", async ({ device }) => {
	const user = await device("chidi");
	const page = await user.newPage();
	await page.goto("/chat");
	await page.getByRole("button", { name: "New direct message" }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByRole("button", { name: "Select a group" }).click();
	for (const name of ["Tomasz Wieczorek", "Nadia Rahman"]) {
		await dialog.getByRole("button", { name: new RegExp(name) }).click();
	}
	await dialog.getByRole("button", { name: "Start group message" }).click();
	await expect(page.getByRole("button", { name: "Members: 3 members" })).toBeVisible();
	const title = await page.getByRole("heading", { level: 1 }).innerText();
	await page.reload();
	await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
	await page.getByRole("button", { name: "Members: 3 members" }).click();
	for (const name of ["Tomasz Wieczorek", "Nadia Rahman", "Chidi Okonkwo"]) {
		await expect(dialog.getByRole("list").getByText(name, { exact: false })).toBeVisible();
	}
});

test("a room owner archives and restores a room while a member reads it", async ({ device }) => {
	const owner = await device("nadia");
	const member = await device("rafael");
	const name = unique("Archive");
	const room = await createRoom(owner, name, [member]);
	const page = await owner.newPage();
	const reader = await member.newPage();
	await Promise.all([openRoom(page, room), openRoom(reader, room)]);
	const dialog = page.getByRole("dialog");
	await page.getByRole("button", { name: "Room controls" }).click();
	// The owner's metadata refresh can still be unavailable when they reopen the dialog.
	// The save response carries the policy that the room actually applied.
	await page.route(`**/api/v1/chat/rooms/${room}`, (route) => route.abort());
	await dialog.getByLabel("Archive this room").check();
	await dialog.getByRole("button", { name: "Save changes" }).click();
	await expect(reader.getByText("This room is archived.")).toBeVisible();
	await expect(reader.getByRole("textbox", { name: `Message to ${name}` })).toHaveCount(0);
	await page.getByRole("button", { name: "Room controls" }).click();
	await expect(dialog.getByLabel("Archive this room")).toBeChecked();
	await dialog.getByLabel("Archive this room").uncheck();
	await dialog.getByRole("button", { name: "Save changes" }).click();
	await expect(reader.getByRole("textbox", { name: `Message to ${name}` })).toBeVisible();
});

test("a member keeps open room and reply edits when posting changes to owners only", async ({ device }) => {
	const owner = await device("nadia");
	const member = await device("rafael");
	const room = await createRoom(owner, unique("Posting"), [member]);
	const parent = await post(member, room, "Original room message");
	const child = await reply(member, room, parent.id, "Original reply");
	const page = await member.newPage();
	const controls = await owner.newPage();
	await Promise.all([openRoom(page, room), openRoom(controls, room)]);
	const roomRow = page.locator(`.chat-messages [data-seq="${parent.seq}"]`);
	await roomRow.getByRole("button", { name: /1 reply/ }).click();
	const thread = page.getByRole("complementary", { name: "Thread" });
	const replyRow = thread.locator(`.chat-thread-reply[data-seq="${child.seq}"]`);
	const edits = [
		{ row: roomRow, original: parent.text },
		{ row: replyRow, original: child.text },
	];
	for (const { row, original } of edits) {
		await row.hover();
		await row.getByRole("button", { name: /Change your message/ }).click();
		const edit = row.getByRole("textbox", { name: "New text of the message" });
		await editorReady(edit);
		await edit.fill(`Unsaved: ${original}`);
	}

	await controls.getByRole("button", { name: "Room controls" }).click();
	const dialog = controls.getByRole("dialog");
	await dialog.getByLabel("Who can post").selectOption("owners");
	await dialog.getByRole("button", { name: "Save changes" }).click();
	await expect(thread.getByText("Only room owners can post in this room.")).toBeVisible();

	const saves: string[] = [];
	page.on("request", (request) => {
		if (request.method() === "POST" && request.url().endsWith("/edit")) saves.push(request.url());
	});
	for (const { row, original } of edits) {
		await expect(row.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
		const edit = row.getByRole("textbox", { name: "New text of the message" });
		await edit.press("Enter");
		await expect(edit).toHaveText(`Unsaved: ${original}`);
		await row.getByRole("button", { name: "Cancel" }).click();
		await expect(row.getByText(original, { exact: true })).toBeVisible();
		await expect(row.getByRole("button", { name: /Change your message/ })).toHaveCount(0);
	}
	expect(saves).toEqual([]);
});

test("an organization owner downloads messages and thread replies from a joined room", async ({ device }) => {
	const owner = await device("nadia");
	const room = await createRoom(owner, unique("Export"));
	const parent = await post(owner, room, unique("Parent"));
	const child = await reply(owner, room, parent.id, unique("Reply"));
	const page = await owner.newPage();
	await openRoom(page, room);
	await page.getByRole("button", { name: "Room controls" }).click();
	const started = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export messages" }).click();
	const download = await started;
	expect(download.suggestedFilename()).toBe(`${room}.jsonl`);
	const file = await download.createReadStream();
	if (!file) throw new Error("The export has no file.");
	const chunks: Buffer[] = [];
	for await (const chunk of file) chunks.push(Buffer.from(chunk));
	const lines = Buffer.concat(chunks)
		.toString("utf8")
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line) as { id: string; parent_id: string | null; text: string });
	expect(lines.map(({ id, parent_id, text }) => [id, parent_id, text])).toEqual([
		[parent.id, null, parent.text],
		[child.id, parent.id, child.text],
	]);
});
