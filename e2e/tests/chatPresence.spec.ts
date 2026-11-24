import { type BrowserContext, expect } from "@playwright/test";
import { createRoom, unique } from "../support/chat.ts";
import { test } from "../support/chatDevices.ts";
import { BASE_URL } from "../support/server.ts";

const JSON_HEADERS = { origin: BASE_URL, "content-type": "application/json" };

async function principal(context: BrowserContext, address: string): Promise<{ id: string; display_name: string }> {
	const response = await context.request.get(`/api/v1/directory/principals?query=${encodeURIComponent(address)}`);
	const { principals } = (await response.json()) as { principals: { id: string; display_name: string }[] };
	const found = principals[0];
	if (!found) throw new Error(`The seed data has no principal ${address}.`);
	return found;
}

async function send(context: BrowserContext, path: string, data: unknown): Promise<unknown> {
	const response = await context.request.post(path, { headers: JSON_HEADERS, data });
	expect(response.ok(), `POST ${path}: ${response.status()}`).toBe(true);
	return response.json();
}

test("a person sets and clears a status that another person sees on the open profile", async ({ device }) => {
	const author = await device("meiling");
	const viewer = await device("rafael");
	const profile = await author.newPage();
	await profile.goto("/chat");
	await profile.getByRole("button", { name: /^Account:/ }).click();
	await profile.getByRole("link", { name: "Profile and status" }).click();
	const change = profile.getByRole("button", { name: "Set status" });
	await expect(change).toBeEnabled();
	const other = await viewer.newPage();
	await other.goto(profile.url());
	const displayed = other.locator(".profile-status");
	await expect(displayed).toContainText(/Active|Away|Offline/);
	await expect(other.getByRole("button", { name: "Set status" })).toHaveCount(0);

	await change.click();
	const dialog = profile.getByRole("dialog", { name: "Set status" });
	const text = unique("On a call");
	await dialog.getByLabel("Status", { exact: true }).fill(text);
	await dialog.getByLabel("Emoji").fill("🎧");
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(displayed).toContainText(`🎧 ${text}`, { timeout: 18_000 });

	await change.click();
	await dialog.getByRole("button", { name: "Clear status" }).click();
	await expect(displayed).not.toContainText(text, { timeout: 18_000 });
});

// An agent opens no events socket, so its availability is always offline. A dot for it tells nothing.
test("the sidebar and the header show a dot for a person and none for an agent", async ({ device }) => {
	const nadia = await device("nadia");
	const agent = await principal(nadia, "triage@example.com");
	const person = await principal(nadia, "ingrid@example.com");
	const dm = async (id: string) =>
		((await send(nadia, "/api/v1/chat/dms", { principal_id: id })) as { room: { id: string } }).room.id;
	const agentDm = await dm(agent.id);
	const personDm = await dm(person.id);
	const page = await nadia.newPage();
	const header = page.locator(".chat-header");
	const current = page.locator('a.nav-item[aria-current="page"]');

	await page.goto(`/chat/${personDm}`);
	await expect(current).toContainText(person.display_name);
	// The page reads presence only for names on screen. Other tests can push the row below the fold.
	await current.scrollIntoViewIfNeeded();
	await expect(header.locator(".chat-presence-dot")).toBeVisible();
	await expect(current.locator(".chat-presence-dot")).toBeVisible();

	await page.goto(`/chat/${agentDm}`);
	await expect(page.getByRole("heading", { name: `Direct message with ${agent.display_name}` })).toBeVisible();
	await expect(current).toContainText(agent.display_name);
	await expect(header.locator(".chat-presence")).toHaveCount(0);
	await expect(current.locator(".chat-presence")).toHaveCount(0);
});

test("the member list shows the availability of a person and not of an agent", async ({ device }) => {
	const nadia = await device("nadia");
	const agent = await principal(nadia, "triage@example.com");
	const person = await principal(nadia, "ingrid@example.com");
	const name = unique("Presence of agents");
	const roomId = await createRoom(nadia, name);
	await send(nadia, `/api/v1/chat/rooms/${roomId}/members`, { principal_ids: [agent.id, person.id] });
	const page = await nadia.newPage();
	await page.goto(`/chat/${roomId}`);
	await page.getByRole("button", { name: /^Members:/ }).click();
	const dialog = page.getByRole("dialog", { name: `Members of ${name}` });
	const row = (who: string) => dialog.locator(".chat-row").filter({ hasText: who });

	// One read gives both principals, so the agent row is final when the person row shows a label.
	await expect(row(person.display_name)).toContainText(/Active|Away|Offline/);
	await expect(row(person.display_name).locator(".chat-presence-dot")).toHaveCount(1);
	await expect(row(agent.display_name)).not.toContainText(/Active|Away|Offline/);
	await expect(row(agent.display_name).locator(".chat-presence-dot")).toHaveCount(0);
});
