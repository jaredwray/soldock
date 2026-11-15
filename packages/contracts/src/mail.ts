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
	/** The addresses that one `mail.suggest_recipients` call returns. */
	recipientSuggestions: 25,
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
	description: `Creates a user label. Use a slash in the name to show it nested, for example Clients/Acme. Mail to user+tag@ gets the label whose full name is the tag. For example, user+netflix@ gets the label Netflix. ${IN_MAILBOX} ${AGENT_READ_ONLY}`,
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
		"Returns the addresses that the mailbox sent mail to (To, Cc or Bcc) that match the query, for example to complete an address that you type.",
		"The query matches the address without regard to case. An address that starts with the query comes first, then an address with a part that starts with the query (after @ . _ - or +), then an address that has the query in a different position.",
		"In each group, the address of the most recent send comes first. Without a query, the result has the most recent addresses.",
		"Mail that arrives adds no address: a sender that you never wrote to is not in the result.",
		`${IN_MAILBOX_READ} The members of a team mailbox share its addresses.`,
	].join(" "),
	http: { method: "GET", path: "/api/v1/mail/recipients" },
	scopes: ["mail.read"],
	callers: ["human", "agent"],
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
});
export type MailSettings = z.infer<typeof MailSettings>;

export const getSettings = defineOperation({
	name: "mail.get_settings",
	summary: "Get your mail settings",
	description:
		"Returns your mail settings: for now, the sections of the sidebar of the web app that are collapsed. The settings belong to your own mailbox, never to a team mailbox. A setting that you did not change has its default value.",
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
		"Changes the settings that the request names, and keeps the others. Returns all your mail settings. The settings belong to your own mailbox, never to a team mailbox. A change does not change the mailbox version that mail.get_profile returns.",
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
	}),
	output: MailSettings,
	errors: [],
});

export const WEBHOOK_LIMITS = {
	urlChars: 2000,
	labelChars: 100,
	/** The webhooks that one principal created, active or disabled. */
	perCreator: 10,
	/** The active webhooks of one mailbox, from all creators. This limits the POST requests of one event. */
	perMailbox: 20,
	/** The POST attempts of one event to one webhook. */
	attempts: 5,
	/** The events in a row whose last attempt failed. Then the webhook is disabled. */
	failedEventsBeforeDisable: 5,
	/** The time that the receiver has to answer one POST. */
	timeoutMs: 15_000,
	/** One mailbox sends at most one event in this time. Mail in that time gives one event. */
	eventGapMs: 5_000,
	authKeyChars: 1024,
	headerNameChars: 64,
	headerValueChars: 2048,
} as const;

/** The event type of the only webhook event: new mail in the inbox of the mailbox. */
export const WEBHOOK_EVENT_TYPE = "mail.inbox.updated";

/**
 * An absolute https URL. The server also refuses an IP address, a user name, a port, a fragment, a host
 * name that cannot be public, and the host of the deployment.
 */
const WebhookUrl = z
	.url({ protocol: /^https$/, error: "must be an absolute https URL, such as https://hooks.example.com/soldock" })
	.max(WEBHOOK_LIMITS.urlChars);

/**
 * Header names that a webhook cannot set: Soldock sets them itself, the HTTP layer owns them, they
 * claim a client address or a different method, or Cloudflare uses them. A name that starts with one of `WEBHOOK_RESERVED_HEADER_PREFIXES` is refused too.
 */
export const WEBHOOK_RESERVED_HEADERS = [
	"accept-encoding",
	"cdn-loop",
	"connection",
	"content-encoding",
	"content-length",
	"content-type",
	"expect",
	"forwarded",
	"host",
	"keep-alive",
	"te",
	"trailer",
	"transfer-encoding",
	"true-client-ip",
	"upgrade",
	"user-agent",
	"via",
	"x-client-ip",
	"x-cluster-client-ip",
	"x-http-method-override",
	"x-method-override",
	"x-real-ip",
] as const;
export const WEBHOOK_RESERVED_HEADER_PREFIXES = ["cf-", "proxy-", "sec-", "webhook-", "x-forwarded-"] as const;

/**
 * The problem with the name of a custom webhook header, or null. `withAuthKey`: the webhook also has an
 * auth key, which uses `Authorization`, so the header cannot.
 */
export function webhookHeaderNameProblem(name: string, withAuthKey: boolean): string | null {
	const lower = name.toLowerCase();
	if (
		(WEBHOOK_RESERVED_HEADERS as readonly string[]).includes(lower) ||
		WEBHOOK_RESERVED_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))
	) {
		return `Soldock sets the header ${name} itself, so a webhook cannot set it.`;
	}
	if (withAuthKey && lower === "authorization") {
		return "The auth key uses the Authorization header. Use the auth key or a custom Authorization header, not both.";
	}
	return null;
}

