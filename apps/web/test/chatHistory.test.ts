import type { ChatMessage } from "@soldock/contracts";
import { describe, expect, it } from "vitest";
import { type History, withChanges, withNewer, withOlder } from "../src/features/chat/history.ts";

function message(seq: number, change: Partial<ChatMessage> = {}): ChatMessage {
	return {
		id: `cmsg_${seq}`,
		room_id: "rm_01JD0000000000000000000001",
		seq,
		author: { principal_id: "prn_01JD0000000000000000000ADA", kind: "human", display_name: "Ada Lovelace" },
		text: `message ${seq}`,
		created_at: new Date(Date.UTC(2026, 0, 1, 9, seq)).toISOString(),
		edited_at: null,
		deleted: false,
		version: seq,
		...change,
	};
}

/** The messages `from` to `to` of a room. */
function range(from: number, to: number): ChatMessage[] {
	return Array.from({ length: to - from + 1 }, (_, index) => message(from + index));
}

function history(messages: ChatMessage[], hasOlder = false, hasNewer = false): History {
	return { messages, hasOlder, hasNewer };
}

/** The seqs of a history, with its two marks. */
function shape(result: History) {
	return { seqs: result.messages.map((entry) => entry.seq), hasOlder: result.hasOlder, hasNewer: result.hasNewer };
}

/** The first and the last seq of a long history, with its size and its two marks. */
function ends(result: History) {
	return {
		first: result.messages[0]?.seq,
		last: result.messages[result.messages.length - 1]?.seq,
		count: result.messages.length,
		hasOlder: result.hasOlder,
		hasNewer: result.hasNewer,
	};
}

describe("the changes of a room in the history of the page", () => {
	it("puts a new message at the end, and replaces a changed or deleted message", () => {
		const next = withChanges(
			history(range(3, 4), true),
			[
				message(4, { text: "changed", version: 6 }),
				message(5, { version: 5 }),
				message(3, { text: "", deleted: true, version: 7 }),
			],
			true,
		);
		expect(next.messages.map((entry) => [entry.seq, entry.text, entry.deleted])).toEqual([
			[3, "", true],
			[4, "changed", false],
			[5, "message 5", false],
		]);
	});

	// "Show older messages" continues from the first message. A message before it would make a gap.
	it("drops a change to a message before the first message, while older messages are not loaded", () => {
		const start = history(range(3, 4), true);
		expect(withChanges(start, [message(1, { text: "old edit", version: 9 })], true)).toBe(start);
	});

	// "Show newer messages" continues from the last message. A new message after it would make a gap.
	it("drops a new message, and keeps a change to a message that shows, while newer messages are not loaded", () => {
		const next = withChanges(
			history(range(3, 4), true, true),
			[message(9), message(4, { text: "changed", version: 10 })],
			false,
		);
		expect(shape(next)).toEqual({ seqs: [3, 4], hasOlder: true, hasNewer: true });
		expect(next.messages[1]?.text).toBe("changed");
	});

	// A room loads empty. A different member posts message 1, then the person posts message 2, and the
	// answer of that post shows first. The sync must still add message 1.
	it("keeps a message from before the first message when the history has the start of the room", () => {
		const afterOwnPost = withChanges(history([]), [message(2)], true);
		expect(shape(withChanges(afterOwnPost, [message(1), message(2)], true)).seqs).toEqual([1, 2]);
	});

	// The answer of an edit can arrive after a sync that has a newer change of the same message.
	it("keeps the newer version of a message when an older answer arrives later", () => {
		const list = withChanges(history([message(3)], true), [message(3, { text: "second edit", version: 8 })], true);
		const next = withChanges(list, [message(3, { text: "first edit", version: 6 })], true);
		expect(next.messages[0]?.text).toBe("second edit");
	});

	it("drops its oldest messages when it is full and the person looks at the end", () => {
		const next = withChanges(history(range(1, 300)), [message(301), message(302)], true);
		expect(ends(next)).toEqual({ first: 3, last: 302, count: 300, hasOlder: true, hasNewer: false });
	});

	// The person reads older messages. They must not go away under the eyes of the person.
	it("does not take a new message when it is full and the person reads older messages", () => {
		const next = withChanges(history(range(1, 300)), [message(301), message(302)], false);
		expect(ends(next)).toEqual({ first: 1, last: 300, count: 300, hasOlder: false, hasNewer: true });
	});
});

describe("a page of the history of a room", () => {
	it("goes before the first message, without a message two times", () => {
		const next = withOlder(history(range(3, 4), true), range(1, 3), 3, false);
		expect(shape(next)).toEqual({ seqs: [1, 2, 3, 4], hasOlder: false, hasNewer: false });
	});

	it("goes after the last message, and tells if the room has more", () => {
		const start = history(range(1, 2), false, true);
		expect(shape(withNewer(start, range(3, 4), 2, true))).toEqual({
			seqs: [1, 2, 3, 4],
			hasOlder: false,
			hasNewer: true,
		});
		expect(shape(withNewer(start, range(3, 4), 2, false)).hasNewer).toBe(false);
	});

	it("puts the newest messages out when a page of older messages makes the history too long", () => {
		const next = withOlder(history(range(51, 350), true), range(1, 50), 51, false);
		expect(ends(next)).toEqual({ first: 1, last: 300, count: 300, hasOlder: false, hasNewer: true });
	});

	it("puts the oldest messages out when a page of newer messages makes the history too long", () => {
		const next = withNewer(history(range(1, 300), false, true), range(301, 350), 300, false);
		expect(ends(next)).toEqual({ first: 51, last: 350, count: 300, hasOlder: true, hasNewer: false });
	});

	// The history changed during the read: a full history dropped its first message, or the person
	// went to the newest messages. The page then does not connect to the history.
	it("does not go in when the history does not start, or end, at the message of the read", () => {
		const moved = history(range(5, 8), true, true);
		expect(withOlder(moved, range(1, 3), 4, false)).toBe(moved);
		expect(withNewer(moved, range(8, 9), 7, false)).toBe(moved);
	});
});
