import { CHAT_LIMITS, ChatBody, ChatMessage } from "./chat.ts";
import { prefixedId, RoomId, Timestamp } from "./common.ts";
import { defineOperation } from "./operation.ts";
import { z } from "./zod.ts";

const roomPath = "/api/v1/chat/rooms/{room_id}";
const messagePath = `${roomPath}/messages/{message_id}`;
const MessageId = prefixedId("cmsg");
const message = { room_id: RoomId, message_id: MessageId };
const draft = { room_id: RoomId, parent_id: MessageId.optional() };
const Draft = z.object({ body: ChatBody.nullable(), revision: z.number().int().nonnegative() });
const Limit = z.coerce.number().int().min(1).max(CHAT_LIMITS.pageSize).optional();
const ParentSeqs = z.record(z.string(), z.number().int().positive());
const Page = { before: z.string().min(1).max(150).optional(), limit: Limit };
const Ok = z.object({ ok: z.literal(true) });
const Key = z.string().min(1).max(255);
const write = {
	callers: ["human", "agent"],
	scopes: ["chat.write"],
	errors: ["not_found", "conflict"],
	annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
} as const;
const read = {
	callers: ["human", "agent"],
	scopes: ["chat.read"],
	errors: ["not_found"],
	annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
} as const;

export const messageToolsOperations = {
	"chat.pin_message": defineOperation({
		...write,
		name: "chat.pin_message",
		summary: "Pin or unpin a message",
		description: "Set the pin on a message. Each member of the room can see and change its pins.",
		http: { method: "POST", path: `${messagePath}/pin` },
		input: z.strictObject({ ...message, pinned: z.boolean() }),
		output: Ok,
	}),
	"chat.list_pins": defineOperation({
		...read,
		name: "chat.list_pins",
		summary: "List the pins of a room",
		description: "Read pinned messages, newest message first. For the next page, pass the lowest seq as before.",
		http: { method: "GET", path: `${roomPath}/pins` },
		input: z.strictObject({ room_id: RoomId, before: z.coerce.number().int().positive().optional(), limit: Limit }),
		output: z.object({ messages: z.array(ChatMessage), parent_seqs: ParentSeqs, has_more: z.boolean() }),
	}),
	"chat.save_message": defineOperation({
		...write,
		name: "chat.save_message",
		summary: "Save or remove a personal bookmark",
		description: "Set your private bookmark for this message. A bookmark gives no access to its room.",
		http: { method: "POST", path: `${messagePath}/save` },
		input: z.strictObject({ ...message, saved: z.boolean() }),
		output: Ok,
	}),
	"chat.list_saved_messages": defineOperation({
		...read,
		name: "chat.list_saved_messages",
		summary: "Read your saved messages",
		description: "Read messages that you saved, newest bookmark first. Use next_cursor as before for the next page.",
		http: { method: "GET", path: "/api/v1/chat/saved" },
		input: z.strictObject(Page),
		output: z.object({ messages: z.array(ChatMessage), parent_seqs: ParentSeqs, next_cursor: z.string().nullable() }),
	}),
	"chat.set_reminder": defineOperation({
		...write,
		name: "chat.set_reminder",
		summary: "Set or dismiss a private message reminder",
		description:
			"Set a future time in UTC. At that time the message appears in your due reminders. Send null to dismiss it.",
		http: { method: "POST", path: `${messagePath}/reminder` },
		input: z.strictObject({ ...message, remind_at: Timestamp.nullable() }),
		output: Ok,
	}),
	"chat.list_reminders": defineOperation({
		...read,
		name: "chat.list_reminders",
		summary: "Read your message reminders",
		description:
			"Read reminders for messages you can access. The default view shows due reminders. Use next_cursor as before.",
		http: { method: "GET", path: "/api/v1/chat/reminders" },
		input: z.strictObject({ ...Page, view: z.enum(["due", "all"]).optional() }),
		output: z.object({
			reminders: z.array(z.object({ message: ChatMessage, remind_at: Timestamp })),
			parent_seqs: ParentSeqs,
			next_cursor: z.string().nullable(),
		}),
	}),
	"chat.get_draft": defineOperation({
		...read,
		name: "chat.get_draft",
		summary: "Read your room or thread draft",
		description: "Read the private draft and its revision. A new draft has revision zero.",
		http: { method: "GET", path: `${roomPath}/draft` },
		input: z.strictObject(draft),
		output: Draft,
	}),
	"chat.set_draft": defineOperation({
		...write,
		name: "chat.set_draft",
		summary: "Write your room or thread draft",
		description:
			"Send the revision you read and a body, or null to clear it. A newer revision gives conflict. Read the draft again.",
		http: { method: "POST", path: `${roomPath}/draft` },
		input: z.strictObject({ ...draft, body: ChatBody.nullable(), revision: z.number().int().nonnegative() }),
		output: Draft,
	}),
	"chat.schedule_message": defineOperation({
		...write,
		name: "chat.schedule_message",
		summary: "Schedule a message",
		description:
			"Post a formatted message at a future UTC time. A retry with the same key returns the same message id.",
		http: { method: "POST", path: `${roomPath}/scheduled` },
		input: z.strictObject({ ...draft, body: ChatBody, send_at: Timestamp, idempotency_key: Key }),
		output: z.object({ message_id: MessageId }),
	}),
	"chat.list_scheduled_messages": defineOperation({
		...read,
		name: "chat.list_scheduled_messages",
		summary: "Read your scheduled messages in a room",
		description:
			"Read your pending messages in order of their delivery times. Each member can schedule up to 100 in a room.",
		http: { method: "GET", path: `${roomPath}/scheduled` },
		input: z.strictObject({ room_id: RoomId }),
		output: z.object({
			messages: z.array(
				z.object({ message_id: MessageId, parent_id: MessageId.nullable(), send_at: Timestamp, body: ChatBody }),
			),
		}),
	}),
	"chat.cancel_scheduled_message": defineOperation({
		...write,
		name: "chat.cancel_scheduled_message",
		summary: "Cancel your scheduled message",
		description: "Cancel your pending send in this room. Returns false if the message is no longer pending.",
		http: { method: "DELETE", path: `${roomPath}/scheduled/{message_id}` },
		input: z.strictObject(message),
		output: z.object({ canceled: z.boolean() }),
	}),
	"chat.forward_message": defineOperation({
		...write,
		scopes: ["chat.read", "chat.write"],
		name: "chat.forward_message",
		summary: "Forward a message to another room",
		description:
			"Copy the message text and its attribution into a different room. Each member there can read the copy. Files and buttons stay in the source room.",
		annotations: { ...write.annotations, idempotent: false },
		http: { method: "POST", path: `${messagePath}/forward` },
		input: z.strictObject({ ...message, destination_room_id: RoomId, idempotency_key: Key.optional() }),
		output: z.object({ message: ChatMessage }),
	}),
} as const;
