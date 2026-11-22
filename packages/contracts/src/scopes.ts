/**
 * The scope catalogue. A token carries scopes. An operation names the scopes that it needs. Scopes
 * only limit what a token can do: the owner's role and the resource still decide the rest.
 */
export const SCOPES = {
	"chat.webhooks": "Create a webhook endpoint and choose which chat message events Asterra sends to it",
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
	"mail.webhooks": "Create a webhook endpoint and choose which mailboxes send new mail to it",
	"drive.webhooks": "Create a webhook endpoint and choose which drives send item events to it",
	"drive.read":
		"Read your drive, the items that others shared with you and the shared drives that you are a member of: folders, files, docs and sheets",
	"drive.write":
		"Create, change, move and delete the items of your drive and of the shared drives where your role lets you, and change the items that others let you edit; owners and admins can also create, rename and delete shared drives",
	"drive.share":
		"Give and remove access to the items of your drive, and change the members of the shared drives that you manage",
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
	"chat.webhooks",
	"account.read",
	"directory.read",
	"mail.read",
	"mail.modify",
	"mail.send",
	"mail.webhooks",
	"drive.read",
	"drive.write",
	"drive.share",
	"drive.webhooks",
	"chat.read",
	"chat.write",
];

/**
 * The most that a token of a service account can hold. A service account gives a script or a system
 * access through the API. It cannot manage keys or the directory, so it can never widen its own access.
 * It cannot create a webhook. Its outbound policy limits its mail, as for an agent.
 */
const SERVICE_SCOPE_LIST = [
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
] as const satisfies readonly Scope[];

export type ServiceScope = (typeof SERVICE_SCOPE_LIST)[number];

export const SERVICE_SCOPES: readonly Scope[] = SERVICE_SCOPE_LIST;

/**
 * The text of each scope for a token of a service account. `SCOPES` is written for a person ("your
 * mail") and names rights of owners and admins, which a service account never has. These texts name the
 * service account instead.
 */
export const SERVICE_SCOPE_DESCRIPTIONS: Readonly<Record<ServiceScope, string>> = {
	"account.read": "Read the account of the service account",
	"directory.read": "Read the directory: the people, agents and service accounts of the organization",
	"mail.read": "Read the mail and labels of the service account, and those of its team mailboxes",
	"mail.modify":
		"Change labels, archive, trash, star and mark the mail of the service account and of its team mailboxes",
	"mail.send": "Send mail from the address of the service account and from the addresses of its team mailboxes",
	"drive.read":
		"Read the drive of the service account, the items that others shared with it, and the shared drives that it is a member of",
	"drive.write":
		"Create, change, move and delete the items of its drive and of the shared drives where its role lets it, and change the items that others let it edit",
	"drive.share": "Give and remove access to the items of its drive",
	"chat.read": "Read the rooms and direct messages of the service account, and find the public rooms",
	"chat.write": "Create and join rooms, change their members, post, change and delete messages, and set what it read",
};

/** The text of a scope for a caller of this kind: the service text for a service account. */
export function scopeDescription(scope: Scope, kind: "human" | "agent" | "service"): string {
	if (kind === "service" && Object.hasOwn(SERVICE_SCOPE_DESCRIPTIONS, scope)) {
		return SERVICE_SCOPE_DESCRIPTIONS[scope as ServiceScope];
	}
	return SCOPES[scope];
}

export function isScope(value: string): value is Scope {
	return Object.hasOwn(SCOPES, value);
}
