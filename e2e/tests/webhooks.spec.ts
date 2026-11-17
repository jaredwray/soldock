import type { BrowserContext } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { signIn, unique } from "../support/chat.ts";
import { BASE_URL } from "../support/server.ts";

interface Subscription {
	event: string;
	endpoint_id: string;
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
	await add.getByLabel("Receiver URL").fill("https://hooks.example.com/soldock");
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
	await add.getByLabel("An edited message").check();
	await add.getByLabel("A new item").check();
	await add.getByRole("button", { name: "Save" }).click();
	const row = page.getByRole("row").filter({ hasText: label });
	await expect(row).toContainText("An edited message");
	await expect(row).toContainText("A new item");

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
	await events.getByLabel("A new item").uncheck();
	await events.getByRole("button", { name: "Save" }).click();
	await expect(adminRow).toContainText("An edited message");
	await expect(adminRow).not.toContainText("A new item");

	const id = await endpointId(sponsor, label);
	await sponsor.request.delete(`/api/v1/webhooks/endpoints/${id}`, { headers: { origin: BASE_URL } });
	await sponsor.close();
	await admin.close();
});

test("a save that fails in part shows the problem, and a second save sends only the remaining event", async ({
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
	await expect(edit.getByRole("alert")).toContainText("Soldock did not save each event. A test refused this event.");
	await edit.getByRole("button", { name: "Save" }).click();
	await expect(edit).toHaveCount(0);
	expect(chatCreates).toBe(3);
	await expect(row).toContainText("A new message, An edited message");
	const id = await endpointId(context, label);
	expect(await eventsOf(context, "chat", id)).toEqual(["chat.message.created", "chat.message.updated"]);

	await context.request.delete(`/api/v1/webhooks/endpoints/${id}`, { headers: { origin: BASE_URL } });
	await context.close();
});
