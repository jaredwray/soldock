import { Address, EmailAddress, prefixedId, Timestamp } from "./common.ts";
import { defineOperation } from "./operation.ts";
import { z } from "./zod.ts";

/** System labels. Every mailbox has them, and nobody can rename or delete them. */
export const SYSTEM_LABELS = ["INBOX", "STARRED", "IMPORTANT", "SENT", "SPAM", "TRASH", "UNREAD"] as const;
export type SystemLabel = (typeof SYSTEM_LABELS)[number];

export const MAIL_LIMITS = {
	/** Recipients in To, Cc and Bcc together. Email Service accepts 50 recipients for each message. */
	recipients: 50,
	subjectChars: 998,
	bodyChars: 2_000_000,
	attachments: 20,
	/** An inbound message. Email Routing accepts at most 25 MiB. */
	inboundMessageBytes: 25 * 1024 * 1024,
	/**
	 * A composed message for recipients in this deployment. A send holds several copies of the message
	 * at once, and a Worker isolate has 128 MB of memory, so this is less than the inbound limit.
	 */
	messageBytes: 10 * 1024 * 1024,
	/** The size of a composed message that has an external recipient. Email Service accepts at most 5 MiB. */
	externalMessageBytes: 5 * 1024 * 1024,
	labelNameChars: 225,
	userLabels: 500,
	threadsPerModify: 100,
	pageSize: 100,
	/** An attachment that `mail.get_attachment` returns as base64, for the same memory reason. */
	attachmentDownloadBytes: 10 * 1024 * 1024,
} as const;

const ThreadId = prefixedId("thr");
const MessageId = prefixedId("msg");

/** The id of a mailbox: the id of a principal for their own mailbox, or the id of a team mailbox. */
export const MailboxId = z
	.string()
	.regex(/^(?:prn|tmb)_[0-9A-HJKMNP-TV-Z]{26}$/, "must be a mailbox id that starts with prn_ or tmb_");

/** The input field that selects the mailbox of a mail operation. */
const MailboxParam = MailboxId.optional().describe(
	"The mailbox to use: an id from mail.list_mailboxes. The default is your own mailbox.",
);

/** One sentence for the description of each mail operation that takes `mailbox_id`. */
const IN_MAILBOX = "Set mailbox_id to use a team mailbox that you are a member of.";

/** The text about `mailbox_id` for an operation that only reads. Owners and admins can read the mailbox of an agent. */
const IN_MAILBOX_READ = `${IN_MAILBOX} An owner or an admin can also set the id of an agent, to read the mailbox of that agent.`;

/** The last sentence of an operation that changes a mailbox or sends from it. */
const AGENT_READ_ONLY =
	"Owners and admins can only read the mailbox of an agent, so this operation fails there with forbidden.";

/**
 * The kind of a mailbox, as the caller sees it. `personal`: the own mailbox of the caller. `team`: a
 * shared mailbox that the caller is a member of. `agent`: the own mailbox of an agent, for an owner or
 * an admin. They can read it, but they cannot change it or send from it.
 */
export const MailboxKind = z.enum(["personal", "team", "agent"]);
export type MailboxKind = z.infer<typeof MailboxKind>;

/** A mailbox that the caller can use. */
export const Mailbox = z.object({
	/** For `personal` and `agent`, the id of the principal. For `team`, the id of the team mailbox. */
	id: z.string(),
	kind: MailboxKind,
	address: z.string(),
	display_name: z.string(),
});
export type Mailbox = z.infer<typeof Mailbox>;
export const LabelId = z.union([z.enum(SYSTEM_LABELS), prefixedId("lbl")]);

export const Label = z.object({
	id: z.string(),
	name: z.string(),
	type: z.enum(["system", "user"]),
	threads_total: z.number().int(),
	threads_unread: z.number().int(),
});
export type Label = z.infer<typeof Label>;

