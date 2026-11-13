import { AGENT_SCOPES, OAUTH_LIMITS, type Scope } from "@soldock/contracts";
import type { Context, Hono } from "hono";
import {
	audit,
	base64UrlEncode,
	OperationError,
	type RequestIdVariables,
	readBodyText,
	sameSecret,
} from "../platform/index.ts";
import {
	createGrant,
	createRequest,
	getClient,
	type IssuedTokens,
	redeemCode,
	refreshGrant,
	registerClient,
} from "./oauth-store.ts";
import { REDIRECT_URI_MAX_LENGTH, redirectUriProblem, redirectWith } from "./oauth-urls.ts";

type OAuthApp = Hono<{ Bindings: Env; Variables: RequestIdVariables }>;
type OAuthContext = Context<{ Bindings: Env; Variables: RequestIdVariables }>;

/** The path of the MCP endpoint, the protected resource of the tokens. */
export const MCP_PATH = "/mcp";

/** The metadata of the MCP endpoint (RFC 9728). The 401 of `/mcp` names it in `resource_metadata`. */
export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";

/** The bodies of `/oauth/register` and `/oauth/token` are small. A larger body is refused while it streams. */
const OAUTH_BODY_BYTES = 16 * 1024;

/** The longest `state` that a client can send. The request keeps it until the redirect. */
const STATE_MAX_LENGTH = 1000;

/** The longest client name. A longer name is cut. */
const CLIENT_NAME_MAX_LENGTH = 100;

const AGENT_SCOPE_SET = new Set<string>(AGENT_SCOPES);

function originOf(c: OAuthContext): string {
	return new URL(c.req.url).origin;
}

/** The URL of the `resource_metadata` of the MCP endpoint, for its `WWW-Authenticate` header. */
export function protectedResourceMetadataUrl(requestUrl: string): string {
	return `${new URL(requestUrl).origin}${PROTECTED_RESOURCE_PATH}${MCP_PATH}`;
}

/** An OAuth error body (RFC 6749 section 5.2). It is not problem+json, because OAuth clients read this form. */
function oauthError(error: string, description: string, status: 400 | 401 = 400): Response {
	return Response.json(
		{ error, error_description: description },
		{ status, headers: { "cache-control": "no-store", pragma: "no-cache" } },
	);
}

/**
 * An error of `/oauth/authorize` that cannot go back to the client, because the client or its redirect
 * URI is not known. The person sees it in the browser. It holds no text from the request.
 */
function authorizePageError(message: string): Response {
	return new Response(`Soldock cannot connect this app. ${message}\n`, {
		status: 400,
		headers: {
			"content-type": "text/plain; charset=utf-8",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
		},
	});
}

/** The agent scopes in an OAuth `scope` value. Unknown scopes, such as `openid`, are ignored. */
function agentScopesOf(value: string | null): Scope[] {
	return [...new Set((value ?? "").split(" ").filter((scope) => AGENT_SCOPE_SET.has(scope)))] as Scope[];
}

/** True when `resource` (RFC 8707) names this deployment or its MCP endpoint. Clients can leave it out. */
function isOwnResource(resource: string | null, origin: string): boolean {
	if (resource === null) return true;
	try {
		const url = new URL(resource);
		return url.origin === origin && ["", "/", MCP_PATH, `${MCP_PATH}/`].includes(url.pathname) && !url.search;
	} catch {
		return false;
	}
}

/** The name that a client gave itself, without control characters, cut to the limit. */
function cleanClientName(value: unknown): string {
	if (typeof value !== "string") return "MCP client";
	const name = value
		.replace(/[\p{Cc}\p{Cf}]/gu, "")
		.replace(/\s+/g, " ")
		.trim();
	return name.slice(0, CLIENT_NAME_MAX_LENGTH) || "MCP client";
}

function tokenResponse(tokens: IssuedTokens): Response {
	return Response.json(
		{
			access_token: tokens.access_token,
			token_type: "Bearer",
			expires_in: OAUTH_LIMITS.accessTokenSeconds,
			refresh_token: tokens.refresh_token,
			scope: tokens.grant.scopes.join(" "),
		},
		{ headers: { "cache-control": "no-store", pragma: "no-cache" } },
	);
}

