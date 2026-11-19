import type { ChatRoom } from "@asterra/contracts";
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
		cache.put(ADA, "rm_1", general, cache.mark());
		expect(cache.get(ADA, "rm_1")).toBe(general);
		expect(cache.get(ADA, "rm_2")).toBeNull();
		expect(cache.get(BOB, "rm_1")).toBeNull();
	});

	it("has the newest list of a room, and nothing after a removal or a clear", () => {
		const cache = createRoomCache();
		cache.put(ADA, "rm_1", list("old"), cache.mark());
		const newest = list("new");
		cache.put(ADA, "rm_1", newest, cache.mark());
		expect(cache.get(ADA, "rm_1")).toBe(newest);
		cache.remove(ADA, "rm_1", cache.mark());
		expect(cache.get(ADA, "rm_1")).toBeNull();
		cache.put(ADA, "rm_2", list("two"), cache.mark());
		cache.clear();
		expect(cache.get(ADA, "rm_2")).toBeNull();
	});

	// Two loads of a room run. The older one fails after the newer one gave its list to the cache.
	// The answer of the newer load is the newer fact, so its list stays.
	it("keeps a list from a load that started after the load that failed", () => {
		const cache = createRoomCache();
		const olderLoad = cache.mark();
		const newerLoad = cache.mark();
		const fromNewerLoad = list("after");
		cache.put(ADA, "rm_1", fromNewerLoad, newerLoad);
		cache.remove(ADA, "rm_1", olderLoad);
		expect(cache.get(ADA, "rm_1")).toBe(fromNewerLoad);
	});

	// A room of a member is in the cache. A new message changes its list, with the mark of the same
	// load. Then a load finds that the person is not a member now. The list must go away.
	it("removes a list from a load that started before the load that failed, also after a change of the list", () => {
		const cache = createRoomCache();
		const firstLoad = cache.mark();
		cache.put(ADA, "rm_1", list("as a member"), firstLoad);
		const failedLoad = cache.mark();
		cache.put(ADA, "rm_1", list("as a member, with a new message"), firstLoad);
		cache.remove(ADA, "rm_1", failedLoad);
		expect(cache.get(ADA, "rm_1")).toBeNull();
	});

	// A person can open hundreds of rooms on one page. The page must not keep each list.
	it("keeps 20 rooms, and drops the room that the person used the longest time ago", () => {
		const cache = createRoomCache();
		for (let room = 1; room <= 20; room++) cache.put(ADA, `rm_${room}`, list(String(room)), cache.mark());
		// The person opens room 1 again. Room 2 is then the room that was used the longest time ago.
		cache.get(ADA, "rm_1");
		cache.put(ADA, "rm_21", list("21"), cache.mark());
		expect(cache.get(ADA, "rm_2")).toBeNull();
		expect(cache.get(ADA, "rm_1")?.room.name).toBe("1");
		expect(cache.get(ADA, "rm_3")?.room.name).toBe("3");
		expect(cache.get(ADA, "rm_21")?.room.name).toBe("21");
	});
});
