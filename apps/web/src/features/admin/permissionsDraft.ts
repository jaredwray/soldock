import { AGENT_SCOPES, type OutputOf, type Principal, type Scope, SERVICE_SCOPES } from "@asterra/contracts";

type Access = Pick<OutputOf<"directory.get_agent_access">, "scopes">;

/**
 * The scopes that the Permissions form offers: `SERVICE_SCOPES` for a service account, and `AGENT_SCOPES`
 * for an agent. The server refuses a scope outside this list.
 */
export function scopesFor(principal: Pick<Principal, "kind">): readonly Scope[] {
	return principal.kind === "service" ? SERVICE_SCOPES : AGENT_SCOPES;
}

/** The form choices that show the saved scopes, in the order of `offered`. `offered` is the list of `scopesFor`. */
export function draftOf(access: Access, offered: readonly Scope[]): readonly Scope[] {
	return offered.filter((scope) => access.scopes.includes(scope));
}

/**
 * The list of scopes that a save sends to `directory.set_agent_access`, or null when the draft is the same
 * as the saved scopes. The draft holds only scopes of `scopesFor`. The server checks the ceiling of a service
 * account.
 */
export function permissionsChange(draft: readonly Scope[], access: Access): Scope[] | null {
	const same = draft.length === access.scopes.length && draft.every((scope) => access.scopes.includes(scope));
	return same ? null : [...draft];
}
