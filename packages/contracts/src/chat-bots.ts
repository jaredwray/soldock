import { CardButtons, CHAT_LIMITS, ChatMessage } from "./chat.ts";
import { prefixedId, RoomId } from "./common.ts";
import { defineOperation } from "./operation.ts";
import { z } from "./zod.ts";

const members = ["human", "agent"] as const;
const create = { readOnly: false, destructive: false, idempotent: false, openWorld: false };
const read = { ...create, readOnly: true, idempotent: true };
const hooks = "/api/v1/chat/rooms/{room_id}/incoming-hooks";
const hook = z.object({ id: prefixedId("hook"), label: z.string() });
const hookScopes = ["chat.webhooks", "chat.write"] as const;

export const chatBotOperations = {
	"chat.create_incoming_hook": defineOperation({
		name: "chat.create_incoming_hook",
		summary: "Create a signed incoming webhook",
		description:
			"Creates a webhook that can post external text to this room as you. Save its signing secret now. The secret appears once.",
		http: { method: "POST", path: hooks },
		scopes: hookScopes,
		callers: members,
		annotations: create,
		input: z.strictObject({ room_id: RoomId, label: z.string().trim().min(1).max(64) }),
		output: z.object({ hook, url: z.string(), secret: z.string() }),
		errors: ["not_found", "conflict"],
	}),
	"chat.list_incoming_hooks": defineOperation({
		name: "chat.list_incoming_hooks",
		summary: "List your incoming webhooks",
		description: "Lists the signed incoming webhooks that you own in this room.",
		http: { method: "GET", path: hooks },
		scopes: hookScopes,
		callers: members,
		annotations: read,
		input: z.strictObject({ room_id: RoomId }),
		output: z.object({ hooks: z.array(hook) }),
		errors: ["not_found"],
	}),
	"chat.delete_incoming_hook": defineOperation({
		name: "chat.delete_incoming_hook",
		summary: "Revoke an incoming webhook",
		description: "Deletes your incoming webhook and its signing secret.",
		http: { method: "DELETE", path: `${hooks}/{hook_id}` },
		scopes: hookScopes,
		callers: members,
		annotations: { ...create, destructive: true, idempotent: true },
		input: z.strictObject({ room_id: RoomId, hook_id: prefixedId("hook") }),
		output: z.object({ deleted: z.boolean() }),
		errors: ["not_found"],
	}),
	"chat.post_card": defineOperation({
		name: "chat.post_card",
		summary: "Post a card with buttons",
		description:
			"Posts an agent message with up to five buttons. Read the replies with chat.list_replies to receive the action id and the principal of each click.",
		http: { method: "POST", path: "/api/v1/chat/rooms/{room_id}/cards" },
		scopes: ["chat.write"],
		callers: ["agent"],
		annotations: create,
		input: z.strictObject({
			room_id: RoomId,
			text: z.string().trim().min(1).max(CHAT_LIMITS.messageChars),
			buttons: CardButtons,
			idempotency_key: z.string().min(1).max(128).optional(),
		}),
		output: z.object({ message: ChatMessage }),
		errors: ["not_found", "conflict"],
	}),
	"chat.click_button": defineOperation({
		name: "chat.click_button",
		summary: "Select a button on an agent card",
		description:
			"Sends the selected action to the agent as a reply. The room validates the action id and records your identity. Reuse the idempotency key on a retry.",
		http: { method: "POST", path: "/api/v1/chat/rooms/{room_id}/cards/{message_id}/click" },
		scopes: ["chat.write"],
		callers: members,
		annotations: { ...create, idempotent: true },
		input: z.strictObject({
			room_id: RoomId,
			message_id: prefixedId("cmsg"),
			action_id: z.string().min(1).max(64),
			idempotency_key: z.string().min(1).max(128),
		}),
		output: z.object({ message: ChatMessage }),
		errors: ["not_found", "conflict"],
	}),
};
