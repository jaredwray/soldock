import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type Actor,
	AI_ACCOUNT_ID,
	AI_GATEWAY_ID,
	AI_GATEWAY_URL,
	AI_MODEL,
	api,
	callTool,
	codeOf,
	createActor,
	enableAi,
	fakeGateway,
	gatewayAnswer,
	mcp,
	ORIGIN,
	PASSWORD,
	request,
	seedOrg,
	withEnv,
} from "./helpers.ts";

// Admin › AI: an owner or an admin connects the AI Gateway, turns on AI, allows models and sets the budget.
// No person without the role, no agent and no service account reads or changes these settings, because
// they decide what the organization spends.

let owner: Actor;
let ada: Actor;
let bot: Actor;
let admin: Actor;

beforeEach(async () => {
	({ owner, ada, bot } = await seedOrg());
	admin = await createActor(owner, {
		kind: "human",
		display_name: "Alan Admin",
		address: "alan@dock.test",
		org_role: "admin",
		password: PASSWORD,
	});
	await env.DIRECTORY.prepare("DELETE FROM ai_usage").run();
	await env.DIRECTORY.prepare(
		"UPDATE ai_settings SET enabled = 0, account_id = NULL, gateway_id = NULL, allowed_models = '[]', monthly_budget_micro_usd = 10000000, auto_label_enabled = 0, auto_label_model = NULL, api_token = NULL",
	).run();
});

afterEach(() => {
	vi.restoreAllMocks();
});

const toolNames = async (key: string) =>
	(((await mcp(key, "tools/list")).body?.result ?? { tools: [] }) as { tools: { name: string }[] }).tools.map(
		(tool) => tool.name,
	);

