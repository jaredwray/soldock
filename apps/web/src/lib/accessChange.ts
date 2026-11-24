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