/**
 * The OAuth authorization server for MCP clients (OAuth 2.1 with PKCE, RFC 8414, RFC 7591, RFC 9728).
 * A client gets only the URL of `/mcp`. Its 401 names the metadata, the client registers itself, and a
 * person approves the request on the `/connect` page of the web app. The tokens act as an agent. These
 * routes are ceremonies, not operations: the client has no credential yet.
 */
export function mountOAuthRoutes(app: OAuthApp): void {
	app.get(PROTECTED_RESOURCE_PATH, (c) => protectedResource(c, originOf(c)));
	app.get(`${PROTECTED_RESOURCE_PATH}${MCP_PATH}`, (c) => protectedResource(c, `${originOf(c)}${MCP_PATH}`));

	app.get("/.well-known/oauth-authorization-server", (c) => {
		const origin = originOf(c);
		return c.json(
			{
				issuer: origin,
				authorization_endpoint: `${origin}/oauth/authorize`,
				token_endpoint: `${origin}/oauth/token`,
				registration_endpoint: `${origin}/oauth/register`,
				scopes_supported: AGENT_SCOPES,
				response_types_supported: ["code"],
				response_modes_supported: ["query"],
				grant_types_supported: ["authorization_code", "refresh_token"],
				token_endpoint_auth_methods_supported: ["none"],
				code_challenge_methods_supported: ["S256"],
			},
			200,
			{ "cache-control": "public, max-age=300" },
		);
	});

	// Dynamic client registration (RFC 7591), without a credential. Each client is public: it gets no
	// secret and must use PKCE. Values that Soldock does not support are replaced, as RFC 7591 allows.
	app.post("/oauth/register", async (c) => {
		let body: unknown;
		try {
			body = JSON.parse(await readBodyText(c.req.raw, OAUTH_BODY_BYTES));
		} catch (error) {
			if (error instanceof OperationError) throw error;
			return oauthError("invalid_client_metadata", "The body must be a JSON object.");
		}
		if (typeof body !== "object" || body === null || Array.isArray(body)) {
			return oauthError("invalid_client_metadata", "The body must be a JSON object.");
		}
		const metadata = body as Record<string, unknown>;
		const uris = metadata.redirect_uris;
		if (!Array.isArray(uris) || uris.length === 0 || uris.length > OAUTH_LIMITS.redirectUris) {
			return oauthError(
				"invalid_redirect_uri",
				`Send redirect_uris with 1 to ${OAUTH_LIMITS.redirectUris} absolute URIs.`,
			);
		}
		for (const uri of uris) {
			const problem = typeof uri === "string" ? redirectUriProblem(uri) : "is not a string";
			if (problem) return oauthError("invalid_redirect_uri", `A redirect URI ${problem}.`);
		}
		let clientUri: string | null = null;
		if (metadata.client_uri !== undefined) {
			const value = metadata.client_uri;
			const valid =
				typeof value === "string" && value.length <= REDIRECT_URI_MAX_LENGTH && URL.canParse(value)
					? new URL(value).protocol === "https:"
					: false;
			if (!valid) return oauthError("invalid_client_metadata", "client_uri must be an https URL.");
			clientUri = value as string;
		}
		const client = await registerClient(c.env.DIRECTORY, {
			name: cleanClientName(metadata.client_name),
			uri: clientUri,
			redirect_uris: [...new Set(uris as string[])],
		});
		audit({
			op: "oauth.register",
			actor: client.id,
			actorKind: "client",
			credential: "none",
			result: "ok",
			requestId: c.var.requestId,
		});
		return c.json(
			{
				client_id: client.id,
				client_id_issued_at: Math.floor(Date.parse(client.created_at) / 1000),
				client_name: client.name,
				...(client.uri ? { client_uri: client.uri } : {}),
				redirect_uris: client.redirect_uris,
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				token_endpoint_auth_method: "none",
			},
			201,
			{ "cache-control": "no-store" },
		);
	});

	// The start of the authorization code flow. After the client and the redirect URI check, each error
	// goes back to the client. A valid request waits for a person on the /connect page of the web app.
	app.get("/oauth/authorize", async (c) => {
		const query = new URL(c.req.url).searchParams;
		const clientId = query.get("client_id");
		const client = clientId ? await getClient(c.env.DIRECTORY, clientId) : null;
		if (!client) return authorizePageError("The app is not registered. Connect it again from the app.");
		const redirectUri = query.get("redirect_uri");
		if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
			return authorizePageError("The redirect address of the app is not registered.");
		}
		const state = query.get("state");
		const fail = (error: string, description: string) =>
			c.redirect(
				redirectWith(redirectUri, {
					error,
					error_description: description,
					state: state && state.length <= STATE_MAX_LENGTH ? state : null,
				}),
				302,
			);
		if (query.get("response_type") !== "code") {
			return fail("unsupported_response_type", "Only response_type=code is supported.");
		}
		const challenge = query.get("code_challenge");
		if (!challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || query.get("code_challenge_method") !== "S256") {
			return fail("invalid_request", "PKCE is required: send code_challenge with code_challenge_method=S256.");
		}
		if (state !== null && state.length > STATE_MAX_LENGTH) {
			return fail("invalid_request", `state can have at most ${STATE_MAX_LENGTH} characters.`);
		}
		if (!isOwnResource(query.get("resource"), originOf(c))) {
			return fail("invalid_target", "The resource must be the MCP endpoint of this server.");
		}
		const id = await createRequest(c.env.DIRECTORY, {
			client_id: client.id,
			redirect_uri: redirectUri,
			state,
			code_challenge: challenge,
			scopes: agentScopesOf(query.get("scope")),
		});
		const response = c.redirect(`/connect/${id}`, 302);
		response.headers.set("cache-control", "no-store");
		return response;
	});

	app.post("/oauth/token", async (c) => {
		const type = c.req.header("content-type") ?? "";
		if (!type.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
			return oauthError("invalid_request", "Send the parameters as application/x-www-form-urlencoded.");
		}
		const form = new URLSearchParams(await readBodyText(c.req.raw, OAUTH_BODY_BYTES));
		const clientId = form.get("client_id");
		if (!clientId) return oauthError("invalid_client", "Send client_id.", 401);
		switch (form.get("grant_type")) {
			case "authorization_code": {
				const code = form.get("code");
				const verifier = form.get("code_verifier");
				const redirectUri = form.get("redirect_uri");
				if (!code || !verifier || !redirectUri) {
					return oauthError("invalid_request", "Send code, code_verifier and redirect_uri.");
				}
				if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
					return oauthError("invalid_request", "code_verifier must have 43 to 128 unreserved characters.");
				}
				const redeemed = await redeemCode(c.env.DIRECTORY, code);
				if (!redeemed) return oauthError("invalid_grant", "The code is not valid, expired, or was used.");
				const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
				if (
					redeemed.client_id !== clientId ||
					redeemed.redirect_uri !== redirectUri ||
					!sameSecret(base64UrlEncode(digest), redeemed.code_challenge)
				) {
					return oauthError("invalid_grant", "The code does not match the client, the redirect URI or the verifier.");
				}
				const tokens = await createGrant(c.env.DIRECTORY, redeemed);
				auditToken(c, tokens, "oauth_code");
				return tokenResponse(tokens);
			}
			case "refresh_token": {
				const refreshToken = form.get("refresh_token");
				if (!refreshToken) return oauthError("invalid_request", "Send refresh_token.");
				const tokens = await refreshGrant(c.env.DIRECTORY, refreshToken, clientId);
				if (!tokens) return oauthError("invalid_grant", "The refresh token is not valid, expired, or was revoked.");
				auditToken(c, tokens, "oauth_refresh");
				return tokenResponse(tokens);
			}
			default:
				return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
		}
	});
}

function protectedResource(c: OAuthContext, resource: string): Response {
	return c.json(
		{
			resource,
			authorization_servers: [originOf(c)],
			scopes_supported: AGENT_SCOPES,
			bearer_methods_supported: ["header"],
			resource_name: "Soldock",
		},
		200,
		{ "cache-control": "public, max-age=300" },
	);
}

function auditToken(c: OAuthContext, tokens: IssuedTokens, credential: string): void {
	audit({
		op: credential === "oauth_code" ? "oauth.issue_tokens" : "oauth.refresh_tokens",
		actor: tokens.grant.principal_id,
		actorKind: "agent",
		credential,
		target: tokens.grant.id,
		result: "ok",
		requestId: c.var.requestId,
	});
}
