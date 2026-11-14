import type { Scope } from "@soldock/contracts";
import { audit, OperationError } from "../platform/index.ts";
import type { AuthContext, CallContext } from "./auth.ts";
import { getPrincipal, type PrincipalRecord, scopeCeiling } from "./store.ts";

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
