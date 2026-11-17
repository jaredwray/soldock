import { domainOf, type PrincipalRecord } from "../identity/index.ts";

/** The agent fields that the outbound policy uses. */
export type OutboundPrincipal = Pick<PrincipalRecord, "kind" | "outbound_mode" | "outbound_allowlist">;

/** The mode that a check uses. A missing mode is internal-only, the same as a new agent. */
export function outboundMode(principal: OutboundPrincipal): string {
	return principal.outbound_mode ?? "internal-only";
}

/**
 * The external addresses that this agent cannot mail. A human and mode `any` deny none. An empty
 * `addresses` list denies none. The addresses are already lowercase.
 */
export function deniedOutboundAddresses(principal: OutboundPrincipal, addresses: readonly string[]): string[] {
	if (principal.kind !== "agent" || addresses.length === 0) return [];
	const mode = outboundMode(principal);
	if (mode === "any") return [];
	const allowed = new Set(mode === "allowlist" ? principal.outbound_allowlist : []);
	return addresses.filter((address) => !allowed.has(address) && !allowed.has(domainOf(address)));
}

/** The text that `mail.send` and a later delivery both return for a refused address. */
export function outboundPolicyDenial(mode: string, addresses: readonly string[]): string {
	return `The outbound policy of this agent (${mode}) does not allow mail to ${addresses.join(", ")}. Ask its sponsor to change the policy.`;
}