export const ThreadSummary = z.object({
	id: z.string(),
	subject: z.string(),
	snippet: z.string(),
	participants: z.array(Address),
	message_count: z.number().int(),
	unread: z.boolean(),
	starred: z.boolean(),
	has_attachments: z.boolean(),
	label_ids: z.array(z.string()),
	last_message_at: Timestamp,
	/** True when a message in the thread came from outside the organization. The subject and snippet are then untrusted. */
	untrusted: z.boolean(),
});
export type ThreadSummary = z.infer<typeof ThreadSummary>;

export const Authentication = z.object({
	spf: z.string().nullable(),
	dkim: z.string().nullable(),
	dmarc: z.string().nullable(),
});

export const AttachmentInfo = z.object({
	index: z.number().int(),
	filename: z.string(),
	mime_type: z.string(),
	size: z.number().int(),
	inline: z.boolean(),
});

export const DeliveryStatus = z.object({
	address: z.string(),
	kind: z.enum(["local", "external"]),
	status: z.enum(["queued", "delivered", "sent", "failed"]),
	error: z.string().nullable(),
});
export type DeliveryStatus = z.infer<typeof DeliveryStatus>;

export const Message = z.object({
	id: z.string(),
	thread_id: z.string(),
	message_id_header: z.string().nullable(),
	from: Address.nullable(),
	to: z.array(Address),
	cc: z.array(Address),
	/** Only on mail that this mailbox sent. */
	bcc: z.array(Address),
	reply_to: z.array(Address),
	subject: z.string(),
	date: Timestamp,
	received_at: Timestamp,
	label_ids: z.array(z.string()),
	snippet: z.string(),
	/**
	 * `external`: it arrived from the internet. `internal`: another mailbox of this deployment sent it.
	 * `sent`: this mailbox sent it. The value comes from the delivery path, never from the headers.
	 */
	origin: z.enum(["external", "internal", "sent"]),
	/** True for `external` mail. Its headers, body and attachments are untrusted content. */
	untrusted: z.boolean(),
	/** SPF, DKIM and DMARC results from the receiving server, when it recorded them. */
	authentication: Authentication.nullable(),
	body: z.object({
		text: z.string().nullable(),
		/** HTML after the server-side allowlist sanitizer. Render it only in a sandboxed iframe. */
		html: z.string().nullable(),
		remote_images_blocked: z.number().int(),
		truncated: z.boolean(),
		/**
		 * True when `mail.get_thread` left this body out to keep a large thread in one response. The
		 * newest messages always have their bodies. Get this one with `mail.get_message`.
		 */
		omitted: z.boolean(),
	}),
	attachments: z.array(AttachmentInfo),
	/** The status for each recipient, on mail that this mailbox sent. */
	delivery: z.array(DeliveryStatus).nullable(),
	/**
	 * The person or agent that sent the message from this mailbox, with the name at that time. In a team
	 * mailbox it tells which member sent it. Null for mail that arrived, and for mail sent before this
	 * field existed.
	 */
	sent_by: z
		.object({
			principal_id: z.string(),
			kind: z.enum(["human", "agent"]),
			display_name: z.string(),
		})
		.nullable(),
});
export type Message = z.infer<typeof Message>;

export const Thread = z.object({
	id: z.string(),
	subject: z.string(),
	label_ids: z.array(z.string()),
	untrusted: z.boolean(),
	messages: z.array(Message),
});
export type Thread = z.infer<typeof Thread>;

const READ = { readOnly: true, destructive: false, idempotent: true, openWorld: false } as const;

export const listMailboxes = defineOperation({
	name: "mail.list_mailboxes",
	summary: "List the mailboxes that you can use",
	description:
		"Returns your own mailbox first, then each team mailbox that you are a member of. A team mailbox is a shared mailbox with its own address. For an owner or an admin, the list then has the mailbox of each agent (kind agent). They can read the mailbox of an agent, but they cannot change it or send from it. Pass the id of a mailbox as mailbox_id to the other mail operations. Without mailbox_id, they use your own mailbox.",
	http: { method: "GET", path: "/api/v1/mail/mailboxes" },
	scopes: ["mail.read"],
	callers: ["human", "agent"],
	annotations: READ,
	input: z.strictObject({}),
	output: z.object({ mailboxes: z.array(Mailbox) }),
	errors: [],
});

