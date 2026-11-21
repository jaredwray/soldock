import { operationList, operationNeedsScope, SCOPES, type Scope } from "@asterra/contracts";
import { audit, OperationError } from "../platform/index.ts";
import type { AuthContext, CallContext } from "./auth.ts";
import { getGrant } from "./oauth-store.ts";
import { getApiKey, getPrincipal, type PrincipalRecord, scopeCeiling } from "./store.ts";

// The access rules that the API key and the OAuth handlers share.

export function isAdmin(caller: AuthContext): boolean {
	return caller.principal.org_role === "owner" || caller.principal.org_role === "admin";
}

/**
 * True when the caller can read the own mailbox of each agent: an owner or an admin. Never an agent,
 * so an agent can never read the mail of a different agent. A D1 CHECK already keeps a role off an
 * agent; the kind check is a second guard. The read access does not include a change. Any credential
 * of the person with `mail.read` has this access, also a narrow API key.
 */
export function canReadAgentMailboxes(caller: AuthContext): boolean {
	return caller.kind === "human" && isAdmin(caller);
}

/**
 * A human manages their own credentials (keys, password and two-step verification), the keys of the
 * agents that they sponsor and, as an admin, the credentials of others. Only the owner manages the owner's
 * credentials, so an admin can never act as the owner.
 */
export function canManageCredentialsOf(caller: AuthContext, target: PrincipalRecord): boolean {
	if (caller.kind !== "human") return false;
	if (target.id === caller.principal.id) return true;
	if (target.org_role === "owner") return false;
	if (target.kind === "agent" && target.sponsor_id === caller.principal.id) return true;
	return isAdmin(caller);
}

/**
 * The scopes for a new key. A key can never hold more than its principal kind allows, and never more
 * than the credential that creates it, so a narrow key cannot mint a wider one.
 */
export function grantableScopes(
	caller: AuthContext,
	target: Pick<PrincipalRecord, "kind">,
	requested: readonly Scope[],
): Scope[] {
	const ceiling = new Set(scopeCeiling(target.kind));
	const outside = requested.filter((scope) => !ceiling.has(scope));
	if (outside.length > 0) {
		throw new OperationError("invalid", `A key for an ${target.kind} cannot hold ${outside.join(", ")}.`);
	}
	const notHeld = requested.filter((scope) => !caller.scopes.has(scope));
	if (notHeld.length > 0) {
		throw new OperationError(
			"forbidden",
			`Your credential does not hold ${notHeld.join(", ")}, so it cannot grant it.`,
		);
	}
	return [...new Set(requested)];
}

/** A scope that the credential does not hold, and the operations of the caller kind that need it. */
export interface MissingScope {
	scope: Scope;
	description: string;
	operations: string[];
}

/**
 * The scopes that a credential of this kind can hold and this credential does not hold. Each one names
 * the operations of the caller kind that need it. A scope that no such operation needs is left out. MCP
 * lists only the tools that a credential can call, so this tells an agent which tools it cannot see.
 */
export function missingScopes(caller: AuthContext): MissingScope[] {
	return scopeCeiling(caller.kind)
		.filter((scope) => !caller.scopes.has(scope))
		.map((scope) => ({
			scope,
			description: SCOPES[scope],
			operations: operationList
				.filter((operation) => operationNeedsScope(operation, scope, caller.scopes, caller.kind))
				.map((operation) => operation.name),
		}))
		.filter((missing) => missing.operations.length > 0);
}

export function auditOk(call: CallContext, op: string, target: string): void {
	audit({
		op,
		actor: call.caller.principal.id,
		actorKind: call.caller.kind,
		credential: call.caller.credential,
		target,
		result: "ok",
		requestId: call.requestId,
	});
}

/**
 * The principal whose credentials the call manages: the caller by default. Throws unless the caller may
 * manage them.
 */
export async function credentialOwner(call: CallContext, principalId: string | undefined): Promise<PrincipalRecord> {
	const target =
		principalId === undefined || principalId === call.caller.principal.id
			? call.caller.principal
			: await getPrincipal(call.env.DIRECTORY, principalId);
	if (!target) throw new OperationError("not_found", "No principal has that id.");
	if (!canManageCredentialsOf(call.caller, target)) {
		throw new OperationError(
			"forbidden",
			"You can manage only your own credentials and the keys of agents that you sponsor.",
		);
	}
	return target;
}

/** The credential that made a lasting effect, such as a webhook. The effect stops when the credential stops. */
export interface CredentialBinding {
	principalId: string;
	kind: AuthContext["credential"];
	/** The API key or the OAuth grant. Null for a session: the effect then stops only with its principal. */
	id: string | null;
}

export function credentialBinding(caller: AuthContext): CredentialBinding {
	const id = caller.credential === "api_key" ? caller.keyId : caller.credential === "oauth" ? caller.grantId : null;
	return { principalId: caller.principal.id, kind: caller.credential, id };
}

/**
 * The state of a credential binding now. `live`: the principal and its credential work. `archived`: the
 * principal is archived, and a restore makes the credential work again. `ended`: the principal was
 * deleted, or the key or the OAuth grant was revoked or expired. A session binding ends only with its
 * principal: a sign-out does not end it.
 */
