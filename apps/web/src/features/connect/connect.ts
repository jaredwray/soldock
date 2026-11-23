import { isScope, type Scope } from "@asterra/contracts";

// The first values of the approval page. The person can change each of them.

/** A name for a new agent from the name that the client gave itself, valid as a display name. */
export function agentNameFromClient(clientName: string): string {
	const name = clientName
		.replace(/[\p{Cc}"<>\\]/gu, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 100);
	return name || "Agent";
}

/** An address for a new agent on the first mail domain, from the client name. Empty without a domain. */
export function suggestedAddress(clientName: string, domains: readonly string[]): string {
	const domain = domains[0];
	if (!domain) return "";
	const local =
		clientName
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 32)
			.replace(/-+$/, "") || "agent";
	return `${local}@${domain}`;
}

/**
 * The scopes that the page selects first: the requested scopes that this session can grant, and
 * `account.read`, so that the agent can read who it is. When the client asked for none of them, each
 * scope that this session can grant.
 */
export function defaultScopes(requested: readonly string[], offered: readonly Scope[]): Scope[] {
	const asked = offered.filter((scope) => requested.includes(scope));
	if (asked.length === 0) return [...offered];
	return offered.filter((scope) => scope === "account.read" || asked.includes(scope));
}

/** What a connection of an agent that exists gives to the app, next to what the app asked for. */
export interface AgentGrant {
	/** Each scope of the agent, in the order of the agent. `requested`: the app asked for it. */
	held: { scope: string; requested: boolean }[];
	/** The Asterra scopes that the app asked for and the agent does not hold. The connection does not give them. */
	missing: Scope[];
	/** True when the app asked for at least one Asterra scope. If not, no held scope is more than the request. */
	asked: boolean;
}

/**
 * Compares the scopes of an agent with the request of the app. A connection has each scope of the agent,
 * also a scope that the app did not ask for, so the approval page must show the difference. A requested
 * scope that is not a scope of Asterra, such as `openid`, is not in the comparison.
 */
export function agentGrant(requested: readonly string[], agentScopes: readonly string[]): AgentGrant {
	const asked = [...new Set(requested)].filter(isScope);
	return {
		held: agentScopes.map((scope) => ({ scope, requested: asked.includes(scope as Scope) })),
		missing: asked.filter((scope) => !agentScopes.includes(scope)),
		asked: asked.length > 0,
	};
}
