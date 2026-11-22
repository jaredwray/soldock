import type { BrowserContext } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { signIn, unique } from "../support/chat.ts";
import { BASE_URL } from "../support/server.ts";

// These tests use one agent card. A parallel run would add events to the wrong webhook.
test.describe.configure({ mode: "serial" });

interface Subscription {
	event: string;
	endpoint_id: string;
	/** The messages that a chat subscription sends. */
	filter?: string;
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

test("a sponsor creates a webhook on the agent card, and Settings does not list it", async ({ browser }) => {
	const sponsor = await signIn(browser, "chidi");
	const page = await sponsor.newPage();
	const label = unique("Card hook");
	await page.goto("/admin/members");
	await page.locator("summary").filter({ hasText: "Research Agent" }).click();

	await page.getByRole("button", { name: "Add webhook" }).click();
	const add = page.getByRole("dialog", { name: "Add a webhook for Research Agent" });
	const picker = add.getByRole("combobox", { name: "Webhook" });
	if (await picker.isVisible()) {
		await picker.click();
		await page.getByRole("option", { name: "New webhook", exact: true }).click();
	}
	await add.getByLabel("Receiver URL").fill("https://hooks.example.com/card");
	await add.getByLabel("Label (optional)").fill(label);
	await add.getByLabel("An edited message").check();
	await add.getByRole("button", { name: "Add webhook" }).click();
	await page.getByRole("dialog", { name: "Copy the signing secret" }).getByRole("button", { name: "Done" }).click();

	const row = page.getByRole("row").filter({ hasText: label });
	await expect(row).toContainText("An edited message");
	const id = await endpointId(sponsor, label);
	expect(await chatFiltersOf(sponsor, id)).toEqual(["chat.message.updated addressed"]);

	await page.goto("/settings");
	await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Webhooks" })).toHaveCount(0);
	await expect(page.getByText(label)).toHaveCount(0);

	await page.goto("/admin/members");
	await page.locator("summary").filter({ hasText: "Research Agent" }).click();
	await page
		.getByRole("row")
		.filter({ hasText: label })
		.getByRole("button", { name: `Delete webhook ${label}` })
		.click();
	await page
		.getByRole("dialog", { name: "Delete this webhook?" })
		.getByRole("button", { name: "Delete webhook" })
		.click();
	await expect(page.getByRole("row").filter({ hasText: label })).toHaveCount(0);
	const listed = await sponsor.request.get("/api/v1/webhooks/endpoints");
	const { endpoints } = (await listed.json()) as { endpoints: { id: string }[] };
	expect(endpoints.some((endpoint) => endpoint.id === id)).toBe(false);
	await sponsor.close();
});

test("a save that fails in part stays open, and a second save sends only the remaining event", async ({ browser }) => {
	const sponsor = await signIn(browser, "chidi");
	const label = unique("Flaky agent hook");
	const created = await sponsor.request.post("/api/v1/webhooks/endpoints", {
		headers: { origin: BASE_URL, "content-type": "application/json" },
		data: { url: "https://hooks.example.com/flaky-agent", label },
	});
	expect(created.ok(), `endpoint: ${await created.text()}`).toBe(true);
	const page = await sponsor.newPage();
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
	await page.goto("/admin/members");
	await page.locator("summary").filter({ hasText: "Research Agent" }).click();

	await page.getByRole("button", { name: "Add webhook" }).click();
	const add = page.getByRole("dialog", { name: "Add a webhook for Research Agent" });
	await add.getByRole("combobox", { name: "Webhook" }).click();
	await page.getByRole("option", { name: label }).click();
	await add.getByRole("group", { name: "Send a POST for" }).getByLabel("An edited message").check();
	await add.getByLabel("A new item").check();
	await add.getByRole("button", { name: "Save" }).click();
	await expect(add.getByRole("alert")).toContainText("Asterra did not save each event. A test refused this event.");
	expect(chatCreates).toBe(1);

	await add.getByRole("button", { name: "Save" }).click();
	await expect(add).toHaveCount(0);
	expect(chatCreates).toBe(2);
	const row = page.getByRole("row").filter({ hasText: label });
	await expect(row).toContainText("An edited message");
	await expect(row).toContainText("A new item");
	const id = await endpointId(sponsor, label);
	expect(await chatFiltersOf(sponsor, id)).toEqual(["chat.message.updated addressed"]);

	await sponsor.request.delete(`/api/v1/webhooks/endpoints/${id}`, { headers: { origin: BASE_URL } });
	await sponsor.close();
});