export const getProfile = defineOperation({
	name: "mail.get_profile",
	summary: "Get the address and counts of a mailbox",
	description: `Returns the address of the mailbox, the mail domains of this deployment, its message and thread totals, the unread inbox count, and a version number. The version grows with each change, so compare it to find out if anything changed. An address on a mail domain is local: mail to it never leaves the deployment. ${IN_MAILBOX_READ}`,
	http: { method: "GET", path: "/api/v1/mail/profile" },
	scopes: ["mail.read"],
	callers: ["human", "agent"],
	annotations: READ,
	input: z.strictObject({ mailbox_id: MailboxParam }),
	output: z.object({
		mailbox_id: z.string(),
		kind: MailboxKind,
		address: z.string(),
		display_name: z.string(),
		mail_domains: z.array(z.string()),
		messages_total: z.number().int(),
		threads_total: z.number().int(),
		inbox_unread: z.number().int(),
		version: z.number().int(),
	}),
	errors: [],
});

export const listLabels = defineOperation({
	name: "mail.list_labels",
	summary: "List the labels of a mailbox, with counts",
	description: `Returns the system labels (INBOX, STARRED, IMPORTANT, SENT, SPAM, TRASH, UNREAD) and the user labels of the mailbox, each with its total and unread thread counts. ${IN_MAILBOX_READ} The members of a team mailbox share its labels.`,
	http: { method: "GET", path: "/api/v1/mail/labels" },
	scopes: ["mail.read"],
	callers: ["human", "agent"],
	annotations: READ,
	input: z.strictObject({ mailbox_id: MailboxParam }),
	output: z.object({ labels: z.array(Label) }),
	errors: [],
});

export const createLabel = defineOperation({
	name: "mail.create_label",
	summary: "Create a label",
	description: `Creates a user label. Use a slash in the name to show it nested, for example Clients/Acme. ${IN_MAILBOX} ${AGENT_READ_ONLY}`,
	http: { method: "POST", path: "/api/v1/mail/labels" },
	scopes: ["mail.modify"],
	callers: ["human", "agent"],
	annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: false },
	input: z.strictObject({
		mailbox_id: MailboxParam,
		name: z
			.string()
			.trim()
			.min(1)
			.max(MAIL_LIMITS.labelNameChars)
			.refine((name) => !/[\p{Cc}]/u.test(name), "must not contain control characters"),
	}),
	output: Label,
	errors: ["conflict", "invalid"],
});

export const deleteLabel = defineOperation({
	name: "mail.delete_label",
	summary: "Delete a label",
	description: `Deletes a user label and removes it from every message. The messages stay in the mailbox. System labels cannot be deleted. ${IN_MAILBOX} ${AGENT_READ_ONLY}`,
	http: { method: "DELETE", path: "/api/v1/mail/labels/{label_id}" },
	scopes: ["mail.modify"],
	callers: ["human", "agent"],
	annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
	input: z.strictObject({ mailbox_id: MailboxParam, label_id: prefixedId("lbl") }),
	output: z.object({ deleted: z.boolean() }),
	errors: ["not_found"],
});

export const listThreads = defineOperation({
	name: "mail.list_threads",
	summary: "List or search threads",
	description: [
		"Returns threads that match a Gmail-style search query, newest first. The default query is in:inbox.",
		"Operators: from:, to:, cc:, subject:, label:, in:inbox|sent|starred|spam|trash|all|anywhere, is:unread|read|starred|important,",
		"has:attachment, filename:, before:YYYY/MM/DD, after:YYYY/MM/DD (UTC days), older_than:/newer_than: (with d, m or y, for example 7d),",
		"larger:/smaller: (with K or M, for example 2M), quoted phrases, a leading - to negate a term, and OR between terms.",
		"Other words search the subject, the people, the body and the attachment names.",
		"An empty query, or in:all, lists all mail except spam and trash, as the All Mail view does. Results exclude spam and trash unless the query names them or uses in:anywhere.",
		"Escape a double quote inside a quoted value with a backslash. Pass next_cursor as cursor to get the next page.",
		`${IN_MAILBOX_READ} In a team mailbox, from:me and to:me mean the address of the team mailbox.`,
	].join(" "),
	http: { method: "GET", path: "/api/v1/mail/threads" },
	scopes: ["mail.read"],
	callers: ["human", "agent"],
	annotations: READ,
	input: z.strictObject({
		mailbox_id: MailboxParam,
		query: z.string().max(2000).optional(),
		cursor: z.string().max(200).optional(),
		limit: z.coerce.number().int().min(1).max(MAIL_LIMITS.pageSize).optional(),
	}),
	output: z.object({
		threads: z.array(ThreadSummary),
		next_cursor: z.string().nullable(),
	}),
	errors: ["invalid"],
});

