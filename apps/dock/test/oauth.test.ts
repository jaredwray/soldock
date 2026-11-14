import { env } from "cloudflare:workers";
import { UNTRUSTED_NOTICE } from "@soldock/contracts";
import { describe, expect, it } from "vitest";
import {
	type Actor,
	api,
	callTool,
	codeOf,
	createActor,
	mcp,
	ORIGIN,
	PASSWORD,
	request,
	SETUP_TOKEN,
	seedOrg,
	setupOwner,
	signIn,
} from "./helpers.ts";

const REDIRECT = "http://localhost:33418/callback";

function base64Url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

/** A PKCE verifier and its S256 challenge, as an MCP client makes them. */
async function pkce() {
	const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
	return { verifier, challenge: base64Url(digest) };
}

function register(body: unknown) {
	return request("/oauth/register", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function registerClient(redirectUris: string[] = [REDIRECT]): Promise<string> {
	const res = await register({ client_name: "Claude Code", redirect_uris: redirectUris });
	expect(res.status).toBe(201);
	return ((await res.json()) as { client_id: string }).client_id;
}

function authorize(params: Record<string, string>) {
	return request(`/oauth/authorize?${new URLSearchParams(params)}`, { redirect: "manual" });
}

/** Starts an authorization as a client does, and returns the id of the request that waits for a person. */
async function startAuthorization(clientId: string, scope = "mail.read chat.read openid") {
	const { verifier, challenge } = await pkce();
	const res = await authorize({
		response_type: "code",
		client_id: clientId,
		redirect_uri: REDIRECT,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: "client-state",
		scope,
		resource: `${ORIGIN}/mcp`,
	});
	expect(res.status).toBe(302);
	const location = res.headers.get("location") ?? "";
	expect(location).toMatch(/^\/connect\/oar_[0-9A-Z]{26}$/);
	return { requestId: location.slice("/connect/".length), verifier };
}

function token(params: Record<string, string>) {
	return request("/oauth/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(params).toString(),
	});
}

interface Tokens {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	scope: string;
	token_type: string;
}

async function exchange(clientId: string, redirectTo: string, verifier: string) {
	const code = new URL(redirectTo).searchParams.get("code") ?? "";
	return token({
		grant_type: "authorization_code",
		code,
		code_verifier: verifier,
		client_id: clientId,
		redirect_uri: REDIRECT,
	});
}

function refresh(clientId: string, refreshToken: string) {
	return token({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });
}

/** The whole flow: a client registers, `approver` approves it for a new agent, and the client gets tokens. */
async function connectNewAgent(approver: Actor, address = "claude@dock.test") {
	const clientId = await registerClient();
	const { requestId, verifier } = await startAuthorization(clientId);
	const approved = await approver.call("oauth.approve_authorization", {
		request_id: requestId,
		new_agent: { display_name: "Claude", address },
		scopes: ["account.read", "mail.read", "chat.read"],
	});
	const res = await exchange(clientId, approved.redirect_to, verifier);
	expect(res.status).toBe(200);
	return { clientId, agent: approved.principal, tokens: (await res.json()) as Tokens };
}

const toolNames = (body: Record<string, unknown> | null) =>
	((body?.result ?? { tools: [] }) as { tools: { name: string }[] }).tools.map((tool) => tool.name).sort();

describe("OAuth discovery", () => {
	// An MCP client gets only the URL of /mcp. The 401 must lead it to the metadata (RFC 9728).
	it("names the metadata in the 401 of /mcp, and serves the metadata of the resource and the server", async () => {
		const res = await request("/mcp", { method: "POST", body: "{}" });
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toBe(
			`Bearer realm="soldock", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
		);
		const stale = await request("/mcp", { method: "POST", headers: { authorization: "Bearer sdo_expired" } });
		expect(stale.status).toBe(401);
		expect(stale.headers.get("www-authenticate")).toContain('error="invalid_token"');

		const resource = await request("/.well-known/oauth-protected-resource/mcp");
		expect(await resource.json()).toMatchObject({
			resource: `${ORIGIN}/mcp`,
			authorization_servers: [ORIGIN],
			bearer_methods_supported: ["header"],
		});
		expect(await (await request("/.well-known/oauth-protected-resource")).json()).toMatchObject({ resource: ORIGIN });
		expect(await (await request("/.well-known/oauth-authorization-server")).json()).toMatchObject({
			issuer: ORIGIN,
			authorization_endpoint: `${ORIGIN}/oauth/authorize`,
			token_endpoint: `${ORIGIN}/oauth/token`,
			registration_endpoint: `${ORIGIN}/oauth/register`,
			grant_types_supported: ["authorization_code", "refresh_token"],
			token_endpoint_auth_methods_supported: ["none"],
			code_challenge_methods_supported: ["S256"],
		});
	});
});

describe("OAuth client registration", () => {
	it("registers a public client with loopback, https and app redirect URIs", async () => {
		const res = await register({
			client_name: "Claude\u0000 Code",
			redirect_uris: [REDIRECT, "https://claude.example/callback", "cursor://anysphere.cursor/oauth"],
			token_endpoint_auth_method: "client_secret_post",
		});
		expect(res.status).toBe(201);
		expect(await res.json()).toMatchObject({
			client_id: expect.stringMatching(/^cli_/),
			client_name: "Claude Code",
			token_endpoint_auth_method: "none",
			grant_types: ["authorization_code", "refresh_token"],
		});
	});

	// The web app sends the browser to the redirect URI. A javascript: URI would run code on this origin.
	it("refuses a redirect URI that can run code, leaves loopback over http, or has a fragment", async () => {
		for (const redirectUris of [
			["javascript:alert(1)"],
			["data:text/html,hi"],
			["http://attacker.example/callback"],
			["https://claude.example/callback#x"],
			["https://user:pass@claude.example/callback"],
			["ms-msdt:/id PCWDiagnostic"],
			["tel:+15551234567"],
			["/relative"],
			[],
			"https://claude.example/callback",
		]) {
			const res = await register({ redirect_uris: redirectUris });
			expect(res.status, JSON.stringify(redirectUris)).toBe(400);
			expect(await res.json()).toMatchObject({ error: "invalid_redirect_uri" });
		}
	});

	// Anybody can register, so idle registrations must not stay, but a client must keep its id for weeks.
	it("keeps a registration for 30 days after its last use, and keeps a client with a grant", async () => {
		const owner = await setupOwner();
		const idle = await registerClient();
		const recent = await registerClient();
		const { clientId: connected } = await connectNewAgent(owner);
		const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
		await env.DIRECTORY.prepare("UPDATE oauth_clients SET created_at = ?, last_used_at = NULL").bind(old).run();
		await env.DIRECTORY.prepare("DELETE FROM oauth_requests").run();
		await env.DIRECTORY.prepare("UPDATE oauth_clients SET last_used_at = ? WHERE id = ?")
			.bind(new Date().toISOString(), recent)
			.run();
		await registerClient();
		const ids = (await env.DIRECTORY.prepare("SELECT id FROM oauth_clients").all<{ id: string }>()).results.map(
			(row) => row.id,
		);
		expect(ids).not.toContain(idle);
		expect(ids).toContain(recent);
		expect(ids).toContain(connected);
	});

	// Unauthenticated writes must not fill the directory database of the whole deployment.
	it("keeps at most 1,000 clients without a grant and 1,000 requests, and removes the oldest first", async () => {
		const seed = (table: string, sql: string) =>
			env.DIRECTORY.prepare(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000) INSERT INTO ${table} ${sql}`,
			).run();
		await seed(
			"oauth_clients (id, name, redirect_uris, created_at)",
			`SELECT 'cli_seed_' || i, 'Seed', '[]', '${new Date(Date.now() - 60 * 60 * 1000).toISOString()}' FROM n`,
		);
		const clientId = await registerClient();
		const clients = await env.DIRECTORY.prepare("SELECT COUNT(*) AS n FROM oauth_clients").first<number>("n");
		expect(clients).toBe(1000);
		await seed(
			"oauth_requests (id, client_id, redirect_uri, code_challenge, scopes, created_at, expires_at)",
			`SELECT 'oar_seed_' || i, '${clientId}', '${REDIRECT}', 'x', '[]', '2026-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z' FROM n`,
		);
		const { requestId } = await startAuthorization(clientId);
		const requests = await env.DIRECTORY.prepare("SELECT COUNT(*) AS n FROM oauth_requests").first<number>("n");
		expect(requests).toBe(1000);
		const owner = await setupOwner();
		expect((await owner.call("oauth.get_authorization", { request_id: requestId })).authorization.id).toBe(requestId);
	});
});

describe("OAuth authorization requests", () => {
	// Anybody can register a redirect URI. A redirect before a person acts would make this origin an open
	// redirect, and a redirect to an address that the client did not register could leak the code.
	it("shows each error to the person, and never redirects before a person acts", async () => {
		const clientId = await registerClient();
		const { challenge } = await pkce();
		const base = {
			response_type: "code",
			client_id: clientId,
			redirect_uri: REDIRECT,
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: "s1",
		};
		for (const params of [
			{ ...base, client_id: "cli_unknown" },
			{ ...base, redirect_uri: "http://localhost:9999/other" },
			{ ...base, redirect_uri: "" },
			{ ...base, response_type: "token" },
			{ ...base, response_type: "" },
			{ ...base, code_challenge_method: "plain" },
			{ ...base, code_challenge: "" },
			{ ...base, state: "s".repeat(1001) },
			{ ...base, resource: "https://other.example/mcp" },
		]) {
			const res = await authorize(params);
			expect(res.status, JSON.stringify(params)).toBe(400);
			expect(res.headers.get("location")).toBeNull();
			expect(res.headers.get("content-type")).toContain("text/plain");
		}
	});
});

describe("OAuth approval", () => {
	it("lets an admin approve a request for a new agent with an address and scopes, and the client acts as that agent", async () => {
		const owner = await setupOwner();
		const clientId = await registerClient();
		const { requestId, verifier } = await startAuthorization(clientId);

		const { authorization } = await owner.call("oauth.get_authorization", { request_id: requestId });
		expect(authorization).toMatchObject({
			client: { id: clientId, name: "Claude Code", uri: null },
			redirect_uri: REDIRECT,
			redirect_host: "localhost:33418",
			requested_scopes: ["mail.read", "chat.read"],
		});
		expect(authorization.untrusted).toBe(true);
		// Parity: the MCP tool returns the same request. The client wrote its name, so a notice comes first.
		const viaMcp = await callTool(owner.key, "oauth_get_authorization", { request_id: requestId });
		expect(viaMcp.structuredContent).toEqual({ authorization });
		expect(viaMcp.content[0]?.text).toBe(UNTRUSTED_NOTICE);

		const approved = await owner.call("oauth.approve_authorization", {
			request_id: requestId,
			new_agent: { display_name: "Claude", address: "claude@dock.test" },
			scopes: ["account.read", "mail.read", "chat.read"],
		});
		expect(approved.principal).toMatchObject({
			kind: "agent",
			address: "claude@dock.test",
			sponsor_id: owner.id,
			outbound_policy: { mode: "internal-only" },
		});
		const redirect = new URL(approved.redirect_to);
		expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT);
		expect(redirect.searchParams.get("state")).toBe("client-state");
		expect(await codeOf(owner.call("oauth.get_authorization", { request_id: requestId }))).toBe("not_found");

		const res = await exchange(clientId, approved.redirect_to, verifier);
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		const tokens = (await res.json()) as Tokens;
		expect(tokens).toMatchObject({
			access_token: expect.stringMatching(/^sdo_/),
			refresh_token: expect.stringMatching(/^sdr_/),
			token_type: "Bearer",
			expires_in: 3600,
			scope: "account.read mail.read chat.read",
		});

		const init = await mcp(tokens.access_token, "initialize", { protocolVersion: "2025-11-25" });
		expect(((init.body?.result ?? {}) as { instructions?: string }).instructions).toContain("claude@dock.test");
		const tools = toolNames((await mcp(tokens.access_token, "tools/list")).body);
		expect(tools.filter((name) => name.startsWith("oauth_") || name.startsWith("account_create"))).toEqual([]);
		expect(tools).toContain("mail_list_threads");
		expect(tools).toContain("chat_list_rooms");
		expect(tools).not.toContain("mail_send");
		expect(tools).not.toContain("drive_list_items");
		const whoami = await callTool(tokens.access_token, "account_whoami");
		expect(whoami.structuredContent).toMatchObject({
			principal: { id: approved.principal.id, kind: "agent" },
			credential: "oauth",
		});
		// The token works on REST too, and an agent that connects with OAuth gets no API key.
		expect(await api(tokens.access_token)("account.whoami")).toMatchObject({ credential: "oauth" });
		expect(await owner.call("account.list_api_keys", { principal_id: approved.principal.id })).toEqual({
			api_keys: [],
		});
		expect((await owner.call("oauth.list_grants", { principal_id: approved.principal.id })).grants).toMatchObject([
			{ client_id: clientId, client_name: "Claude Code", created_by: owner.id, revoked: false },
		]);
	});

	it("lets a person deny a request, and the client gets access_denied with its state", async () => {
		const owner = await setupOwner();
		const { requestId } = await startAuthorization(await registerClient());
		const { redirect_to } = await owner.call("oauth.deny_authorization", { request_id: requestId });
		const url = new URL(redirect_to);
		expect(url.searchParams.get("error")).toBe("access_denied");
		expect(url.searchParams.get("state")).toBe("client-state");
		expect(
			await codeOf(
				owner.call("oauth.approve_authorization", {
					request_id: requestId,
					new_agent: { display_name: "Late", address: "late@dock.test" },
					scopes: ["mail.read"],
				}),
			),
		).toBe("not_found");
	});

	it("refuses an expired request, and creates no agent for it", async () => {
		const owner = await setupOwner();
		const { requestId } = await startAuthorization(await registerClient());
		await env.DIRECTORY.prepare("UPDATE oauth_requests SET expires_at = ?")
			.bind(new Date(Date.now() - 1000).toISOString())
			.run();
		const approve = owner.call("oauth.approve_authorization", {
			request_id: requestId,
			new_agent: { display_name: "Late", address: "late@dock.test" },
			scopes: ["mail.read"],
		});
		expect(await codeOf(approve)).toBe("not_found");
		const { principals } = await owner.call("directory.list_principals");
		expect(principals.map((p) => p.address)).not.toContain("late@dock.test");
	});

	// The approval that the UI makes: the session cookie of a sponsor, from this origin.
	it("lets a sponsor connect only an agent that they sponsor, and only an admin create an agent", async () => {
		const { owner, ada, bot } = await seedOrg();
		const other = await createActor(owner, { kind: "agent", display_name: "Other", address: "other@dock.test" });
		const clientId = await registerClient();
		const { requestId, verifier } = await startAuthorization(clientId);

		const newAgent = ada.call("oauth.approve_authorization", {
			request_id: requestId,
			new_agent: { display_name: "Mine", address: "mine@dock.test" },
			scopes: ["mail.read"],
		});
		expect(await codeOf(newAgent)).toBe("forbidden");
		const notSponsored = ada.call("oauth.approve_authorization", {
			request_id: requestId,
			agent_id: other.id,
			scopes: ["mail.read"],
		});
		expect(await codeOf(notSponsored)).toBe("forbidden");

		const cookie = await signIn(ada.address, PASSWORD);
		const res = await request(`/api/v1/oauth/authorizations/${requestId}/approve`, {
			method: "POST",
			headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
			body: JSON.stringify({ request_id: requestId, agent_id: bot.id, scopes: ["account.read", "mail.read"] }),
		});
		expect(res.status).toBe(200);
		const { redirect_to } = (await res.json()) as { redirect_to: string };
		const tokens = (await (await exchange(clientId, redirect_to, verifier)).json()) as Tokens;
		expect(await api(tokens.access_token)("account.whoami")).toMatchObject({ principal: { id: bot.id } });
		expect((await ada.call("oauth.list_grants", { principal_id: bot.id })).grants).toHaveLength(1);
		expect(await codeOf(ada.call("oauth.list_grants", { principal_id: other.id }))).toBe("forbidden");
	});

	it("refuses an agent, a narrow key, and a scope that an agent cannot hold", async () => {
		const { owner, bot } = await seedOrg();
		const { requestId } = await startAuthorization(await registerClient());
		expect(await codeOf(bot.call("oauth.get_authorization", { request_id: requestId }))).toBe("forbidden");
		const { tokens, agent } = await connectNewAgent(owner);
		// An agent that connected with OAuth cannot approve more connections, also not for itself.
		const self = api(tokens.access_token)("oauth.approve_authorization", {
			request_id: requestId,
			agent_id: agent.id,
			scopes: ["mail.read"],
		});
		expect(await codeOf(self)).toBe("forbidden");

		const { api_key } = await owner.call("account.create_api_key", {
			label: "narrow",
			scopes: ["account.keys", "mail.read"],
		});
		const narrow = api(api_key.secret);
		const create = narrow("oauth.approve_authorization", {
			request_id: requestId,
			new_agent: { display_name: "Narrow", address: "narrow@dock.test" },
			scopes: ["mail.read"],
		});
		expect(await codeOf(create)).toBe("forbidden");
		const wider = narrow("oauth.approve_authorization", {
			request_id: requestId,
			agent_id: bot.id,
			scopes: ["mail.send"],
		});
		expect(await codeOf(wider)).toBe("forbidden");
		const keys = owner.call("oauth.approve_authorization", {
			request_id: requestId,
			agent_id: bot.id,
			scopes: ["account.keys" as "mail.read"],
		});
		expect(await codeOf(keys)).toBe("invalid");
		const both = owner.call("oauth.approve_authorization", {
			request_id: requestId,
			agent_id: bot.id,
			new_agent: { display_name: "Two", address: "two@dock.test" },
			scopes: ["mail.read"],
		});
		expect(await codeOf(both)).toBe("invalid");
	});
});

