import { expect, test } from "@playwright/test";
import { type Agent, createAgent, deleteAgents } from "../support/agents.ts";
import { signIn, unique } from "../support/chat.ts";

/** A private room of the agent. Returns the id of the room. */
async function privateRoom(agent: Agent, name: string): Promise<string> {
	const response = await agent.post("/api/v1/chat/rooms", { kind: "private", name });
	expect(response.ok(), `the room ${name}: ${response.status()} ${await response.text()}`).toBe(true);
	return ((await response.json()) as { room: { id: string } }).room.id;
}

/** The ids of the rooms that the agent is a member of. */
async function roomsOf(agent: Agent): Promise<string[]> {
	const response = await agent.get("/api/v1/chat/rooms");
	expect(response.ok(), `the rooms of the agent: ${response.status()} ${await response.text()}`).toBe(true);
	return ((await response.json()) as { rooms: { id: string }[] }).rooms.map((room) => room.id);
}

// An agent cannot put a different agent into a room. It asks, and the person who manages that agent
// decides: in the activity list of Chat, or on the page of the agent in Admin › Members.
test("an agent asks to add an agent to a room, and its manager approves the request in Chat and denies a second request in Admin", async ({
	browser,
	request,
}) => {
	// Tomasz is an admin. He creates the two agents, so he is the sponsor of each.
	const admin = await signIn(browser, "tomasz");
	const askerName = unique("Planner");
	const helperName = unique("Helper");
	const firstRoom = unique("Plans");
	const secondRoom = unique("Drafts");
	const ids: string[] = [];
	try {
		const asker = await createAgent(admin, request, askerName);
		ids.push(asker.id);
		const helper = await createAgent(admin, request, helperName);
		ids.push(helper.id);

		// The agent owns the room, and still cannot add the other agent. It can ask.
		const first = await privateRoom(asker, firstRoom);
		const refused = await asker.post(`/api/v1/chat/rooms/${first}/members`, { principal_ids: [helper.id] });
		expect(refused.status()).toBe(403);
		const asked = await asker.post(`/api/v1/chat/rooms/${first}/member-requests`, { principal_id: helper.id });
		expect(asked.status(), await asked.text()).toBe(200);

		// The request is in the activity list of the sponsor. It names the agent that asked, the agent to add
		// and the room. The sponsor is not a member of the room, so the item has only its two buttons.
		const page = await admin.newPage();
		await page.goto("/chat/activity");
		const item = page.locator(".chat-feed-item").filter({ hasText: firstRoom });
		await expect(item).toContainText(`${askerName} asks to add ${helperName}`);
		await expect(item).toContainText(`to #${firstRoom}`);
		await expect(item.getByRole("button")).toHaveCount(2);
		await item.getByRole("button", { name: `Approve the request to add ${helperName} to #${firstRoom}` }).click();
		// The approval makes the member. The membership alone decides what the agent can do in the room.
		await expect(page.getByText(`${helperName} is now a member of #${firstRoom}.`, { exact: true })).toBeVisible();
		await expect(item).toHaveCount(0);
		expect(await roomsOf(helper)).toEqual([first]);

		// A second request, for a second room. The page of the agent in Admin › Members shows it.
		const second = await privateRoom(asker, secondRoom);
		const again = await asker.post(`/api/v1/chat/rooms/${second}/member-requests`, { principal_id: helper.id });
		expect(again.status(), await again.text()).toBe(200);
		await page.goto("/admin/members");
		await page.getByRole("button", { name: /^Agents/ }).click();
		await page.getByRole("link", { name: new RegExp(`^${helperName}`) }).click();
		const requests = page.getByRole("main").getByRole("region", { name: "Requests" });
		await expect(requests).toContainText(`${askerName} asks to add this account to #${secondRoom}.`);
		await expect(requests).toContainText("the account can read and post in the room");
		await requests.getByRole("button", { name: `Deny the request to add ${helperName} to #${secondRoom}` }).click();
		await expect(page.getByText(`${helperName} is not added to #${secondRoom}.`)).toBeVisible();
		// The part goes away with its last request: the page shows no empty box.
		await expect(requests).toHaveCount(0);
		expect(await roomsOf(helper)).toEqual([first]);
	} finally {
		await deleteAgents(admin, ids);
		await admin.close();
	}
});
