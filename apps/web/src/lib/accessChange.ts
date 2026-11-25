import type { AgentAccessChange } from "@asterra/contracts";

/**
 * The text for what a call changed on an agent or a service account that it made a member, for a toast. An
 * empty text for a person, and for an agent that held the scopes. The person must see it: the scopes apply
 * to the account of the agent, not only to this mailbox, this room or this shared drive.
 */
export function accessChangeText(name: string, changes: readonly AgentAccessChange[]): string {
	const change = changes[0];
	if (!change || change.scopes_added.length === 0) return "";
	return ` ${name} now also holds ${change.scopes_added.join(", ")}.`;
}

/** The fields of a room or a shared drive operation that tell what it changed on the agents that the person manages. */
export interface RoomAccessResult {
	agent_access_changes: readonly AgentAccessChange[];
	agent_access_pending: readonly string[];
}

/**
 * The text for what an operation of a room or a shared drive changed on the agents that the person manages,
 * for a toast. It names each agent that got scopes, and each agent that did not get the scopes of its
 * membership. An empty text when the operation changed no agent. `again` tells how to try again.
 */
export function memberAccessText(
	result: RoomAccessResult,
	nameOf: (principalId: string) => string,
	again: string,
): string {
	return agentAccessText(
		result,
		nameOf,
		(name) =>
			` ${name} is a member, but did not get the scopes of its membership: the access of the account changed at the same time. ${again}`,
	);
}

/**
 * The text for what a grant on a Drive item changed on the agents that the person manages, for a toast. The
 * account is not a member of a drive: it has a role on one item. `again` tells how to try again.
 */
export function shareAccessText(
	result: RoomAccessResult,
	nameOf: (principalId: string) => string,
	again: string,
): string {
	return agentAccessText(
		result,
		nameOf,
		(name) =>
			` ${name} has access to the item, but did not get the scopes of its role: the access of the account changed at the same time. ${again}`,
	);
}

/** The scopes that each agent got, then the text of `pendingText` for each agent that did not get its scopes. */
function agentAccessText(
	result: RoomAccessResult,
	nameOf: (principalId: string) => string,
	pendingText: (name: string) => string,
): string {
	const changed = result.agent_access_changes.map((change) => accessChangeText(nameOf(change.principal_id), [change]));
	const pending = result.agent_access_pending.map((id) => pendingText(nameOf(id)));
	return [...changed, ...pending].join("");
}

/** `memberAccessText` for a room. */
export function roomAccessText(result: RoomAccessResult, nameOf: (principalId: string) => string): string {
	return memberAccessText(result, nameOf, "Add it again.");
}

/** `memberAccessText` for a shared drive. */
export function driveAccessText(result: RoomAccessResult, nameOf: (principalId: string) => string): string {
	return memberAccessText(result, nameOf, "Select Try again in its row.");
}

/** How to give the scopes after an approval of a request: the request is gone, so the page of the account. */
const REQUEST_AGAIN = "Set its permissions on its page in Admin, Members.";

/**
 * `memberAccessText` for a member request that a person approved. The request is gone after the approval,
 * so the person gives the scopes on the page of the account.
 */
export function requestAccessText(result: RoomAccessResult, nameOf: (principalId: string) => string): string {
	return memberAccessText(result, nameOf, REQUEST_AGAIN);
}

/** `shareAccessText` for a share request that a person approved. As for a member request, the request is gone. */
export function shareRequestAccessText(result: RoomAccessResult, nameOf: (principalId: string) => string): string {
	return shareAccessText(result, nameOf, REQUEST_AGAIN);
}
