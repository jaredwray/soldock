import { type BrowserContext, expect, test } from "@playwright/test";
import { createRoom, signIn, unique } from "../support/chat.ts";
import { BASE_URL } from "../support/server.ts";

const JSON_HEADERS = { origin: BASE_URL, "content-type": "application/json" };

async function post<T>(context: BrowserContext, path: string, data: unknown): Promise<T> {
	const response = await context.request.post(path, { headers: JSON_HEADERS, data });
	expect(response.ok(), `POST ${path}: ${response.status()} ${await response.text()}`).toBe(true);
	return (await response.json()) as T;
}

// The owner of a room decides what each member can do in it, in the members dialog of the room. The form
// asks what a new member can do. An agent that its manager adds gets its chat scopes with the membership.
test("the owner of a room selects what a new member can do, changes it later, and an agent gets its access with the membership", async ({
	browser,
}) => {
	// Tomasz is an admin, so he manages each agent. Nadia is a member of the room.
	const owner = await signIn(browser, "tomasz");
	const nadia = await signIn(browser, "nadia");
	const local = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	const name = unique("Reports");
	const agentName = unique("Reporter");
	let agentId: string | null = null;
	try {
		const { principal: agent } = await post<{ principal: { id: string } }>(owner, "/api/v1/directory/principals", {
			kind: "agent",
			display_name: agentName,
			address: `reporter-${local}@example.com`,
			scopes: ["account.read"],
		});
		agentId = agent.id;
		const roomId = await createRoom(owner, name);
		const page = await owner.newPage();
		await page.goto(`/chat/${roomId}`);
		await page.getByRole("button", { name: /^Members:/ }).click();
		const dialog = page.getByRole("dialog", { name: `Members of ${name}` });
		const select = dialog.getByRole("combobox", { name: "Person or agent to add" });

		// A person can post and add members at the start. The owner clears Post for Nadia.
		await select.click();
		await page.getByRole("option", { name: /^Nadia/ }).click();
		const fresh = dialog.getByRole("group", { name: /can read the room, and$/ });
		await expect(fresh.getByLabel("Post")).toBeChecked();
		await expect(fresh.getByLabel("Add members")).toBeChecked();
		await fresh.getByLabel("Post").uncheck();
		await fresh.getByLabel("Add members").uncheck();
		await dialog.getByRole("button", { name: "Add", exact: true }).click();
		await expect(page.getByText(/^Nadia .* can now only read in /)).toBeVisible();

		// An agent does not add members at the start. Its manager adds it, and it gets the chat scopes on its
		// account and the room in its limits.
		await select.click();
		await page.getByRole("option", { name: new RegExp(`^${agentName}`) }).click();
		await expect(fresh.getByLabel("Post")).toBeChecked();
		await expect(fresh.getByLabel("Add members")).not.toBeChecked();
		await dialog.getByRole("button", { name: "Add", exact: true }).click();
		await expect(
			page.getByText(`${agentName} now also holds chat.read, chat.write, and has this room in its limits now.`, {
				exact: false,
			}),
		).toBeVisible();
		const access = await owner.request.get(`/api/v1/directory/agents/${agent.id}/access`);
		expect(await access.json()).toMatchObject({
			scopes: ["account.read", "chat.read", "chat.write"],
			resources: { room_ids: [roomId] },
		});

		// Nadia reads the room, and has no box for a message.
		const room = await nadia.newPage();
		await room.goto(`/chat/${roomId}`);
		await expect(room.getByText("You can read this room. The owner of the room can let you post.")).toBeVisible();
		await expect(room.locator(".chat-composer")).toHaveCount(0);
		const refused = await nadia.request.post(`/api/v1/chat/rooms/${roomId}/messages`, {
			headers: JSON_HEADERS,
			data: { text: "Hello" },
		});
		expect(refused.status()).toBe(403);

		// The owner selects Post for Nadia in the list of members. Her room then has the box.
		const nadiaCan = dialog.getByRole("group", { name: /^What Nadia .* can do in the room$/ });
		await expect(nadiaCan.getByLabel("Post")).not.toBeChecked();
		// A click, not `check`: the check box shows the saved scopes, so it changes after the answer of the server.
		await nadiaCan.getByLabel("Post").click();
		// The toast of the agent can still show, so the text names Nadia.
		await expect(page.getByText(/^Nadia .* can now read and post in /)).toBeVisible();
		await expect(nadiaCan.getByLabel("Post")).toBeChecked();
		await room.reload();
		await expect(room.locator(".chat-composer")).toBeVisible();
	} finally {
		if (agentId) {
			await owner.request.delete(`/api/v1/directory/principals/${agentId}`, { headers: { origin: BASE_URL } });
		}
		await owner.close();
		await nadia.close();
	}
});
