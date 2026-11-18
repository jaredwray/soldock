import type { ChatMessage } from "@soldock/contracts";
import { describe, expect, it } from "vitest";
import { mergeThread, type ThreadState } from "../src/features/chat/thread.ts";

function message(seq: number, version: number, parentId: string | null, text = `message ${seq}`): ChatMessage {
	return {
		id: `cmsg_${seq}`,
		room_id: "rm_01JD0000000000000000000001",
		seq,
		author: { principal_id: "prn_01JD0000000000000000000ADA", kind: "human", display_name: "Ada Lovelace" },
		text,
		created_at: "2026-01-01T09:00:00.000Z",
		edited_at: null,
		deleted: false,
		version,
		idempotency_key: null,
		reactions: [],
		mentions: [],
		group_mentions: [],
		parent_id: parentId,
		also_in_room: false,
		thread: null,
	};
}

const parent = message(1, 1, null, "plan");
const start: ThreadState = { parent, replies: [message(3, 3, "cmsg_1")], version: 3 };

describe("the view of a thread", () => {
	// The socket and a read can bring the same message, in each order. The view must show each reply one
	// time, in its place, with its newest copy.
	it("takes the newer copy of the parent and of each reply, in the order of the seq, and nothing of other threads", () => {
		const merged = mergeThread(start, [
			message(2, 5, "cmsg_1", "earlier reply"),
			message(3, 6, "cmsg_1", "changed reply"),
			{ ...parent, version: 4, text: "plan, changed" },
			message(9, 7, "cmsg_8", "a different thread"),
			message(10, 8, null, "a message of the room"),
		]);
		expect(merged.parent.text).toBe("plan, changed");
		expect(merged.replies.map((reply) => [reply.seq, reply.text])).toEqual([
			[2, "earlier reply"],
			[3, "changed reply"],
		]);
		// An older copy changes nothing, so the same state comes back.
		expect(mergeThread(merged, [message(3, 3, "cmsg_1"), { ...parent, version: 2 }])).toBe(merged);
		// The read of a catch-up keeps the version of the thread: the panel sets it.
		expect(merged.version).toBe(3);
	});
});
