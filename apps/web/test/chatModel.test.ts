import type { ChatMessage } from "@soldock/contracts";
import { describe, expect, it } from "vitest";
import { startsGroup, withChanges, withOlder } from "../src/features/chat/model.ts";

const ADA = { principal_id: "prn_01JD0000000000000000000ADA", kind: "human", display_name: "Ada Lovelace" } as const;
const BOT = { principal_id: "prn_01JD0000000000000000000B0T", kind: "agent", display_name: "Deploy Bot" } as const;

function message(seq: number, change: Partial<ChatMessage> = {}): ChatMessage {
	return {
		id: `cmsg_${seq}`,
		room_id: "rm_01JD0000000000000000000001",
		seq,
		author: ADA,
		text: `message ${seq}`,
		created_at: new Date(Date.UTC(2026, 0, 1, 9, seq)).toISOString(),
		edited_at: null,
		deleted: false,
		version: seq,
		...change,
	};
}

const seqs = (messages: readonly ChatMessage[]) => messages.map((entry) => entry.seq);

describe("the message list of a room", () => {
	it("puts a new message at the end, and replaces a changed or deleted message", () => {
		const list = [message(3), message(4)];
		const next = withChanges(
			list,
			[
				message(4, { text: "changed", version: 6 }),
				message(5, { version: 5 }),
				message(3, { text: "", deleted: true, version: 7 }),
			],
			true,
		);
		expect(next.map((entry) => [entry.seq, entry.text, entry.deleted])).toEqual([
			[3, "", true],
			[4, "changed", false],
			[5, "message 5", false],
		]);
	});

	// "Show older messages" continues from the first message. A message before it would make a gap.
	it("drops a change to a message that is older than the first message, while older messages are not loaded", () => {
		const next = withChanges([message(3), message(4)], [message(1, { text: "old edit", version: 9 })], true);
		expect(seqs(next)).toEqual([3, 4]);
	});

	// A room loads empty. A different member posts message 1, then the person posts message 2, and the
	// answer of that post shows first. The sync must still add message 1.
	it("keeps a message from before the first message when the list has the start of the room", () => {
		const afterOwnPost = withChanges([], [message(2)], false);
		expect(seqs(withChanges(afterOwnPost, [message(1), message(2)], false))).toEqual([1, 2]);
	});

	// The answer of an edit can arrive after a sync that has a newer change of the same message.
	it("keeps the newer version of a message when an older answer arrives later", () => {
		const list = withChanges([message(3)], [message(3, { text: "second edit", version: 8 })], true);
		expect(withChanges(list, [message(3, { text: "first edit", version: 6 })], true)[0]?.text).toBe("second edit");
	});

	it("puts a page of older messages before the list, without a message two times", () => {
		expect(seqs(withOlder([message(3), message(4)], [message(1), message(2), message(3)]))).toEqual([1, 2, 3, 4]);
	});
});

describe("the look of a room", () => {
	it("shows the author again after a different author, and after five minutes", () => {
		expect(startsGroup(undefined, message(1))).toBe(true);
		expect(startsGroup(message(1), message(2))).toBe(false);
		expect(startsGroup(message(1), message(2, { author: BOT }))).toBe(true);
		expect(startsGroup(message(1), message(7))).toBe(true);
	});
});