describe("the AI settings", () => {
	it("start off, and let owners and admins read and change them", async () => {
		expect(await owner.call("ai.get_settings")).toEqual({
			enabled: false,
			account_id: null,
			gateway_id: null,
			token_configured: true,
			token_source: "secret",
			ready: false,
			not_ready_reason: "off",
			allowed_models: [],
			monthly_budget_usd: 10,
			features: { mail_auto_label: { enabled: false, model: null } },
			price_date: expect.any(String),
		});
		const saved = await enableAi(admin);
		expect(saved).toMatchObject({
			enabled: true,
			account_id: AI_ACCOUNT_ID,
			gateway_id: AI_GATEWAY_ID,
			ready: true,
			not_ready_reason: null,
			allowed_models: [AI_MODEL],
			features: { mail_auto_label: { enabled: true, model: AI_MODEL } },
		});
		expect(await owner.call("ai.get_settings")).toEqual(saved);
		// MCP gives the same settings as REST.
		expect((await callTool(owner.key, "ai_get_settings")).structuredContent).toEqual(saved);
	});

	it("refuse a member, an agent and a service account, and hide the tools from an agent", async () => {
		for (const name of ["ai.get_settings", "ai.get_usage"] as const) {
			expect(await codeOf(ada.call(name, {}))).toBe("forbidden");
			expect(await codeOf(bot.call(name, {}))).toBe("forbidden");
		}
		expect(await codeOf(ada.call("ai.update_settings", { enabled: false }))).toBe("forbidden");
		expect(await codeOf(ada.call("ai.test_connection", {}))).toBe("forbidden");
		expect(await codeOf(bot.call("ai.update_settings", { enabled: false }))).toBe("forbidden");
		expect(await codeOf(bot.call("ai.test_connection", {}))).toBe("forbidden");
		expect((await toolNames(bot.key)).filter((name) => name.startsWith("ai_"))).toEqual([]);
		expect((await toolNames(owner.key)).filter((name) => name.startsWith("ai_")).sort()).toEqual([
			"ai_get_settings",
			"ai_get_usage",
			"ai_test_connection",
			"ai_update_settings",
		]);

		const { principal: service } = await owner.call("directory.create_service_account", {
			display_name: "CI Pipeline",
			address: "ci@dock.test",
			sponsor_id: ada.id,
			scopes: ["directory.read", "mail.read"],
		});
		const { api_key } = await owner.call("account.create_api_key", { principal_id: service.id, label: "ci" });
		expect(await codeOf(api(api_key.secret)("ai.get_settings", {}))).toBe("forbidden");
	});

	it("follow the scopes of the key of an admin: directory.read reads, directory.write changes", async () => {
		const { api_key: reader } = await admin.call("account.create_api_key", {
			principal_id: admin.id,
			label: "read only",
			scopes: ["directory.read"],
		});
		expect((await api(reader.secret)("ai.get_settings", {})).enabled).toBe(false);
		expect(await codeOf(api(reader.secret)("ai.update_settings", { enabled: false }))).toBe("forbidden");
		expect(await codeOf(api(reader.secret)("ai.test_connection", {}))).toBe("forbidden");
		const { api_key: mailOnly } = await admin.call("account.create_api_key", {
			principal_id: admin.id,
			label: "mail only",
			scopes: ["mail.read"],
		});
		expect(await codeOf(api(mailOnly.secret)("ai.get_settings", {}))).toBe("forbidden");
	});

	it("change only the named settings", async () => {
		await enableAi(owner);
		const changed = await owner.call("ai.update_settings", { monthly_budget_usd: 25.5 });
		expect(changed).toMatchObject({ enabled: true, monthly_budget_usd: 25.5, allowed_models: [AI_MODEL] });
		const off = await owner.call("ai.update_settings", { features: { mail_auto_label: { enabled: false } } });
		expect(off.features.mail_auto_label).toEqual({ enabled: false, model: AI_MODEL });
		expect(off.monthly_budget_usd).toBe(25.5);
	});

	it("keep both changes when two admins save at the same time", async () => {
		await enableAi(owner);
		const [budget, feature] = await Promise.all([
			owner.call("ai.update_settings", { monthly_budget_usd: 42 }),
			admin.call("ai.update_settings", { features: { mail_auto_label: { enabled: false } } }),
		]);
		expect(budget.monthly_budget_usd).toBe(42);
		expect(feature.features.mail_auto_label.enabled).toBe(false);
		const settings = await owner.call("ai.get_settings", {});
		expect(settings.monthly_budget_usd).toBe(42);
		expect(settings.features.mail_auto_label.enabled).toBe(false);
	});

	it("refuse settings that cannot work", async () => {
		// On without a gateway, or without a model.
		expect(await codeOf(owner.call("ai.update_settings", { enabled: true }))).toBe("invalid");
		expect(
			await codeOf(
				owner.call("ai.update_settings", { enabled: true, account_id: AI_ACCOUNT_ID, gateway_id: AI_GATEWAY_ID }),
			),
		).toBe("invalid");
		// A feature with a model that is not allowed, or with no model.
		expect(
			await codeOf(
				owner.call("ai.update_settings", {
					allowed_models: [AI_MODEL],
					features: { mail_auto_label: { enabled: true, model: "@cf/meta/llama-3.1-8b-instruct-fast" } },
				}),
			),
		).toBe("invalid");
		expect(await codeOf(owner.call("ai.update_settings", { features: { mail_auto_label: { enabled: true } } }))).toBe(
			"invalid",
		);
		// The contract refuses a model outside the catalog and an id that could change the URL.
		const res = await owner.call("ai.update_settings", { gateway_id: "a/../../b" }).catch((error: unknown) => error);
		expect(res).toMatchObject({ code: "invalid" });
		// A refused change saves nothing.
		expect((await owner.call("ai.get_settings")).enabled).toBe(false);
	});

	it("tell whether the token secret exists, and never return it", async () => {
		const settings = await enableAi(owner);
		expect(JSON.stringify(settings)).not.toContain("test-ai-gateway-token");
		const res = await withEnv({ AI_GATEWAY_TOKEN: undefined }, "/api/v1/ai/settings", {
			headers: { authorization: `Bearer ${owner.key}`, origin: ORIGIN },
		});
		expect(await res.json()).toMatchObject({
			token_configured: false,
			token_source: null,
			ready: false,
			not_ready_reason: "no_token",
		});
	});

	it("keep an API token from Admin, use it before the Worker secret, and never return it", async () => {
		const token = "settings-token_0123456789-abcdef";
		// Each line that the Worker writes in this test: no line may hold the token.
		const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
		const lines = () => spies.flatMap((spy) => spy.mock.calls.map((args) => args.map(String).join(" ")));
		await enableAi(owner);

		// Saved through MCP: the answer says where the token comes from, never the token.
		const viaMcp = await callTool(owner.key, "ai_update_settings", { api_token: token });
		expect(viaMcp.structuredContent).toMatchObject({ token_configured: true, token_source: "settings", ready: true });
		expect(JSON.stringify(viaMcp)).not.toContain(token);
		expect(JSON.stringify(await owner.call("ai.get_settings"))).not.toContain(token);
		expect(JSON.stringify(await callTool(owner.key, "ai_get_settings"))).not.toContain(token);
		// A later change that does not name the token keeps it.
		expect(await owner.call("ai.update_settings", { monthly_budget_usd: 20 })).toMatchObject({
			token_source: "settings",
		});

		// The token of the settings wins over the Worker secret, and works without it.
		const calls = fakeGateway(() => gatewayAnswer("OK"));
		await owner.call("ai.test_connection", {});
		expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${token}`);
		expect(calls[0]?.headers.get("cf-aig-authorization")).toBe(`Bearer ${token}`);
		const res = await withEnv({ AI_GATEWAY_TOKEN: undefined }, "/api/v1/ai/settings", {
			headers: { authorization: `Bearer ${owner.key}`, origin: ORIGIN },
		});
		expect(await res.json()).toMatchObject({ token_configured: true, token_source: "settings", ready: true });

		// A value that could break a header is refused, and the error does not repeat it.
		const bad = `${token} x`;
		const refused = await request("/api/v1/ai/settings", {
			method: "POST",
			headers: { authorization: `Bearer ${owner.key}`, origin: ORIGIN, "content-type": "application/json" },
			body: JSON.stringify({ api_token: bad }),
		});
		expect(refused.status).toBe(400);
		expect(await refused.text()).not.toContain(token);
		const refusedMcp = await callTool(owner.key, "ai_update_settings", { api_token: bad });
		expect(refusedMcp.isError).toBe(true);
		expect(JSON.stringify(refusedMcp)).not.toContain(token);

		// Null removes it: the Worker secret is in use again. A second removal changes nothing.
		expect(await owner.call("ai.update_settings", { api_token: null })).toMatchObject({ token_source: "secret" });
		await owner.call("ai.update_settings", { api_token: null });

		const written = lines();
		expect(written.filter((line) => line.includes(token))).toEqual([]);
		const targets = written
			.filter((line) => line.startsWith("{") && line.includes('"audit":true'))
			.map((line) => (JSON.parse(line) as { target?: string }).target);
		expect(targets.filter((target) => target === "api_token_set")).toHaveLength(1);
		expect(targets.filter((target) => target === "api_token_removed")).toHaveLength(1);
	});
});

describe("the connection test", () => {
	it("sends one request to the gateway with the token, the metadata and the Workers AI model", async () => {
		await enableAi(owner);
		const calls = fakeGateway(() => gatewayAnswer("OK", { prompt_tokens: 30, completion_tokens: 1 }));
		const result = await owner.call("ai.test_connection", {});
		expect(result).toMatchObject({ ok: true, status: 200, model: AI_MODEL, reason: null, detail: null });
		expect(calls).toHaveLength(1);
		const [call] = calls;
		expect(call?.url).toBe(AI_GATEWAY_URL);
		expect(call?.headers.get("authorization")).toBe("Bearer test-ai-gateway-token");
		expect(call?.headers.get("cf-aig-authorization")).toBe("Bearer test-ai-gateway-token");
		expect(JSON.parse(call?.headers.get("cf-aig-metadata") ?? "{}")).toEqual({
			feature: "connection_test",
			resource: owner.id,
		});
		expect(call?.body).toMatchObject({ model: `workers-ai/${AI_MODEL}`, temperature: 0 });
		// The call is in the ledger, for the person who tested.
		const usage = await owner.call("ai.get_usage", {});
		expect(usage.by_feature).toEqual([{ feature: "connection_test", cost_usd: expect.any(Number), requests: 1 }]);
		expect(usage.top_resources[0]).toMatchObject({ resource_id: owner.id, kind: "personal", requests: 1 });
	});

	it("works while AI is off, and reports a refusal of the gateway with its status", async () => {
		await owner.call("ai.update_settings", {
			account_id: AI_ACCOUNT_ID,
			gateway_id: AI_GATEWAY_ID,
			allowed_models: [AI_MODEL],
		});
		fakeGateway(() => new Response("Authentication error: the token is not valid", { status: 401 }));
		const result = await owner.call("ai.test_connection", {});
		expect(result).toMatchObject({ ok: false, status: 401, reason: "http", detail: expect.stringContaining("token") });
		const usage = await owner.call("ai.get_usage", {});
		expect(usage).toMatchObject({ requests: 1, failures: 1, cost_usd: 0 });
	});

	it("reports a request that did not reach the gateway, and counts it as a failed request", async () => {
		await enableAi(owner);
		fakeGateway(() => {
			throw new TypeError("Network connection lost.");
		});
		const result = await owner.call("ai.test_connection", {});
		expect(result).toMatchObject({ ok: false, status: null, reason: "http", model: AI_MODEL });
		expect(await owner.call("ai.get_usage", {})).toMatchObject({ requests: 1, failures: 1, cost_usd: 0 });
	});

	it("keeps the test of a reasoning model small, and accepts its answer with no text", async () => {
		await enableAi(owner);
		// A reasoning model can use the tokens of a small answer to reason: the content is null then.
		const calls = fakeGateway(() => gatewayAnswer(null));
		const result = await owner.call("ai.test_connection", { model: "@cf/openai/gpt-oss-120b" });
		expect(result).toMatchObject({ ok: true, status: 200 });
		// The test does not stop at the budget, so it does not get the 1,200 tokens of a feature call.
		expect(calls.map((call) => call.body.max_tokens)).toEqual([64]);
		// Other JSON with status 200 is not an answer, so it proves nothing: an error, or a message with no content.
		for (const body of [{ error: "the model is not available" }, { choices: [{ message: {} }] }]) {
			vi.restoreAllMocks();
			fakeGateway(() => Response.json(body));
			expect(await owner.call("ai.test_connection", { model: "@cf/openai/gpt-oss-120b" })).toMatchObject({
				ok: false,
				reason: "bad_response",
			});
		}
		// Only a reasoning model can answer with no text.
		vi.restoreAllMocks();
		fakeGateway(() => gatewayAnswer(null));
		expect(await owner.call("ai.test_connection", {})).toMatchObject({ ok: false, reason: "bad_response" });
	});

	it("sends nothing without a gateway or without the token", async () => {
		const calls = fakeGateway();
		expect(await owner.call("ai.test_connection", {})).toMatchObject({ ok: false, reason: "no_gateway", status: null });
		await owner.call("ai.update_settings", { account_id: AI_ACCOUNT_ID, gateway_id: AI_GATEWAY_ID });
		const res = await withEnv({ AI_GATEWAY_TOKEN: undefined }, "/api/v1/ai/test", {
			method: "POST",
			headers: { authorization: `Bearer ${owner.key}`, origin: ORIGIN, "content-type": "application/json" },
			body: "{}",
		});
		expect(await res.json()).toMatchObject({ ok: false, reason: "no_token" });
		expect(calls).toHaveLength(0);
	});
});
