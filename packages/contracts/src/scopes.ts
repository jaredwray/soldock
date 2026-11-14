/**
 * The scope catalogue. A token carries scopes. An operation names the scopes that it needs. Scopes
 * only limit what a token can do: the owner's role and the resource still decide the rest.
 */
export const SCOPES = {
	"account.read": "Read your own account",
	"account.keys":
		"Create, list and revoke API keys and OAuth connections for yourself and for the agents that you sponsor, approve OAuth requests, and change passwords and two-step verification",
	"directory.read": "Read the directory; owners and admins can also read mail domain settings",
	"directory.write":
		"Create accounts and change agent policies; owners and admins can also manage mail domains and team mailboxes",
	"mail.read":
		"Read your mail and labels, and those of your team mailboxes; owners and admins can also read the mailboxes of agents",
	"mail.modify": "Change labels, archive, trash, star and mark your mail and the mail of your team mailboxes",
	"mail.send": "Send mail from your address and from the addresses of your team mailboxes",
	"drive.read": "Read your drive and the items that others shared with you: folders, files, docs and sheets",
	"drive.write":
		"Create, change, move and delete the items of your drive, and change the items that others let you edit",
	"drive.share": "Give and remove access to the items of your drive",
	"chat.read": "Read your rooms and direct messages, and find the public rooms",
	"chat.write": "Create and join rooms, change their members, post, change and delete messages, and set what you read",
} as const;

export type Scope = keyof typeof SCOPES;

export const ALL_SCOPES = Object.keys(SCOPES) as Scope[];

/**
 * The most that an agent token can hold. An agent cannot manage keys or the directory, so it can
 * never change its own policy or mint a wider token. An agent has its own drive, as it has its own mailbox.
 * An agent is a member of rooms, as a person is.
 */
export const AGENT_SCOPES: readonly Scope[] = [
	"account.read",
	"directory.read",
	"mail.read",
	"mail.modify",
	"mail.send",
	"drive.read",
	"drive.write",
	"drive.share",
	"chat.read",
	"chat.write",
];

export function isScope(value: string): value is Scope {
	return Object.hasOwn(SCOPES, value);
}
