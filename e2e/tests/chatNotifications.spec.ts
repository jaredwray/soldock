import { expect } from "@playwright/test";
import { createRoom, openRoom, unique } from "../support/chat.ts";
import { test } from "../support/chatDevices.ts";
import { BASE_URL } from "../support/server.ts";

test("an owner can save room details and retry a personal notification change independently", async ({ device }) => {
	const person = await device("ingrid");
	const name = unique("Room settings");
	const room = await createRoom(person, name);
	const page = await person.newPage();
	await openRoom(page, room);
	const button = page.getByRole("button", { name: "Room settings" });
	const dialog = page.getByRole("dialog", { name: "Room settings" });
	const inherit = dialog.getByRole("radio", { name: "Use account default" });
	const mentions = dialog.getByRole("radio", { name: "Mentions only" });
	const edit = dialog.getByRole("button", { name: "Edit room details" });
	const save = dialog.getByRole("button", { name: "Save changes" });

	await button.click();
	await expect(dialog.getByText(name, { exact: true })).toBeVisible();
	await expect(dialog.getByRole("textbox")).toHaveCount(0);
	await expect(inherit).toBeChecked();
	await expect(inherit).toHaveAccessibleDescription("Currently: All messages");
	await expect(save).toBeDisabled();
	await mentions.check();
	await edit.click();
	await dialog.getByLabel("Room name", { exact: true }).fill("Discard this name");
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(button).toBeFocused();
	await button.click();
	await expect(inherit).toBeChecked();
	await expect(dialog.getByText(name, { exact: true })).toBeVisible();

	let updates = 0;
	page.on("request", (request) => {
		if (new URL(request.url()).pathname === `/api/v1/chat/rooms/${room}/update`) updates++;
	});
	const rename = async (name: string) => {
		const result = await person.request.post(`/api/v1/chat/rooms/${room}/update`, {
			headers: { origin: BASE_URL },
			data: { name },
		});
		expect(result.ok()).toBe(true);
	};
	const firstName = unique("Design notes");
	const newName = unique("Design review");
	const topic = "Review prototypes on Fridays.";
	await rename(firstName);
	await expect(dialog.getByText(firstName, { exact: true })).toBeVisible();
	await edit.click();
	await expect(dialog.getByLabel("Room name", { exact: true })).toHaveValue(firstName);
	await dialog.getByLabel("Topic", { exact: true }).fill("Review prototypes\non Fridays.");
	// A second device changes the name while this device edits the topic.
	await rename(newName);
	await expect(page.locator(".chat-title")).toHaveText(newName);
	await expect(dialog.getByLabel("Room name", { exact: true })).toHaveValue(firstName);
	await mentions.check();
	await page.route(`**/api/v1/chat/rooms/${room}/notifications`, (route) => route.abort(), { times: 1 });
	await save.click();
	await expect(dialog.getByRole("alert")).toContainText("Room details saved.");
	await expect(dialog.getByText(newName, { exact: true })).toBeVisible();
	await expect(mentions).toBeChecked();
	await save.click();
	await expect(dialog).toHaveCount(0);
	expect(updates).toBe(1);
	await expect(page.getByText("Room settings saved.")).toBeVisible();
	await page.reload();
	await button.click();
	await expect(dialog.getByText(newName, { exact: true })).toBeVisible();
	await expect(dialog.getByText(topic, { exact: true })).toBeVisible();
	await expect(mentions).toBeChecked();
	await page.setViewportSize({ width: 360, height: 640 });
	await expect(save).toBeInViewport();
	await mentions.press("ArrowDown");
	await expect(dialog.getByRole("radio", { name: "Mute room" })).toBeChecked();
	await page.keyboard.press("Escape");
	await expect(button).toBeFocused();

	await button.click();
	await expect(mentions).toBeChecked();
	await inherit.check();
	await save.click();
	await expect(dialog).toHaveCount(0);
	const settings = await person.request.get("/api/v1/chat/notifications");
	expect((await settings.json()).settings.room_levels).not.toHaveProperty(room);
});

test("a member sets personal notifications in a joined room and in a direct message", async ({ device }) => {
	const owner = await device("meiling");
	const member = await device("rafael");
	const room = await createRoom(owner, unique("Member settings"));
	const { principal } = await (await owner.request.get("/api/v1/account")).json();
	const opened = await member.request.post("/api/v1/chat/dms", {
		headers: { origin: BASE_URL },
		data: { principal_id: principal.id },
	});
	expect(opened.ok()).toBe(true);
	const dm = (await opened.json()).room;
	const page = await member.newPage();
	const button = page.getByRole("button", { name: "Room settings" });
	const dialog = page.getByRole("dialog", { name: "Room settings" });
	await page.goto(`/chat/${room}`);
	const join = page.getByRole("button", { name: "Join the room" });
	await expect(join).toBeVisible();
	await expect(button).toHaveCount(0);
	await join.click();
	await expect(button).toBeVisible();

	for (const id of [room, dm.id]) {
		await openRoom(page, id);
		await button.click();
		await expect(dialog.getByRole("heading", { name: "Notifications", exact: true })).toBeVisible();
		await expect(dialog.getByRole("button", { name: "Edit room details" })).toHaveCount(0);
		if (id === dm.id) await expect(dialog.getByText(principal.display_name, { exact: true })).toBeVisible();
		await dialog.getByRole("radio", { name: "Mute room" }).check();
		await dialog.getByRole("button", { name: "Save changes" }).click();
		await expect(dialog).toHaveCount(0);
	}
	const read = async (actor: typeof member) =>
		(await (await actor.request.get("/api/v1/chat/notifications")).json()).settings.room_levels;
	expect(await read(member)).toMatchObject({ [room]: "none", [dm.id]: "none" });
	expect(await read(owner)).not.toHaveProperty(room);
});

