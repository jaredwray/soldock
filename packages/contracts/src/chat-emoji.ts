import { defineOperation } from "./operation.ts";
import { z } from "./zod.ts";

export const CUSTOM_EMOJI_LIMITS = { count: 256, bytes: 32 * 1024, side: 128 } as const;
export const CustomEmojiName = z.string().regex(/^[a-z0-9_+-]{1,30}$/);
export const CustomEmojiToken = z.string().regex(/^:[a-z0-9_+-]{1,30}:$/);
const nameInput = z.strictObject({ name: CustomEmojiName });
const content = z
	.string()
	.min(1)
	.max(4 * Math.ceil(CUSTOM_EMOJI_LIMITS.bytes / 3))
	.base64();
const read = { readOnly: true, destructive: false, idempotent: true, openWorld: false };

export const chatEmojiOperations = {
	"chat.list_emoji": defineOperation({
		name: "chat.list_emoji",
		summary: "List the custom emoji",
		description:
			"Get the names of the custom emoji of the organization. Use a name between colons in text or a reaction.",
		http: { method: "GET", path: "/api/v1/chat/emoji" },
		scopes: ["chat.read"],
		callers: ["human", "agent"],
		annotations: read,
		input: z.strictObject({}),
		output: z.object({ names: z.array(CustomEmojiName) }),
		errors: [],
	}),
	"chat.get_emoji": defineOperation({
		name: "chat.get_emoji",
		summary: "Get a custom emoji",
		description: "Get the PNG image for a custom emoji. A browser can also read /dl/chat-emoji/{name}.",
		http: { method: "GET", path: "/api/v1/chat/emoji/{name}" },
		scopes: ["chat.read"],
		callers: ["human", "agent"],
		annotations: read,
		input: nameInput,
		output: z.object({ content_base64: content }),
		errors: ["not_found"],
	}),
	"chat.create_emoji": defineOperation({
		name: "chat.create_emoji",
		summary: "Add a custom emoji",
		description:
			"An owner or admin can add a PNG image up to 32 KiB and 128 pixels per side. Each name must be unique.",
		http: { method: "POST", path: "/api/v1/chat/emoji" },
		scopes: ["chat.write"],
		callers: ["human"],
		annotations: { ...read, readOnly: false, idempotent: false },
		input: nameInput.extend({ content_base64: content }),
		output: z.object({ name: CustomEmojiName }),
		errors: ["conflict"],
	}),
	"chat.delete_emoji": defineOperation({
		name: "chat.delete_emoji",
		summary: "Remove a custom emoji",
		description: "An owner or admin can remove a custom emoji. Messages keep its name.",
		http: { method: "DELETE", path: "/api/v1/chat/emoji/{name}" },
		scopes: ["chat.write"],
		callers: ["human"],
		annotations: { ...read, readOnly: false, destructive: true },
		input: nameInput,
		output: z.object({ removed: z.boolean() }),
		errors: [],
	}),
};
