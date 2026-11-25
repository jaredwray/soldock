import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
	AGENT_SCOPES,
	CHAT_SOCKET_CLOSE,
	EVENTS_SOCKET_CLOSE,
	EVENTS_SOCKET_PATH,
	SCOPES,
	UNTRUSTED_NOTICE,
} from "@asterra/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MEMBER_DELAY_MS, SOCKET_RECHECK_MS } from "../src/chat/room.ts";
import { EVENTS_SOCKET_RECHECK_MS } from "../src/identity/principal.ts";
import {
	type Actor,
	api,
	bearer,
	callTool,
	codeOf,
	connectRoomSocket,
	consumeWebhooks,
	createActor,
	mcp,
	ORIGIN,
	PASSWORD,
	racing,
	readSocket,
	receiveWebhooks,
	request,
	SETUP_TOKEN,
	seedOrg,
	sendMemberStates,
	setLegacyScopes,
	setupOwner,
	signIn,
	withEnv,
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
			`Bearer realm="asterra", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
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
	it("lets an admin approve a request for a new agent with an address, and the client acts as that agent", async () => {
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
		});
		expect(approved.principal).toMatchObject({
			kind: "agent",
			address: "claude@dock.test",
			sponsor_id: owner.id,
			created_by: owner.id,
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
			scope: AGENT_SCOPES.join(" "),
		});

		const init = await mcp(tokens.access_token, "initialize", { protocolVersion: "2025-11-25" });
		expect(((init.body?.result ?? {}) as { instructions?: string }).instructions).toContain("claude@dock.test");
		const tools = toolNames((await mcp(tokens.access_token, "tools/list")).body);
		expect(tools.filter((name) => name.startsWith("oauth_") || name.startsWith("account_create"))).toEqual([]);
		// The app asked for mail.read and chat.read. A new agent holds each agent scope for its own mailbox, its own
		// drive and the actions without a resource, and its memberships decide the rest.
		expect(tools).toEqual(
			expect.arrayContaining(["mail_list_threads", "chat_list_rooms", "mail_send", "drive_list_items"]),
		);
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
			{ client_id: clientId, client_name: "Claude Code", created_by: owner.id, revoked: false, scopes: [] },
		]);
	});

	// A connection reads the people of the directory only with the scope that the person approved.
	it("lets a connection get principals by id and by handle only with directory.read on its agent", async () => {
		const owner = await setupOwner();
		// An agent from before migration 0031 can lack directory.read. The read has no resource, so its account decides.
		const { tokens: without, agent: legacy } = await connectNewAgent(owner);
		await setLegacyScopes(legacy.id, ["account.read", "mail.read", "chat.read"]);
		expect(await codeOf(api(without.access_token)("directory.get_principals", { ids: owner.id }))).toBe("forbidden");

		const clientId = await registerClient();
		const { requestId, verifier } = await startAuthorization(clientId);
		const approved = await owner.call("oauth.approve_authorization", {
			request_id: requestId,
			new_agent: { display_name: "Reader", address: "reader@dock.test" },
		});
		const tokens = (await (await exchange(clientId, approved.redirect_to, verifier)).json()) as Tokens;
		const found = await api(tokens.access_token)("directory.get_principals", { ids: owner.id, handles: "reader" });
		expect(found.principals.map((p) => p.id)).toEqual([owner.id, approved.principal.id]);
		expect(found.mentions).toEqual([{ handle: "reader", principal_id: approved.principal.id }]);
		const tool = await callTool(tokens.access_token, "directory_get_principals", { handles: "owner" });
		expect(tool.structuredContent).toMatchObject({ mentions: [{ handle: "owner", principal_id: owner.id }] });
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
		});
		expect(await codeOf(approve)).toBe("not_found");
		// A request that expires during the approval, after the read of the handler: the insert of the
		// agent checks the request again in its transaction, so it writes nothing.
		const late = await startAuthorization(await registerClient());
		const res = await withEnv(
			{
				DIRECTORY: racing(
					"UPDATE oauth_requests SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
					late.requestId,
				),
			},
			`/api/v1/oauth/authorizations/${late.requestId}/approve`,
			{
				method: "POST",
				headers: { authorization: `Bearer ${owner.key}`, "content-type": "application/json" },
				body: JSON.stringify({ new_agent: { display_name: "Late", address: "late@dock.test" } }),
			},
		);
		expect(res.status).toBe(409);
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
		});
		expect(await codeOf(newAgent)).toBe("forbidden");
		const notSponsored = ada.call("oauth.approve_authorization", { request_id: requestId, agent_id: other.id });
		expect(await codeOf(notSponsored)).toBe("forbidden");

		// An agent from before migration 0031 with narrow account scopes.
		await setLegacyScopes(bot.id, ["account.read", "mail.read"]);
		const cookie = await signIn(ada.address, PASSWORD);
		const res = await request(`/api/v1/oauth/authorizations/${requestId}/approve`, {
			method: "POST",
			headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
			body: JSON.stringify({ request_id: requestId, agent_id: bot.id }),
		});
		expect(res.status).toBe(200);
		const { redirect_to } = (await res.json()) as { redirect_to: string };
		const tokens = (await (await exchange(clientId, redirect_to, verifier)).json()) as Tokens;
		// The connection only proves the identity of the agent: it acts with the account scopes of the agent.
		expect(tokens.scope).toBe("account.read mail.read");
		expect(await api(tokens.access_token)("account.whoami")).toMatchObject({
			principal: { id: bot.id },
			scopes: ["account.read", "mail.read"],
		});
		expect((await ada.call("oauth.list_grants", { principal_id: bot.id })).grants).toHaveLength(1);
		expect(await codeOf(ada.call("oauth.list_grants", { principal_id: other.id }))).toBe("forbidden");
	});

	it("refuses an agent, a narrow key, and scopes for a new agent or an agent that exists", async () => {
		const { owner, bot } = await seedOrg();
		const { requestId } = await startAuthorization(await registerClient());
		expect(await codeOf(bot.call("oauth.get_authorization", { request_id: requestId }))).toBe("forbidden");
		const { tokens, agent } = await connectNewAgent(owner);
		// An agent that connected with OAuth cannot approve more connections, also not for itself.
		const self = api(tokens.access_token)("oauth.approve_authorization", { request_id: requestId, agent_id: agent.id });
		expect(await codeOf(self)).toBe("forbidden");

		const { api_key } = await owner.call("account.create_api_key", {
			label: "narrow",
			scopes: ["account.keys", "mail.read"],
		});
		const narrow = api(api_key.secret);
		const create = narrow("oauth.approve_authorization", {
			request_id: requestId,
			new_agent: { display_name: "Narrow", address: "narrow@dock.test" },
		});
		expect(await codeOf(create)).toBe("forbidden");
		// The connection gives each scope of the bot, and the narrow key does not hold mail.send.
		const wider = narrow("oauth.approve_authorization", { request_id: requestId, agent_id: bot.id });
		expect(await codeOf(wider)).toBe("forbidden");
		// A connection has no scopes, and a new agent gets each agent scope: the call takes no scopes.
		const own = owner.call("oauth.approve_authorization", {
			request_id: requestId,
			agent_id: bot.id,
			scopes: ["mail.read"],
		} as never);
		expect(await codeOf(own)).toBe("invalid");
		const picked = owner.call("oauth.approve_authorization", {
			request_id: requestId,
			new_agent: { display_name: "Picked", address: "picked@dock.test" },
			scopes: ["mail.read"],
		} as never);
		expect(await codeOf(picked)).toBe("invalid");
		// An agent has no resource limits. The call refuses a client that asks for them: the client must not
		// get an agent that reaches more than it asked for.
		const limited = owner.call("oauth.approve_authorization", {
			request_id: requestId,
			new_agent: { display_name: "Limited", address: "limited@dock.test" },
			limits: "own",
		} as never);
		expect(await codeOf(limited)).toBe("invalid");
		const both = owner.call("oauth.approve_authorization", {
			request_id: requestId,
			agent_id: bot.id,
			new_agent: { display_name: "Two", address: "two@dock.test" },
		});
		expect(await codeOf(both)).toBe("invalid");
	});
});

describe("OAuth tokens", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	// RFC 9700: somebody else can hold a code. A second use must fail and end what the first use made.
	it("uses a code one time: a second use fails and revokes the tokens of the first use", async () => {
		const owner = await setupOwner();
		const clientId = await registerClient();
		const { requestId, verifier } = await startAuthorization(clientId);
		const { redirect_to } = await owner.call("oauth.approve_authorization", {
			request_id: requestId,
			new_agent: { display_name: "Claude", address: "claude@dock.test" },
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

	// A room socket stays open after its request. It must not outlive the token that opened it.
	it("closes the room socket of a token that a refresh replaced or that expired, and of a revoked connection", async () => {
		const owner = await setupOwner();
		const { clientId, agent, tokens: firstTokens } = await connectNewAgent(owner);
		const { room } = await owner.call("chat.create_room", { kind: "private", name: "Runbook", member_ids: [agent.id] });
		const post = async (text: string) => (await owner.call("chat.post_message", { room_id: room.id, text })).message;
		// Only the clock is fake: the room checks a credential again when its last check is old.
		vi.useFakeTimers({ toFake: ["Date"] });
		// A refresh replaces the access token. A copy of the old token must not keep a socket open.
		const replaced = await connectRoomSocket(room.id, bearer(firstTokens.access_token));
		const tokens = (await (await refresh(clientId, firstTokens.refresh_token)).json()) as Tokens;
		const socket = await connectRoomSocket(room.id, bearer(tokens.access_token));
		vi.setSystemTime(Date.now() + SOCKET_RECHECK_MS);
		const first = await post("Deploy 42 is done.");
		// The connection works, so the code tells the client to open a new socket with its new token.
		expect(await replaced.next()).toEqual({ closed: CHAT_SOCKET_CLOSE.reconnect });
		expect(await socket.next()).toEqual({ type: "message", message: first });

		// The access token expires, and the client did not refresh it yet.
		await env.DIRECTORY.prepare("UPDATE oauth_grants SET access_expires_at = ?")
			.bind(new Date(Date.now() - 1000).toISOString())
			.run();
		vi.setSystemTime(Date.now() + SOCKET_RECHECK_MS);
		await post("The token is expired.");
		expect(await socket.next()).toEqual({ closed: CHAT_SOCKET_CLOSE.reconnect });

		const renewed = (await (await refresh(clientId, tokens.refresh_token)).json()) as Tokens;
		const last = await connectRoomSocket(room.id, bearer(renewed.access_token));
		const [grant] = (await owner.call("oauth.list_grants", { principal_id: agent.id })).grants;
		await owner.call("oauth.revoke_grant", { grant_id: grant?.id ?? "" });
		vi.setSystemTime(Date.now() + SOCKET_RECHECK_MS);
		await post("The connection is revoked.");
		// A revoked connection gives no new token: the client must not open a new socket.
		expect(await last.next()).toEqual({ closed: CHAT_SOCKET_CLOSE.ended });
	});

	it("opens the events socket of its own agent, and closes it after a refresh and at once after a revoke", async () => {
		const owner = await setupOwner();
		const { clientId, agent, tokens: firstTokens } = await connectNewAgent(owner);
		const { room } = await owner.call("chat.create_room", { kind: "private", name: "Runbook", member_ids: [agent.id] });
		vi.useFakeTimers({ toFake: ["Date"] });
		const replaced = readSocket(
			await request(EVENTS_SOCKET_PATH, { headers: { upgrade: "websocket", ...bearer(firstTokens.access_token) } }),
		);
		expect(await replaced.next()).toMatchObject({ type: "hello" });
		// The clock is fake, so the alarm of the room does not come by itself. Move the clock past the time
		// that the states of the other members wait, and run the alarm.
		const sendToMembers = async () => {
			vi.setSystemTime(Date.now() + MEMBER_DELAY_MS);
			await runDurableObjectAlarm(env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(room.id)));
		};
		await owner.call("chat.post_message", { room_id: room.id, text: "Deploy 42 is done." });
		await sendToMembers();
		// The token acts as its agent: the event has the room of the agent, with its count.
		expect(await replaced.next()).toMatchObject({ type: "chat.room", room: { id: room.id, unread_count: 1 } });

		const tokens = (await (await refresh(clientId, firstTokens.refresh_token)).json()) as Tokens;
		vi.setSystemTime(Date.now() + EVENTS_SOCKET_RECHECK_MS);
		await owner.call("chat.post_message", { room_id: room.id, text: "Deploy 43 is done." });
		await sendToMembers();
		// The connection works, so the code tells the client to open a new socket with its new token.
		expect(await replaced.next()).toEqual({ closed: EVENTS_SOCKET_CLOSE.reconnect });

		// A revoke of the connection closes each socket of its tokens at once, without an event.
		const current = readSocket(
			await request(EVENTS_SOCKET_PATH, { headers: { upgrade: "websocket", ...bearer(tokens.access_token) } }),
		);
		expect(await current.next()).toMatchObject({ type: "hello" });
		const [grant] = (await owner.call("oauth.list_grants", { principal_id: agent.id })).grants;
		await owner.call("oauth.revoke_grant", { grant_id: grant?.id ?? "" });
		expect(await current.next()).toEqual({ closed: EVENTS_SOCKET_CLOSE.ended });
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
		const approval = owner.call("oauth.approve_authorization", { request_id: requestId, agent_id: agent.id });
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

describe("OAuth and the state of Chat", () => {
	// A token from OAuth acts as its agent. The lists must come from the object of that agent only.
	it("lists the rooms and the unread counts of its own agent, and no room of a different principal", async () => {
		const owner = await setupOwner();
		const { agent, tokens } = await connectNewAgent(owner);
		const { room: shared } = await owner.call("chat.create_room", {
			kind: "private",
			name: "With the agent",
			member_ids: [agent.id],
		});
		await owner.call("chat.create_room", { kind: "private", name: "Owner only" });
		await owner.call("chat.post_message", { room_id: shared.id, text: "Hello" });
		// The owner made the changes, so the list of the agent gets them after the delay.
		await sendMemberStates(agent.id);
		const listed = await callTool(tokens.access_token, "chat_list_rooms");
		// Only the room of the agent, with the count of the agent.
		expect(listed.structuredContent?.rooms).toEqual([
			expect.objectContaining({ id: shared.id, name: "With the agent", unread_count: 1 }),
		]);
	});
});

describe("OAuth connections follow their agent", () => {
	const instructions = async (token: string) => {
		const { body } = await mcp(token, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "t", version: "1" },
		});
		return ((body?.result ?? {}) as { instructions?: string }).instructions ?? "";
	};

	// A connection only proves the identity of its agent. A membership that a person gives to the agent, or
	// takes away, reaches the token that the client holds at its next request: no refresh and no new approval.
	it("follows the memberships of its agent at once, without a new approval", async () => {
		const owner = await setupOwner();
		const { clientId, agent, tokens } = await connectNewAgent(owner);
		const agentApi = api(tokens.access_token);
		// A new agent holds each agent scope, so the agent sees each tool of its kind.
		expect((await agentApi("account.whoami")).missing_scopes).toEqual([]);
		expect(await instructions(tokens.access_token)).not.toContain("does not hold");
		const { team_mailbox: support } = await owner.call("directory.create_team_mailbox", {
			display_name: "Support",
			address: "support@dock.test",
		});
		const read = () => agentApi("mail.list_threads", { mailbox_id: support.id });
		expect(await codeOf(read())).toBe("forbidden");
		// Parity: the owner gives the membership through MCP.
		await callTool(owner.key, "directory_add_team_mailbox_member", {
			mailbox_id: support.id,
			principal_id: agent.id,
			scopes: ["mail.read"],
		});
		expect((await read()).threads).toEqual([]);
		expect(await codeOf(agentApi("mail.send", { mailbox_id: support.id, to: ["owner@dock.test"], text: "x" }))).toBe(
			"forbidden",
		);
		await owner.call("directory.remove_team_mailbox_member", { mailbox_id: support.id, principal_id: agent.id });
		expect(await codeOf(read())).toBe("forbidden");
		// The connection has no scopes, and a refresh keeps the account scopes of the agent.
		expect((await owner.call("oauth.list_grants", { principal_id: agent.id })).grants[0]?.scopes).toEqual([]);
		const refreshed = (await (await refresh(clientId, tokens.refresh_token)).json()) as Tokens;
		expect(refreshed.scope).toBe(AGENT_SCOPES.join(" "));
	});

	// An agent from before migration 0031 can have narrow account scopes. The agent learns which tools it cannot
	// call, and that a person changes a membership, not its account or its connection.
	it("tells an agent from before migration 0031 which tools its account scopes leave out", async () => {
		const owner = await setupOwner();
		const { agent, tokens } = await connectNewAgent(owner);
		await setLegacyScopes(agent.id, ["account.read", "mail.read", "chat.read"]);
		expect((await api(tokens.access_token)("account.whoami")).missing_scopes).toContainEqual({
			scope: "mail.webhooks",
			description: SCOPES["mail.webhooks"],
			operations: [
				"mail.create_webhook_subscription",
				"mail.list_webhook_subscriptions",
				"mail.delete_webhook_subscription",
				"webhooks.create_endpoint",
				"webhooks.list_endpoints",
				"webhooks.update_endpoint",
				"webhooks.delete_endpoint",
			],
		});
		const text = await instructions(tokens.access_token);
		expect(text).toContain("mail.webhooks (7 tools)");
		expect(text).toContain("your membership decides");
		const tools = toolNames((await mcp(tokens.access_token, "tools/list")).body);
		expect(tools).not.toContain("mail_create_webhook_subscription");
		// A membership can still give a tool that names a team mailbox.
		expect(tools).toContain("mail_send");
	});

	// An agent never reads or changes its own access. Only a person who manages the agent reads it.
	it("lets only a person who manages the agent read its access", async () => {
		const { owner, ada, bot } = await seedOrg();
		const grace = await createActor(owner, {
			kind: "human",
			display_name: "Grace Hopper",
			address: "grace@dock.test",
			password: PASSWORD,
		});
		const clientId = await registerClient();
		const { requestId, verifier } = await startAuthorization(clientId);
		const { redirect_to } = await ada.call("oauth.approve_authorization", { request_id: requestId, agent_id: bot.id });
		const tokens = (await (await exchange(clientId, redirect_to, verifier)).json()) as Tokens;
		const read = (caller: (typeof ada)["call"]) => caller("directory.get_agent_access", { principal_id: bot.id });
		expect(await codeOf(read(api(tokens.access_token)))).toBe("forbidden");
		expect(await codeOf(read(bot.call))).toBe("forbidden");
		// Grace is a member who does not sponsor the bot.
		expect(await codeOf(read(grace.call))).toBe("forbidden");
		expect((await read(ada.call)).principal_id).toBe(bot.id);
		expect((await read(owner.call)).principal_id).toBe(bot.id);
		// The scope editor of an account is gone: no operation changes the access of an agent.
		expect(toolNames((await mcp(owner.key, "tools/list")).body)).not.toContain("directory_set_agent_access");
	});
});

describe("OAuth and webhooks", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// A webhook outlives the request that made it, so it must stop with the connection that made it.
	it.each(["mail", "chat"] as const)("stops a %s webhook when its OAuth connection is revoked", async (domain) => {
		const owner = await setupOwner();
		const clientId = await registerClient();
		const { requestId, verifier } = await startAuthorization(clientId, `${domain}.read ${domain}.webhooks`);
		const approved = await owner.call("oauth.approve_authorization", {
			request_id: requestId,
			new_agent: { display_name: "Claude", address: "claude@dock.test" },
		});
		const tokens = (await (await exchange(clientId, approved.redirect_to, verifier)).json()) as Tokens;
		const agent = approved.principal;
		await owner.call("directory.update_agent_policy", { principal_id: agent.id, mode: "any" });
		const created = await callTool(tokens.access_token, "webhooks_create_endpoint", {
			url: "https://hooks.example.com/a",
		});
		const createdBody = created.structuredContent as { endpoint: { id: string } } | undefined;
		if (!createdBody) throw new Error("the endpoint was not created");
		const subscribed = await callTool(tokens.access_token, `${domain}_create_webhook_subscription`, {
			endpoint_id: createdBody.endpoint.id,
			event: domain === "mail" ? "mail.inbox.updated" : "chat.message.created",
		});
		const subscribedBody = subscribed.structuredContent as { subscription: { id: string } } | undefined;
		if (!subscribedBody) throw new Error("the subscription was not created");
		const subscription = subscribedBody.subscription;
		let job: unknown = {
			v: 1,
			kind: "delivery",
			webhookId: subscription.id,
			mailboxId: agent.id,
			eventId: "evt_01JC0000000000000000000000",
			occurredAt: Date.now(),
		};
		if (domain === "chat") {
			const { room } = await owner.call("chat.create_room", { kind: "private", name: "OAuth", member_ids: [agent.id] });
			const { message } = await owner.call("chat.post_message", { room_id: room.id, text: "Wake up" });
			const membershipId = await runInDurableObject(
				env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(room.id)),
				(_instance, state) =>
					state.storage.sql
						.exec<{ membership_id: string }>("SELECT membership_id FROM members WHERE principal_id = ?", agent.id)
						.one().membership_id,
			);
			job = {
				v: 1,
				kind: "chat_delivery",
				webhookId: subscription.id,
				mailboxId: agent.id,
				roomId: room.id,
				eventId: message.id,
				messageId: message.id,
				eventType: "chat.message.created",
				occurredAt: Date.now(),
				membershipId,
			};
		}
		const posts = receiveWebhooks();
		await consumeWebhooks([job]);
		expect(posts).toHaveLength(1);

		const [grant] = (await owner.call("oauth.list_grants", { principal_id: agent.id })).grants;
		await owner.call("oauth.revoke_grant", { grant_id: grant?.id ?? "" });
		await consumeWebhooks([job]);
		expect(posts).toHaveLength(1);
		const listed =
			domain === "mail"
				? (await owner.call("mail.list_webhook_subscriptions", { mailbox_id: agent.id })).subscriptions
				: (await owner.call("chat.list_webhook_subscriptions", { principal_id: agent.id })).subscriptions;
		expect(listed).toMatchObject([{ endpoint: { status: "disabled", disabled_reason: "credential_revoked" } }]);
	});

	// Before migration 0031, a person could take the webhook scopes away from an agent after it made a
	// subscription. The subscription stops at its next delivery, also when that delivery comes after the deploy:
	// a delivery needs the scope that a new subscription needs.
	it("stops the webhook of an agent whose account lost the webhook scope before migration 0031", async () => {
		const owner = await setupOwner();
		const { tokens, agent } = await connectNewAgent(owner);
		await owner.call("directory.update_agent_policy", { principal_id: agent.id, mode: "any" });
		const endpoint = (
			(await callTool(tokens.access_token, "webhooks_create_endpoint", { url: "https://hooks.example.com/a" }))
				.structuredContent as { endpoint: { id: string } }
		).endpoint;
		const events = { mail: "mail.inbox.updated", chat: "chat.message.created", drive: "drive.item.created" };
		const subscribe = async (domain: keyof typeof events) =>
			(
				(
					await callTool(tokens.access_token, `${domain}_create_webhook_subscription`, {
						endpoint_id: endpoint.id,
						event: events[domain],
					})
				).structuredContent as { subscription: { id: string } }
			).subscription.id;
		const mailId = await subscribe("mail");
		const chatId = await subscribe("chat");
		const driveId = await subscribe("drive");
		const mailJob = {
			v: 1,
			kind: "delivery",
			webhookId: mailId,
			mailboxId: agent.id,
			eventId: "evt_01JC0000000000000000000000",
			occurredAt: Date.now(),
		};
		// An event of the own drive of the agent. An event of a personal drive has no list of members.
		const driveJob = {
			v: 1,
			kind: "drive_delivery",
			webhookId: driveId,
			spaceId: agent.id,
			eventType: "drive.item.created",
			eventId: "drv_event",
			itemId: "itm_01AAAAAAAAAAAAAAAAAAAAAAAAAA",
			occurredAt: Date.now(),
		};
		const chatJob = async (roomName: string) => {
			const { room } = await owner.call("chat.create_room", {
				kind: "private",
				name: roomName,
				member_ids: [agent.id],
			});
			const { message } = await owner.call("chat.post_message", { room_id: room.id, text: "Wake up" });
			const membershipId = await runInDurableObject(
				env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(room.id)),
				(_instance, state) =>
					state.storage.sql
						.exec<{ membership_id: string }>("SELECT membership_id FROM members WHERE principal_id = ?", agent.id)
						.one().membership_id,
			);
			const job = {
				v: 1,
				kind: "chat_delivery",
				webhookId: chatId,
				mailboxId: agent.id,
				roomId: room.id,
				eventId: message.id,
				messageId: message.id,
				eventType: "chat.message.created",
				occurredAt: Date.now(),
				membershipId,
			};
			return { room, job };
		};
		const roomJob = (await chatJob("Builds")).job;
		const posts = receiveWebhooks();
		await consumeWebhooks([mailJob, driveJob, roomJob]);
		expect(posts).toHaveLength(3);
		const status = async (domain: keyof typeof events) =>
			(domain === "mail"
				? (await owner.call("mail.list_webhook_subscriptions", { mailbox_id: agent.id })).subscriptions
				: domain === "drive"
					? (await owner.call("drive.list_webhook_subscriptions", { space_id: agent.id })).subscriptions
					: (await owner.call("chat.list_webhook_subscriptions", { principal_id: agent.id })).subscriptions
			).map((row) => [row.status, row.disabled_reason]);

		// The account from before has no webhook scope: no event goes out, and each subscription stops for good.
		await setLegacyScopes(agent.id, ["chat.read"]);
		await consumeWebhooks([mailJob, driveJob, roomJob]);
		expect(posts).toHaveLength(3);
		for (const domain of ["mail", "chat", "drive"] as const) {
			expect(await status(domain), domain).toEqual([["disabled", "access_lost"]]);
		}
	});

	// A dot of ChatGPT connects with OAuth. Its access token changes each hour, and its subscription of
	// MCP Events lives a day, so the connection, not the token, must name the subscription.
	it("binds a subscription of MCP Events to its OAuth connection", async () => {
		const owner = await setupOwner();
		const scopes = ["chat.read", "chat.webhooks"] as const;
		const clientId = await registerClient();
		const first = await startAuthorization(clientId, scopes.join(" "));
		const approved = await owner.call("oauth.approve_authorization", {
			request_id: first.requestId,
			new_agent: { display_name: "Dot", address: "dot@dock.test" },
		});
		const tokens = (await (await exchange(clientId, approved.redirect_to, first.verifier)).json()) as Tokens;
		const agent = approved.principal;
		await owner.call("directory.update_agent_policy", { principal_id: agent.id, mode: "any" });
		const posts = receiveWebhooks((post) => {
			const body = JSON.parse(post.body) as { type?: string; challenge?: string };
			return body.type === "verification" ? Response.json({ challenge: body.challenge }) : new Response(null);
		});
		const params = {
			name: "chat.message.created",
			arguments: {},
			delivery: {
				mode: "webhook",
				url: "https://receiver.example.com/callback",
				secret: `whsec_${btoa("k".repeat(32))}`,
			},
		};
		const idOf = async (accessToken: string) =>
			((await mcp(accessToken, "events/subscribe", params)).body?.result as { id: string } | undefined)?.id;
		const id = await idOf(tokens.access_token);
		expect(id).toMatch(/^sub_/);

		// A new access token of the same connection refreshes the same subscription.
		const renewed = (await (await refresh(clientId, tokens.refresh_token)).json()) as Tokens;
		expect(await idOf(renewed.access_token)).toBe(id);

		// A second connection of the same agent has its own subscription, and cannot stop the first one.
		const second = await startAuthorization(clientId, scopes.join(" "));
		const again = await owner.call("oauth.approve_authorization", { request_id: second.requestId, agent_id: agent.id });
		const others = (await (await exchange(clientId, again.redirect_to, second.verifier)).json()) as Tokens;
		expect((await mcp(others.access_token, "events/unsubscribe", params)).body?.result).toEqual({});
		expect(await idOf(others.access_token)).not.toBe(id);

		const { room } = await owner.call("chat.create_room", { kind: "private", name: "OAuth", member_ids: [agent.id] });
		const { message } = await owner.call("chat.post_message", { room_id: room.id, text: "Wake up" });
		const membershipId = await runInDurableObject(
			env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(room.id)),
			(_instance, state) =>
				state.storage.sql
					.exec<{ membership_id: string }>("SELECT membership_id FROM members WHERE principal_id = ?", agent.id)
					.one().membership_id,
		);
		const job = {
			v: 1,
			kind: "chat_delivery",
			webhookId: id,
			mailboxId: agent.id,
			roomId: room.id,
			eventId: message.id,
			messageId: message.id,
			eventType: "chat.message.created",
			occurredAt: Date.now(),
			membershipId,
		};
		const eventsFor = () =>
			posts.filter((post) => post.headers.get("x-mcp-subscription-id") === id && "eventId" in JSON.parse(post.body));
		await consumeWebhooks([job]);
		expect(eventsFor()).toHaveLength(1);

		// The revoke of the first connection stops its subscription.
		const grants = (await owner.call("oauth.list_grants", { principal_id: agent.id })).grants;
		const stored = await env.DIRECTORY.prepare("SELECT credential_id FROM webhook_subscriptions WHERE id = ?")
			.bind(id)
			.first<string>("credential_id");
		expect(grants.map((grant) => grant.id)).toContain(stored);
		await owner.call("oauth.revoke_grant", { grant_id: stored ?? "" });
		await consumeWebhooks([job]);
		expect(eventsFor()).toHaveLength(1);
	});
});