test("a delayed room list cannot undo a saved name, and a later rename can restore the previous name", async ({
	device,
}) => {
	const person = await device("ingrid");
	const first = unique("Initial name");
	const earlier = unique("Name before save");
	const saved = unique("Name after save");
	const room = await createRoom(person, first);
	const page = await person.newPage();
	await page.clock.install();
	// The lists use HTTP. Room socket events must not start an independent read of the members.
	await page.routeWebSocket("**/ws/**", () => {});
	await openRoom(page, room);
	await expect(
		page.getByRole("navigation", { name: "Rooms" }).getByRole("link", { name: first }).first(),
	).toBeVisible();
	await page.getByRole("button", { name: "Room settings" }).click();
	const dialog = page.getByRole("dialog", { name: "Room settings" });
	await dialog.getByRole("button", { name: "Edit room details" }).click();
	await dialog.getByLabel("Room name", { exact: true }).fill(saved);
	await dialog.getByRole("radio", { name: "Mentions only" }).check();

	const readEarlier = Promise.withResolvers<void>();
	const captured = Promise.withResolvers<void>();
	const checking = Promise.withResolvers<void>();
	const failCheck = Promise.withResolvers<void>();
	let checks = 0;
	const showEarlier = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	let waiting = true;
	await page.route(
		(url) => url.pathname === "/api/v1/chat/rooms",
		async (route) => {
			if (waiting) {
				waiting = false;
				await readEarlier.promise;
				const response = await route.fetch();
				captured.resolve();
				await showEarlier.promise;
				await route.fulfill({ response });
			} else {
				await resume.promise;
				await route.continue();
			}
		},
	);
	const rename = async () => {
		const response = await person.request.post(`/api/v1/chat/rooms/${room}/update`, {
			headers: { origin: BASE_URL },
			data: { name: earlier },
		});
		expect(response.ok()).toBe(true);
		// Wait until the principal's list projects the rename before the browser reads that list.
		await expect
			.poll(async () => {
				const list = await person.request.get("/api/v1/chat/rooms?limit=100");
				const { rooms } = (await list.json()) as { rooms: Array<{ id: string; name: string | null }> };
				return rooms.find((entry) => entry.id === room)?.name;
			})
			.toBe(earlier);
	};
	try {
		await rename();
		readEarlier.resolve();
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		await captured.promise;
		await page.route(`**/api/v1/chat/rooms/${room}/notifications`, (route) => route.abort(), { times: 1 });
		await dialog.getByRole("button", { name: "Save changes" }).click();
		await expect(dialog.getByRole("alert")).toContainText("Room details saved.");
		await expect(dialog.getByText(saved, { exact: true })).toBeVisible();
		await page.route(
			(url) => url.pathname === `/api/v1/chat/rooms/${room}`,
			async (route) => {
				if (++checks === 1) {
					checking.resolve();
					await failCheck.promise;
					await route.abort();
				} else {
					await route.continue();
				}
			},
		);
		showEarlier.resolve();
		await expect(page.locator(".chat-title")).toHaveText(earlier);
		await expect(dialog.getByText(saved, { exact: true })).toBeVisible();
		await checking.promise;
		// Keep the first check open across the poll and the delay between repeated checks.
		await page.clock.fastForward(10_000);
		await rename();
		resume.resolve();
		// Each change of the star proves that the browser applied a different list with the same name.
		const star = page.locator(".chat-room-heading button[aria-pressed]");
		for (const starred of [true, false, true]) {
			const changed = await person.request.post(`/api/v1/chat/rooms/${room}/star`, {
				headers: { origin: BASE_URL },
				data: { starred },
			});
			expect(changed.ok()).toBe(true);
			await page.evaluate(() => window.dispatchEvent(new Event("focus")));
			await expect(star).toHaveAttribute("aria-pressed", String(starred));
		}
		expect(checks).toBe(1);
		failCheck.resolve();
		await expect(dialog.getByText(earlier, { exact: true })).toBeVisible();
		expect(checks).toBe(2);
	} finally {
		failCheck.resolve();
		readEarlier.resolve();
		showEarlier.resolve();
		resume.resolve();
	}
});
