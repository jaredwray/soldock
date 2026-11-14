import { ALL_SCOPES, type Scope } from "@soldock/contracts";
import type { Caller } from "../platform/index.ts";
import { ACCESS_TOKEN_PREFIX, findGrantByAccessToken, touchGrant } from "./oauth-store.ts";
import { findApiKey, findSession, type PrincipalRecord, scopeCeiling, touchApiKey } from "./store.ts";

/** `__Host-` makes the browser refuse the cookie unless it is Secure, host-only and on path `/`. */
export const SESSION_COOKIE = "__Host-soldock_session";

/** The authenticated principal of a request and what its credential can do. */
export interface AuthContext extends Caller {
	principal: PrincipalRecord;
	kind: PrincipalRecord["kind"];
	/** `oauth`: an access token that an MCP client got through OAuth. */
	credential: "session" | "api_key" | "oauth";
	keyId: string | null;
	/** The SHA-256 of the session cookie, for a session. A change can end the other sessions and keep this one. */
	sessionHash: string | null;
	scopes: ReadonlySet<Scope>;
}

/** The context that each operation handler gets. */
export interface CallContext {
	caller: AuthContext;
	env: Env;
	requestId: string;
	waitUntil(promise: Promise<unknown>): void;
}

export function readCookie(request: Request, name: string): string | null {
	const header = request.headers.get("cookie");
	if (!header) return null;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
	}
	return null;
}

/**
 * Finds the principal of a request. A bearer token comes first: an API key or an OAuth access token.
 * An archived principal is not authenticated, with any credential. A deleted principal has no record.
 * When a request has an Authorization header that is not a live token, the request is not
 * authenticated, and the session cookie is not tried. The cookie is tried only when `allowSession` is
 * true: MCP takes bearer tokens only.
 */
export async function authenticate(
	request: Request,
	env: Env,
	waitUntil: (promise: Promise<unknown>) => void,
	options: { allowSession: boolean },
): Promise<AuthContext | null> {
	const authorization = request.headers.get("authorization");
	if (authorization !== null) {
		const match = /^Bearer\s+(\S+)$/i.exec(authorization);
		if (!match?.[1]) return null;
		if (match[1].startsWith(ACCESS_TOKEN_PREFIX)) {
			const granted = await findGrantByAccessToken(env.DIRECTORY, match[1]);
			if (!granted || granted.principal.archived_at !== null) return null;
			waitUntil(touchGrant(env.DIRECTORY, granted.grant));
			const ceiling = new Set<Scope>(scopeCeiling(granted.principal.kind));
			return {
				id: granted.principal.id,
				principal: granted.principal,
				kind: granted.principal.kind,
				credential: "oauth",
				keyId: null,
				sessionHash: null,
				scopes: new Set(granted.grant.scopes.filter((scope) => ceiling.has(scope))),
			};
		}
		const found = await findApiKey(env.DIRECTORY, match[1]);
		if (!found || found.principal.archived_at !== null) return null;
		waitUntil(touchApiKey(env.DIRECTORY, found.key));
		// The ceiling applies again here, so a key row with a wider scope list still cannot exceed it.
		const ceiling = new Set<Scope>(scopeCeiling(found.principal.kind));
		return {
			id: found.principal.id,
			principal: found.principal,
			kind: found.principal.kind,
			credential: "api_key",
			keyId: found.key.id,
			sessionHash: null,
			scopes: new Set(found.key.scopes.filter((scope) => ceiling.has(scope))),
		};
	}
	if (!options.allowSession) return null;
	const token = readCookie(request, SESSION_COOKIE);
	if (!token) return null;
	const session = await findSession(env.DIRECTORY, token);
	if (session?.principal.kind !== "human" || session.principal.archived_at !== null) return null;
	// A human signs in with a password and, when it is on, a TOTP code, so a session holds every human scope.
	return {
		id: session.principal.id,
		principal: session.principal,
		kind: "human",
		credential: "session",
		keyId: null,
		sessionHash: session.tokenHash,
		scopes: new Set<Scope>(ALL_SCOPES),
	};
}

/**
 * True when a state-changing request with a session cookie comes from this origin. Browsers send
 * `Origin` on each cross-origin request and on each same-origin POST, so a missing or different
 * Origin means a forged cross-site request.
 */
export function isSameOrigin(request: Request): boolean {
	const origin = request.headers.get("origin");
	return origin !== null && origin === new URL(request.url).origin;
}
