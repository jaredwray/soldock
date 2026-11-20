import type { BrowserContext } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { signIn, unique } from "../support/chat.ts";
import { BASE_URL } from "../support/server.ts";

interface Subscription {
	event: string;
	endpoint_id: string;
	/** The messages that a chat subscription sends. */
	filter?: string;
	/** The drive of a drive subscription. */
	space_id?: string;
}

/** The events that one endpoint sends for one product, from the REST API, in a fixed sequence. */
async function eventsOf(context: BrowserContext, product: "mail" | "chat" | "drive", endpointId: string) {
	const response = await context.request.get(`/api/v1/${product}/webhook-subscriptions`);
	expect(response.ok(), `list of ${product} subscriptions`).toBe(true);
	const { subscriptions } = (await response.json()) as { subscriptions: Subscription[] };
	return subscriptions
		.filter((subscription) => subscription.endpoint_id === endpointId)
		.map((subscription) =>
			subscription.space_id?.startsWith("drv_") ? `shared ${subscription.event}` : subscription.event,
		)
		.sort();
}

/** The filter of each chat subscription of one endpoint, from the REST API. */
async function chatFiltersOf(context: BrowserContext, endpointId: string) {
	const response = await context.request.get("/api/v1/chat/webhook-subscriptions");
	expect(response.ok(), "list of chat subscriptions").toBe(true);
	const { subscriptions } = (await response.json()) as { subscriptions: Subscription[] };
	return subscriptions
		.filter((subscription) => subscription.endpoint_id === endpointId)
		.map((subscription) => `${subscription.event} ${subscription.filter}`)
		.sort();
}

async function endpointId(context: BrowserContext, label: string): Promise<string> {
	const response = await context.request.get("/api/v1/webhooks/endpoints");
	const { endpoints } = (await response.json()) as { endpoints: { id: string; label: string }[] };
	const endpoint = endpoints.find((candidate) => candidate.label === label);
	expect(endpoint, `endpoint ${label}`).toBeDefined();
	return endpoint?.id ?? "";
}

test("a person selects the events of a webhook with check boxes, then changes them", async ({ browser }) => {
	const context = await signIn(browser, "meiling");
	const page = await context.newPage();
	const label = unique("Hook");
	await page.goto("/settings");

	// A new webhook gets its URL and its events in one dialog.
	await page.getByRole("button", { name: "Add webhook" }).click();
	const add = page.getByRole("dialog", { name: "Add a webhook" });
	await add.getByLabel("Receiver URL").fill("https://hooks.example.com/asterra");
	await add.getByLabel("Label (optional)").fill(label);
	await add.getByLabel("New mail in the inbox").check();
	await add.getByLabel("A new message").check();
	await add.getByLabel("A deleted message").check();
	await add.getByRole("button", { name: "Add webhook" }).click();
	await page.getByRole("dialog", { name: "Copy the signing secret" }).getByRole("button", { name: "Done" }).click();

	const row = page.getByRole("row").filter({ hasText: label });
	await expect(row).toContainText("New mail in the inbox");
	await expect(row).toContainText("A new message, A deleted message");
	const id = await endpointId(context, label);
	expect(await eventsOf(context, "mail", id)).toEqual(["mail.inbox.updated"]);
	expect(await eventsOf(context, "chat", id)).toEqual(["chat.message.created", "chat.message.deleted"]);
	expect(await eventsOf(context, "drive", id)).toEqual([]);

	// Edit shows the saved events as set check boxes. A save adds and removes only the difference.
	await row.getByRole("button", { name: `Edit webhook ${label}` }).click();
	const edit = page.getByRole("dialog", { name: `Edit ${label}` });
	await expect(edit.getByLabel("New mail in the inbox")).toBeChecked();
	await expect(edit.getByLabel("A new message")).toBeChecked();
	await expect(edit.getByLabel("An edited message")).not.toBeChecked();
	await edit.getByLabel("New mail in the inbox").uncheck();
	await edit.getByLabel("An edited message").check();
	await edit.getByLabel("All drive events").check();
	// A product with a second target has a menu. The check boxes then show the events of that target.
	const drive = edit.getByRole("group", { name: "Drive" });
	await drive.getByRole("combobox").click();
	await page.getByRole("option", { name: /Design/ }).click();
	await expect(drive.getByLabel("A new item")).not.toBeChecked();
	await drive.getByLabel("A change to the members").check();
	await edit.getByRole("button", { name: "Save" }).click();

	await expect(row).toContainText("All events");
	await expect(row).toContainText("Drive · Design");
	await expect(row).not.toContainText("New mail in the inbox");
	expect(await eventsOf(context, "mail", id)).toEqual([]);
	expect(await eventsOf(context, "chat", id)).toEqual([
		"chat.message.created",
		"chat.message.deleted",
		"chat.message.updated",
	]);
	// Your drive has no members and no delete, so "All drive events" sets its 8 item events.
	const driveEvents = await eventsOf(context, "drive", id);
	expect(driveEvents).toHaveLength(9);
	expect(driveEvents).toContain("shared drive.members.changed");
	expect(driveEvents).not.toContain("drive.members.changed");

	// A different tab deletes an event first. The clear of the same event is then good, with no error.
	await row.getByRole("button", { name: `Edit webhook ${label}` }).click();
	const listed = (await (await context.request.get("/api/v1/chat/webhook-subscriptions")).json()) as {
		subscriptions: (Subscription & { id: string })[];
	};
	const stale = listed.subscriptions.find(
		(subscription) => subscription.endpoint_id === id && subscription.event === "chat.message.created",
	);
	const removed = await context.request.delete(`/api/v1/chat/webhook-subscriptions/${stale?.id}`, {
		headers: { origin: BASE_URL },
	});
	expect(removed.ok(), "delete from a different tab").toBe(true);
	await edit.getByLabel("A new message").uncheck();
	await edit.getByRole("button", { name: "Save" }).click();
	await expect(edit).toHaveCount(0);
	await expect(row).toContainText("An edited message, A deleted message");

	await row.getByRole("button", { name: `Delete webhook ${label}` }).click();
	await page
		.getByRole("dialog", { name: "Delete this webhook?" })
		.getByRole("button", { name: "Delete webhook" })
		.click();
	await expect(row).toHaveCount(0);
	await context.close();
});

