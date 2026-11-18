import { RoomId } from "./chat.ts";
import { SpaceId } from "./drive.ts";
import { MailboxId } from "./mail.ts";
import { WEBHOOK_EVENTS, type WebhookDomain, type WebhookEvent, webhookDomain } from "./webhooks.ts";
import { z } from "./zod.ts";

// MCP Events: an MCP client subscribes to an event with events/subscribe, and gives a callback URL and
// a signing secret. Soldock then sends each event to that URL as one signed POST. Each event here is a
// webhook event, so MCP Events and the webhook operations give the same changes.

/** Limits for the subscriptions that an MCP client creates with events/subscribe. */
export const MCP_EVENT_LIMITS = {
	/** The default life of a subscription, and the longest life. The client refreshes it before the end. */
	ttlMs: 24 * 60 * 60 * 1000,
	/** The shortest life. A client that asks for less gets this, so it cannot refresh without a pause. */
	minTtlMs: 60 * 1000,
	/** The subscriptions of one principal that did not expire. */
	subscriptionsPerCreator: 50,
	/** The time that the receiver has to answer the verification POST. */
	verifyTimeoutMs: 10_000,
	/** The verification POSTs that one principal can cause in one hour. More get the error `rate_limited`. */
	verificationsPerHour: 100,
	/** The most bytes that Soldock reads from the answer to the verification POST. */
	verifyResponseBytes: 4096,
	/** After a verification, the same principal, URL and secret need no new verification for this time. */
	verifiedMs: 5 * 60 * 1000,
	/** After a refresh with a new secret, each POST has the signatures of the two secrets for this time. */
	secretOverlapMs: 5 * 60 * 1000,
	/** An expired subscription stays for this time. Then a later events/subscribe deletes it. */
	expiredKeepMs: 24 * 60 * 60 * 1000,
	/** The signing key that the client gives, after base64 decoding. */
	secretMinBytes: 24,
	secretMaxBytes: 64,
} as const;

/** One event that a client can subscribe to. `input` is the arguments, and `payload` is `data` of each POST. */
export interface McpEventDefinition {
	name: WebhookEvent;
	domain: WebhookDomain;
	description: string;
	input: z.ZodType;
	payload: z.ZodType;
}

const MailArguments = z.strictObject({
	mailbox_id: MailboxId.optional().describe(
		"The mailbox to monitor: an id from mail_list_mailboxes. The default is your own mailbox.",
	),
});

const ChatArguments = z.strictObject({
	room_id: RoomId.optional().describe(
		"The room to monitor: an id from chat_list_rooms. You must be a member. Without it, each room that you are a member of sends the event.",
	),
});

const DriveArguments = z.strictObject({
	space_id: SpaceId.optional().describe(
		"The drive to monitor: your id for your own drive, or the id of a shared drive from drive_list_shared_drives. The default is your own drive.",
	),
});

const Uri = z.string().describe("The MCP resource that changed. Read it with resources/read.");

const MailPayload = z.strictObject({
	mailbox_id: z.string(),
	uri: Uri,
});

const ChatPayload = z.strictObject({
	room_id: z.string(),
	message_id: z
		.string()
		.describe(
			"Read the message with chat_list_messages, or with chat_list_replies when parent_id is set. The event has no message text.",
		),
	parent_id: z
		.string()
		.optional()
		.describe(
			"Only for a reply in a thread: the message that the reply answers. The reply is not in chat_list_messages. Read it with chat_list_replies of this message.",
		),
	uri: Uri,
});

const DriveItemPayload = z.strictObject({
	space_id: z.string(),
	item_id: z.string().describe("Read the item with drive_get_item. The event has no file content."),
	uri: Uri,
});

const DriveSpacePayload = z.strictObject({
	space_id: z.string(),
	uri: Uri,
});

const DESCRIPTIONS: Record<WebhookEvent, string> = {
	"mail.inbox.updated":
		"New mail arrived in the inbox of the mailbox. Spam, a label and an archive send nothing. Mail in a short time gives one event. Read the inbox with mail_list_threads.",
	"chat.message.created":
		"A different member posted a message in a room that you are a member of, also a reply in a thread. Your own messages send nothing.",
	"chat.message.updated": "A different member edited a message in a room that you are a member of.",
	"chat.message.deleted": "A message was deleted in a room that you are a member of.",
	"drive.item.created": "An item was created in the drive, also a copy and an item that arrived from another drive.",
	"drive.item.updated": "An item of the drive changed, also the content of a doc or a sheet.",
	"drive.item.moved": "An item moved inside the drive, or left it for another drive.",
	"drive.item.trashed": "An item of the drive went to the trash.",
	"drive.item.restored": "An item of the drive left the trash.",
	"drive.item.deleted": "An item of the drive was deleted.",
	"drive.item.shared": "A person or an agent got access to an item of the drive.",
	"drive.item.unshared": "A person or an agent lost access to an item of the drive.",
	"drive.members.changed": "The members of the shared drive changed. Only a shared drive sends this event.",
	"drive.deleted": "The shared drive was deleted. Only a shared drive sends this event.",
};

function define(name: WebhookEvent): McpEventDefinition {
	const domain = webhookDomain(name);
	const description = DESCRIPTIONS[name];
	if (domain === "mail") return { name, domain, description, input: MailArguments, payload: MailPayload };
	if (domain === "chat") return { name, domain, description, input: ChatArguments, payload: ChatPayload };
	const payload = name.startsWith("drive.item.") ? DriveItemPayload : DriveSpacePayload;
	return { name, domain, description, input: DriveArguments, payload };
}

/** Each event of MCP Events, in the sequence of the webhook events. */
export const mcpEventList: readonly McpEventDefinition[] = WEBHOOK_EVENTS.map(define);

/** Each event of MCP Events by its name. */
export const mcpEvents: ReadonlyMap<string, McpEventDefinition> = new Map(
	mcpEventList.map((event) => [event.name, event]),
);
