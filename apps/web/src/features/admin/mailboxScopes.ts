import { MAILBOX_MEMBER_SCOPES, type MailboxMemberScope, type Principal } from "@asterra/contracts";

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

/** The scopes as text, for a toast: "read, change and send". */
export function scopesText(scopes: readonly MailboxMemberScope[]): string {
	const names = scopes.map((scope) => MAILBOX_SCOPE_NAMES[scope].toLowerCase());
	if (names.length <= 1) return names.join("");
	return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** One principal that can use a mailbox, as a row of the access editor. */
export interface AccessMember {
	id: string;
	/** The name in the directory, or "Unknown account" for a principal that the directory did not give. */
	name: string;
	/** The address in the directory, or the id of the principal when the directory did not give it. */
	note: string;
	/** Null for a principal that the directory did not give. */
	kind: Principal["kind"] | null;
	archived: boolean;
	scopes: MailboxMemberScope[];
}

/**
 * The rows of the access editor: one for each principal that can use the mailbox, in the stored order. A
 * principal that the directory did not give keeps its row, with its id. So a read of the directory that
 * fails never hides a principal that has access, and the person can still remove it.
 */
export function accessMembers(
	stored: readonly { principal_id: string; scopes: readonly string[] }[],
	principals: readonly Principal[],
): AccessMember[] {
	const byId = new Map(principals.map((principal) => [principal.id, principal]));
	return stored.map((member) => {
		const principal = byId.get(member.principal_id);
		return {
			id: member.principal_id,
			name: principal?.display_name ?? "Unknown account",
			note: principal?.address ?? member.principal_id,
			kind: principal?.kind ?? null,
			archived: principal ? principal.archived_at !== null : false,
			scopes: memberScopes(member.scopes),
		};
	});
}
