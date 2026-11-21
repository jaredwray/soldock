import { ChatRoom } from "./chat.ts";
import { RoomId, Timestamp } from "./common.ts";
import { defineOperation } from "./operation.ts";
import { z } from "./zod.ts";

const read = { readOnly: true, destructive: false, idempotent: true, openWorld: false };
const SectionName = z.string().trim().min(1).max(60);
export const RoomSection = z.object({ name: SectionName, rooms: z.array(ChatRoom) });
export type RoomSection = z.infer<typeof RoomSection>;

export const ChatActivityEntry = z.object({
	room_id: RoomId,
	room_name: z.string(),
	version: z.number().int().positive(),
	kind: z.enum(["mention", "reply", "reaction"]),
	actor_name: z.string(),
	emoji: z.string().nullable(),
	seq: z.number().int().positive(),
	parent_seq: z.number().int().positive().nullable(),
	at: Timestamp,
});
export type ChatActivityEntry = z.infer<typeof ChatActivityEntry>;

export const chatNavigationOperations = {
	"chat.list_activity": defineOperation({
		name: "chat.list_activity",
		summary: "List your recent mentions, replies and reactions",
		description:
			"Read new mentions, replies in threads you follow, and reactions to your messages. Each room keeps your 50 most recent entries. Pass next_cursor to continue.",
		http: { method: "GET", path: "/api/v1/chat/activity" },
		scopes: ["chat.read"],
		callers: ["human", "agent"],
		annotations: read,
		input: z.strictObject({
			cursor: z.string().max(500).optional(),
			limit: z.coerce.number().int().min(1).max(50).optional(),
		}),
		output: z.object({ activity: z.array(ChatActivityEntry), next_cursor: z.string().nullable() }),
		errors: ["invalid"],
	}),
	"chat.list_sections": defineOperation({
		name: "chat.list_sections",
		summary: "List your sidebar sections",
		description:
			"Each section contains the rooms you put in it. Pass next_cursor to read more rooms. A section can appear on more than one page.",
		http: { method: "GET", path: "/api/v1/chat/sections" },
		scopes: ["chat.read"],
		callers: ["human", "agent"],
		annotations: read,
		input: z.strictObject({ cursor: RoomId.optional() }),
		output: z.object({ sections: z.array(RoomSection), next_cursor: RoomId.nullable() }),
		errors: [],
	}),
	"chat.set_room_section": defineOperation({
		name: "chat.set_room_section",
		summary: "Move a room to a sidebar section",
		description:
			"Pass a section name to create or use a section. Pass null to remove the room from its section. Empty sections disappear.",
		http: { method: "POST", path: "/api/v1/chat/rooms/{room_id}/section" },
		scopes: ["chat.write"],
		callers: ["human", "agent"],
		annotations: { ...read, readOnly: false },
		input: z.strictObject({ room_id: RoomId, section: SectionName.nullable() }),
		output: z.object({ section: SectionName.nullable() }),
		errors: ["not_found", "forbidden"],
	}),
};