export async function credentialState(
	db: D1Database,
	binding: CredentialBinding,
): Promise<{ state: "live"; principal: PrincipalRecord } | { state: "archived" } | { state: "ended" }> {
	// A deleted principal has no address, so getPrincipal does not find it.
	const principal = await getPrincipal(db, binding.principalId);
	if (!principal) return { state: "ended" };
	if (binding.kind === "api_key") {
		const key = binding.id ? await getApiKey(db, binding.id) : null;
		if (!key || key.revoked_at !== null || key.principal_id !== principal.id) return { state: "ended" };
	} else if (binding.kind === "oauth") {
		const grant = binding.id ? await getGrant(db, binding.id) : null;
		if (
			!grant ||
			grant.revoked_at !== null ||
			grant.principal_id !== principal.id ||
			Date.parse(grant.refresh_expires_at) <= Date.now()
		) {
			return { state: "ended" };
		}
	}
	if (principal.archived_at !== null) return { state: "archived" };
	return { state: "live", principal };
}

/**
 * A credential, named by a value that is not its secret: the SHA-256 of a session cookie, the id of
 * an API key, or the SHA-256 of an OAuth access token. A live connection keeps it, and asks again
 * later if the credential works. For OAuth it names the token and not the grant, so a connection
 * stops with the token that opened it. `grantId` then names the grant, which can give a new token.
 */
export interface CredentialRef {
	principalId: string;
	kind: AuthContext["credential"];
	id: string;
	grantId?: string;
}

/** The same credential can open several sockets and register a push device. */
export function credentialKey(ref: CredentialRef): string {
	return `${ref.kind}:${ref.id}`;
}

export function credentialRef(caller: AuthContext): CredentialRef {
	const id =
		caller.credential === "session"
			? caller.sessionHash
			: caller.credential === "api_key"
				? caller.keyId
				: caller.accessHash;
	if (id === null) throw new Error(`a ${caller.credential} credential without an id`);
	const ref: CredentialRef = { principalId: caller.principal.id, kind: caller.credential, id };
	if (caller.grantId !== null) ref.grantId = caller.grantId;
	return ref;
}

/**
 * What a credential can do now.
 * - `live`: it works.
 * - `renew`: an OAuth access token that expired, or that a refresh replaced, while its grant works.
 *   The client can get a new token and connect again.
 * - `ended`: it does not work, and its owner cannot renew it.
 */
export type CredentialCheck = "live" | "renew" | "ended";

/**
 * For each credential, what it can do now, by the rules of `authenticate`: the principal is not
 * archived and not deleted, a session did not expire and its person did not sign out, an API key is
 * not revoked, and an OAuth access token is the current token of a grant that is not revoked, and did
 * not expire. So a refresh of a grant, which replaces its access token, stops the old token here too.
 * One query reads the whole list, and a credential that the list has many times is read one time. So
 * a room with many sockets makes one read.
 */
export async function checkCredentials(db: D1Database, refs: readonly CredentialRef[]): Promise<CredentialCheck[]> {
	if (refs.length === 0) return [];
	const keys = refs.map(credentialKey);
	const unique = [...new Map(refs.map((ref, index) => [keys[index] as string, ref])).values()];
	const { results } = await db
		.prepare(
			`SELECT json_extract(ref.value, '$.kind') || ':' || json_extract(ref.value, '$.id') AS key,
				CASE json_extract(ref.value, '$.kind')
					WHEN 'session' THEN CASE WHEN p.kind = 'human' AND EXISTS (
						SELECT 1 FROM sessions s
						WHERE s.token_hash = json_extract(ref.value, '$.id') AND s.principal_id = p.id AND s.expires_at > ?2)
						THEN 'live' END
					WHEN 'api_key' THEN CASE WHEN EXISTS (
						SELECT 1 FROM api_keys k
						WHERE k.id = json_extract(ref.value, '$.id') AND k.principal_id = p.id AND k.revoked_at IS NULL)
						THEN 'live' END
					WHEN 'oauth' THEN CASE
						WHEN EXISTS (
							SELECT 1 FROM oauth_grants g
							WHERE g.access_hash = json_extract(ref.value, '$.id') AND g.principal_id = p.id
								AND g.revoked_at IS NULL AND g.access_expires_at > ?2)
							THEN 'live'
						WHEN EXISTS (
							SELECT 1 FROM oauth_grants g
							WHERE g.id = json_extract(ref.value, '$.grantId') AND g.principal_id = p.id
								AND g.revoked_at IS NULL AND g.refresh_expires_at > ?2)
							THEN 'renew' END
				END AS state
			FROM json_each(?1) AS ref
			JOIN principals p ON p.id = json_extract(ref.value, '$.principalId')
				AND p.archived_at IS NULL AND p.deleted_at IS NULL`,
		)
		.bind(JSON.stringify(unique), new Date().toISOString())
		.all<{ key: string; state: CredentialCheck | null }>();
	const states = new Map(results.map((row) => [row.key, row.state ?? "ended"]));
	return keys.map((key) => states.get(key) ?? "ended");
}