/**
 * A token that the receiver checks. Soldock sends it as `Authorization: Bearer <key>` on each POST. It
 * is write-only: no result shows it after the call that sets it.
 */
const WebhookAuthKey = z
	.string()
	.trim()
	.min(1)
	.max(WEBHOOK_LIMITS.authKeyChars)
	.regex(/^[\x21-\x7E]+$/, "must be printable ASCII without spaces")
	.describe("A token that your receiver checks. Soldock sends it as Authorization: Bearer <key> on each POST.");

/** One custom header that Soldock sends on each POST. The value is write-only. */
const WebhookHeader = z
	.strictObject({
		name: z
			.string()
			.trim()
			.min(1)
			.max(WEBHOOK_LIMITS.headerNameChars)
			.regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, "must be an HTTP header name, such as X-Api-Key"),
		value: z
			.string()
			.trim()
			.min(1)
			.max(WEBHOOK_LIMITS.headerValueChars)
			.regex(/^[\x20-\x7E]+$/, "must be printable ASCII"),
	})
	.superRefine((header, ctx) => {
		const problem = webhookHeaderNameProblem(header.name, false);
		if (problem) ctx.addIssue({ code: "custom", message: problem, path: ["name"] });
	})
	.describe("A custom header that Soldock sends on each POST, for example X-Api-Key for your receiver.");

/** The auth key and the custom header may not both use `Authorization`. */
function authorizationConflict(input: {
	auth_key?: string | null | undefined;
	header?: { name: string } | null | undefined;
}): boolean {
	return Boolean(input.auth_key) && input.header?.name.toLowerCase() === "authorization";
}

/**
 * A webhook: a URL outside Soldock that gets a signed POST when new mail arrives in the inbox of a
 * mailbox. The POST holds no mail content: the receiver reads the inbox with its own credential.
 */
export const Webhook = z.object({
	id: z.string(),
	/** The mailbox that the webhook watches. */
	mailbox_id: z.string(),
	url: z.string(),
	label: z.string(),
	/** The person or agent that created the webhook. Its access is checked again before each POST. */
	created_by: z.string(),
	/** `disabled`: Soldock sends nothing more. Delete the webhook and create a new one. */
	status: z.enum(["active", "disabled"]),
	/**
	 * Why the webhook stopped. `failures`: too many events failed in a row. `gone`: the receiver answered
	 * 410. `credential_revoked`: the key or the OAuth connection that created it stopped, or its creator
	 * was deleted. `access_lost`: its creator lost access to the mailbox. `policy_denied`: the outbound
	 * policy of the agent that created it no longer allows the host.
	 */
	disabled_reason: z.enum(["failures", "gone", "credential_revoked", "access_lost", "policy_denied"]).nullable(),
	/** The events in a row whose last attempt failed. A success sets it to 0. */
	consecutive_failures: z.number().int(),
	last_delivery_at: Timestamp.nullable(),
	last_failure_at: Timestamp.nullable(),
	/**
	 * Why the last attempt failed: `http_<status>`, `redirect`, `timeout` or `network`. The response body
	 * of the receiver is never stored.
	 */
	last_error: z.string().nullable(),
	/** True when Soldock sends an auth key (`Authorization: Bearer`). The key itself is never returned. */
	has_auth_key: z.boolean(),
	/** The name of the custom header that Soldock sends, or null. Its value is never returned. */
	header_name: z.string().nullable(),
	created_at: Timestamp,
});
export type Webhook = z.infer<typeof Webhook>;

/** A new webhook. The signing secret is returned once. */
export const CreatedWebhook = Webhook.extend({ secret: z.string() });
export type CreatedWebhook = z.infer<typeof CreatedWebhook>;

const WebhookLabel = z
	.string()
	.trim()
	.max(WEBHOOK_LIMITS.labelChars)
	.refine((label) => !/[\p{Cc}]/u.test(label), "must not contain control characters");

const WEBHOOK_MAILBOXES =
	"Use your own mailbox (the default), a team mailbox that you are a member of, or, for a person, the mailbox of an agent that you sponsor.";

