import { Address, EmailAddress, prefixedId, Timestamp } from "./common.ts";
import { defineOperation } from "./operation.ts";
import { MAIL_WEBHOOK_EVENTS, MailWebhookSubscription } from "./webhooks.ts";
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
	/** The addresses that one `mail.suggest_recipients` call returns. */
	recipientSuggestions: 25,
	/** The signature of a mailbox, in characters of plain text. */
	signatureChars: 2_000,
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
const IN_MAILBOX =
	"Set mailbox_id to use a team mailbox that you are a member of. Your membership must have the scope of this operation: see scopes in mail.list_mailboxes.";

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
	/**
	 * True when the mailbox belongs to a service account. In mail, a service account acts as an agent, so
	 * its mailbox has the kind `agent` for an owner or an admin. False for a team mailbox.
	 */
	service: z.boolean(),
	/**
	 * What you can do in the mailbox: `mail.read`, `mail.modify` and `mail.send`. Your own mailbox has the
	 * three. A team mailbox has the scopes of your membership. The mailbox of an agent has `mail.read` only.
	 * The scopes of your credential apply too.
	 */
	scopes: z.array(z.string()),
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
	/** The ids in `label_ids` that auto labels applied. A person or an agent applied the others. */
	auto_label_ids: z.array(z.string()),
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
	/** The ids in `label_ids` that auto labels applied. */
	auto_label_ids: z.array(z.string()),
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
	/** The ids in `label_ids` that auto labels applied to a message of the thread. */
	auto_label_ids: z.array(z.string()),
	untrusted: z.boolean(),
	messages: z.array(Message),
});
export type Thread = z.infer<typeof Thread>;

const READ = { readOnly: true, destructive: false, idempotent: true, openWorld: false } as const;

export const listMailboxes = defineOperation({
	name: "mail.list_mailboxes",
	summary: "List the mailboxes that you can use",
	description:
		"Returns your own mailbox first, then each team mailbox that you are a member of. A team mailbox is a shared mailbox with its own address. scopes says what you can do in each mailbox: an owner or an admin sets the scopes of each member of a team mailbox. For an owner or an admin, the list then has the mailbox of each agent and each service account (kind agent, and service is true for a service account). They can read the mailbox of an agent, but they cannot change it or send from it. Pass the id of a mailbox as mailbox_id to the other mail operations. Without mailbox_id, they use your own mailbox.",
	http: { method: "GET", path: "/api/v1/mail/mailboxes" },
	scopes: ["mail.read"],
	callers: ["human", "agent", "service"],
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
	callers: ["human", "agent", "service"],
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
	callers: ["human", "agent", "service"],
	annotations: READ,
	input: z.strictObject({ mailbox_id: MailboxParam }),
	output: z.object({ labels: z.array(Label) }),
	errors: [],
});

