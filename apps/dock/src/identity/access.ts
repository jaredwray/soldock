import type { Scope } from "@soldock/contracts";
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