test("a sponsor sends the events of an agent to a webhook, and an admin can only clear them", async ({ browser }) => {
	const sponsor = await signIn(browser, "chidi");
	const label = unique("Agent hook");
	const created = await sponsor.request.post("/api/v1/webhooks/endpoints", {
		headers: { origin: BASE_URL, "content-type": "application/json" },
		data: { url: "https://hooks.example.com/agent", label },
	});
	expect(created.ok(), `endpoint: ${await created.text()}`).toBe(true);
	const page = await sponsor.newPage();
	await page.goto("/admin/members");
	await page.locator("summary").filter({ hasText: "Research Agent" }).click();

	await page.getByRole("button", { name: "Add webhook" }).click();
	const add = page.getByRole("dialog", { name: "Add a webhook for Research Agent" });
	// An agent starts with only the messages for it, so a busy room does not send a POST for each message.
	const addressed = "Direct messages, mentions and followed threads";
	await expect(add.getByRole("combobox", { name: "Messages" })).toContainText(addressed);
	// The hint under the menu tells what each check box sends for the choice. An edit and a delete have their own rule.
	await expect(add.getByRole("combobox", { name: "Messages" })).toHaveAccessibleDescription(
		"Only these messages send a POST. An edit counts when the message is one of these after the edit. A delete counts when the message was one of these before the delete, or when a different member deletes a message of the agent.",
	);
	await add.getByRole("group", { name: "Send a POST for" }).getByLabel("An edited message").check();
	await add.getByLabel("A new item").check();
	await add.getByRole("button", { name: "Save" }).click();
	const row = page.getByRole("row").filter({ hasText: label });
	await expect(row).toContainText(`An edited message (${addressed} only)`);
	await expect(row).toContainText("A new item");
	const id = await endpointId(sponsor, label);
	expect(await chatFiltersOf(sponsor, id)).toEqual(["chat.message.updated addressed"]);

	// A different filter replaces the saved subscription, and a new event gets the filter of the menu.
	await row.getByRole("button", { name: `Edit events of ${label}` }).click();
	const edit = page.getByRole("dialog", { name: `Events of ${label}` });
	await edit.getByRole("combobox", { name: "Messages" }).click();
	await page.getByRole("option", { name: "Each message" }).click();
	await expect(edit.getByRole("combobox", { name: "Messages" })).toHaveAccessibleDescription(
		"Each message in the rooms and direct messages of the agent sends a POST.",
	);
	await edit.getByLabel("A new message").check();
	await edit.getByRole("button", { name: "Save" }).click();
	await expect(row).toContainText("A new message, An edited message");
	await expect(row).not.toContainText(addressed);
	expect(await chatFiltersOf(sponsor, id)).toEqual(["chat.message.created all", "chat.message.updated all"]);

	// An admin who is not the sponsor sees the same webhook. The admin can clear an event, but cannot set one.
	const admin = await signIn(browser, "tomasz");
	const adminPage = await admin.newPage();
	await adminPage.goto("/admin/members");
	await adminPage.locator("summary").filter({ hasText: "Research Agent" }).click();
	const adminRow = adminPage.getByRole("row").filter({ hasText: label });
	await adminRow.getByRole("button", { name: `Edit events of ${label}` }).click();
	const events = adminPage.getByRole("dialog", { name: `Events of ${label}` });
	await expect(events.getByLabel("A new item")).toBeChecked();
	await expect(events.getByLabel("A moved item")).toBeDisabled();
	// A different filter adds a subscription, and the admin cannot add one.
	await expect(events.getByRole("combobox", { name: "Messages" })).toBeDisabled();
	await events.getByLabel("A new item").uncheck();
	await events.getByRole("button", { name: "Save" }).click();
	await expect(adminRow).toContainText("An edited message");
	await expect(adminRow).not.toContainText("A new item");

	await sponsor.request.delete(`/api/v1/webhooks/endpoints/${id}`, { headers: { origin: BASE_URL } });
	await sponsor.close();
	await admin.close();
});

