import type { ThreadSummary } from "@asterra/contracts";
import { describe, expect, it } from "vitest";
import { mergeQueue, nextActive } from "../src/features/mail/replyLater.ts";

function thread(id: string, messageCount = 1): ThreadSummary {
	return {
		id,
		subject: id,
		snippet: "",
		participants: [],
		message_count: messageCount,
		unread: false,
		starred: false,
		has_attachments: false,
		label_ids: ["INBOX", "REPLY_LATER"],
		auto_label_ids: [],
		last_message_at: "2026-11-02T10:00:00.000Z",
		untrusted: false,
	};
}

const idsOf = (threads: readonly ThreadSummary[]) => threads.map((item) => item.id);

describe("mergeQueue", () => {
	it("keeps the order on screen, adds new threads at the end, and takes the fresh data", () => {
		const current = [thread("a"), thread("b"), thread("c")];
		// The newest thread is first in the fresh list. It goes after the items on screen, so nothing moves.
		const merged = mergeQueue(current, [thread("d"), thread("c"), thread("b", 2), thread("a")], new Set());
		expect(idsOf(merged)).toEqual(["a", "b", "c", "d"]);
		expect(merged[1]?.message_count).toBe(2);
	});

	it("drops a thread that left the queue, but keeps it while its reply is open", () => {
		const current = [thread("a"), thread("b"), thread("c")];
		expect(idsOf(mergeQueue(current, [thread("c")], new Set()))).toEqual(["c"]);
		expect(idsOf(mergeQueue(current, [thread("c")], new Set(["b"])))).toEqual(["b", "c"]);
	});
});

describe("nextActive", () => {
	it("moves to the next item, to the previous one after the last item, and to nothing when the queue is empty", () => {
		expect(nextActive(["a", "b", "c"], "b")).toBe("c");
		expect(nextActive(["a", "b", "c"], "c")).toBe("b");
		expect(nextActive(["a"], "a")).toBeNull();
	});
});
