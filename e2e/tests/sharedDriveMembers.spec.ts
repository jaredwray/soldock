import { type BrowserContext, expect, test } from "@playwright/test";
import { signIn, unique } from "../support/chat.ts";
import { BASE_URL } from "../support/server.ts";

const JSON_HEADERS = { origin: BASE_URL, "content-type": "application/json" };

async function post<T>(context: BrowserContext, path: string, data: unknown): Promise<T> {
	const response = await context.request.post(path, { headers: JSON_HEADERS, data });
	expect(response.ok(), `POST ${path}: ${response.status()} ${await response.text()}`).toBe(true);
	return (await response.json()) as T;
}

// An admin gives an agent a role in a shared drive, in the settings of the drive. The role alone decides what
// the agent can do there, and nothing changes on the account of the agent. A remove ends the access of the
// agent to the drive.
test("an admin gives an agent a role in a shared drive, and the agent gets and loses its access with the membership", async ({
	browser,
}) => {
	// Tomasz is an admin, so he manages each agent.
	const admin = await signIn(browser, "tomasz");
	const local = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	const name = unique("Plans");
	const agentName = unique("Filer");
	let agentId: string | null = null;
	let driveId: string | null = null;
	try {
		const { principal: self } = (await (await admin.request.get("/api/v1/account")).json()) as {
			principal: { id: string };
		};
		// A new agent is a member of no shared drive.
		const { principal: agent } = await post<{ principal: { id: string } }>(admin, "/api/v1/directory/principals", {
			kind: "agent",
			display_name: agentName,
			address: `filer-${local}@example.com`,
		});
		agentId = agent.id;
		const { shared_drive: drive } = await post<{ shared_drive: { id: string } }>(admin, "/api/v1/drive/shared-drives", {
			name,
			members: [{ principal_id: self.id, role: "manager" }],
		});
		driveId = drive.id;
		const accessOf = async () =>
			(await (await admin.request.get(`/api/v1/directory/agents/${agent.id}/access`)).json()) as { scopes: string[] };
		const { scopes } = await accessOf();

		const page = await admin.newPage();
		await page.goto("/admin/shared-drives");
		const card = page.locator("details.admin-card").filter({ hasText: name });
		await card.locator("summary").click();

		// The form tells that the role alone decides for an agent. The role of the form is Editor.
		await card.getByRole("combobox", { name: "Add a member" }).click();
		await page.getByRole("option", { name: new RegExp(`^${agentName}`) }).click();
		await expect(card.getByText("The role alone decides what this account can do", { exact: false })).toBeVisible();
		await card.getByRole("button", { name: "Add member" }).click();
		await expect(page.getByText(`${agentName} is now a member of ${name}.`)).toBeVisible();
		await expect(page.getByText("now also holds", { exact: false })).toHaveCount(0);
		expect(await accessOf()).toMatchObject({ scopes, shared_drives: [{ id: drive.id, role: "editor" }] });

		// The admin removes the agent. The membership ends, and the account still does not change.
		await card.getByRole("button", { name: `Remove ${agentName} from ${name}` }).click();
		await page.getByRole("button", { name: "Remove member" }).click();
		await expect(page.getByText(`${agentName} is no longer a member of ${name}.`)).toBeVisible();
		expect(await accessOf()).toMatchObject({ scopes, shared_drives: [] });
	} finally {
		const headers = { origin: BASE_URL };
		if (driveId) await admin.request.delete(`/api/v1/drive/shared-drives/${driveId}`, { headers });
		if (agentId) await admin.request.delete(`/api/v1/directory/principals/${agentId}`, { headers });
		await admin.close();
	}
});
