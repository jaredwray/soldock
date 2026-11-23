import { type AgentAccessChange, MAILBOX_MEMBER_SCOPES, type MailboxMemberScope } from "@asterra/contracts";

// What a member can do in a shared mailbox: the scopes of the membership, as the settings of the mailbox show them.

/** The name of each scope in the settings of a shared mailbox. */
export const MAILBOX_SCOPE_NAMES: Readonly<Record<MailboxMemberScope, string>> = {
	"mail.read": "Read",
	"mail.modify": "Change",
	"mail.send": "Send",
};

/** The scopes of a member, of the known ones, in the order of the settings. */
export function memberScopes(scopes: readonly string[]): MailboxMemberScope[] {
	return MAILBOX_MEMBER_SCOPES.filter((scope) => scopes.includes(scope));
}

/**
 * The scopes after a click on one check box. Null when the click removes the last scope: a member has at
 * least one scope, and Remove takes the access away.
 */
export function toggleMemberScope(
	scopes: readonly MailboxMemberScope[],
	scope: MailboxMemberScope,
): MailboxMemberScope[] | null {
	const next = MAILBOX_MEMBER_SCOPES.filter((one) => (one === scope ? !scopes.includes(one) : scopes.includes(one)));
	return next.length === 0 ? null : next;
}

/**
 * The text for what a call changed on an agent or a service account, for a toast. An empty text for a
 * person, and for an agent that had the access. The admin must see it: the scopes also apply to the own
 * mailbox of the agent.
 */
export function accessChangeText(name: string, changes: readonly AgentAccessChange[]): string {
	const change = changes[0];
	if (!change) return "";
	const parts = [
		change.scopes_added.length > 0 ? `now also holds ${change.scopes_added.join(", ")}` : null,
		change.limits_widened ? "has this mailbox in its limits now" : null,
	].filter((part) => part !== null);
	return parts.length === 0 ? "" : ` ${name} ${parts.join(", and ")}.`;
}

/** The scopes as text, for a toast: "read, change and send". */
export function scopesText(scopes: readonly MailboxMemberScope[]): string {
	const names = scopes.map((scope) => MAILBOX_SCOPE_NAMES[scope].toLowerCase());
	if (names.length <= 1) return names.join("");
	return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
