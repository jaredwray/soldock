import type { ChatRoom } from "@soldock/contracts";
import { CHAT_LIMITS } from "@soldock/contracts";
import { describe, expect, it } from "vitest";
import { forgetChangesUpTo, type RoomChange, withChangesSince, withRoom } from "../src/features/chat/roomList.ts";

function room(id: string, lastMessageAt: string | null, unread = 0): ChatRoom {
	return {
		id,
		kind: "public",
		name: id,
		topic: "",
		peer: null,
		created_at: "2026-01-01T09:00:00.000Z",
		created_by: { principal_id: "prn_1", kind: "human", display_name: "Ada Lovelace" },
		member_count: 2,
		role: "member",
		last_seq: unread,
		last_message_at: lastMessageAt,
		last_read_seq: 0,
		unread: unread > 0,
		unread_count: unread,
		version: unread,
	};
}

const ids = (rooms: readonly ChatRoom[]) => rooms.map((listed) => listed.id);

describe("the room list with the events socket", () => {
	it("puts a changed room at its place, adds a new room, and removes a room that the person left", () => {
		const list = [room("rm_b", "2026-01-02T09:00:00.000Z"), room("rm_a", "2026-01-01T10:00:00.000Z")];
		// A new message moves a room to the top, as chat.list_rooms orders it.
		const moved = withRoom(list, "rm_a", room("rm_a", "2026-01-03T09:00:00.000Z", 1));
		expect(ids(moved)).toEqual(["rm_a", "rm_b"]);
		expect(moved[0]?.unread_count).toBe(1);
		// A room without a message has its time of creation. The same time orders by the higher id.
		expect(ids(withRoom(moved, "rm_c", room("rm_c", "2026-01-02T09:00:00.000Z")))).toEqual(["rm_a", "rm_c", "rm_b"]);
		expect(ids(withRoom(moved, "rm_b", null))).toEqual(["rm_a"]);
	});

	// A read of the list can answer after an event. The room of the event is newer than the room of the answer.
	it("keeps each change that came after the start of a read of the list", () => {
		const answer = [room("rm_b", "2026-01-02T09:00:00.000Z"), room("rm_a", "2026-01-01T10:00:00.000Z")];
		const changes = new Map<string, RoomChange>([
			// Before the read: the answer has it already.
			["rm_b", { at: 3, room: room("rm_b", "2026-01-01T08:00:00.000Z") }],
			// During the read: a new message, and a room that the person left.
			["rm_a", { at: 5, room: room("rm_a", "2026-01-04T09:00:00.000Z", 2) }],
			["rm_c", { at: 6, room: null }],
		]);
		const rooms = withChangesSince(answer, changes, 4);
		expect(ids(rooms)).toEqual(["rm_a", "rm_b"]);
		expect(rooms[0]?.unread_count).toBe(2);
		expect(rooms[1]?.last_message_at).toBe("2026-01-02T09:00:00.000Z");
		expect(ids(withChangesSince([...answer, room("rm_c", null)], changes, 4))).toEqual(["rm_a", "rm_b"]);
	});

	// The sidebar shows the first page of chat.list_rooms. An event for an older room must not make it longer.
	it("keeps the first page only when an event adds a room", () => {
		const page = Array.from({ length: CHAT_LIMITS.pageSize }, (_, index) =>
			room(`rm_${String(index).padStart(3, "0")}`, `2026-02-01T09:${String(index % 60).padStart(2, "0")}:00.000Z`),
		);
		const older = withRoom(page, "rm_old", room("rm_old", "2026-01-01T09:00:00.000Z", 1));
		expect(older).toHaveLength(CHAT_LIMITS.pageSize);
		expect(ids(older)).not.toContain("rm_old");
		const newer = withRoom(page, "rm_new", room("rm_new", "2026-03-01T09:00:00.000Z", 1));
		expect(newer).toHaveLength(CHAT_LIMITS.pageSize);
		expect(newer[0]?.id).toBe("rm_new");
	});

	// A long-lived page gets changes of many rooms. It keeps only the changes that a read can still need.
	it("forgets the changes that a read that applied covers", () => {
		const changes = new Map<string, RoomChange>([
			["rm_a", { at: 2, room: room("rm_a", null) }],
			["rm_b", { at: 5, room: null }],
		]);
		forgetChangesUpTo(changes, 4);
		expect([...changes.keys()]).toEqual(["rm_b"]);
	});
});
