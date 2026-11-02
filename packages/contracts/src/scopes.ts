/**
 * The scope catalogue. A token carries scopes. An operation names the scopes that it needs. Scopes
 * only limit what a token can do: the owner's role and the resource still decide the rest.
 */
export const SCOPES = {
	"account.read": "Read your own account",
	"account.keys": "Create, list and revoke API keys for yourself and for the agents that you sponsor",
	"directory.read": "Read the directory of people and agents",
	"directory.write": "Create people and agents, and change the policy of an agent (owners, admins and sponsors)",
	"mail.read": "Read your mail and labels",
	"mail.modify": "Change labels, archive, trash, star and mark your mail",
	"mail.send": "Send mail from your address",
} as const;

export type Scope = keyof typeof SCOPES;

export const ALL_SCOPES = Object.keys(SCOPES) as Scope[];

/**
 * The most that an agent token can hold. An agent cannot manage keys or the directory, so it can
 * never change its own policy or mint a wider token.
 */
export const AGENT_SCOPES: readonly Scope[] = [
	"account.read",
	"directory.read",
	"mail.read",
	"mail.modify",
	"mail.send",
];

export function isScope(value: string): value is Scope {
	return Object.hasOwn(SCOPES, value);
}
