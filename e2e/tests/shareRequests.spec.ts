import { expect, test } from "@playwright/test";
import { type Agent, createAgent, deleteAgents } from "../support/agents.ts";
import { signIn, unique } from "../support/chat.ts";

/** A folder in the own drive of the agent. Returns the id of the folder. */
async function folderOf(agent: Agent, name: string): Promise<string> {
	const response = await agent.post("/api/v1/drive/folders", { name });
	expect(response.ok(), `the folder ${name}: ${response.status()} ${await response.text()}`).toBe(true);
	return ((await response.json()) as { item: { id: string } }).item.id;
}

/** The status of a read of an item in the drive of `owner`, as `agent`. */
async function readStatus(agent: Agent, owner: Agent, itemId: string): Promise<number> {
	return (await agent.get(`/api/v1/drive/items/${itemId}?space_id=${owner.id}`)).status();
}

// An agent cannot share a Drive item with a different agent. It asks, and the person who manages that agent
// decides: in the activity list of Chat, or on the page of the agent in Admin › Members.
test("an agent asks to share an item with an agent, and its manager approves the request in Chat and denies a second request in Admin", async ({
	browser,
	request,
}) => {
	// Tomasz is an admin. He creates the two agents, so he is the sponsor of each.
	const admin = await signIn(browser, "tomasz");
	const askerName = unique("Filer");
	const helperName = unique("Reader");
	const firstItem = unique("Plans");
	const secondItem = unique("Drafts");
	const ids: string[] = [];
	try {
		const asker = await createAgent(admin, request, askerName, [
			"account.read",
			"drive.read",
			"drive.write",
			"drive.share",
		]);
		ids.push(asker.id);
		const helper = await createAgent(admin, request, helperName, ["account.read"]);
		ids.push(helper.id);

		// The agent owns the folder, and still cannot share it with the other agent. It can ask.
		const first = await folderOf(asker, firstItem);
		const refused = await asker.post(`/api/v1/drive/items/${first}/permissions`, {
			principal_id: helper.id,
			role: "viewer",
		});
		expect(refused.status(), await refused.text()).toBe(403);
		const asked = await asker.post(`/api/v1/drive/items/${first}/share-requests`, {
			principal_id: helper.id,
			role: "viewer",
		});
		expect(asked.status(), await asked.text()).toBe(200);

		// The request is in the activity list of the sponsor, also with the filter of its kind. It names the agent
		// that asked, the item and the agent that gets it. The item is not a link to the file: it has only its
		// two buttons.
		const page = await admin.newPage();
		await page.goto("/chat/activity");
		await page.getByRole("tab", { name: "Share requests" }).click();
		const item = page.locator(".chat-feed-item").filter({ hasText: firstItem });
		await expect(item).toContainText(`${askerName} asks to share “${firstItem}” with ${helperName}`);
		await expect(item).toContainText("the account can view the item");
		await expect(item.getByRole("button")).toHaveCount(2);
		await item.getByRole("button", { name: `Approve the request to share “${firstItem}” with ${helperName}` }).click();
		// The grant is for this item only. The agent gets no scope, and it reads the item with the same key.
		await expect(page.getByText(`${helperName} can now view “${firstItem}”.`, { exact: true })).toBeVisible();
		await expect(item).toHaveCount(0);
		expect(await readStatus(helper, asker, first)).toBe(200);

		// A second request, for a second item. The page of the agent in Admin › Members shows it.
		const second = await folderOf(asker, secondItem);
		const again = await asker.post(`/api/v1/drive/items/${second}/share-requests`, {
			principal_id: helper.id,
			role: "editor",
		});
		expect(again.status(), await again.text()).toBe(200);
		await page.goto("/admin/members");
		await page.getByRole("button", { name: /^Agents/ }).click();
		await page.getByRole("link", { name: new RegExp(`^${helperName}`) }).click();
		const requests = page.getByRole("main").getByRole("region", { name: "Requests" });
		await expect(requests).toContainText(`${askerName} asks to share “${secondItem}” with this account.`);
		await expect(requests).toContainText("the account can edit the item");
		await requests
			.getByRole("button", { name: `Deny the request to share “${secondItem}” with ${helperName}` })
			.click();
		await expect(page.getByText(`${helperName} does not get access to “${secondItem}”.`)).toBeVisible();
		// The part goes away with its last request: the page shows no empty box.
		await expect(requests).toHaveCount(0);
		expect(await readStatus(helper, asker, second)).toBe(404);
	} finally {
		await deleteAgents(admin, ids);
		await admin.close();
	}
});
