import type { Message, ThreadSummary } from "@asterra/contracts";
import { describe, expect, it } from "vitest";
import {
	type ClearKind,
	finishSummary,
	focusMode,
	leftQueue,
	mergeQueue,
	moveActive,
	nextActive,
	queueView,
	replySource,
	replyTarget,
	restoreAt,
	sessionProgress,
	waitingCount,
} from "../src/features/mail/focusReply.ts";
import type { MailView } from "../src/routes.ts";

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

	// A refresh that started before a Done still has the thread, and Starred keeps a thread after a reply. Its card
	// left the page. A new message in the thread brings the card back.
	it("does not bring back a cleared thread until a new message comes", () => {
		const fresh = [thread("c"), thread("b"), thread("a")];
		const gone = new Map([["b", 1]]);
		expect(idsOf(mergeQueue([thread("a")], fresh, new Set(), true, gone))).toEqual(["a", "c"]);
		// A card in its exit motion stays until the motion ends.
		expect(idsOf(mergeQueue([thread("a"), thread("b")], fresh, new Set(["b"]), true, gone))).toEqual(["a", "b", "c"]);
		// The count of a reply has the reply. A message after it is new.
		const replied = new Map([["b", 2]]);
		expect(idsOf(mergeQueue([thread("a")], [thread("b", 2), thread("a")], new Set(), true, replied))).toEqual(["a"]);
		expect(idsOf(mergeQueue([thread("a")], [thread("b", 3), thread("a")], new Set(), true, replied))).toEqual([
			"a",
			"b",
		]);
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

describe("replySource", () => {
	// In a very large thread, the server leaves out the bodies of older messages. A reply quotes the body.
	it("gives no message while the server left out its body, then the message with the body that came", () => {
		const message = (id: string, omitted: boolean) => ({ id, body: { omitted, text: omitted ? "" : id } }) as Message;
		const whole = message("m1", false);
		const cut = message("m2", true);
		expect(replySource(whole, null)).toBe(whole);
		expect(replySource(cut, null)).toBeNull();
		// A body that came for a different message does not count.
		expect(replySource(cut, message("m1", false))).toBeNull();
		const loaded = message("m2", false);
		expect(replySource(cut, loaded)).toBe(loaded);
		expect(replySource(null, loaded)).toBeNull();
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

describe("focusMode", () => {
	const system = (view: Extract<MailView, { kind: "system" }>["view"]): MailView => ({ kind: "system", view });
	const archive = { add: [], remove: ["INBOX"] };

	// Done takes the conversation out of the view where a label change can. In the inbox, a reply also archives.
	// A view that keeps a cleared conversation does not count it as waiting (`leaves`).
	it("gives each view its Done, its Later, its reply change and its count", () => {
		const table: [MailView, object][] = [
			[
				system("inbox"),
				{
					done: archive,
					later: true,
					archiveOnReply: true,
					countLabel: "INBOX",
					leaves: { answered: true, done: true, later: true },
				},
			],
			[
				system("reply-later"),
				{
					done: { add: [], remove: ["REPLY_LATER"] },
					later: false,
					archiveOnReply: false,
					countLabel: "REPLY_LATER",
					leaves: { answered: true, done: true, later: true },
				},
			],
			[
				system("starred"),
				{
					done: { add: [], remove: ["STARRED"] },
					later: true,
					archiveOnReply: false,
					countLabel: "STARRED",
					leaves: { answered: false, done: true, later: false },
				},
			],
			[
				{ kind: "label", labelId: "lbl_1" },
				{
					done: { add: [], remove: ["lbl_1"] },
					later: true,
					archiveOnReply: false,
					countLabel: "lbl_1",
					leaves: { answered: false, done: true, later: false },
				},
			],
			[system("sent"), { done: archive, archiveOnReply: false, countLabel: "SENT", leaves: { done: false } }],
			[system("all"), { done: archive, archiveOnReply: false, countLabel: null, leaves: { done: false } }],
			[
				{ kind: "search", query: "from:ana" },
				{ done: archive, archiveOnReply: false, countLabel: null, leaves: { done: false } },
			],
		];
		for (const [view, mode] of table) expect(focusMode(view), JSON.stringify(view)).toMatchObject(mode);
	});

	// Spam and Trash have no reply. The server refuses to move mail that the Screener holds.
	// A search or a label path can show Spam and Trash too. Done there would archive spam, or restore from Trash.
	it("gives no Focus & Reply to Spam, Trash and a search of held mail, also through a search or a label path", () => {
		const search = (query: string): MailView => ({ kind: "search", query });
		const label = (labelId: string): MailView => ({ kind: "label", labelId });
		for (const view of [
			system("spam"),
			system("trash"),
			search("in:screener"),
			search("invoice in:spam"),
			search('label:"Trash"'),
			search("(in:anywhere) from:ana"),
			label("SPAM"),
			label("TRASH"),
		]) {
			expect(focusMode(view), JSON.stringify(view)).toBeNull();
		}
		// A word that only starts like the operator is a normal search.
		expect(focusMode(search("in:spammy"))).not.toBeNull();
		// The label path of a system view gets the mode of that view.
		expect(focusMode(label("INBOX"))).toMatchObject({ archiveOnReply: true, countLabel: "INBOX" });
	});

	it("names what Done does, with the name of the label when it loaded", () => {
		const label: MailView = { kind: "label", labelId: "lbl_1" };
		expect(focusMode(label, "Clients")?.doneText("Q3")).toBe("remove the label “Clients” from “Q3”");
		expect(focusMode(label, "Clients")?.doneNotice).toBe("Label “Clients” removed.");
		expect(focusMode(label)?.doneText("Q3")).toBe("remove the label from “Q3”");
		expect(focusMode(system("inbox"))?.doneText("Q3")).toBe("archive “Q3”");
	});
});

describe("queueView", () => {
	// All mail keeps a conversation after Done, so a refresh gives no new card. The page must get the next page.
	it("gets the next page when each card is cleared and the queue has more pages, and finishes only at its end", () => {
		expect(queueView(2, 5, false)).toBe("cards");
		expect(queueView(0, 50, false)).toBe("older");
		expect(queueView(0, 50, true)).toBe("finished");
		expect(queueView(0, 0, true)).toBe("empty");
	});
});

describe("waitingCount", () => {
	it("counts the cards when the queue is complete, else the label count without the cleared ones that stay", () => {
		expect(waitingCount({ complete: true, queued: 3, total: 40, staying: 1 })).toEqual({ left: 3, more: false });
		// A starred conversation that the person answered stays in Starred, and the label still counts it.
		expect(waitingCount({ complete: false, queued: 50, total: 80, staying: 2 })).toEqual({ left: 78, more: false });
		// The label count comes a moment after a change. The cards on screen still wait.
		expect(waitingCount({ complete: false, queued: 50, total: 10, staying: 0 })).toEqual({ left: 50, more: false });
		// All mail and a search have no label count: more can come with Older.
		expect(waitingCount({ complete: false, queued: 50, total: null, staying: 0 })).toEqual({ left: 50, more: true });
	});
});

describe("progress and finish text", () => {
	it("counts the conversations of this visit", () => {
		expect(sessionProgress(0, 3)).toEqual({ total: 3, fraction: 0, label: "3 left" });
		expect(sessionProgress(2, 3)).toEqual({ total: 5, fraction: 0.4, label: "2 of 5 done · 3 left" });
		expect(sessionProgress(5, 0)).toEqual({ total: 5, fraction: 1, label: "5 of 5 done" });
		// With more conversations than the page shows and no label count, the text shows no total.
		expect(sessionProgress(0, 50, true).label).toBe("50+ left");
		expect(sessionProgress(2, 48, true).label).toBe("2 done · 48+ left");
		expect(sessionProgress(50, 0, true).label).toBe("50 done");
	});

	it("says what the person answered, marked as done and moved to Reply later", () => {
		const cleared = (how: ClearKind, count: number) =>
			Array.from({ length: count }, (_, index) => ({
				id: `${how}${index}`,
				subject: "S",
				how,
				count: 1,
				stays: false,
			}));
		const table: [ReturnType<typeof cleared>, string][] = [
			[cleared("answered", 1), "You answered 1 conversation."],
			[cleared("answered", 4), "You answered 4 conversations."],
			[cleared("done", 1), "You marked 1 conversation as done."],
			[cleared("done", 2), "You marked 2 conversations as done."],
			[[...cleared("answered", 4), ...cleared("done", 1)], "You answered 4 conversations and marked 1 as done."],
			[cleared("later", 2), "You moved 2 conversations to Reply later."],
			[
				[...cleared("later", 1), ...cleared("answered", 2), ...cleared("done", 3)],
				"You answered 2 conversations, marked 3 as done and moved 1 to Reply later.",
			],
		];
		for (const [log, text] of table) expect(finishSummary(log)).toBe(text);
	});
});
