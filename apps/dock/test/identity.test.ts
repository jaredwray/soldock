import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { ApiError } from "@soldock/contracts";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { api, callTool, createActor, mcp, ORIGIN, request, SETUP_TOKEN, seedOrg, setupOwner } from "./helpers.ts";

async function denied(promise: Promise<unknown>): Promise<string> {
	const error = await promise.then(
		() => null,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(ApiError);
	return (error as ApiError).code;
}

function setup(token: string, body: unknown) {
	return request("/auth/setup", {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function signIn(key: string, origin: string | null = ORIGIN) {
	return request("/auth/session", {
		method: "POST",
		headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
		body: JSON.stringify({ api_key: key }),
	});
}

function cookieOf(res: Response): string {
	return (res.headers.get("set-cookie") ?? "").split(";")[0] as string;
}

describe("first-run setup", () => {
	it("creates the owner once, only with the setup token, and only on a mail domain", async () => {
		expect((await setup("wrong", { display_name: "X", address: "x@dock.test" })).status).toBe(401);
		expect((await setup(SETUP_TOKEN, { display_name: "X", address: "x@elsewhere.example" })).status).toBe(400);
		const owner = await setupOwner();
		expect(await owner.call("account.whoami")).toMatchObject({
			principal: { kind: "human", org_role: "owner", address: "owner@dock.test" },
			credential: "api_key",
		});
		const again = await setup(SETUP_TOKEN, { display_name: "Mallory", address: "mallory@dock.test" });
		expect(again.status).toBe(409);
	});

	it("is off while the SETUP_TOKEN secret is not set", async () => {
		const noToken = { ...env, SETUP_TOKEN: undefined } as unknown as Env;
		const res = await (worker as unknown as Required<Pick<ExportedHandler<Env>, "fetch">>).fetch(
			new Request(`${ORIGIN}/auth/setup`, { method: "POST", headers: { authorization: "Bearer " } }),
			noToken,
			createExecutionContext(),
		);
		expect(res.status).toBe(503);
	});
});

describe("credentials", () => {
	it("answers a request without a valid key with 401 and a Bearer challenge", async () => {
		for (const authorization of [undefined, "Bearer sdk_not-a-key", "Basic abc"]) {
			const res = await request("/api/v1/account", authorization ? { headers: { authorization } } : {});
			expect(res.status).toBe(401);
			expect(res.headers.get("www-authenticate")).toBe('Bearer realm="soldock"');
		}
	});

	it("stops accepting a key as soon as it is revoked", async () => {
		const owner = await setupOwner();
		const { api_key } = await owner.call("account.create_api_key", { label: "temp", scopes: ["account.read"] });
		const temp = api(api_key.secret);
		await temp("account.whoami");
		await owner.call("account.revoke_api_key", { key_id: api_key.id });
		expect(await denied(temp("account.whoami"))).toBe("unauthenticated");
	});

	it("limits a key to its scopes, and a narrow key cannot mint a wider one", async () => {
		const owner = await setupOwner();
		const { api_key } = await owner.call("account.create_api_key", {
			label: "narrow",
			scopes: ["account.keys", "mail.read"],
		});
		const narrow = api(api_key.secret);
		await narrow("mail.list_threads");
		expect(await denied(narrow("mail.create_label", { name: "x" }))).toBe("forbidden");
		expect(await denied(narrow("account.create_api_key", { label: "wide", scopes: ["mail.send"] }))).toBe("forbidden");
	});
});

describe("browser sessions", () => {
	it("signs a human in with a key, and the cookie is HttpOnly, Secure, SameSite=Lax and host-only", async () => {
		const owner = await setupOwner();
		const res = await signIn(owner.key);
		expect(res.status).toBe(204);
		const cookie = res.headers.get("set-cookie") ?? "";
		expect(cookie).toMatch(
			/^__Host-soldock_session=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=\d+$/,
		);
		const whoami = await request("/api/v1/account", { headers: { cookie: cookieOf(res) } });
		expect(await whoami.json()).toMatchObject({ credential: "session", principal: { id: owner.id } });
	});

	// A narrow key must not become a full session: that would let a read-only key mint a full key.
	it("gives a session the scopes of the key that signed in, and no more", async () => {
		const owner = await setupOwner();
		const { api_key } = await owner.call("account.create_api_key", {
			label: "reader",
			scopes: ["account.read", "mail.read"],
		});
		const cookie = cookieOf(await signIn(api_key.secret));
		const whoami = await request("/api/v1/account", { headers: { cookie } });
		expect(((await whoami.json()) as { scopes: string[] }).scopes.sort()).toEqual(["account.read", "mail.read"]);
		const mint = await request("/api/v1/account/api-keys", {
			method: "POST",
			headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
			body: JSON.stringify({ label: "full", scopes: ["mail.send"] }),
		});
		expect(mint.status).toBe(403);
	});

	it("refuses a sign-in from another origin, with a bad key, or with an agent key", async () => {
		const { owner, bot } = await seedOrg();
		expect((await signIn(owner.key, "https://evil.example")).status).toBe(403);
		expect((await signIn(owner.key, null)).status).toBe(403);
		expect((await signIn("sdk_wrong")).status).toBe(401);
		expect((await signIn(bot.key)).status).toBe(403);
	});

	// SameSite=Lax still sends the cookie on some cross-site requests, so changes also need the Origin.
	it("refuses a change made with the cookie unless it comes from this origin", async () => {
		const owner = await setupOwner();
		const cookie = cookieOf(await signIn(owner.key));
		const create = (headers: Record<string, string>) =>
			request("/api/v1/mail/labels", {
				method: "POST",
				headers: { cookie, "content-type": "application/json", ...headers },
				body: JSON.stringify({ name: "Receipts" }),
			});
		expect((await create({})).status).toBe(403);
		expect((await create({ origin: "https://evil.example" })).status).toBe(403);
		expect((await create({ origin: ORIGIN })).status).toBe(200);
	});

	it("ends the session on sign-out", async () => {
		const owner = await setupOwner();
		const cookie = cookieOf(await signIn(owner.key));
		const out = await request("/auth/sign-out", { method: "POST", headers: { cookie, origin: ORIGIN } });
		expect(out.status).toBe(204);
		expect(out.headers.get("set-cookie")).toMatch(/Max-Age=0/);
		expect((await request("/api/v1/account", { headers: { cookie } })).status).toBe(401);
	});
});

describe("directory authorization", () => {
	it("lets only owners and admins create principals", async () => {
		const { owner, ada, bot } = await seedOrg();
		const input = { kind: "human", display_name: "Eve", address: "eve@dock.test" } as const;
		expect(await denied(ada.call("directory.create_principal", input))).toBe("forbidden");
		expect(await denied(bot.call("directory.create_principal", input))).toBe("forbidden");
		const admin = await createActor(owner, {
			kind: "human",
			display_name: "Ann Admin",
			address: "ann@dock.test",
			org_role: "admin",
		});
		await admin.call("directory.create_principal", input);
	});

	it("gives a new agent a human sponsor and the internal-only policy, and validates the address", async () => {
		const owner = await setupOwner();
		const { principal } = await owner.call("directory.create_principal", {
			kind: "agent",
			display_name: "Helper",
			address: "helper@dock.test",
		});
		expect(principal).toMatchObject({
			kind: "agent",
			org_role: null,
			sponsor_id: owner.id,
			outbound_policy: { mode: "internal-only", allowlist: [] },
		});
		const create = (address: string) =>
			owner.call("directory.create_principal", { kind: "human", display_name: "X", address });
		expect(await denied(create("x@not-ours.example"))).toBe("invalid");
		expect(await denied(create("x+tag@dock.test"))).toBe("invalid");
		expect(await denied(create("HELPER@dock.test"))).toBe("conflict");
		expect(
			await denied(
				owner.call("directory.create_principal", {
					kind: "agent",
					display_name: "Y",
					address: "y@dock.test",
					sponsor_id: principal.id,
				}),
			),
		).toBe("invalid");
	});

	it("lets the sponsor and admins change an agent's policy, and never the agent or another member", async () => {
		const { owner, ada, bot } = await seedOrg();
		const other = await createActor(owner, { kind: "human", display_name: "Bob", address: "bob@dock.test" });
		const change = (mode: "any" | "internal-only") => ({ principal_id: bot.id, mode });
		await ada.call("directory.update_agent_policy", change("any"));
		await owner.call("directory.update_agent_policy", change("internal-only"));
		expect(await denied(other.call("directory.update_agent_policy", change("any")))).toBe("forbidden");
		expect(await denied(bot.call("directory.update_agent_policy", change("any")))).toBe("forbidden");
		// The MCP surface does not offer the tool to the agent, and refuses a direct call.
		const tool = await mcp(bot.key, "tools/call", {
			name: "directory_update_agent_policy",
			arguments: change("any"),
		});
		expect(tool.body).toMatchObject({ error: { code: -32602 } });
		const { principals } = await owner.call("directory.list_principals");
		expect(principals.find((p) => p.id === bot.id)?.outbound_policy?.mode).toBe("internal-only");
	});

	it("lets the sponsor manage an agent's keys within agent scopes, and nobody else but admins", async () => {
		const { ada, bot, owner } = await seedOrg();
		const other = await createActor(owner, { kind: "human", display_name: "Bob", address: "bob@dock.test" });
		const { api_key } = await ada.call("account.create_api_key", {
			principal_id: bot.id,
			label: "reader",
			scopes: ["mail.read"],
		});
		expect(api_key.principal_id).toBe(bot.id);
		expect(
			await denied(
				ada.call("account.create_api_key", { principal_id: bot.id, label: "x", scopes: ["directory.write"] }),
			),
		).toBe("invalid");
		expect(
			await denied(other.call("account.create_api_key", { principal_id: bot.id, label: "x", scopes: ["mail.read"] })),
		).toBe("forbidden");
		expect(await denied(other.call("account.list_api_keys", { principal_id: ada.id }))).toBe("forbidden");
		expect(await denied(other.call("account.revoke_api_key", { key_id: api_key.id }))).toBe("forbidden");
		// An agent has no account.keys scope at all, so it cannot mint or revoke keys.
		expect(await denied(bot.call("account.list_api_keys"))).toBe("forbidden");
		const tool = await callTool(owner.key, "account_list_api_keys", { principal_id: bot.id });
		expect((tool.structuredContent?.api_keys ?? []) as unknown[]).toHaveLength(2);
	});
});