test("a save that fails in part shows the problem, a second save sends only the remaining event, and a list that does not load hides its old rows", async ({
	browser,
}) => {
	const context = await signIn(browser, "rafael");
	const page = await context.newPage();
	const label = unique("Flaky hook");
	// The server refuses the next chat subscription. The other calls go to the server.
	let refuse = true;
	let chatCreates = 0;
	await page.route("**/api/v1/chat/webhook-subscriptions", async (route) => {
		if (route.request().method() !== "POST") return route.continue();
		chatCreates += 1;
		if (!refuse) return route.continue();
		refuse = false;
		await route.fulfill({
			status: 409,
			contentType: "application/problem+json",
			body: JSON.stringify({ title: "Conflict", detail: "A test refused this event.", code: "conflict" }),
		});
	});
	// The next load of the list fails when `failList` is true.
	let failList = false;
	await page.route("**/api/v1/webhooks/endpoints", async (route) => {
		if (route.request().method() !== "GET" || !failList) return route.continue();
		failList = false;
		await route.fulfill({ status: 500, contentType: "application/problem+json", body: "{}" });
	});
	await page.goto("/settings");

	// Add: the webhook exists, so its secret shows. The problem shows in the same dialog.
	await page.getByRole("button", { name: "Add webhook" }).click();
	const add = page.getByRole("dialog", { name: "Add a webhook" });
	await add.getByLabel("Receiver URL").fill("https://hooks.example.com/flaky");
	await add.getByLabel("Label (optional)").fill(label);
	await add.getByLabel("New mail in the inbox").check();
	await add.getByLabel("A new message").check();
	await add.getByRole("button", { name: "Add webhook" }).click();
	const secret = page.getByRole("dialog", { name: "Copy the signing secret" });
	await expect(secret.getByRole("alert")).toContainText("did not add each event. A test refused this event.");
	await secret.getByRole("button", { name: "Done" }).click();
	const row = page.getByRole("row").filter({ hasText: label });
	await expect(row).toContainText("New mail in the inbox");
	await expect(row).not.toContainText("A new message");

	// Edit: the dialog stays open with the problem. The second save sends only the event that failed.
	refuse = true;
	chatCreates = 0;
	await row.getByRole("button", { name: `Edit webhook ${label}` }).click();
	const edit = page.getByRole("dialog", { name: `Edit ${label}` });
	await edit.getByLabel("A new message").check();
	await edit.getByLabel("An edited message").check();
	await edit.getByRole("button", { name: "Save" }).click();
	await expect(edit.getByRole("alert")).toContainText("Asterra did not save each event. A test refused this event.");
	failList = true;
	await edit.getByRole("button", { name: "Save" }).click();
	await expect(edit).toHaveCount(0);
	expect(chatCreates).toBe(3);
	// The list did not load after the save. The old row goes away, so Edit cannot open with old events.
	await expect(page.getByRole("alert")).toContainText("The webhooks did not load.");
	await expect(row).toHaveCount(0);
	await page.getByRole("button", { name: "Try again" }).click();
	await expect(row).toContainText("A new message, An edited message");
	const id = await endpointId(context, label);
	expect(await eventsOf(context, "chat", id)).toEqual(["chat.message.created", "chat.message.updated"]);

	await context.request.delete(`/api/v1/webhooks/endpoints/${id}`, { headers: { origin: BASE_URL } });
	await context.close();
});
