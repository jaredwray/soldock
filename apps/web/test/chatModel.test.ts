import type { ChatMessage } from "@soldock/contracts";
import { describe, expect, it } from "vitest";
import {
	chatRows,
	type LocalChange,
	newMessages,
	nextReading,
	startReading,
	startsDay,
	startsGroup,
	startsNew,
	storedSends,
	unseenSendsNote,
	withLocalChanges,
} from "../src/features/chat/model.ts";

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
		idempotency_key: null,
		...change,
	};
}

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
		uncertain: state === "failed",
	});
	const outbox = (pending: ReturnType<typeof waiting>[], keys: [string, string][] = []) => ({
		pending,
		keys: new Map(keys),
		sendingKey: pending.find((entry) => entry.state === "sending")?.key ?? null,
	});
	const keysOf = (rows: readonly { key: string }[]) => rows.map((row) => row.key);

	// A row that gets a new key is a new row for React: the message flashes, and an open edit box closes.
	it("keeps the key of a send for the stored message, and puts the messages that wait at the end", () => {
		const rows = chatRows(
			[message(1, { author: BOT, idempotency_key: "bot-key" }), message(2, { idempotency_key: "k2" })],
			outbox([waiting("k3", "third", "sending"), waiting("k4", "fourth")], [["cmsg_2", "k2"]]),
			ADA,
			ROOM,
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
	it("shows a send as its stored message, at the position of the room, when the list has that message", () => {
		// A different member posted after the message of the person, before the answer of the send.
		const messages = [
			message(1),
			message(2, { author: BOT }),
			message(3, { idempotency_key: "k3" }),
			message(4, { author: BOT }),
		];
		const during = chatRows(
			messages,
			outbox([waiting("k3", "message 3", "sending"), waiting("k5", "fifth")]),
			ADA,
			ROOM,
		);
		// The row of the send is the stored message, before the later message. It is not a second row at the end.
		expect(keysOf(during)).toEqual(["cmsg_1", "cmsg_2", "k3", "cmsg_4", "k5"]);
		expect(during[2]).toMatchObject({ pending: null, message: { id: "cmsg_3", seq: 3 } });
		// The answer of the send arrives: each row keeps its key and its position.
		const after = chatRows(messages, outbox([waiting("k5", "fifth", "sending")], [["cmsg_3", "k3"]]), ADA, ROOM);
		expect(keysOf(after)).toEqual(["cmsg_1", "cmsg_2", "k3", "cmsg_4", "k5"]);
		// The answers got lost: the failed send shows one time, as its stored message.
		const lost = chatRows(messages, outbox([waiting("k3", "message 3", "failed")]), ADA, ROOM);
		expect(keysOf(lost)).toEqual(["cmsg_1", "cmsg_2", "k3", "cmsg_4"]);
	});

	// A wrong pair shows a message of a different tab, or of a different member, as the message of this send, and
	// hides the send. Before the key, the list paired by the text and the time of the send.
	it("pairs a send only with the message of the person that has the key of the send", () => {
		const messages = [
			message(1, { text: "Hello" }),
			message(2, { author: BOT, text: "Hello", idempotency_key: "k4" }),
			message(3, { text: "Hello", idempotency_key: "other-tab" }),
		];
		const rows = chatRows(messages, outbox([waiting("k4", "Hello", "sending")]), ADA, ROOM);
		expect(rows.map((row) => [row.key, row.pending?.state ?? "stored"])).toEqual([
			["cmsg_1", "stored"],
			["cmsg_2", "stored"],
			["cmsg_3", "stored"],
			["k4", "sending"],
		]);
	});

	// The room keeps a key for a day. A different client of the person can use the same key after that. A page
	// of older messages then brings a message with the key of a row that shows. A row key that changes makes the
	// list jump, and a focus in the row goes away.
	it("keeps the row key of each message when a page brings an older message with the same key", () => {
		const recent = message(5, { idempotency_key: "daily" });
		const state = outbox([], [["cmsg_5", "daily"]]);
		expect(keysOf(chatRows([recent], state, ADA, ROOM))).toEqual(["daily"]);
		const withOlder = [message(1, { idempotency_key: "daily" }), recent];
		expect(keysOf(chatRows(withOlder, state, ADA, ROOM))).toEqual(["cmsg_1", "daily"]);
	});
});

describe("a failed send whose message the room has", () => {
	const failed = (key: string, text: string, uncertain = true) => ({
		key,
		text,
		created_at: "2026-01-01T09:10:00.000Z",
		state: "failed" as const,
		error: "No connection.",
		uncertain,
	});
	const outbox = (pending: ReturnType<typeof failed>[]) => ({
		pending,
		keys: new Map<string, string>(),
		sendingKey: null,
	});

	// The server stored the message and each answer got lost. Without the pair, the message shows two times, one
	// time as "Not sent", and the person sends it again.
	it("is the message of the person with the key of the send", () => {
		const messages = [message(1, { text: "Hello" }), message(2, { text: "Hello", idempotency_key: "k1" })];
		expect(storedSends(messages, outbox([failed("k1", "Hello")]), ADA)).toEqual([{ key: "k1", id: "cmsg_2" }]);
	});

	// A wrong pair removes a message that the server does not have.
	it("is not a message of a different member with the same key, and not a message without the key", () => {
		const messages = [
			message(1, { text: "Hello" }),
			message(2, { author: BOT, text: "Hello", idempotency_key: "k1" }),
			message(3, { text: "Hello", idempotency_key: "k0" }),
		];
		expect(storedSends(messages, outbox([failed("k1", "Hello")]), ADA)).toEqual([]);
	});

	// Before the key, the list could not know which of two sends with one text the server had, and kept the two
	// as "Not sent". With the key, each send gets its own message.
	it("is one message for each of two failed sends with the same text", () => {
		const messages = [
			message(1, { text: "Ping", idempotency_key: "k2" }),
			message(2, { text: "Ping", idempotency_key: "k1" }),
		];
		const pairs = storedSends(messages, outbox([failed("k1", "Ping"), failed("k2", "Ping")]), ADA);
		expect(pairs.toSorted((a, b) => a.key.localeCompare(b.key))).toEqual([
			{ key: "k1", id: "cmsg_2" },
			{ key: "k2", id: "cmsg_1" },
		]);
	});
});

describe("the messages with the changes that wait for the server", () => {
	const AT = "2026-01-01T10:00:00.000Z";

	// The socket brought the stored message of a send, and the person changed it before the answer of the send.
	// The row must stay the row of the send, also with its new text.
	it("stay the row of their send when the person changes or deletes them before the answer of the send", () => {
		const messages = [message(1), message(2, { text: "Hello", idempotency_key: "k2" })];
		const sending = {
			pending: [
				{
					key: "k2",
					text: "Hello",
					created_at: "2026-01-01T09:10:00.000Z",
					state: "sending" as const,
					error: null,
					uncertain: false,
				},
			],
			keys: new Map<string, string>(),
			sendingKey: "k2",
		};
		const room = "rm_01JD0000000000000000000001";
		const edited = chatRows(
			messages,
			sending,
			ADA,
			room,
			new Map([["cmsg_2", { kind: "edit", text: "Hello all", at: AT }]]),
		);
		expect(edited.map((row) => [row.key, row.message.text, row.pending])).toEqual([
			["cmsg_1", "message 1", null],
			["k2", "Hello all", null],
		]);
		const deleted = chatRows(messages, sending, ADA, room, new Map([["cmsg_2", { kind: "delete" }]]));
		expect(deleted.map((row) => [row.key, row.message.deleted])).toEqual([
			["cmsg_1", false],
			["k2", true],
		]);
	});

	// The person sees the result of an edit or a delete before the answer of the server.
	it("show the new text of an edit with the edited mark, and a delete without its text", () => {
		const messages = [message(1), message(2), message(3, { edited_at: "2026-01-01T09:30:00.000Z" })];
		const shown = withLocalChanges(
			messages,
			new Map<string, LocalChange>([
				["cmsg_1", { kind: "edit", text: "new text", at: AT }],
				["cmsg_2", { kind: "delete" }],
			]),
		);
		expect(shown.map((entry) => [entry.id, entry.text, entry.edited_at, entry.deleted])).toEqual([
			["cmsg_1", "new text", AT, false],
			["cmsg_2", "", null, true],
			["cmsg_3", "message 3", "2026-01-01T09:30:00.000Z", false],
		]);
		// The position, the author and the version of a message do not change.
		expect(shown[0]).toMatchObject({ seq: 1, author: ADA, version: 1 });
	});

	// The owner of the room deleted the message while the author changed it. The room has no text of it.
	it("keep a message deleted when the room deleted it, also with an edit that waits", () => {
		const messages = [message(1, { deleted: true, text: "" })];
		const shown = withLocalChanges(messages, new Map([["cmsg_1", { kind: "edit", text: "too late", at: AT }]]));
		expect(shown).toEqual(messages);
	});

	// The list renders again for each new array. Without a change, the rows must stay the same.
	it("are the same list when no change waits, and ignore a change of a message that the list does not have", () => {
		const messages = [message(1)];
		expect(withLocalChanges(messages, new Map())).toBe(messages);
		expect(withLocalChanges(messages, new Map([["cmsg_9", { kind: "delete" }]]))).toEqual(messages);
	});
});

describe("the line about the sends that a list does not show", () => {
	type SendState = "waiting" | "sending" | "failed" | "no answer";
	const pending = (state: SendState) => ({
		key: `k_${state}`,
		text: "Hello",
		created_at: "2026-01-01T09:10:00.000Z",
		state: state === "no answer" ? ("failed" as const) : state,
		error: state === "failed" || state === "no answer" ? "No connection." : null,
		uncertain: state === "no answer",
	});
	const outbox = (...states: SendState[]) => ({
		pending: states.map(pending),
		keys: new Map<string, string>(),
		sendingKey: null,
	});

	// The list is not at the newest messages, and the room stored the message of the person. Without
	// the line, the person sees nothing of the send, and can send the message a second time.
	it("tells that the room has a message of the person, also after the send ended", () => {
		expect(unseenSendsNote(outbox(), 0)).toBeNull();
		expect(unseenSendsNote(outbox(), 1)).toMatch(/^The room has your new messages/);
	});

	it("tells first that a message was not sent, then that messages wait", () => {
		expect(unseenSendsNote(outbox("sending", "waiting"), 1)).toMatch(/^Your new messages wait/);
		expect(unseenSendsNote(outbox("waiting", "failed"), 1)).toMatch(/^A message was not sent/);
	});

	// The answers of a send got lost. The room possibly has the message, so "not sent" is not true.
	it("does not tell that a message was not sent when the server gave no answer", () => {
		expect(unseenSendsNote(outbox("no answer"), 0)).toMatch(/^The page got no answer for a message/);
		expect(unseenSendsNote(outbox("no answer", "failed"), 0)).toMatch(/^A message was not sent/);
	});
});

describe("the line before the new messages", () => {
	const own = ADA.principal_id;
	const fromBot = (seq: number) => message(seq, { author: BOT });

	// The room opens with the read marker at message 2. Messages 3 and 4 came while the person was away.
	it("goes after the read marker when the room opens with messages that the person did not see", () => {
		const list = [message(1), fromBot(2), fromBot(3), fromBot(4)];
		const opened = nextReading(startReading(2), list, own, false);
		expect(opened).toEqual({ seenSeq: 2, newAfter: 2, lineSeen: false });
		expect(list.map((entry, index) => startsNew(list[index - 1], entry, opened.newAfter, false))).toEqual([
			false,
			false,
			true,
			false,
		]);
		// A room without a message after the marker has no line.
		expect(nextReading(startReading(4), list, own, false).newAfter).toBeNull();
	});

	it("stays while the person reads, and moves to the next messages that come while the person does not look", () => {
		const list = [message(1), fromBot(2), fromBot(3)];
		let reading = nextReading(startReading(1), list, own, false);
		reading = nextReading(reading, list, own, true);
		expect(reading).toEqual({ seenSeq: 3, newAfter: 1, lineSeen: true });
		// The person looks, and a message comes: the person sees it, and the line stays.
		const more = [...list, fromBot(4)];
		reading = nextReading(reading, more, own, true);
		expect(reading).toEqual({ seenSeq: 4, newAfter: 1, lineSeen: true });
		// The person does not look, and two messages come: the line goes before the first of them.
		reading = nextReading(reading, [...more, fromBot(5)], own, false);
		reading = nextReading(reading, [...more, fromBot(5), fromBot(6)], own, false);
		expect(reading).toEqual({ seenSeq: 4, newAfter: 4, lineSeen: false });
	});

	// A message of the person in a different tab is not new for the person.
	it("does not start for a message of the person, and counts only the messages of other authors", () => {
		const list = [fromBot(1), message(2), message(3)];
		const reading = startReading(1);
		expect(nextReading(reading, list, own, false)).toBe(reading);
		expect(newMessages([...list, fromBot(4), fromBot(5)], reading, own)).toBe(2);
	});

	it("is the same object when nothing changed, so the page does not show the room again", () => {
		const list = [message(1), fromBot(2)];
		const seen = nextReading(startReading(1), list, own, true);
		expect(nextReading(seen, list, own, true)).toBe(seen);
		expect(nextReading(seen, list, own, false)).toBe(seen);
	});

	// The first message of the list is after the marker, and the room has older messages. The first
	// new message is possibly one of them, so the list shows no line there.
	it("does not go before the first message of a list that has older messages to read", () => {
		const list = [fromBot(5), fromBot(6)];
		expect(startsNew(undefined, list[0] as ChatMessage, 3, true)).toBe(false);
		expect(startsNew(undefined, list[0] as ChatMessage, 3, false)).toBe(true);
		expect(startsNew(list[0], list[1] as ChatMessage, 5, true)).toBe(true);
	});
});
