import { EmailAddress, prefixedId, Timestamp } from "./common.ts";
import { DisplayName } from "./directory.ts";
import { defineOperation } from "./operation.ts";
import type { Scope } from "./scopes.ts";
import { z } from "./zod.ts";

const PrincipalId = prefixedId("prn");
const TeamMailboxId = prefixedId("tmb");

export const TEAM_MAILBOX_LIMITS = {
	/** The people and agents of one team mailbox. */
	members: 100,
} as const;

/**
 * What a member can do in a team mailbox. These are the mail scopes, for one mailbox: `mail.read` reads the
 * mail and the labels, `mail.modify` changes them, and `mail.send` sends from the address of the mailbox.
 * The rule is the same for a person, an agent and a service account. The scopes of the credential apply
 * too: a call needs its scope in the credential and in the membership.
 */
export const MAILBOX_MEMBER_SCOPES = ["mail.read", "mail.modify", "mail.send"] as const satisfies readonly Scope[];
export type MailboxMemberScope = (typeof MAILBOX_MEMBER_SCOPES)[number];

/** The scopes that an operation needs in the membership of a team mailbox: its mail scopes of the list above. */
export function mailboxMemberScopes(scopes: readonly string[]): MailboxMemberScope[] {
	return MAILBOX_MEMBER_SCOPES.filter((scope) => scopes.includes(scope));
}

const MemberScopes = z
	.array(z.enum(MAILBOX_MEMBER_SCOPES))
	.min(1)
	.refine((scopes) => new Set(scopes).size === scopes.length, "must not name a scope two times");

/** One member of a team mailbox, with what the member can do in it. */
export const TeamMailboxMember = z.object({
	principal_id: z.string(),
	/** Of `MAILBOX_MEMBER_SCOPES`. An empty list: the member can do nothing in the mailbox. */
	scopes: z.array(z.string()),
});
export type TeamMailboxMember = z.infer<typeof TeamMailboxMember>;

/**
 * A mailbox with its own address that a list of people and agents shares. It is not a principal: it
 * has no credential and cannot sign in. Each member uses it with their own credential.
 */
export const TeamMailbox = z.object({
	id: z.string(),
	display_name: z.string(),
	address: z.string(),
	/** The ids of the people and agents that can use the mailbox, in the order of `members`. */
	member_ids: z.array(z.string()),
	/** Each member with its scopes in the mailbox, in the order in which they joined. */
	members: z.array(TeamMailboxMember),
	created_at: Timestamp,
});
export type TeamMailbox = z.infer<typeof TeamMailbox>;

const ADMIN_ONLY = "Owners and admins only.";

/** What a membership gives to an agent or a service account. */
const AGENT_MEMBER =
	"The membership alone decides what an agent or a service account can do in the mailbox. Its account and its API keys do not change, and it can use the mailbox at once with each key.";

export const listTeamMailboxes = defineOperation({
	name: "directory.list_team_mailboxes",
	summary: "List the team mailboxes of the organization",
	description:
		"Returns each team mailbox with its address and its members. A team mailbox is a shared mailbox. Each member has scopes in it: mail.read to read it, mail.modify to change it and mail.send to send from its address. To get only the mailboxes that you can use, call mail.list_mailboxes.",
	http: { method: "GET", path: "/api/v1/directory/team-mailboxes" },
	scopes: ["directory.read"],
	callers: ["human", "agent", "service"],
	annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
	input: z.strictObject({}),
	output: z.object({ team_mailboxes: z.array(TeamMailbox) }),
	errors: [],
});

export const createTeamMailbox = defineOperation({
	name: "directory.create_team_mailbox",
	summary: "Create a team mailbox",
	description: [
		ADMIN_ONLY,
		"Creates a shared mailbox with its own address on one of the mail domains of the deployment, for example support@example.com.",
		"Each member (a person, an agent or a service account) gets mail.read, mail.modify and mail.send in the mailbox: it can read the mailbox, change it and send from its address.",
		"To give a member fewer scopes, call directory.add_team_mailbox_member with scopes.",
		AGENT_MEMBER,
		"The creator is not a member unless member_ids names them.",
	].join(" "),
	http: { method: "POST", path: "/api/v1/directory/team-mailboxes" },
	scopes: ["directory.write"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: false },
	input: z.strictObject({
		display_name: DisplayName,
		address: EmailAddress,
		member_ids: z.array(PrincipalId).max(TEAM_MAILBOX_LIMITS.members).default([]),
	}),
	output: z.object({ team_mailbox: TeamMailbox }),
	errors: ["conflict", "not_found"],
});

export const updateTeamMailbox = defineOperation({
	name: "directory.update_team_mailbox",
	summary: "Change the name of a team mailbox",
	description: [
		ADMIN_ONLY,
		"Mail that the members send from the mailbox has the new name in From. The address, the mail, the labels and the members do not change.",
		"The address of a team mailbox cannot change.",
	].join(" "),
	http: { method: "POST", path: "/api/v1/directory/team-mailboxes/{mailbox_id}" },
	scopes: ["directory.write"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
	input: z.strictObject({ mailbox_id: TeamMailboxId, display_name: DisplayName }),
	output: z.object({ team_mailbox: TeamMailbox }),
	errors: ["not_found", "conflict"],
});

export const addTeamMailboxMember = defineOperation({
	name: "directory.add_team_mailbox_member",
	summary: "Give a person or an agent access to a team mailbox, or change what a member can do in it",
	description: [
		ADMIN_ONLY,
		"scopes says what the member can do in this mailbox: mail.read, mail.modify and mail.send. A new member without scopes gets the three.",
		"For a principal that is a member, scopes replaces the scopes of the membership. Without scopes, the membership does not change.",
		"The member can use the mailbox at once. A person uses it with each credential that holds the scopes. An agent uses it with each of its keys.",
		AGENT_MEMBER,
		"An agent can never add itself. The outbound policy of an agent also applies to mail that it sends from a team mailbox.",
	].join(" "),
	http: { method: "POST", path: "/api/v1/directory/team-mailboxes/{mailbox_id}/members" },
	scopes: ["directory.write"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
	input: z.strictObject({
		mailbox_id: TeamMailboxId,
		principal_id: PrincipalId,
		/** What the member can do in the mailbox. The default for a new member is each scope. */
		scopes: MemberScopes.optional(),
	}),
	output: z.object({ team_mailbox: TeamMailbox }),
	errors: ["not_found"],
});

export const removeTeamMailboxMember = defineOperation({
	name: "directory.remove_team_mailbox_member",
	summary: "Remove the access of a person or an agent to a team mailbox",
	description: `${ADMIN_ONLY} The access ends at once. The mail stays in the team mailbox.`,
	http: { method: "DELETE", path: "/api/v1/directory/team-mailboxes/{mailbox_id}/members/{principal_id}" },
	scopes: ["directory.write"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
	input: z.strictObject({ mailbox_id: TeamMailboxId, principal_id: PrincipalId }),
	output: z.object({ team_mailbox: TeamMailbox }),
	errors: ["not_found"],
});

export const teamMailboxOperations = {
	"directory.list_team_mailboxes": listTeamMailboxes,
	"directory.create_team_mailbox": createTeamMailbox,
	"directory.update_team_mailbox": updateTeamMailbox,
	"directory.add_team_mailbox_member": addTeamMailboxMember,
	"directory.remove_team_mailbox_member": removeTeamMailboxMember,
} as const;
