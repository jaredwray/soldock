import type { Message, ThreadSummary } from "@asterra/contracts";
import { describe, expect, it } from "vitest";
import {
	finishSummary,
	leftQueue,
	mergeQueue,
	moveActive,
	nextActive,
	replyTarget,
	restoreAt,
	sessionProgress,
} from "../src/features/mail/focusReply.ts";

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
		label_ids: ["REPLY_LATER"],
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

	it("drops a thread that left the queue, but keeps a card with an open reply or in its exit motion", () => {
		const current = [thread("a"), thread("b"), thread("c")];
		expect(idsOf(mergeQueue(current, [thread("c")], new Set(), true))).toEqual(["c"]);
		expect(idsOf(mergeQueue(current, [thread("c")], new Set(["b"]), true))).toEqual(["b", "c"]);
	});

	// A refresh gets one page. The person can have more cards on screen, from "Older".
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

describe("moveActive", () => {
	it("moves one card and stops at the first and the last card, and starts at the first card", () => {
		expect(moveActive(["a", "b", "c"], "a", 1)).toBe("b");
		expect(moveActive(["a", "b", "c"], "c", 1)).toBe("c");
		expect(moveActive(["a", "b", "c"], "a", -1)).toBe("a");
		expect(moveActive(["a", "b", "c"], null, 1)).toBe("a");
		expect(moveActive([], null, 1)).toBeNull();
	});
});

describe("replyTarget", () => {
	// Reply answers the person who waits. A forward from the mailbox can be the newest message of the thread.
	it("answers the newest message that the mailbox got, else the newest message", () => {
		const message = (id: string, origin: Message["origin"]) => ({ id, origin }) as Message;
		expect(replyTarget([message("in1", "external"), message("in2", "internal"), message("out", "sent")])?.id).toBe(
			"in2",
		);
		expect(replyTarget([message("out1", "sent"), message("out2", "sent")])?.id).toBe("out2");
		expect(replyTarget([])).toBeNull();
	});
});

describe("restoreAt", () => {
	// Undo of Done puts the card back where it was, not at the end of the list.
	it("puts an item back at its old place, at the end when the list got shorter, and only once", () => {
		const a = { id: "a" };
		const b = { id: "b" };
		const c = { id: "c" };
		expect(restoreAt([a, c], b, 1)).toEqual([a, b, c]);
		expect(restoreAt([a], c, 5)).toEqual([a, c]);
		expect(restoreAt([a, b], b, 0)).toEqual([a, b]);
	});
});

describe("progress and finish text", () => {
	it("counts the conversations of this visit", () => {
		expect(sessionProgress(0, 3)).toEqual({ total: 3, fraction: 0, label: "3 left" });
		expect(sessionProgress(2, 3)).toEqual({ total: 5, fraction: 0.4, label: "2 of 5 done · 3 left" });
		expect(sessionProgress(5, 0)).toEqual({ total: 5, fraction: 1, label: "5 of 5 done" });
	});

	it("says what the person answered and marked as done", () => {
		const cleared = (how: "answered" | "done", count: number) =>
			Array.from({ length: count }, (_, index) => ({ id: `${how}${index}`, subject: "S", how }));
		const table: [ReturnType<typeof cleared>, string][] = [
			[cleared("answered", 1), "You answered 1 conversation."],
			[cleared("answered", 4), "You answered 4 conversations."],
			[cleared("done", 1), "You marked 1 conversation as done."],
			[cleared("done", 2), "You marked 2 conversations as done."],
			[[...cleared("answered", 4), ...cleared("done", 1)], "You answered 4 conversations and marked 1 as done."],
		];
		for (const [log, text] of table) expect(finishSummary(log)).toBe(text);
	});
});