export const createLabel = defineOperation({
	name: "mail.create_label",
	summary: "Create a label",
	description: `Creates a user label. Use a slash in the name to show it nested, for example Clients/Acme. Mail to user+tag@ gets the label whose full name is the tag. For example, user+netflix@ gets the label Netflix. ${IN_MAILBOX} ${AGENT_READ_ONLY}`,
	http: { method: "POST", path: "/api/v1/mail/labels" },
	scopes: ["mail.modify"],
	callers: ["human", "agent", "service"],
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
	callers: ["human", "agent", "service"],
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
	callers: ["human", "agent", "service"],
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
	callers: ["human", "agent", "service"],
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
	callers: ["human", "agent", "service"],
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
	callers: ["human", "agent", "service"],
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
		"The signature of the mailbox is not added. Read it with mail.get_mailbox_settings, and add it to text and html yourself.",
		"To reply, set reply_to_message_id: the message joins that thread, and the subject defaults to Re: and the original subject.",
		"A reply reads the message that it answers. So it also needs mail.read: in your credential, and in your membership of a team mailbox.",
		"An agent can send only to the recipients that its policy allows, also from a team mailbox. Otherwise the call fails with policy_denied and nothing is sent.",
		"Set idempotency_key to make a retry safe: a second call with the same key and the same message returns the first result and sends nothing. The same key with a different message fails with conflict.",
	].join(" "),
	http: { method: "POST", path: "/api/v1/mail/messages" },
	scopes: ["mail.send"],
	callers: ["human", "agent", "service"],
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
	callers: ["human", "agent", "service"],
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

/** An address that the mailbox sent mail to. */
export const RecipientSuggestion = z.object({
	/** The address as the last message to it had it. The domain is lowercase. */
	address: z.string(),
	/** The sent messages that had the address in To, Cc or Bcc. */
	times_sent: z.number().int(),
	/** The time of the last sent message to the address. */
	last_sent_at: Timestamp,
});
export type RecipientSuggestion = z.infer<typeof RecipientSuggestion>;

export const suggestRecipients = defineOperation({
	name: "mail.suggest_recipients",
	summary: "Find addresses that the mailbox sent mail to",
	description: [
		"Returns the addresses that the mailbox sent mail to in To, Cc or Bcc, and that match the query.",
		"Use it to complete an address that you type. The query matches the address without regard to case.",
		"First come the addresses that start with the query. Then come the addresses with a part that starts with the query, after @ . _ - or +.",
		"Then come the other matches. In each group, the address of the most recent send comes first.",
		"Without a query, the result has the most recent addresses.",
		"Mail that arrives adds no address: a sender that you never wrote to is not in the result.",
		`${IN_MAILBOX_READ} The members of a team mailbox share its addresses.`,
	].join(" "),
	http: { method: "GET", path: "/api/v1/mail/recipients" },
	scopes: ["mail.read"],
	callers: ["human", "agent", "service"],
	annotations: READ,
	input: z.strictObject({
		mailbox_id: MailboxParam,
		query: z.string().max(254).optional(),
		limit: z.coerce.number().int().min(1).max(MAIL_LIMITS.recipientSuggestions).optional(),
	}),
	output: z.object({ recipients: z.array(RecipientSuggestion) }),
	errors: [],
});

/**
 * The mail settings of a person. They live in the own mailbox of the person, never in a team mailbox
 * or in the mailbox of an agent. Each setting has a default, so a person without saved settings gets them.
 */
export const MailSettings = z.object({
	sidebar: z.object({
		/** True when the Shared mailboxes section of the sidebar of the web app is collapsed. */
		shared_mailboxes_collapsed: z.boolean(),
		/** True when the Agent mailboxes section of the sidebar of the web app is collapsed. */
		agent_mailboxes_collapsed: z.boolean(),
	}),
	/**
	 * The mailbox that the web app opens first: the id of a team mailbox that you are a member of. Null
	 * means your own mailbox, which is the default. A membership can end after you save it, so a client
	 * opens your own mailbox when the id is not in mail.list_mailboxes.
	 */
	default_mailbox_id: z.string().nullable(),
});
export type MailSettings = z.infer<typeof MailSettings>;

export const getSettings = defineOperation({
	name: "mail.get_settings",
	summary: "Get your mail settings",
	description:
		"Returns your mail settings: the sections of the sidebar of the web app that are collapsed, and the mailbox that the web app opens first (default_mailbox_id, null for your own mailbox). The settings belong to your own mailbox, never to a team mailbox. A setting that you did not change has its default value. For the signature of a mailbox, use mail.get_mailbox_settings.",
	http: { method: "GET", path: "/api/v1/mail/settings" },
	scopes: ["mail.read"],
	callers: ["human"],
	annotations: READ,
	input: z.strictObject({}),
	output: MailSettings,
	errors: [],
});

export const updateSettings = defineOperation({
	name: "mail.update_settings",
	summary: "Change your mail settings",
	description:
		"Changes the settings that the request names, and keeps the others. Returns all your mail settings. The settings belong to your own mailbox, never to a team mailbox. A change does not change the mailbox version that mail.get_profile returns. default_mailbox_id must be your own id, null, or the id of a team mailbox that you are a member of with mail.read. The mailbox of an agent cannot be the default.",
	http: { method: "POST", path: "/api/v1/mail/settings" },
	scopes: ["mail.modify"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
	input: z.strictObject({
		sidebar: z
			.strictObject({
				shared_mailboxes_collapsed: z.boolean().optional(),
				agent_mailboxes_collapsed: z.boolean().optional(),
			})
			.optional(),
		default_mailbox_id: MailboxId.nullable()
			.optional()
			.describe("The mailbox that the web app opens first. Null, or your own id, means your own mailbox."),
	}),
	output: MailSettings,
	errors: ["not_found", "invalid"],
});

/**
 * The control characters, except a line break and a tab, the Unicode line and paragraph separators, and
 * the characters that change the direction of text (the marks, embeddings, overrides and isolates). A
 * signature goes into the mail of each member, so it must not hide or move text there.
 */
const SIGNATURE_REFUSED = /[^\P{Cc}\n\r\t]|[\u2028\u2029]|[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

/**
 * The plain-text signature of a mailbox. A line break and a tab are the only control characters that it
 * can hold. It cannot hold a Unicode line or paragraph separator, or a control that changes the direction
 * of text. The mailbox stores `\n` for each line break, and removes the spaces at the end of each line.
 */
export const Signature = z
	.string()
	.max(MAIL_LIMITS.signatureChars)
	.refine(
		(text) => !SIGNATURE_REFUSED.test(text),
		"must not contain control characters other than line breaks, or characters that change the direction of text",
	);

/**
 * The settings of one mailbox. The mailbox holds them, so the members of a team mailbox share them.
 * Each setting has a default, so a mailbox without saved settings gets them.
 */
export const MailboxSettings = z.object({
	mailbox_id: z.string(),
	/**
	 * The plain-text signature of the mailbox, or an empty string for none. The web composer adds it to
	 * each new message, reply and forward. mail.send never adds it: a client that wants it adds it to text
	 * (and html) itself.
	 */
	signature: z.string(),
});
export type MailboxSettings = z.infer<typeof MailboxSettings>;

export const getMailboxSettings = defineOperation({
	name: "mail.get_mailbox_settings",
	summary: "Get the settings of a mailbox",
	description: `Returns the settings of the mailbox: for now, its plain-text signature (an empty string for none). mail.send never adds the signature. To sign a message, add the signature to text, after a line with "-- " (two dashes and a space), and to html. ${IN_MAILBOX_READ} The members of a team mailbox share its settings. For your own settings, such as the mailbox that the web app opens first, use mail.get_settings.`,
	http: { method: "GET", path: "/api/v1/mail/mailbox-settings" },
	scopes: ["mail.read"],
	callers: ["human", "agent", "service"],
	annotations: READ,
	input: z.strictObject({ mailbox_id: MailboxParam }),
	output: MailboxSettings,
	errors: [],
});

export const updateMailboxSettings = defineOperation({
	name: "mail.update_mailbox_settings",
	summary: "Change the settings of a mailbox",
	description: `Changes the settings that the request names, and keeps the others. Returns all the settings of the mailbox. Name at least one setting: to read the settings, use mail.get_mailbox_settings. signature is plain text of at most ${MAIL_LIMITS.signatureChars} characters. An empty string removes it. ${IN_MAILBOX} The members of a team mailbox share its settings, so only a person changes them there. An agent or a service account can change only the settings of its own mailbox. ${AGENT_READ_ONLY} A change does not change the mailbox version that mail.get_profile returns.`,
	http: { method: "POST", path: "/api/v1/mail/mailbox-settings" },
	scopes: ["mail.modify"],
	callers: ["human", "agent", "service"],
	annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
	input: z
		.strictObject({
			mailbox_id: MailboxParam,
			signature: Signature.optional().describe(
				`The plain-text signature, at most ${MAIL_LIMITS.signatureChars} characters. An empty string removes it.`,
			),
		})
		// A change returns the settings. Without a setting to change, the call would only read them, with the
		// scope to change and not the scope to read. Use mail.get_mailbox_settings to read them.
		.refine((input) => input.signature !== undefined, "name a setting to change"),
	output: MailboxSettings,
	errors: [],
});

export const AUTO_LABEL_LIMITS = {
	/** The custom auto labels of one mailbox. */
	custom: 10,
	nameChars: 40,
	descriptionMinChars: 10,
	descriptionChars: 300,
	/** The inbox messages that one `mail.run_auto_labels` call examines. */
	runMax: 200,
	runDefault: 100,
	/** The label entries in one `mail.update_auto_labels` call. */
	updateEntries: 30,
} as const;

/**
 * The built-in auto labels. `scope` tells what decides the label. `sender`: the sender, so a correction
 * of the label applies to the next mail from that sender. `message`: the content of each message, so a
 * correction is only an example for the classifier. `definition` is the text of the classifier prompt.
 * `summary` is the short text of the settings, for people.
 */
export const AUTO_LABELS = [
	{
		key: "needs_reply",
		name: "Needs reply",
		scope: "message",
		summary: "Mail from a person who asks you a question or waits for your answer or decision.",
		definition:
			"A person wrote to the owner and expects an answer or an action from the owner: a question, a request, an approval or a decision. Not automated mail, mail to a list, a thank-you or an acknowledgement with no question, a cold pitch, or mail where the owner is only in Cc and the text does not address the owner by name.",
	},
	{
		key: "meeting",
		name: "Meeting",
		scope: "message",
		summary: "Invitations, changes and reminders of meetings and calls, and people who propose a time.",
		definition:
			"About one specific meeting or call: an invitation, a change, a cancellation, a reminder, or a person who proposes or confirms a time. Not the promotion of a webinar or an event to a list (marketing), and not a booking for a trip (travel).",
	},
	{
		key: "marketing",
		name: "Marketing",
		scope: "sender",
		summary: "Promotions, offers and product news that companies send to their lists.",
		definition:
			"Promotion from a company to a list: offers, sales, product news, webinars, event promotion, win-back mail. The sender wants the owner to buy, upgrade or sign up. Not editorial content to read (newsletter), not mail about the account, order or payment of the owner (notification, receipt), and not one-to-one sales mail from a person (cold_pitch).",
	},
	{
		key: "newsletter",
		name: "Newsletter",
		scope: "sender",
		summary: "Issues of newsletters, digests and blogs that you read.",
		definition:
			"Editorial content in issues to subscribers: news digests, blogs, letters from an author, community digests. The main purpose is to read, not to buy. Not promotion (marketing).",
	},
	{
		key: "cold_pitch",
		name: "Cold pitch",
		scope: "sender",
		summary: "Sales mail from people and companies that you never wrote to.",
		definition:
			"Unsolicited one-to-one mail from a person or a company with no relation to the owner. It sells a product or a service, asks for a call, or proposes a partnership, a guest post, links or an investment. Only when FACTS say that the owner never wrote to this sender or its domain and the owner did not write in the thread. Not mail to a list (marketing), and not a reply to mail from the owner.",
	},
	{
		key: "social",
		name: "Social",
		scope: "sender",
		summary: "Activity from social networks and communities: follows, likes, comments and mentions.",
		definition:
			"Automated mail from a social network or a community platform about activity: follows, likes, comments, mentions, connection requests, messages on the platform. Not a person who writes directly, and not security or billing mail of the platform (notification, receipt).",
	},
	{
		key: "notification",
		name: "Notification",
		scope: "sender",
		summary: "Automated mail about your accounts and tools: alerts, codes, builds and shipping.",
		definition:
			"Automated mail from an app or a service about the account or the systems of the owner: alerts, sign-in codes, password resets, build and monitor results, comments and tasks in work tools, shipping status, reminders. Not payment documents (receipt), trips (travel), social networks (social) or promotion (marketing).",
	},
	{
		key: "receipt",
		name: "Receipt",
		scope: "message",
		summary: "Receipts, invoices, order confirmations, bills and payment problems.",
		definition:
			"A document about money: a receipt, an invoice, an order confirmation with a total, a payment confirmation, a refund, a bill, a statement, a renewal charge or a failed payment. Not promotion with prices (marketing), and not shipping status with no payment (notification).",
	},
	{
		key: "travel",
		name: "Travel",
		scope: "message",
		summary: "Bookings, tickets, itineraries and check-ins of your trips.",
		definition:
			"About one specific trip of the owner: a booking, a ticket, an itinerary, a check-in, a boarding pass, a hotel, car or train reservation, or a change or a cancellation of one. Not travel offers (marketing), and not receipts for local rides or food (receipt).",
	},
] as const;

export type BuiltinAutoLabel = (typeof AUTO_LABELS)[number];
export type AutoLabelKey = BuiltinAutoLabel["key"];
export const AutoLabelKey = z.enum(AUTO_LABELS.map((label) => label.key) as [AutoLabelKey, ...AutoLabelKey[]]);

/** The id of a custom auto label. */
export const CustomAutoLabelId = prefixedId("alb");

/** Why auto labels cannot run in this mailbox now. Null when they can. */
export const AutoLabelUnavailableReason = z.enum(["ai_off", "feature_off"]);

export const AutoLabelSettings = z.object({
	mailbox_id: z.string(),
	/** True when the members of the mailbox turned on auto labels. */
	enabled: z.boolean(),
	/**
	 * True when the organization lets auto labels run: an owner or an admin turned on AI and the
	 * feature. Rules from the headers and from your corrections apply even when the AI Gateway cannot
	 * take calls, for example after the monthly budget is used.
	 */
	available: z.boolean(),
	unavailable_reason: AutoLabelUnavailableReason.nullable(),
	labels: z.array(
		z.object({
			/** A built-in key such as `newsletter`, or the `alb_` id of a custom auto label. */
			key: z.string(),
			kind: z.enum(["builtin", "custom"]),
			name: z.string(),
			description: z.string(),
			enabled: z.boolean(),
			/**
			 * True when mail with this label skips the inbox. It stays in All mail and under its label. Only
			 * mail from a proved sender skips the inbox: internal mail, or mail that passed DMARC.
			 */
			skip_inbox: z.boolean(),
			/** The user label that the auto label applies, or null before its first use. */
			label_id: z.string().nullable(),
		}),
	),
});
export type AutoLabelSettings = z.infer<typeof AutoLabelSettings>;

const AUTO_LABEL_TEXT =
	"Auto labels sort new mail in the inbox with built-in labels (Needs reply, Meeting, Marketing, Newsletter, Cold pitch, Social, Notification, Receipt, Travel) and with custom labels that the members describe. Rules from the mail headers apply first. A Workers AI model through the AI Gateway of the organization decides the rest. An auto label is a user label, so label:, the sidebar and mail.modify_threads use it.";

const AutoLabelName = z
	.string()
	.trim()
	.min(1)
	.max(AUTO_LABEL_LIMITS.nameChars)
	.refine((name) => !/[\p{Cc}]/u.test(name), "must not contain control characters");

const AutoLabelDescription = z
	.string()
	.trim()
	.min(AUTO_LABEL_LIMITS.descriptionMinChars)
	.max(AUTO_LABEL_LIMITS.descriptionChars)
	.refine((text) => !/[\p{Cc}]/u.test(text), "must not contain control characters");

export const getAutoLabels = defineOperation({
	name: "mail.get_auto_labels",
	summary: "Get the auto-label settings of a mailbox",
	description: `${AUTO_LABEL_TEXT} Returns whether auto labels are on in the mailbox, whether the organization lets them run, and each built-in and custom auto label. ${IN_MAILBOX_READ}`,
	http: { method: "GET", path: "/api/v1/mail/auto-labels" },
	scopes: ["mail.read"],
	callers: ["human", "agent", "service"],
	annotations: READ,
	input: z.strictObject({ mailbox_id: MailboxParam }),
	output: AutoLabelSettings,
	errors: [],
});

export const updateAutoLabels = defineOperation({
	name: "mail.update_auto_labels",
	summary: "Change the auto-label settings of a mailbox",
	description: `Turns auto labels on or off in a mailbox, and changes each auto label that the request names: on or off, skip the inbox, and the description of a custom auto label. The first time you turn on auto labels, each built-in label is on. Turning on a label creates its user label, or uses the user label with the same name. People only. ${IN_MAILBOX} The members of a team mailbox share its settings. ${AGENT_READ_ONLY}`,
	http: { method: "POST", path: "/api/v1/mail/auto-labels" },
	scopes: ["mail.modify"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
	input: z.strictObject({
		mailbox_id: MailboxParam,
		enabled: z.boolean().optional(),
		labels: z
			.array(
				z.strictObject({
					key: z.union([AutoLabelKey, CustomAutoLabelId]),
					enabled: z.boolean().optional(),
					skip_inbox: z.boolean().optional(),
					description: AutoLabelDescription.optional(),
				}),
			)
			.max(AUTO_LABEL_LIMITS.updateEntries)
			.optional(),
	}),
	output: AutoLabelSettings,
	errors: ["not_found", "invalid", "conflict"],
});

export const createAutoLabel = defineOperation({
	name: "mail.create_auto_label",
	summary: "Create a custom auto label",
	description: `Creates a custom auto label: a name and a description in plain words of the mail that gets it, for example "Investor updates: monthly reports from the companies that we invested in". The classifier reads the description. The label can skip the inbox. A mailbox can have at most ${AUTO_LABEL_LIMITS.custom} custom auto labels. People only. ${IN_MAILBOX} ${AGENT_READ_ONLY}`,
	http: { method: "POST", path: "/api/v1/mail/auto-labels/custom" },
	scopes: ["mail.modify"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: false },
	input: z.strictObject({
		mailbox_id: MailboxParam,
		name: AutoLabelName,
		description: AutoLabelDescription,
		skip_inbox: z.boolean().default(false),
	}),
	output: AutoLabelSettings,
	errors: ["conflict", "invalid"],
});

export const deleteAutoLabel = defineOperation({
	name: "mail.delete_auto_label",
	summary: "Delete a custom auto label",
	description: `Deletes a custom auto label. Its user label and the messages with it stay. People only. ${IN_MAILBOX} ${AGENT_READ_ONLY}`,
	http: { method: "DELETE", path: "/api/v1/mail/auto-labels/custom/{auto_label_id}" },
	scopes: ["mail.modify"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
	input: z.strictObject({ mailbox_id: MailboxParam, auto_label_id: CustomAutoLabelId }),
	output: z.object({ deleted: z.boolean() }),
	errors: ["not_found"],
});

export const runAutoLabels = defineOperation({
	name: "mail.run_auto_labels",
	summary: "Apply auto labels to recent inbox mail",
	description: `Applies auto labels to the newest messages in the inbox that auto labels did not examine. Rules apply at once, and the classifier labels the rest in the next minutes. A run never moves mail out of the inbox: skip the inbox applies to new mail only. Set dry_run to true to get the count without a change. People only. ${IN_MAILBOX} ${AGENT_READ_ONLY}`,
	http: { method: "POST", path: "/api/v1/mail/auto-labels/run" },
	scopes: ["mail.modify"],
	callers: ["human"],
	annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
	input: z.strictObject({
		mailbox_id: MailboxParam,
		limit: z.number().int().min(1).max(AUTO_LABEL_LIMITS.runMax).default(AUTO_LABEL_LIMITS.runDefault),
		dry_run: z.boolean().default(false),
	}),
	output: z.object({
		/** The messages that the run examined, or would examine with dry_run. */
		messages: z.number().int(),
		/** The messages that rules labelled at once. Zero with dry_run. */
		labeled_by_rules: z.number().int(),
		/** The messages that wait for the classifier. Zero with dry_run. */
		queued: z.number().int(),
		dry_run: z.boolean(),
	}),
	errors: ["conflict"],
});

export { WEBHOOK_LIMITS } from "./webhooks.ts";

/** The event type for new mail in the inbox of a mailbox. */
export const WEBHOOK_EVENT_TYPE = MAIL_WEBHOOK_EVENTS[0];

const createWebhookSubscription = defineOperation({
	name: "mail.create_webhook_subscription",
	summary: "Send new mail to an endpoint",
	description: [
		"Adds a subscription. Asterra sends a signed POST when new mail arrives in the inbox.",
		"Use your own mailbox, a team mailbox that you belong to, or the mailbox of an agent that you sponsor.",
		"The POST has no mail content. Read the inbox with your own credential.",
		"The endpoint must be yours and active. One endpoint can watch more than one mailbox.",
	].join(" "),
	http: { method: "POST", path: "/api/v1/mail/webhook-subscriptions" },
	scopes: ["mail.webhooks"],
	callers: ["human", "agent"],
	annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: true },
	input: z.strictObject({
		endpoint_id: prefixedId("whe"),
		event: z.enum(MAIL_WEBHOOK_EVENTS).default(WEBHOOK_EVENT_TYPE),
		mailbox_id: MailboxId.optional().describe(
			"The mailbox to watch. The default is your own mailbox. You can also name a team mailbox or an agent that you sponsor.",
		),
	}),
	output: z.object({ subscription: MailWebhookSubscription }),
	errors: ["not_found", "policy_denied", "conflict", "forbidden"],
});

const listWebhookSubscriptions = defineOperation({
	name: "mail.list_webhook_subscriptions",
	summary: "List mail webhook subscriptions",
	description: [
		"Lists your mail subscriptions. With mailbox_id, lists the subscriptions of that mailbox that you can see.",
		"In your mailbox and in a team mailbox, you see only your subscriptions.",
		"An owner or an admin sees each subscription of a team mailbox.",
		"The sponsor of an agent, an owner or an admin sees each subscription of that agent.",
	].join(" "),
	http: { method: "GET", path: "/api/v1/mail/webhook-subscriptions" },
	scopes: ["mail.webhooks"],
	callers: ["human", "agent"],
	annotations: READ,
	input: z.strictObject({ mailbox_id: MailboxId.optional() }),
	output: z.object({ subscriptions: z.array(MailWebhookSubscription) }),
	errors: ["not_found"],
});

const deleteWebhookSubscription = defineOperation({
	name: "mail.delete_webhook_subscription",
	summary: "Delete a mail webhook subscription",
	description:
		"Deletes a subscription. The endpoint stays. You can delete a subscription that you created. An owner or an admin can delete each subscription of a team mailbox. The sponsor of an agent can delete each subscription of that agent.",
	http: { method: "DELETE", path: "/api/v1/mail/webhook-subscriptions/{subscription_id}" },
	scopes: ["mail.webhooks"],
	callers: ["human", "agent"],
	annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
	input: z.strictObject({ subscription_id: prefixedId("whk") }),
	output: z.object({ deleted: z.boolean() }),
	errors: ["not_found"],
});

export const mailOperations = {
	"mail.list_mailboxes": listMailboxes,
	"mail.get_settings": getSettings,
	"mail.update_settings": updateSettings,
	"mail.get_mailbox_settings": getMailboxSettings,
	"mail.update_mailbox_settings": updateMailboxSettings,
	"mail.get_auto_labels": getAutoLabels,
	"mail.update_auto_labels": updateAutoLabels,
	"mail.create_auto_label": createAutoLabel,
	"mail.delete_auto_label": deleteAutoLabel,
	"mail.run_auto_labels": runAutoLabels,
	"mail.get_profile": getProfile,
	"mail.list_labels": listLabels,
	"mail.create_label": createLabel,
	"mail.delete_label": deleteLabel,
	"mail.list_threads": listThreads,
	"mail.get_thread": getThread,
	"mail.get_message": getMessage,
	"mail.modify_threads": modifyThreads,
	"mail.send": send,
	"mail.suggest_recipients": suggestRecipients,
	"mail.get_attachment": getAttachment,
	"mail.create_webhook_subscription": createWebhookSubscription,
	"mail.list_webhook_subscriptions": listWebhookSubscriptions,
	"mail.delete_webhook_subscription": deleteWebhookSubscription,
} as const;
