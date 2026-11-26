import { EmailAddress, Timestamp } from "./common.ts";
import { MailboxId } from "./mail.ts";
import { defineOperation } from "./operation.ts";
import { z } from "./zod.ts";

export const MAILBOX_ALIAS_LIMITS = {
	/** The aliases of one mailbox, apart from its primary address. */
	aliases: 10,
} as const;

/**
 * The address of an alias, in lowercase. The local part can contain only letters, digits, dots, hyphens and
 * underscores, so the address is safe in the path of a URL. A `+` is not permitted: mail to `user+tag@`
 * reaches `user@`.
 */
export const AliasAddress = EmailAddress.toLowerCase().regex(
	/^[a-z0-9._-]+@/,
	"must have a local part of letters, digits, dots, hyphens and underscores only",
);

/** One alias of a mailbox: an extra address that receives mail for the mailbox. */
export const MailboxAlias = z.object({
	address: z.string(),
	created_at: Timestamp,
});
export type MailboxAlias = z.infer<typeof MailboxAlias>;

/** The aliases of one mailbox, with its primary address. */
export const MailboxAliases = z.object({
	mailbox_id: z.string(),
	/** The primary address of the mailbox. Mail from the mailbox always uses this address. */
	address: z.string(),
	/** The aliases, the oldest first. */
	aliases: z.array(MailboxAlias),
});
export type MailboxAliases = z.infer<typeof MailboxAliases>;

const ADMIN_ONLY =
	"Owners and admins only. Only the owner can change the aliases of the own mailbox of the owner: an admin gets `forbidden` there.";

/** What an alias does, and what it does not do. */
const ALIAS_RULES =
	"An alias is an extra address that receives mail for the mailbox. Mail to the alias, also with a +tag, goes to the same mailbox as mail to the primary address. Mail from the mailbox always uses the primary address. An alias is not a sign-in name. Personal mailboxes (of a person, an agent or a service account) and team mailboxes can have aliases.";

const MailboxParam = MailboxId.describe(
	"The mailbox: the id of a principal for its own mailbox, or the id of a team mailbox.",
);

export const listMailboxAliases = defineOperation({
	name: "directory.list_mailbox_aliases",
	summary: "List the aliases of a mailbox",
	description: [
		"Returns the primary address of the mailbox and its aliases, the oldest first.",
		ALIAS_RULES,
		"An owner or an admin can read the aliases of each mailbox. A principal can read the aliases of its own mailbox. A member of a team mailbox can read the aliases of that mailbox.",
	].join(" "),
	http: { method: "GET", path: "/api/v1/directory/mailboxes/{mailbox_id}/aliases" },
	scopes: ["directory.read"],
	callers: ["human", "agent", "service"],
	annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
	input: z.strictObject({ mailbox_id: MailboxParam }),
	output: MailboxAliases,
	errors: ["not_found"],
});

export const addMailboxAlias = defineOperation({
	name: "directory.add_mailbox_alias",
	summary: "Add an alias to a mailbox",
	description: [
		ADMIN_ONLY,
		ALIAS_RULES,
		"The address must use a saved mail domain, and no principal, team mailbox or alias can have it.",
		"The alias receives mail at once. A second call with the same alias changes nothing.",
		`A mailbox can have at most ${MAILBOX_ALIAS_LIMITS.aliases} aliases.`,
	].join(" "),
	http: { method: "POST", path: "/api/v1/directory/mailboxes/{mailbox_id}/aliases" },
	scopes: ["directory.write"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
	input: z.strictObject({ mailbox_id: MailboxParam, address: AliasAddress }),
	output: MailboxAliases,
	errors: ["not_found", "conflict"],
});

export const removeMailboxAlias = defineOperation({
	name: "directory.remove_mailbox_alias",
	summary: "Remove an alias from a mailbox",
	description: [
		ADMIN_ONLY,
		"The alias stops at once: new mail to it is rejected, and a different mailbox can then have the address.",
		"The mail that the alias received stays in the mailbox. The primary address cannot be removed. A second call changes nothing.",
	].join(" "),
	http: { method: "DELETE", path: "/api/v1/directory/mailboxes/{mailbox_id}/aliases/{address}" },
	scopes: ["directory.write"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
	input: z.strictObject({ mailbox_id: MailboxParam, address: AliasAddress }),
	output: MailboxAliases,
	errors: ["not_found"],
});

export const mailboxAliasOperations = {
	"directory.list_mailbox_aliases": listMailboxAliases,
	"directory.add_mailbox_alias": addMailboxAlias,
	"directory.remove_mailbox_alias": removeMailboxAlias,
} as const;