export const getThread = defineOperation({
	name: "mail.get_thread",
	summary: "Get a thread and all its messages",
	description: `Returns each message of a thread with headers, plain text, sanitized HTML, attachment details and, for mail that the mailbox sent, the delivery status of each recipient and who sent it (sent_by). In a very large thread, the oldest bodies can be left out (body.omitted): get them with mail.get_message. Reading a thread does not mark it as read: use mail.modify_threads to remove UNREAD. ${IN_MAILBOX_READ}`,
	http: { method: "GET", path: "/api/v1/mail/threads/{thread_id}" },
	scopes: ["mail.read"],
	callers: ["human", "agent"],
	annotations: READ,
	input: z.strictObject({ mailbox_id: MailboxParam, thread_id: ThreadId }),
	output: Thread,
	errors: ["not_found"],
});

export const getMessage = defineOperation({
	name: "mail.get_message",
	summary: "Get one message with its full body",
	description: `Returns one message with headers, plain text, sanitized HTML and attachment details. Use it for a message whose body mail.get_thread left out (body.omitted). Reading a message does not mark it as read. ${IN_MAILBOX_READ}`,
	http: { method: "GET", path: "/api/v1/mail/messages/{message_id}" },
	scopes: ["mail.read"],
	callers: ["human", "agent"],
	annotations: READ,
	input: z.strictObject({ mailbox_id: MailboxParam, message_id: MessageId }),
	output: Message,
	errors: ["not_found"],
});

export const modifyThreads = defineOperation({
	name: "mail.modify_threads",
	summary: "Add or remove labels on threads",
	description: [
		"Adds and removes labels on every message of the given threads.",
		"Archive: remove INBOX. Mark as read: remove UNREAD. Star: add STARRED. Move to trash: add TRASH. Report spam: add SPAM.",
		"Restore from trash or spam: remove TRASH or SPAM.",
		"Set dry_run to true to get the counts without a change.",
		`${IN_MAILBOX} A change in a team mailbox applies for each member: the members share the labels and the read state.`,
		AGENT_READ_ONLY,
	].join(" "),
	http: { method: "POST", path: "/api/v1/mail/threads/modify" },
	scopes: ["mail.modify"],
	callers: ["human", "agent"],
	annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
	input: z
		.strictObject({
			mailbox_id: MailboxParam,
			thread_ids: z.array(ThreadId).min(1).max(MAIL_LIMITS.threadsPerModify),
			add_label_ids: z.array(LabelId).max(20).default([]),
			remove_label_ids: z.array(LabelId).max(20).default([]),
			dry_run: z.boolean().default(false),
		})
		.refine((input) => input.add_label_ids.length + input.remove_label_ids.length > 0, "name a label to add or remove")
		.refine(
			(input) => !input.add_label_ids.some((id) => input.remove_label_ids.includes(id)),
			"a label cannot be added and removed in one call",
		),
	output: z.object({
		threads_changed: z.number().int(),
		messages_changed: z.number().int(),
		dry_run: z.boolean(),
	}),
	errors: ["not_found"],
});

const OutgoingAttachment = z.strictObject({
	filename: z
		.string()
		.trim()
		.min(1)
		.max(255)
		.refine(
			(name) => !/[\p{Cc}"\\/]/u.test(name),
			"must not contain control characters, quotes, slashes or backslashes",
		),
	mime_type: z
		.string()
		.max(127)
		.regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i, "must be a MIME type such as application/pdf"),
	content_base64: z
		.string()
		// The base64 of the largest message, so a request cannot make the Worker decode more than that.
		.max(Math.ceil(MAIL_LIMITS.messageBytes / 3) * 4, "must be at most 10 MiB")
		.regex(/^[A-Za-z0-9+/]*={0,2}$/, "must be base64"),
});

