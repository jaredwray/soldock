/**
 * The scope catalogue. An operation names the scopes that it needs. A key of a person carries scopes, and
 * they only limit what the key can do: the role of the person and the resource still decide the rest. An
 * agent and a service account have account scopes for their own mailbox, their own drive and the actions
 * that have no mailbox, room or drive. In a team mailbox, a room and a shared drive, the membership decides
 * (`resource-access.ts`). In the mailbox of a person, the grant of that person decides.
 */
export const SCOPES = {
	"chat.webhooks": "Create a webhook endpoint and choose which chat message events Asterra sends to it",
	"account.read": "Read your own account",
	"account.keys":
		"Create, list and revoke API keys and OAuth connections for yourself and for the agents that you sponsor, approve OAuth requests, and change passwords and two-step verification",
	"directory.read":
		"Read the directory; owners and admins can also read mail domain settings, the mail settings of the organization, AI settings, AI usage and feedback settings",
	"directory.write":
		"Create accounts and change agent policies; owners and admins can also manage mail domains, team mailboxes, the mail settings of the organization, AI settings and feedback settings",
	"mail.read":
		"Read your mail, labels and Screener, and those of your team mailboxes and of the mailboxes that their owners let you use; owners and admins can also read the mailboxes of agents",
	"mail.modify":
		"Change labels, archive, trash, star and mark your mail, the mail of your team mailboxes and the mail of the mailboxes that their owners let you use, and screen senders in or out",
	"mail.send":
		"Send mail from your address, from the addresses of your team mailboxes and from the addresses of the mailboxes that their owners let you use",
	"mail.share": "Give and remove the access of other people and agents to your own mailbox",
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
	"calendar.read":
		"Read the events of your calendar and of the calendars that their owners let you schedule in, and find free times",
	"calendar.write":
		"Add, change and delete the events of your calendar and the events that you add to the calendars that their owners let you schedule in",
	"calendar.share": "Give and remove the access of other people and agents to your own calendar",
	"calendar.webhooks": "Subscribe to the changes of your calendar through MCP Events and webhooks",
	"feedback.write":
		"Send bug reports and ideas about Asterra as public issues to the GitHub repository that your admin chose",
} as const;

export type Scope = keyof typeof SCOPES;

export const ALL_SCOPES = Object.keys(SCOPES) as Scope[];

/**
 * The scopes that only the person gives to a key of the person. An owner or an admin who creates or rotates a
 * key of a different person cannot give them. `mail.share` gives other principals access to the mailbox of
 * the person, and `calendar.share` gives them access to the calendar of the person. That access stays after
 * the key ends.
 */
export const OWN_KEY_SCOPES: readonly Scope[] = ["mail.share", "calendar.share"];

/**
 * The account scopes of a new agent, and the most that an agent can hold. An agent cannot manage keys or the
 * directory, so it can never change its own policy or mint a wider token. An agent has its own drive, as it
 * has its own mailbox. An agent is a member of rooms, as a person is.
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
	"calendar.read",
	"calendar.write",
	"calendar.webhooks",
];

/**
 * The account scopes of a new service account, and the most that it can hold. A service account gives a
 * script or a system access through the API. It cannot manage keys or the directory, so it can never widen
 * its own access. It cannot create a webhook. Its outbound policy limits its mail, as for an agent.
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
	"calendar.read",
	"calendar.write",
] as const satisfies readonly Scope[];

export type ServiceScope = (typeof SERVICE_SCOPE_LIST)[number];

export const SERVICE_SCOPES: readonly Scope[] = SERVICE_SCOPE_LIST;

/**
 * The text of each account scope for a service account. `SCOPES` is written for a person ("your mail") and
 * names rights of owners and admins, which a service account never has. These texts name the service account
 * instead. In a team mailbox, a room and a shared drive, the membership decides, so these texts name only the
 * own mailbox and the own drive of the account.
 */
export const SERVICE_SCOPE_DESCRIPTIONS: Readonly<Record<ServiceScope, string>> = {
	"account.read": "Read the account of the service account",
	"directory.read": "Read the directory: the people, agents and service accounts of the organization",
	"mail.read": "Read the mail, labels and Screener of the own mailbox of the service account",
	"mail.modify": "Change labels, archive, trash, star and mark the mail of the own mailbox of the service account",
	"mail.send": "Send mail from the own address of the service account",
	"drive.read": "Read the own drive of the service account, and list the items that others shared with it",
	"drive.write": "Create, change, move and delete the items of the own drive of the service account",
	"drive.share": "Give and remove access to the items of its own drive",
	"chat.read": "Find the public rooms, and read the threads, mentions, saved messages and settings of the account",
	"chat.write": "Create rooms, open direct messages, and change the sections, reminders and settings of the account",
	"calendar.read":
		"Read the events of the own calendar of the service account and of the calendars whose owners let it schedule, and find free times",
	"calendar.write":
		"Add, change and delete the events of the own calendar of the service account, and the events that it adds to the calendars whose owners let it schedule",
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
