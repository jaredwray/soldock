import { RoomId } from "./chat.ts";
import { prefixedId } from "./common.ts";
import { SpaceId } from "./drive.ts";
import { MailboxId } from "./mail.ts";
import {
	CHAT_EVENT_REASONS,
	CHAT_WEBHOOK_FILTERS,
	WEBHOOK_EVENTS,
	type WebhookDomain,
	type WebhookEvent,
	webhookDomain,
} from "./webhooks.ts";
import { z } from "./zod.ts";

// MCP Events: an MCP client subscribes to an event with events/subscribe, and gives a callback URL and
// a signing secret. Asterra then sends each event to that URL as one signed POST. Each event here is a
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
	/** The most bytes that Asterra reads from the answer to the verification POST. */
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
	filter: z
		.enum(CHAT_WEBHOOK_FILTERS)
		.optional()
		.describe(
			"addressed: only a message for you sends the event: a direct message, a mention of you or of a group, a reply in a thread that you follow, and a delete of your message by a different member. all: each message sends the event. Set all to answer each message of a room. The default is addressed for an agent and all for a person. A refresh without filter keeps a filter that you set, and gives a subscription without one the default. Delivery also follows the notification levels and quiet hours of the target principal.",
		),
});

const DriveArguments = z.strictObject({
	space_id: SpaceId.optional().describe(
		"The drive to monitor: your id for your own drive, or the id of a shared drive from drive_list_shared_drives. The default is your own drive.",
	),
});

const CalendarArguments = z.strictObject({
	calendar_id: prefixedId("prn")
		.optional()
		.describe(
			"The calendar to monitor: your own principal id. The default and the only allowed value is your own calendar.",
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
	// The three fields below are optional only for an event that the previous Worker stored: during a
	// deploy, such an event has none of them. Each event of this Worker has them.
	reason: z
		.enum(CHAT_EVENT_REASONS)
		.optional()
		.describe(
			"Why you get the event. author: a different member deleted a message that you wrote. mention: the message mentions you or a group. dm: the message is in a direct message. thread_reply: a reply in a thread that you follow. room: none of these, so the message is possibly not for you. Absent only in an event from before an update of the server.",
		),
	author_id: z
		.string()
		.optional()
		.describe("The principal that wrote the message. Absent only in an event from before an update of the server."),
	version: z
		.number()
		.int()
		.optional()
		.describe(
			"The version that the message got from this change. It is a version of the room. When the version of your last chat_list_messages result is not lower, that result is not older than this event. Absent only in an event from before an update of the server.",
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

const CalendarPayload = z.strictObject({
	calendar_id: z.string().describe("The calendar: the id of its owner."),
	event_id: z
		.string()
		.describe(
			"Read the event with calendar_get_event. The event has no title, time or answer. After a delete or a cancel, the event is gone.",
		),
	uid: z.string().describe("The meeting: the same on the event of the organizer and on each copy."),
	change_id: z
		.string()
		.describe("The stable id of the change, as in calendar_list_changes. A retry has the same id: skip a known id."),
	occurrence_id: z.string().nullable().describe("The occurrence of a recurring event. Null for the whole event."),
	revision: z
		.number()
		.int()
		.describe(
			"The revision of the event after the change. An answer of a different attendee does not change it, so deduplicate by change_id.",
		),
	actor_id: z
		.string()
		.nullable()
		.describe("The principal that caused the change. Skip your own changes to prevent a loop."),
	cursor: z
		.string()
		.describe("The position after this change. Give it to calendar_list_changes to read the changes that follow."),
});

const DESCRIPTIONS: Record<WebhookEvent, string> = {
	"mail.inbox.updated":
		"New mail arrived in the inbox of the mailbox. Spam, a label and an archive send nothing. Mail in a short time gives one event. Read the inbox with mail_list_threads.",
	"chat.message.created":
		"A different member posted a message in a room that you are a member of, also a reply in a thread. Your own messages send nothing. With filter addressed, only a message for you sends the event.",
	"chat.message.updated":
		"A different member edited a message in a room that you are a member of. With filter addressed, only a message that is for you after the edit sends the event.",
	"chat.message.deleted":
		"A message was deleted in a room that you are a member of. With filter addressed, only a message that was for you, or that you wrote, sends the event.",
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
	"calendar.event.created": "You added an event to your calendar.",
	"calendar.event.updated": "You changed the fields or the attendees of your own event.",
	"calendar.event.deleted": "You deleted your own event. For a meeting, this cancels it for each attendee.",
	"calendar.invitation.received": "A different principal invited you: a copy of the meeting is on your calendar.",
	"calendar.invitation.updated": "The organizer changed the meeting of a copy on your calendar.",
	"calendar.invitation.cancelled":
		"A copy of a meeting left your calendar: the organizer cancelled the meeting or removed you.",
	"calendar.rsvp.changed":
		"An answer changed: your own answer to an invitation, the answer of an attendee to your meeting, or the answer of a different attendee on a copy.",
};

function define(name: WebhookEvent): McpEventDefinition {
	const domain = webhookDomain(name);
	const description = DESCRIPTIONS[name];
	if (domain === "mail") return { name, domain, description, input: MailArguments, payload: MailPayload };
	if (domain === "chat") return { name, domain, description, input: ChatArguments, payload: ChatPayload };
	if (domain === "calendar") return { name, domain, description, input: CalendarArguments, payload: CalendarPayload };
	const payload = name.startsWith("drive.item.") ? DriveItemPayload : DriveSpacePayload;
	return { name, domain, description, input: DriveArguments, payload };
}

/** Each event of MCP Events, in the sequence of the webhook events. */
export const mcpEventList: readonly McpEventDefinition[] = WEBHOOK_EVENTS.map(define);

/** Each event of MCP Events by its name. */
export const mcpEvents: ReadonlyMap<string, McpEventDefinition> = new Map(
	mcpEventList.map((event) => [event.name, event]),
);
