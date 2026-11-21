import type { ChatRoom, chatNavigationOperations } from "@asterra/contracts";
import type { CallContext } from "../identity/index.ts";
import { decodeCursor, encodeCursor, type HandlerMap, OperationError } from "../platform/index.ts";
import { auditOk, openRoom, roomStub, toRoom } from "./room-call.ts";

function principal(call: CallContext) {
	return call.env.PRINCIPAL.get(call.env.PRINCIPAL.idFromName(call.caller.id));
}

export const chatNavigationHandlers: Pick<HandlerMap<CallContext>, keyof typeof chatNavigationOperations> = {
	async "chat.list_activity"(call, input) {
		const after =
			input.cursor === undefined
				? null
				: decodeCursor<[number, string, number]>(input.cursor, ["number", "string", "number"]);
		if (input.cursor !== undefined && after === null) throw new OperationError("invalid", "Invalid activity cursor.");
		const limit = input.limit ?? 20;
		const candidates = await principal(call).chatActivityPage(after, limit);
		const page = candidates.slice(0, limit);
		const byRoom = new Map<string, number[]>();
		for (const entry of page) {
			const versions = byRoom.get(entry.room_id) ?? [];
			versions.push(entry.version);
			byRoom.set(entry.room_id, versions);
		}
		const batches = await Promise.all(
			[...byRoom].map(([id, versions]) => {
				const { room, ctx } = openRoom(call, id);
				return room.activityEntries(ctx, versions);
			}),
		);
		const current = new Map(batches.flat().map((entry) => [`${entry.room_id}/${entry.version}`, entry]));
		const activity = page.flatMap((ref) => current.get(`${ref.room_id}/${ref.version}`) ?? []);
		const last = page.at(-1);
		return {
			activity,
			next_cursor: candidates.length > limit && last ? encodeCursor([last.at, last.room_id, last.version]) : null,
		};
	},
	async "chat.list_sections"(call, { cursor }) {
		const limit = 25;
		const refs = await principal(call).chatSectionRefs(cursor ?? null, limit);
		const page = refs.slice(0, limit);
		const results = await Promise.all(
			page.map(async ({ room_id, section }) => {
				const { room, ctx } = openRoom(call, room_id);
				const record = await room.joinedRoom(ctx);
				return record ? { section, room: toRoom(record) } : null;
			}),
		);
		const groups = new Map<string, ChatRoom[]>();
		for (const entry of results) {
			if (!entry) continue;
			const rooms = groups.get(entry.section) ?? [];
			rooms.push(entry.room);
			groups.set(entry.section, rooms);
		}
		return {
			sections: [...groups].map(([name, rooms]) => ({ name, rooms })),
			next_cursor: refs.length > page.length ? (page.at(-1)?.room_id ?? null) : null,
		};
	},
	async "chat.set_room_section"(call, { room_id, section }) {
		const state = await roomStub(call.env, room_id).stateFor(call.caller.id);
		if (!state?.view) throw new OperationError("not_found", "No joined room has that id.");
		const result = await principal(call).setRoomSection(state, section);
		if (result === "not_found") throw new OperationError(result, "No joined room has that id.");
		auditOk(call, "chat.set_room_section", room_id);
		return { section };
	},
};
