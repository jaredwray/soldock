import type { RoomKind } from "@asterra/contracts";
import { type CallContext, getPrincipal, isAdmin } from "../identity/index.ts";
import { type HandlerMap, OperationError } from "../platform/index.ts";
import { messageOutput } from "./room.ts";
import { accept, actorsOf, auditOk, dmRoomId, openRoom, toRoom } from "./room-call.ts";

function requireAdmin(call: CallContext): void {
	if (!isAdmin(call.caller))
		throw new OperationError("forbidden", "Only organization owners and admins can manage rooms.");
}

/** A fresh directory has no administration rights over the rooms of the old directory. */
async function adminRoom(call: CallContext, roomId: string) {
	requireAdmin(call);
	const indexed = await call.env.DIRECTORY.prepare("SELECT 1 FROM chat_rooms WHERE id = ?").bind(roomId).first();
	if (!indexed) throw new OperationError("not_found", "The room does not exist.");
	return openRoom(call, roomId);
}

async function requireDeleted(call: CallContext, principalId: string) {
	const deleted = await call.env.DIRECTORY.prepare("SELECT 1 FROM principals WHERE id = ? AND deleted_at IS NOT NULL")
		.bind(principalId)
		.first();
	if (!deleted) throw new OperationError("invalid", "The principal must be deleted first.");
}

export const roomManagementHandlers = {
	async "chat.open_group_dm"(call, { principal_ids }) {
		const others = new Set(principal_ids);
		if (others.has(call.caller.id) || others.size !== principal_ids.length) {
			throw new OperationError("invalid", "Select two to eight other principals. Select each principal once.");
		}
		const actors = await actorsOf(call, principal_ids);
		const { room, ctx } = openRoom(call, await dmRoomId(call.caller.id, ...principal_ids));
		const result = accept(await room.openDm(ctx, actors));
		if (result.created) auditOk(call, "chat.open_group_dm", ctx.roomId);
		return { room: toRoom(result.room), created: result.created };
	},
	async "chat.get_room_policy"(call, { room_id }) {
		const { room, ctx } = openRoom(call, room_id);
		return accept(await room.getPolicy(ctx));
	},
	async "chat.set_room_policy"(call, { room_id, ...updates }) {
		const { room, ctx } = openRoom(call, room_id);
		const policy = accept(await room.setPolicy(ctx, updates, call.caller.principal.org_role === "owner"));
		auditOk(call, "chat.set_room_policy", room_id);
		return policy;
	},
	async "chat.delete_room"(call, { room_id }) {
		const { room, ctx } = openRoom(call, room_id);
		const result = accept(await room.deleteRoom(ctx));
		auditOk(call, "chat.delete_room", room_id);
		return result;
	},
	async "chat.export_room"(call, { room_id, after, limit, through }) {
		if (call.caller.principal.org_role !== "owner")
			throw new OperationError("forbidden", "Only the organization owner can export rooms.");
		const { room, ctx } = openRoom(call, room_id);
		const page = accept(await room.exportPage(ctx, after ?? 0, limit ?? 50, through ?? null));
		auditOk(call, "chat.export_room", room_id);
		return { messages: page.messages.map(messageOutput), through: page.through, next_after: page.next_after };
	},
	async "chat.admin_list_rooms"(call, { cursor, limit = 50 }) {
		requireAdmin(call);
		const { results } = await call.env.DIRECTORY.prepare(
			"SELECT id, kind, name, member_count FROM chat_rooms WHERE id > ? ORDER BY id LIMIT ?",
		)
			.bind(cursor ?? "", limit + 1)
			.all<{ id: string; kind: RoomKind; name: string | null; member_count: number }>();
		const rooms = results.slice(0, limit);
		return { rooms, next_cursor: results.length > limit ? (rooms.at(-1)?.id ?? null) : null };
	},
	async "chat.admin_room_members"(call, { room_id }) {
		const { room } = await adminRoom(call, room_id);
		const { members } = accept(await room.adminMembers());
		const { results } = await call.env.DIRECTORY.prepare(
			"SELECT id FROM principals WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NOT NULL",
		)
			.bind(JSON.stringify(members.map((member) => member.principal_id)))
			.all<{ id: string }>();
		const deleted = new Set(results.map((row) => row.id));
		return { members: members.map((member) => ({ ...member, deleted: deleted.has(member.principal_id) })) };
	},
	async "chat.admin_assign_owner"(call, { room_id, principal_id }) {
		const { room, ctx } = await adminRoom(call, room_id);
		const target = await getPrincipal(call.env.DIRECTORY, principal_id);
		if (!target) throw new OperationError("not_found", "The principal does not exist.");
		if (target.archived_at !== null) throw new OperationError("invalid", "Select an active principal as owner.");
		const result = accept(
			await room.assignOwner(ctx, { principal_id: target.id, kind: target.kind, display_name: target.display_name }),
		);
		auditOk(call, "chat.admin_assign_owner", room_id);
		return result;
	},
	async "chat.admin_cleanup_principal"(call, { principal_id, cursor, limit = 25 }) {
		requireAdmin(call);
		await requireDeleted(call, principal_id);
		const { results } = await call.env.DIRECTORY.prepare(
			"SELECT m.room_id FROM chat_members m JOIN chat_rooms r ON r.id = m.room_id WHERE m.principal_id = ? AND m.room_id > ? ORDER BY m.room_id LIMIT ?",
		)
			.bind(principal_id, cursor ?? "", limit + 1)
			.all<{ room_id: string }>();
		const page = results.slice(0, limit);
		const removals = await Promise.all(
			page.map(async ({ room_id }) => {
				const { room, ctx } = openRoom(call, room_id);
				const result = await room.removeDeletedMember(ctx, principal_id);
				if ("error" in result && result.error.code === "not_found") return false;
				return accept(result).removed;
			}),
		);
		auditOk(call, "chat.admin_cleanup_principal", principal_id);
		return {
			removed: removals.filter(Boolean).length,
			next_cursor: results.length > limit ? (page.at(-1)?.room_id ?? null) : null,
		};
	},
	async "chat.admin_remove_deleted"(call, { room_id, principal_id }) {
		const { room, ctx } = await adminRoom(call, room_id);
		await requireDeleted(call, principal_id);
		const result = accept(await room.removeDeletedMember(ctx, principal_id));
		auditOk(call, "chat.admin_remove_deleted", room_id);
		return result;
	},
} satisfies Partial<HandlerMap<CallContext>>;
