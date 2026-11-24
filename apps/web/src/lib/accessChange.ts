import type { AgentAccessChange } from "@asterra/contracts";

/**
 * The text for what a call changed on an agent or a service account that it made a member, for a toast. An
 * empty text for a person, and for an agent that had the access. The person must see it: the scopes apply
 * to the account of the agent, not only to this mailbox or this room.
 */
export function accessChangeText(
	name: string,
	changes: readonly AgentAccessChange[],
	resource: "mailbox" | "room",
): string {
	const change = changes[0];
	if (!change) return "";
	const parts = [
		change.scopes_added.length > 0 ? `now also holds ${change.scopes_added.join(", ")}` : null,
		change.limits_widened ? `has this ${resource} in its limits now` : null,
	].filter((part) => part !== null);
	return parts.length === 0 ? "" : ` ${name} ${parts.join(", and ")}.`;
}

/** The fields of a room operation that tell what it changed on the agents that the person manages. */
export interface RoomAccessResult {
	agent_access_changes: readonly AgentAccessChange[];
	agent_access_pending: readonly string[];
}

/**
 * The text for what a room operation changed on the agents that the person manages, for a toast. It names
 * each agent that got scopes or the room in its limits, and each agent that did not get its access. An empty
 * text when the operation changed no agent.
 */
export function roomAccessText(result: RoomAccessResult, nameOf: (principalId: string) => string): string {
	const changed = result.agent_access_changes.map((change) =>
		accessChangeText(nameOf(change.principal_id), [change], "room"),
	);
	const pending = result.agent_access_pending.map(
		(id) =>
			` ${nameOf(id)} is a member, but cannot use this room yet: its limits have no place for the room, or its access changed at the same time. Add it again.`,
	);
	return [...changed, ...pending].join("");
}