describe("OAuth tokens", () => {
	// RFC 9700: somebody else can hold a code. A second use must fail and end what the first use made.
	it("uses a code one time: a second use fails and revokes the tokens of the first use", async () => {
		const owner = await setupOwner();
		const clientId = await registerClient();
		const { requestId, verifier } = await startAuthorization(clientId);
		const { redirect_to } = await owner.call("oauth.approve_authorization", {
			request_id: requestId,
			new_agent: { display_name: "Claude", address: "claude@dock.test" },
			scopes: ["mail.read"],
		});
		const first = (await (await exchange(clientId, redirect_to, verifier)).json()) as Tokens;
		const second = await exchange(clientId, redirect_to, verifier);
		expect(second.status).toBe(400);
		expect(await second.json()).toMatchObject({ error: "invalid_grant" });
		expect((await mcp(first.access_token, "tools/list")).status).toBe(401);
		expect(await (await refresh(clientId, first.refresh_token)).json()).toMatchObject({ error: "invalid_grant" });
	});

	// The code works for 60 seconds after the approval, also when the request itself would have expired.
	it("keeps an approved request until its code expires, when a new request deletes the expired ones", async () => {
		const owner = await setupOwner();
		const clientId = await registerClient();
		const { requestId, verifier } = await startAuthorization(clientId);
		await env.DIRECTORY.prepare("UPDATE oauth_requests SET expires_at = ?")
			.bind(new Date(Date.now() + 300).toISOString())
			.run();
		const { redirect_to } = await owner.call("oauth.approve_authorization", {
			request_id: requestId,
			new_agent: { display_name: "Claude", address: "claude@dock.test" },
			scopes: ["mail.read"],
		});
		await new Promise((resolve) => setTimeout(resolve, 400));
		await startAuthorization(clientId);
		expect((await exchange(clientId, redirect_to, verifier)).status).toBe(200);
	});

	// A flood of requests must not remove an approved request: a second use of its code must still revoke.
	it("keeps an approved request when a flood of new requests passes the limit", async () => {
		const owner = await setupOwner();
		const clientId = await registerClient();
		const { requestId, verifier } = await startAuthorization(clientId);
		const { redirect_to } = await owner.call("oauth.approve_authorization", {
			request_id: requestId,
			new_agent: { display_name: "Claude", address: "claude@dock.test" },
			scopes: ["mail.read"],
		});
		const later = new Date(Date.now() + 1000).toISOString();
		await env.DIRECTORY.prepare(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
			INSERT INTO oauth_requests (id, client_id, redirect_uri, code_challenge, scopes, created_at, expires_at)
			SELECT 'oar_flood_' || i, ?1, ?2, 'x', '[]', ?3, '2999-01-01T00:00:00.000Z' FROM n`,
		)
			.bind(clientId, REDIRECT, later)
			.run();
		await startAuthorization(clientId);
		expect((await exchange(clientId, redirect_to, verifier)).status).toBe(200);
	});

	it("refuses a code with a wrong verifier, client or redirect URI", async () => {
		const owner = await setupOwner();
		const clientId = await registerClient();
		const otherClient = await registerClient();
		for (const change of ["verifier", "client", "redirect"] as const) {
			const { requestId, verifier } = await startAuthorization(clientId);
			const { redirect_to } = await owner.call("oauth.approve_authorization", {
				request_id: requestId,
				new_agent: { display_name: "Claude", address: `claude-${change}@dock.test` },
				scopes: ["mail.read"],
			});
			const code = new URL(redirect_to).searchParams.get("code") ?? "";
			const res = await token({
				grant_type: "authorization_code",
				code,
				code_verifier: change === "verifier" ? (await pkce()).verifier : verifier,
				client_id: change === "client" ? otherClient : clientId,
				redirect_uri: change === "redirect" ? "http://localhost:1/other" : REDIRECT,
			});
			expect(res.status, change).toBe(400);
			expect(await res.json()).toMatchObject({ error: "invalid_grant" });
		}
	});

	it("rotates the refresh token, and the replaced token works one more time after a lost response", async () => {
		const owner = await setupOwner();
		const { clientId, tokens: first } = await connectNewAgent(owner);
		const second = (await (await refresh(clientId, first.refresh_token)).json()) as Tokens;
		expect(second.refresh_token).not.toBe(first.refresh_token);
		expect((await mcp(first.access_token, "tools/list")).status).toBe(401);
		expect((await mcp(second.access_token, "tools/list")).status).toBe(200);

		// The response with `second` got lost: the client sends the first refresh token again at once.
		const third = (await (await refresh(clientId, first.refresh_token)).json()) as Tokens;
		expect((await mcp(third.access_token, "tools/list")).status).toBe(200);
		const fourth = (await (await refresh(clientId, third.refresh_token)).json()) as Tokens;
		expect(fourth.access_token).toMatch(/^sdo_/);
		expect(await (await refresh(await registerClient(), fourth.refresh_token)).json()).toMatchObject({
			error: "invalid_grant",
		});
		expect((await mcp(fourth.access_token, "tools/list")).status).toBe(200);
	});

	// A replaced token works one time only. A copy of it cannot mint more tokens, and its second use revokes.
	it("revokes the grant when a replaced refresh token comes back after its one more use", async () => {
		const owner = await setupOwner();
		const { clientId, agent, tokens: first } = await connectNewAgent(owner);
		await refresh(clientId, first.refresh_token);
		const third = (await (await refresh(clientId, first.refresh_token)).json()) as Tokens;
		expect((await mcp(third.access_token, "tools/list")).status).toBe(200);
		expect(await (await refresh(clientId, first.refresh_token)).json()).toMatchObject({ error: "invalid_grant" });
		expect((await mcp(third.access_token, "tools/list")).status).toBe(401);
		expect(await (await refresh(clientId, third.refresh_token)).json()).toMatchObject({ error: "invalid_grant" });
		expect((await owner.call("oauth.list_grants", { principal_id: agent.id })).grants).toMatchObject([
			{ revoked: true },
		]);
	});

	// OAuth 2.1 reuse detection: a replaced refresh token that comes back later can be a stolen copy.
	it("revokes the grant when a replaced refresh token comes back after its grace period", async () => {
		const owner = await setupOwner();
		const { clientId, agent, tokens: first } = await connectNewAgent(owner);
		const second = (await (await refresh(clientId, first.refresh_token)).json()) as Tokens;
		await env.DIRECTORY.prepare("UPDATE oauth_grants SET previous_refresh_until = ?")
			.bind(new Date(Date.now() - 1000).toISOString())
			.run();
		expect(await (await refresh(clientId, first.refresh_token)).json()).toMatchObject({ error: "invalid_grant" });
		expect((await mcp(second.access_token, "tools/list")).status).toBe(401);
		expect(await (await refresh(clientId, second.refresh_token)).json()).toMatchObject({ error: "invalid_grant" });
		expect((await owner.call("oauth.list_grants", { principal_id: agent.id })).grants).toMatchObject([
			{ revoked: true },
		]);
	});

	it("refuses an expired access token, and the refresh token still works", async () => {
		const owner = await setupOwner();
		const { clientId, tokens } = await connectNewAgent(owner);
		await env.DIRECTORY.prepare("UPDATE oauth_grants SET access_expires_at = ?")
			.bind(new Date(Date.now() - 1000).toISOString())
			.run();
		expect((await mcp(tokens.access_token, "tools/list")).status).toBe(401);
		const renewed = (await (await refresh(clientId, tokens.refresh_token)).json()) as Tokens;
		expect((await mcp(renewed.access_token, "tools/list")).status).toBe(200);
	});

	it("stops each token at once when the sponsor revokes the connection", async () => {
		const owner = await setupOwner();
		const { clientId, agent, tokens } = await connectNewAgent(owner);
		const [grant] = (await owner.call("oauth.list_grants", { principal_id: agent.id })).grants;
		expect(await owner.call("oauth.revoke_grant", { grant_id: grant?.id ?? "" })).toEqual({ revoked: true });
		expect((await mcp(tokens.access_token, "tools/list")).status).toBe(401);
		expect(await (await refresh(clientId, tokens.refresh_token)).json()).toMatchObject({ error: "invalid_grant" });
		expect((await owner.call("oauth.list_grants", { principal_id: agent.id })).grants).toMatchObject([
			{ revoked: true },
		]);

		// A new connection of the agent deletes the connections that ended 30 days before.
		const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
		await env.DIRECTORY.prepare("UPDATE oauth_grants SET revoked_at = ?").bind(old).run();
		const { requestId, verifier } = await startAuthorization(clientId);
		const { redirect_to } = await owner.call("oauth.approve_authorization", {
			request_id: requestId,
			agent_id: agent.id,
			scopes: ["mail.read"],
		});
		expect((await exchange(clientId, redirect_to, verifier)).status).toBe(200);
		expect((await owner.call("oauth.list_grants", { principal_id: agent.id })).grants).toMatchObject([
			{ revoked: false },
		]);
	});

	// An archived agent must not act through a connection, and a restore must not need a new approval.
	it("stops the tokens of an archived agent until a restore, and ends them when the agent is deleted", async () => {
		const owner = await setupOwner();
		const { clientId, agent, tokens } = await connectNewAgent(owner);
		await owner.call("directory.archive_principal", { principal_id: agent.id });
		expect((await mcp(tokens.access_token, "tools/list")).status).toBe(401);
		expect(await (await refresh(clientId, tokens.refresh_token)).json()).toMatchObject({ error: "invalid_grant" });
		const { requestId } = await startAuthorization(clientId);
		const approval = owner.call("oauth.approve_authorization", {
			request_id: requestId,
			agent_id: agent.id,
			scopes: ["mail.read"],
		});
		expect(await codeOf(approval)).toBe("invalid");
		await owner.call("directory.restore_principal", { principal_id: agent.id });
		expect((await mcp(tokens.access_token, "tools/list")).status).toBe(200);
		const renewed = (await (await refresh(clientId, tokens.refresh_token)).json()) as Tokens;
		await owner.call("directory.delete_principal", { principal_id: agent.id });
		expect((await mcp(renewed.access_token, "tools/list")).status).toBe(401);
		expect(await (await refresh(clientId, renewed.refresh_token)).json()).toMatchObject({ error: "invalid_grant" });
	});

	// The OAuth tables refer to the principals, so a fresh start must drop them first.
	it("ends each OAuth connection when the operator starts fresh", async () => {
		const owner = await setupOwner();
		const { tokens } = await connectNewAgent(owner);
		const res = await request("/auth/setup", {
			method: "POST",
			headers: { authorization: `Bearer ${SETUP_TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify({
				mail_domain: "dock.test",
				display_name: "New Owner",
				address: "new@dock.test",
				password: PASSWORD,
				start_fresh: "DELETE DIRECTORY",
			}),
		});
		expect(res.status).toBe(201);
		expect((await mcp(tokens.access_token, "tools/list")).status).toBe(401);
	});
});
