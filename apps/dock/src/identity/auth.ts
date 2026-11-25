import { ALL_SCOPES, type PrincipalKind, resourceDecidedScopes, type Scope } from "@asterra/contracts";
import { type Caller, type InvokeOutcome, sha256Hex } from "../platform/index.ts";
import { type RequestTrace, recordRefusedToken } from "./access.ts";
import { ACCESS_TOKEN_PREFIX, findGrantByAccessToken, touchGrant } from "./oauth-store.ts";
import { findApiKey, findSession, type PrincipalRecord, scopeCeiling, touchApiKey } from "./store.ts";

/** `__Host-` makes the browser refuse the cookie unless it is Secure, host-only and on path `/`. */
export const SESSION_COOKIE = "__Host-soldock_session";

/** The authenticated principal of a request and what its credential can do. */
export interface AuthContext extends Caller {
	principal: PrincipalRecord;
	/**
	 * The kind of the caller: `service` for a service account. A product record uses
	 * `principal.kind`, so a service account is an agent there.
	 */
	kind: PrincipalKind;
	/** `oauth`: an access token that an MCP client got through OAuth. */
	credential: "session" | "api_key" | "oauth";
	keyId: string | null;
	/**
	 * The number of the secret of an API key: 0 for the first secret, one more for each rotation. A live
	 * connection keeps it, so the old secret stops with its overlap. Null for each other credential.
	 */
	keyGeneration: number | null;
	/** The OAuth grant of an `oauth` credential. A lasting effect, such as a webhook, stops with the grant. */
	grantId: string | null;
	/** The SHA-256 of the session cookie, for a session. A change can end the other sessions and keep this one. */
	sessionHash: string | null;
	/** The SHA-256 of the access token, for an `oauth` credential. A refresh of the grant replaces the token. */
	accessHash: string | null;
	scopes: ReadonlySet<Scope>;
}

/** The context that each operation handler gets. */
export interface CallContext {
	caller: AuthContext;
	env: Env;
	requestId: string;
	/** The origin of the request, such as `https://work.soldock.org`. A webhook cannot use its host. */
	origin: string;
	waitUntil(promise: Promise<unknown>): void;
	/** Set for a service account: the invoker reports each call to its activity log. */
	record?: ((outcome: InvokeOutcome) => void) | undefined;
	/**
	 * True when the invoker let an agent call an item operation without its scopes (`itemGrant`). The drive then
	 * counts only the grants that a person gave on single items.
	 */
	grantOnly?: boolean;
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
 * The scopes that a credential of this principal holds. A key or an OAuth connection of an agent or a service
 * account only proves its identity: it has the account scopes of the agent. They apply to the own mailbox, the
 * own drive and the actions without a resource (`resourceScopesOf`). A key of a person has its own scopes
 * (`own`). The ceiling of the kind applies again here, so a stored list with a wider scope still cannot
 * exceed it.
 */
function credentialScopes(principal: PrincipalRecord, own: readonly Scope[]): Scope[] {
	const ceiling = new Set<Scope>(scopeCeiling(principal));
	const scopes = principal.kind === "agent" ? principal.agent_scopes : own;
	return scopes.filter((scope) => ceiling.has(scope));
}

/**
 * For an agent or a service account: the scopes of a call that the membership of a team mailbox, a room or a
 * shared drive decides, or a share of an item (`resourceDecidedScopes`). The object of the resource checks
 * them on the call, so the account scopes do not decide them. The ceiling of the kind still applies, so a
 * service account never gets a scope that its kind cannot hold. Undefined for a person: the scopes of a key
 * of a person limit each call.
 */
function resourceScopesOf(principal: PrincipalRecord): AuthContext["resourceScopes"] {
	if (principal.kind !== "agent") return undefined;
	const ceiling = new Set<string>(scopeCeiling(principal));
	return (operation, rawInput) =>
		resourceDecidedScopes(operation, rawInput, principal.id).filter((scope) => ceiling.has(scope));
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
	options: {
		allowSession: boolean;
		/** Where the request came from. A refused token of a service account goes into its activity log. */
		trace: RequestTrace;
	},
): Promise<AuthContext | null> {
	const authorization = request.headers.get("authorization");
	if (authorization !== null) {
		const match = /^Bearer\s+(\S+)$/i.exec(authorization);
		if (!match?.[1]) return null;
		if (match[1].startsWith(ACCESS_TOKEN_PREFIX)) {
			const granted = await findGrantByAccessToken(env.DIRECTORY, match[1]);
			// A service account never connects through OAuth. The approval refuses it, and this is a second guard.
			if (!granted || granted.principal.archived_at !== null || granted.principal.service) return null;
			waitUntil(touchGrant(env.DIRECTORY, granted.grant));
			// An OAuth connection is only a credential of its agent: the scopes are those of the
			// agent, so a change of the agent applies to the next request of each access token.
			return {
				id: granted.principal.id,
				principal: granted.principal,
				kind: granted.principal.kind,
				credential: "oauth",
				keyId: null,
				keyGeneration: null,
				grantId: granted.grant.id,
				sessionHash: null,
				accessHash: await sha256Hex(match[1]),
				scopes: new Set(credentialScopes(granted.principal, [])),
				resourceScopes: resourceScopesOf(granted.principal),
			};
		}
		const found = await findApiKey(env.DIRECTORY, match[1]);
		if (!found || found.principal.archived_at !== null) {
			waitUntil(recordRefusedToken(env, match[1], options.trace));
			return null;
		}
		waitUntil(touchApiKey(env.DIRECTORY, found.key));
		return {
			id: found.principal.id,
			principal: found.principal,
			kind: found.principal.service ? "service" : found.principal.kind,
			credential: "api_key",
			keyId: found.key.id,
			keyGeneration: found.generation,
			grantId: null,
			sessionHash: null,
			accessHash: null,
			scopes: new Set(credentialScopes(found.principal, found.key.scopes)),
			resourceScopes: resourceScopesOf(found.principal),
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
		keyGeneration: null,
		grantId: null,
		sessionHash: session.tokenHash,
		accessHash: null,
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