export const send = defineOperation({
	name: "mail.send",
	summary: "Send a message",
	description: [
		"Sends a message from the address of the mailbox: your own address by default. Recipients in this deployment get it directly. Other recipients get it through Cloudflare Email Service.",
		`${IN_MAILBOX} The message then comes from the address and the name of the team mailbox, and the sent copy is in the team mailbox with your name in sent_by.`,
		AGENT_READ_ONLY,
		"For formatted mail, also set html. The message then has two parts: text for mail apps without HTML, and html. Make text the plain-text form of html.",
		"To reply, set reply_to_message_id: the message joins that thread, and the subject defaults to Re: and the original subject.",
		"An agent can send only to the recipients that its policy allows, also from a team mailbox. Otherwise the call fails with policy_denied and nothing is sent.",
		"Set idempotency_key to make a retry safe: a second call with the same key and the same message returns the first result and sends nothing. The same key with a different message fails with conflict.",
	].join(" "),
	http: { method: "POST", path: "/api/v1/mail/messages" },
	scopes: ["mail.send"],
	callers: ["human", "agent"],
	annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: true },
	input: z
		.strictObject({
			mailbox_id: MailboxParam,
			to: z.array(EmailAddress).max(MAIL_LIMITS.recipients).default([]),
			cc: z.array(EmailAddress).max(MAIL_LIMITS.recipients).default([]),
			bcc: z.array(EmailAddress).max(MAIL_LIMITS.recipients).default([]),
			subject: z.string().max(MAIL_LIMITS.subjectChars).optional(),
			text: z.string().max(MAIL_LIMITS.bodyChars),
			html: z.string().max(MAIL_LIMITS.bodyChars).optional(),
			reply_to_message_id: MessageId.optional(),
			attachments: z.array(OutgoingAttachment).max(MAIL_LIMITS.attachments).default([]),
			idempotency_key: z.string().min(1).max(255).optional(),
		})
		.refine((input) => input.to.length + input.cc.length + input.bcc.length > 0, "name at least one recipient")
		.refine(
			(input) => input.to.length + input.cc.length + input.bcc.length <= MAIL_LIMITS.recipients,
			`name at most ${MAIL_LIMITS.recipients} recipients in to, cc and bcc together`,
		),
	output: z.object({
		message_id: z.string(),
		thread_id: z.string(),
		recipients: z.array(DeliveryStatus),
	}),
	errors: ["not_found", "policy_denied", "payload_too_large", "conflict"],
});

export const getAttachment = defineOperation({
	name: "mail.get_attachment",
	summary: "Get the content of an attachment",
	description: `Returns one attachment of a message as base64, with its name and type. The index comes from the attachments list of mail.get_thread. The content of an attachment on external mail is untrusted. ${IN_MAILBOX_READ}`,
	http: { method: "GET", path: "/api/v1/mail/messages/{message_id}/attachments/{index}" },
	scopes: ["mail.read"],
	callers: ["human", "agent"],
	annotations: READ,
	input: z.strictObject({
		mailbox_id: MailboxParam,
		message_id: MessageId,
		index: z.coerce.number().int().min(0).max(1000),
	}),
	output: z.object({
		filename: z.string(),
		mime_type: z.string(),
		size: z.number().int(),
		untrusted: z.boolean(),
		content_base64: z.string(),
	}),
	errors: ["not_found", "payload_too_large"],
});

export const mailOperations = {
	"mail.list_mailboxes": listMailboxes,
	"mail.get_profile": getProfile,
	"mail.list_labels": listLabels,
	"mail.create_label": createLabel,
	"mail.delete_label": deleteLabel,
	"mail.list_threads": listThreads,
	"mail.get_thread": getThread,
	"mail.get_message": getMessage,
	"mail.modify_threads": modifyThreads,
	"mail.send": send,
	"mail.get_attachment": getAttachment,
} as const;
