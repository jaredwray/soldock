/**
 * The scope catalogue. A token carries scopes. An operation names the scopes that it needs. Scopes
 * only limit what a token can do: the owner's role and the resource still decide the rest.
 */
export const SCOPES = {
	"account.read": "Read your own account",
	"account.keys":
		"Create, list and revoke API keys for yourself and for the agents that you sponsor, and change passwords and two-step verification",
	"directory.read": "Read the directory; owners and admins can also read mail domain settings",
	"directory.write": "Create accounts and change agent policies; owners and admins can also manage mail domains",
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
