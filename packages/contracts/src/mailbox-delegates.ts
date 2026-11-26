import { prefixedId, Timestamp } from "./common.ts";
import { defineOperation } from "./operation.ts";
import { MemberScopes } from "./team-mailboxes.ts";
import { z } from "./zod.ts";

const PrincipalId = prefixedId("prn");

export const MAILBOX_DELEGATE_LIMITS = {
	/** The people and agents that one person lets use their own mailbox. */
	delegates: 25,
} as const;

/**
 * A person or an agent that the owner of a mailbox lets use it. The grant has the mail scopes of the list
 * `MAILBOX_MEMBER_SCOPES`, for this one mailbox: `mail.read` reads the mail and the labels, `mail.modify`
 * changes them, and `mail.send` sends from the address of the owner. A mailbox has no delegate until its
 * owner adds one.
 */
export const MailboxDelegate = z.object({
	principal_id: z.string(),
	/** Of `MAILBOX_MEMBER_SCOPES`. An empty list: the delegate can do nothing in the mailbox. */
	scopes: z.array(z.string()),
	created_at: Timestamp,
});
export type MailboxDelegate = z.infer<typeof MailboxDelegate>;

const OWN_MAILBOX = "People only, for their own mailbox. An owner or an admin cannot do this for a different person.";

/** What a delegate gets, and what stays with the owner. */
const DELEGATE_RULES =
	"The delegate uses the mailbox with its own credential: it passes your id as mailbox_id, and mail.list_mailboxes shows your mailbox to it with the kind delegated. A send by a delegate comes from your name and your address, and the sent copy names the delegate in sent_by. Only you change the settings of the mailbox and its delegates.";

export const listDelegates = defineOperation({
	name: "mail.list_delegates",
	summary: "List the people and agents that can use your mailbox",
	description: `Returns each delegate of your own mailbox with its scopes there, in the order in which you added them. The list is empty until you add a delegate with mail.set_delegate. ${OWN_MAILBOX}`,
	http: { method: "GET", path: "/api/v1/mail/delegates" },
	scopes: ["mail.read"],
	callers: ["human"],
	annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
	input: z.strictObject({}),
	output: z.object({ delegates: z.array(MailboxDelegate) }),
	errors: [],
});

export const setDelegate = defineOperation({
	name: "mail.set_delegate",
	summary: "Let a person or an agent use your mailbox, or change what a delegate can do in it",
	description: [
		OWN_MAILBOX,
		"scopes says what the delegate can do in your mailbox: mail.read, mail.modify and mail.send. For a principal that is a delegate, scopes replaces the scopes of the grant.",
		"The grant applies at once.",
		DELEGATE_RULES,
		"Your credential must hold each scope that it gives, so a narrow key cannot give more than it can do.",
		"The grant alone decides what an agent or a service account can do in your mailbox. Its outbound policy also applies to the mail that it sends from your address.",
		`A mailbox can have at most ${MAILBOX_DELEGATE_LIMITS.delegates} delegates.`,
	].join(" "),
	http: { method: "POST", path: "/api/v1/mail/delegates" },
	scopes: ["mail.share"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
	input: z.strictObject({ principal_id: PrincipalId, scopes: MemberScopes }),
	output: z.object({ delegates: z.array(MailboxDelegate) }),
	errors: ["not_found"],
});

export const removeDelegate = defineOperation({
	name: "mail.remove_delegate",
	summary: "Remove the access of a person or an agent to your mailbox",
	description: `${OWN_MAILBOX} The access ends at once. The mail stays in your mailbox, also the mail that the delegate sent from it. A second call changes nothing.`,
	http: { method: "DELETE", path: "/api/v1/mail/delegates/{principal_id}" },
	scopes: ["mail.share"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
	input: z.strictObject({ principal_id: PrincipalId }),
	output: z.object({ delegates: z.array(MailboxDelegate) }),
	errors: [],
});

export const mailboxDelegateOperations = {
	"mail.list_delegates": listDelegates,
	"mail.set_delegate": setDelegate,
	"mail.remove_delegate": removeDelegate,
} as const;
