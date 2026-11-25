import type { ThreadSummary } from "@asterra/contracts";
import { describe, expect, it } from "vitest";
import { leftQueue, mergeQueue, nextActive } from "../src/features/mail/replyLater.ts";

function thread(id: string, messageCount = 1, lastMessageAt = "2026-11-02T10:00:00.000Z"): ThreadSummary {
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
		last_message_at: lastMessageAt,
		untrusted: false,
	};
}

const idsOf = (threads: readonly ThreadSummary[]) => threads.map((item) => item.id);

describe("mergeQueue", () => {
	it("keeps the order on screen, adds new threads at the end, and takes the fresh data", () => {
		const current = [thread("a"), thread("b"), thread("c")];
		// The newest thread is first in the fresh list. It goes after the items on screen, so nothing moves.
		const merged = mergeQueue(current, [thread("d"), thread("c"), thread("b", 2), thread("a")], new Set(), true);
		expect(idsOf(merged)).toEqual(["a", "b", "c", "d"]);
		expect(merged[1]?.message_count).toBe(2);
	});

	it("drops a thread that left the queue, but keeps it while its reply is open", () => {
		const current = [thread("a"), thread("b"), thread("c")];
		expect(idsOf(mergeQueue(current, [thread("c")], new Set(), true))).toEqual(["c"]);
		expect(idsOf(mergeQueue(current, [thread("c")], new Set(["b"]), true))).toEqual(["b", "c"]);
	});

	// A refresh gets one page. The person can have more items on screen, from "Older".
	it("keeps an item that can be on a later page of the queue, and drops one that the page must show", () => {
		const at = (hour: number) => `2026-11-02T${String(hour).padStart(2, "0")}:00:00.000Z`;
		const newest = thread("new", 1, at(12));
		const gone = thread("gone", 1, at(11));
		const last = thread("last", 1, at(10));
		const tie = thread("tie", 1, at(10));
		const older = thread("older", 1, at(9));
		const current = [newest, gone, last, tie, older];
		// The page ends at "last" and has more rows after it. "gone" is newer than "last", so it left the queue.
		expect(idsOf(mergeQueue(current, [newest, last], new Set(), false))).toEqual(["new", "last", "tie", "older"]);
		// A page with no row after it is the full queue.
		expect(idsOf(mergeQueue(current, [newest, last], new Set(), true))).toEqual(["new", "last"]);
		expect(leftQueue(older, [], false)).toBe(true);
	});
});

describe("nextActive", () => {
	it("moves to the next item, to the previous one after the last item, and to nothing when the queue is empty", () => {
		expect(nextActive(["a", "b", "c"], "b")).toBe("c");
		expect(nextActive(["a", "b", "c"], "c")).toBe("b");
		expect(nextActive(["a"], "a")).toBeNull();
	});
});
