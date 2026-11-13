import { EmailAddress, prefixedId, Timestamp } from "./common.ts";
import { DisplayName } from "./directory.ts";
import { defineOperation } from "./operation.ts";
import { z } from "./zod.ts";

const PrincipalId = prefixedId("prn");
const TeamMailboxId = prefixedId("tmb");

export const TEAM_MAILBOX_LIMITS = {
	/** The people and agents of one team mailbox. */
	members: 100,
} as const;

/**
 * A mailbox with its own address that a list of people and agents shares. It is not a principal: it
 * has no credential and cannot sign in. Each member uses it with their own credential.
 */
export const TeamMailbox = z.object({
	id: z.string(),
	display_name: z.string(),
	address: z.string(),
	/** The ids of the people and agents that can use the mailbox. */
	member_ids: z.array(z.string()),
	created_at: Timestamp,
});
export type TeamMailbox = z.infer<typeof TeamMailbox>;

const ADMIN_ONLY = "Owners and admins only.";

export const listTeamMailboxes = defineOperation({
	name: "directory.list_team_mailboxes",
	summary: "List the team mailboxes of the organization",
	description:
		"Returns each team mailbox with its address and the ids of its members. A team mailbox is a shared mailbox: each member can read it, change it and send from its address. To get only the mailboxes that you can use, call mail.list_mailboxes.",
	http: { method: "GET", path: "/api/v1/directory/team-mailboxes" },
	scopes: ["directory.read"],
	callers: ["human", "agent"],
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
		"Each member (a person or an agent) can read the mailbox, change it and send from its address.",
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

export const addTeamMailboxMember = defineOperation({
	name: "directory.add_team_mailbox_member",
	summary: "Give a person or an agent access to a team mailbox",
	description: [
		ADMIN_ONLY,
		"The member can use the mailbox at once, with each credential that holds the mail scopes.",
		"An agent can never add itself. The outbound policy of an agent also applies to mail that it sends from a team mailbox.",
	].join(" "),
	http: { method: "POST", path: "/api/v1/directory/team-mailboxes/{mailbox_id}/members" },
	scopes: ["directory.write"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
	input: z.strictObject({ mailbox_id: TeamMailboxId, principal_id: PrincipalId }),
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
	"directory.add_team_mailbox_member": addTeamMailboxMember,
	"directory.remove_team_mailbox_member": removeTeamMailboxMember,
} as const;
