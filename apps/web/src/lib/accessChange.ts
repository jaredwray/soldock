import type { AgentAccessChange } from "@asterra/contracts";

/** The resource of a membership, as a text names it. */
type MemberResource = "mailbox" | "room" | "shared drive";

/**
 * The text for what a call changed on an agent or a service account that it made a member, for a toast. An
 * empty text for a person, and for an agent that had the access. The person must see it: the scopes apply
 * to the account of the agent, not only to this mailbox, this room or this shared drive.
 */
export function accessChangeText(
	name: string,
	changes: readonly AgentAccessChange[],
	resource: MemberResource,
): string {
	const change = changes[0];
	if (!change) return "";
	const parts = [
		change.scopes_added.length > 0 ? `now also holds ${change.scopes_added.join(", ")}` : null,
		change.limits_widened ? `has this ${resource} in its limits now` : null,
	].filter((part) => part !== null);
	return parts.length === 0 ? "" : ` ${name} ${parts.join(", and ")}.`;
}

/** The fields of a room or a shared drive operation that tell what it changed on the agents that the person manages. */
export interface RoomAccessResult {
	agent_access_changes: readonly AgentAccessChange[];
	agent_access_pending: readonly string[];
}

/**
 * The text for what an operation of a room or a shared drive changed on the agents that the person manages,
 * for a toast. It names each agent that got scopes or the resource in its limits, and each agent that did not
 * get its access. An empty text when the operation changed no agent. `again` tells how to complete the access.
 */
export function memberAccessText(
	result: RoomAccessResult,
	nameOf: (principalId: string) => string,
	resource: "room" | "shared drive",
	again: string,
): string {
	const changed = result.agent_access_changes.map((change) =>
		accessChangeText(nameOf(change.principal_id), [change], resource),
	);
	const pending = result.agent_access_pending.map(
		(id) =>
			` ${nameOf(id)} is a member, but cannot use this ${resource} yet: its limits have no place for the ${resource}, or its access changed at the same time. ${again}`,
	);
	return [...changed, ...pending].join("");
}

/** `memberAccessText` for a room. */
export function roomAccessText(result: RoomAccessResult, nameOf: (principalId: string) => string): string {
	return memberAccessText(result, nameOf, "room", "Add it again.");
}

/** `memberAccessText` for a shared drive. */
export function driveAccessText(result: RoomAccessResult, nameOf: (principalId: string) => string): string {
	return memberAccessText(result, nameOf, "shared drive", "Set its role again.");
}