export const createWebhook = defineOperation({
	name: "mail.create_webhook",
	summary: "Get a POST at a URL when new mail arrives",
	description: [
		"Creates a webhook: Soldock sends a POST to the URL when new mail arrives in the inbox of the mailbox.",
		WEBHOOK_MAILBOXES,
		`The body is JSON: {"type": "${WEBHOOK_EVENT_TYPE}", "timestamp", "data": {"webhook_id", "mailbox_id", "uri"}}. It holds no mail content: read the inbox with mail.list_threads, or read the resource at data.uri on MCP.`,
		"Mail in the same few seconds gives one POST. Spam, a read, a label and an archive send nothing.",
		"Each POST is signed as Standard Webhooks specifies: the headers webhook-id, webhook-timestamp and webhook-signature.",
		"The result holds the signing secret (whsec_...). It is shown only once. Use it to verify each POST.",
		"The URL must use https and a public host name. A POST that fails is retried up to 5 times, and mail while a retry waits sends no POST of its own. After 5 events in a row fail, the webhook is disabled.",
		"An agent can use only a host that its outbound policy allows: mode any, or a host in its allowlist. Otherwise the call fails with policy_denied. Its sponsor can create the webhook for it.",
		"For a receiver that checks a token, set auth_key: Soldock sends it as Authorization: Bearer <key>. Set header to send one more header, such as X-Api-Key. The key and the header value are write-only: change them with mail.update_webhook.",
		"The webhook stops when the credential that created it is revoked, or when its creator loses access to the mailbox.",
	].join(" "),
	http: { method: "POST", path: "/api/v1/mail/webhooks" },
	scopes: ["mail.webhooks"],
	callers: ["human", "agent"],
	annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: true },
	input: z
		.strictObject({
			mailbox_id: MailboxId.optional().describe(
				"The mailbox to watch: an id from mail.list_mailboxes, or the id of an agent that you sponsor. The default is your own mailbox.",
			),
			url: WebhookUrl,
			label: WebhookLabel.optional(),
			auth_key: WebhookAuthKey.optional(),
			header: WebhookHeader.optional(),
		})
		.refine((input) => !authorizationConflict(input), {
			message:
				"The auth key uses the Authorization header. Use the auth key or a custom Authorization header, not both.",
			path: ["header", "name"],
		}),
	output: z.object({ webhook: CreatedWebhook }),
	errors: ["not_found", "policy_denied", "conflict"],
});

export const updateWebhook = defineOperation({
	name: "mail.update_webhook",
	summary: "Change the label, the auth key or the custom header of a webhook",
	description: [
		"Changes the fields that the request names, and keeps the others. Only the creator of the webhook can change it.",
		"auth_key replaces the auth key, and null removes it. header replaces the custom header (its name and its value), and null removes it.",
		"The key and the header value are write-only: the result shows has_auth_key and header_name only.",
		"A change does not restart a disabled webhook.",
	].join(" "),
	http: { method: "POST", path: "/api/v1/mail/webhooks/{webhook_id}" },
	scopes: ["mail.webhooks"],
	callers: ["human", "agent"],
	annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
	input: z
		.strictObject({
			webhook_id: prefixedId("whk"),
			label: WebhookLabel.optional(),
			auth_key: WebhookAuthKey.nullable().optional(),
			header: WebhookHeader.nullable().optional(),
		})
		.refine(
			(input) => input.label !== undefined || input.auth_key !== undefined || input.header !== undefined,
			"send label, auth_key or header",
		),
	output: z.object({ webhook: Webhook }),
	errors: ["not_found"],
});

export const listWebhooks = defineOperation({
	name: "mail.list_webhooks",
	summary: "List webhooks",
	description: [
		"Without mailbox_id: the webhooks that you created.",
		"With mailbox_id: the webhooks of that mailbox that you can see. In your own mailbox and in a team mailbox, you see only your own webhooks.",
		"An owner and an admin see each webhook of a team mailbox. The sponsor of an agent, an owner and an admin see each webhook of the mailbox of the agent.",
		"The secrets are never returned again.",
	].join(" "),
	http: { method: "GET", path: "/api/v1/mail/webhooks" },
	scopes: ["mail.webhooks"],
	callers: ["human", "agent"],
	annotations: READ,
	input: z.strictObject({ mailbox_id: MailboxId.optional() }),
	output: z.object({ webhooks: z.array(Webhook) }),
	errors: ["not_found"],
});

export const deleteWebhook = defineOperation({
	name: "mail.delete_webhook",
	summary: "Delete a webhook",
	description:
		"Deletes a webhook. No POST goes to its URL after this. You can delete a webhook that you created. An owner or an admin can delete each webhook of a team mailbox. The sponsor of an agent, an owner and an admin can delete each webhook of the mailbox of the agent.",
	http: { method: "DELETE", path: "/api/v1/mail/webhooks/{webhook_id}" },
	scopes: ["mail.webhooks"],
	callers: ["human", "agent"],
	annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
	input: z.strictObject({ webhook_id: prefixedId("whk") }),
	output: z.object({ deleted: z.boolean() }),
	errors: ["not_found"],
});

export const mailOperations = {
	"mail.list_mailboxes": listMailboxes,
	"mail.get_settings": getSettings,
	"mail.update_settings": updateSettings,
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
	"mail.create_webhook": createWebhook,
	"mail.list_webhooks": listWebhooks,
	"mail.update_webhook": updateWebhook,
	"mail.delete_webhook": deleteWebhook,
} as const;
