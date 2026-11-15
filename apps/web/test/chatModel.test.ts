import type { ChatMessage } from "@soldock/contracts";
import { describe, expect, it } from "vitest";
import { chatRows, startsDay, startsGroup, withChanges, withOlder } from "../src/features/chat/model.ts";

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

	// The times are times of the device, as the page shows them: two minutes apart, across midnight.
	it("shows the date and the author again on the first message of a day", () => {
		const evening = message(1, { created_at: new Date(2026, 0, 1, 23, 59).toISOString() });
		const night = message(2, { created_at: new Date(2026, 0, 2, 0, 1).toISOString() });
		const later = message(3, { created_at: new Date(2026, 0, 2, 0, 3).toISOString() });
		expect([startsDay(undefined, evening), startsDay(evening, night), startsDay(night, later)]).toEqual([
			true,
			true,
			false,
		]);
		expect([startsGroup(evening, night), startsGroup(night, later)]).toEqual([true, false]);
	});
});

describe("the rows of the message list", () => {
	const ROOM = "rm_01JD0000000000000000000001";
	const waiting = (key: string, text: string, state: "waiting" | "sending" | "failed" = "waiting") => ({
		key,
		text,
		created_at: "2026-01-01T09:10:00.000Z",
		state,
		error: state === "failed" ? "No connection." : null,
	});

	// A row that gets a new key is a new row for React: the message flashes, and an open edit box closes.
	it("keeps the key of a send for the stored message, and puts the messages that wait at the end", () => {
		const rows = chatRows(
			[message(1, { author: BOT }), message(2)],
			{
				pending: [waiting("k3", "third", "sending"), waiting("k4", "fourth")],
				keys: new Map([["cmsg_2", "k2"]]),
				sendingKey: "k3",
			},
			ADA,
			ROOM,
			2,
		);
		expect(rows.map((row) => [row.key, row.message.text, row.pending?.state ?? "stored"])).toEqual([
			["cmsg_1", "message 1", "stored"],
			["k2", "message 2", "stored"],
			["k3", "third", "sending"],
			["k4", "fourth", "waiting"],
		]);
		// A message that waits shows as a message of the person, after the last stored message.
		expect(rows[2]?.message).toMatchObject({ id: "k3", room_id: ROOM, seq: 3, author: ADA, deleted: false });
		expect(rows[3]?.message.seq).toBe(4);
	});

	// The socket can bring the stored message before the answer of the call. The list must not show the message two times.
	it("leaves out the stored message of the call that runs until the call ends", () => {
		const messages = [message(1), message(2, { author: BOT }), message(3), message(4, { author: BOT })];
		const sending = {
			pending: [waiting("k3", "message 3", "sending")],
			keys: new Map<string, string>(),
			sendingKey: "k3",
		};
		const during = chatRows(messages, sending, ADA, ROOM, 2);
		// The message of a different member shows. The older message of the person shows.
		expect(during.map((row) => row.key)).toEqual(["cmsg_1", "cmsg_2", "cmsg_4", "k3"]);

		const after = chatRows(
			messages,
			{ pending: [], keys: new Map([["cmsg_3", "k3"]]), sendingKey: null },
			ADA,
			ROOM,
			2,
		);
		expect(after.map((row) => row.key)).toEqual(["cmsg_1", "cmsg_2", "k3", "cmsg_4"]);
		// With no call, a message of the person from a different tab shows at once.
		const idle = chatRows(messages, { pending: [], keys: new Map(), sendingKey: null }, ADA, ROOM, 2);
		expect(idle.map((row) => row.key)).toEqual(["cmsg_1", "cmsg_2", "cmsg_3", "cmsg_4"]);
	});
});
