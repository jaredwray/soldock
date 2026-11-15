import type { ChatRoom } from "@soldock/contracts";
import { describe, expect, it } from "vitest";
import { type CachedRoom, createRoomCache } from "../src/features/chat/roomCache.ts";

const ADA = "prn_01JD0000000000000000000ADA";
const BOB = "prn_01JD0000000000000000000B0B";

/** A list of a room. `name` tells the lists apart. */
function list(name: string): CachedRoom {
	return { room: { id: `rm_${name}`, name } as ChatRoom, messages: [], hasOlder: false };
}

describe("the last list of each room", () => {
	it("comes back for the room and the person that it is for, and for nobody else", () => {
		const cache = createRoomCache();
		const general = list("general");
		cache.put(ADA, "rm_1", general);
		expect(cache.get(ADA, "rm_1")).toBe(general);
		expect(cache.get(ADA, "rm_2")).toBeNull();
		expect(cache.get(BOB, "rm_1")).toBeNull();
	});

	it("has the newest list of a room, and nothing after a removal or a clear", () => {
		const cache = createRoomCache();
		cache.put(ADA, "rm_1", list("old"));
		const newest = list("new");
		cache.put(ADA, "rm_1", newest);
		expect(cache.get(ADA, "rm_1")).toBe(newest);
		cache.remove(ADA, "rm_1");
		expect(cache.get(ADA, "rm_1")).toBeNull();
		cache.put(ADA, "rm_2", list("two"));
		cache.clear();
		expect(cache.get(ADA, "rm_2")).toBeNull();
	});

	// A person can open hundreds of rooms on one page. The page must not keep each list.
	it("keeps 20 rooms, and drops the room that the person used the longest time ago", () => {
		const cache = createRoomCache();
		for (let room = 1; room <= 20; room++) cache.put(ADA, `rm_${room}`, list(String(room)));
		// The person opens room 1 again. Room 2 is then the room that was used the longest time ago.
		cache.get(ADA, "rm_1");
		cache.put(ADA, "rm_21", list("21"));
		expect(cache.get(ADA, "rm_2")).toBeNull();
		expect(cache.get(ADA, "rm_1")?.room.name).toBe("1");
		expect(cache.get(ADA, "rm_3")?.room.name).toBe("3");
		expect(cache.get(ADA, "rm_21")?.room.name).toBe("21");
	});
});
