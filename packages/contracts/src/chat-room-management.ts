import { CHAT_LIMITS, ChatMessage, ChatRoom, ChatRoomPolicy, ROOM_KINDS, ROOM_ROLES } from "./chat.ts";
import { prefixedId, RoomId } from "./common.ts";
import { defineOperation } from "./operation.ts";
import { z } from "./zod.ts";

const people = ["human", "agent"] as const;
const admin = ["human"] as const;
const read = { readOnly: true, destructive: false, idempotent: true, openWorld: false };
const change = { ...read, readOnly: false };
const destructive = { ...change, destructive: true };
const room = z.strictObject({ room_id: RoomId });
const principal = prefixedId("prn");
const member = room.extend({ principal_id: principal });
const pageSize = z.coerce.number().int().min(1).max(CHAT_LIMITS.pageSize).optional();
export const roomManagementOperations = {
	"chat.open_group_dm": defineOperation({
		name: "chat.open_group_dm",
		summary: "Open a group direct message",
		description:
			"Open the direct message for you and two to eight other principals. The same set of principals shares one room.",
		http: { method: "POST", path: "/api/v1/chat/group-dms" },
		scopes: ["chat.write"],
		callers: people,
		annotations: change,
		input: z.strictObject({ principal_ids: z.array(principal).min(2).max(8) }),
		output: z.object({ room: ChatRoom, created: z.boolean() }),
		errors: ["invalid", "not_found"],
	}),
	"chat.get_room_policy": defineOperation({
		name: "chat.get_room_policy",
		summary: "Read the policy of a joined room",
		description: "Read the archive status, the posting rule and the retention period for messages.",
		http: { method: "GET", path: "/api/v1/chat/rooms/{room_id}/policy" },
		scopes: ["chat.read"],
		callers: people,
		annotations: read,
		input: room,
		output: ChatRoomPolicy,
		errors: ["not_found", "forbidden"],
	}),
	"chat.set_room_policy": defineOperation({
		name: "chat.set_room_policy",
		summary: "Change the policy of your room",
		description:
			"A room owner can archive or reopen the room, limit new posts to owners, and set retention. The organization owner can also set retention in a joined direct message. Use null for indefinite retention. Expired messages cannot be restored.",
		http: { method: "POST", path: "/api/v1/chat/rooms/{room_id}/policy" },
		scopes: ["chat.write"],
		callers: people,
		annotations: destructive,
		input: room
			.extend(ChatRoomPolicy.partial().shape)
			.refine((input) => Object.keys(input).length > 1, "Supply a policy change."),
		output: ChatRoomPolicy,
		errors: ["invalid", "not_found", "forbidden"],
	}),
	"chat.delete_room": defineOperation({
		name: "chat.delete_room",
		summary: "Delete your room",
		description:
			"The room owner can delete a public or private room. Access ends immediately. Messages and file grants are removed in the background.",
		http: { method: "DELETE", path: "/api/v1/chat/rooms/{room_id}" },
		scopes: ["chat.write"],
		callers: people,
		annotations: destructive,
		input: room,
		output: z.object({ deleted: z.boolean() }),
		errors: ["invalid", "not_found", "forbidden"],
	}),
	"chat.export_room": defineOperation({
		name: "chat.export_room",
		summary: "Export messages from a joined room",
		description:
			"An organization owner can export current messages and thread replies from a joined room. For each next page, pass the returned through and use next_after as after. Later posts fall outside that range.",
		http: { method: "GET", path: "/api/v1/chat/rooms/{room_id}/export" },
		scopes: ["chat.read"],
		callers: admin,
		annotations: read,
		auditDenied: true,
		input: room.extend({
			after: z.coerce.number().int().nonnegative().optional(),
			through: z.coerce.number().int().nonnegative().optional(),
			limit: pageSize,
		}),
		output: z.object({
			messages: z.array(ChatMessage),
			through: z.number().int().nonnegative(),
			next_after: z.number().nullable(),
		}),
		errors: ["not_found", "forbidden"],
	}),
	"chat.admin_list_rooms": defineOperation({
		name: "chat.admin_list_rooms",
		summary: "List rooms in the organization",
		description: "An organization owner or admin can list room metadata. This operation grants no access to messages.",
		http: { method: "GET", path: "/api/v1/chat/admin/rooms" },
		scopes: ["chat.read", "directory.read"],
		callers: admin,
		annotations: read,
		auditDenied: true,
		input: z.strictObject({ cursor: RoomId.optional(), limit: pageSize }),
		output: z.object({
			rooms: z.array(
				z.object({ id: RoomId, kind: z.enum(ROOM_KINDS), name: z.string().nullable(), member_count: z.number().int() }),
			),
			next_cursor: RoomId.nullable(),
		}),
		errors: ["forbidden"],
	}),
	"chat.admin_room_members": defineOperation({
		name: "chat.admin_room_members",
		summary: "List members for room administration",
		description:
			"An organization owner or admin can inspect the roles of room members and identify deleted principals.",
		http: { method: "GET", path: "/api/v1/chat/admin/rooms/{room_id}/members" },
		scopes: ["chat.read", "directory.read"],
		callers: admin,
		annotations: read,
		auditDenied: true,
		input: room,
		output: z.object({
			members: z.array(
				z.object({ principal_id: principal, display_name: z.string(), role: z.enum(ROOM_ROLES), deleted: z.boolean() }),
			),
		}),
		errors: ["not_found", "forbidden"],
	}),
	"chat.admin_assign_owner": defineOperation({
		name: "chat.admin_assign_owner",
		summary: "Assign an owner to a room without one",
		description:
			"An organization owner or admin can assign an existing member. For an empty room, the new owner joins it.",
		http: { method: "POST", path: "/api/v1/chat/admin/rooms/{room_id}/owner" },
		scopes: ["chat.write", "directory.write"],
		callers: admin,
		annotations: change,
		input: member,
		output: z.object({ assigned: z.boolean() }),
		errors: ["invalid", "not_found", "conflict", "forbidden"],
	}),
	"chat.admin_cleanup_principal": defineOperation({
		name: "chat.admin_cleanup_principal",
		summary: "Remove a deleted principal from its rooms",
		description:
			"An organization owner or admin can remove a deleted principal from its rooms in batches. Pass next_cursor as cursor until it is null.",
		http: { method: "POST", path: "/api/v1/chat/admin/principals/{principal_id}/cleanup" },
		scopes: ["chat.write", "directory.write"],
		callers: admin,
		annotations: destructive,
		input: z.strictObject({
			principal_id: principal,
			cursor: RoomId.optional(),
			limit: z.number().int().min(1).max(25).optional(),
		}),
		output: z.object({ removed: z.number().int(), next_cursor: RoomId.nullable() }),
		errors: ["invalid", "forbidden"],
	}),
	"chat.admin_remove_deleted": defineOperation({
		name: "chat.admin_remove_deleted",
		summary: "Remove a deleted principal from a room",
		description:
			"An organization owner or admin can remove a principal after deletion in the directory. An archived principal keeps its membership.",
		http: { method: "DELETE", path: "/api/v1/chat/admin/rooms/{room_id}/members/{principal_id}" },
		scopes: ["chat.write", "directory.write"],
		callers: admin,
		annotations: destructive,
		input: member,
		output: z.object({ removed: z.boolean() }),
		errors: ["invalid", "not_found", "forbidden"],
	}),
} as const;
