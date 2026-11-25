import type { APIRequestContext, BrowserContext } from "@playwright/test";
import { expect } from "@playwright/test";
import { BASE_URL } from "./server.ts";

const JSON_HEADERS = { origin: BASE_URL, "content-type": "application/json" };

/** An agent of the directory, and its REST calls. */
export interface Agent {
	id: string;
	/** Calls the REST API as the agent, with its first API key. */
	get: (path: string) => ReturnType<APIRequestContext["get"]>;
	post: (path: string, data: unknown) => ReturnType<APIRequestContext["post"]>;
}

/** A new agent of the admin. The admin is its sponsor. Its memberships decide what it can do in a resource. */
export async function createAgent(admin: BrowserContext, request: APIRequestContext, name: string): Promise<Agent> {
	const local = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	const response = await admin.request.post("/api/v1/directory/principals", {
		headers: JSON_HEADERS,
		data: { kind: "agent", display_name: name, address: `bot-${local}@example.com` },
	});
	expect(response.ok(), `the new agent ${name}: ${response.status()} ${await response.text()}`).toBe(true);
	const created = (await response.json()) as { principal: { id: string }; api_key: { secret: string } };
	// The calls of the agent have no session cookie: only the key.
	const headers = { authorization: `Bearer ${created.api_key.secret}`, "content-type": "application/json" };
	return {
		id: created.principal.id,
		get: (path) => request.get(path, { headers }),
		post: (path, data) => request.post(path, { headers, data }),
	};
}

/** Deletes the agents of a test, as the admin that created them. */
export async function deleteAgents(admin: BrowserContext, ids: readonly string[]): Promise<void> {
	for (const id of ids) {
		await admin.request.delete(`/api/v1/directory/principals/${id}`, { headers: { origin: BASE_URL } });
	}
}
