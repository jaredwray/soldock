import type { ChatMessage } from "@soldock/contracts";
import { describe, expect, it } from "vitest";
import {
	chatRows,
	type LocalChange,
	startsDay,
	startsGroup,
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
	const waiting = (
		key: string,
		text: string,
		state: "waiting" | "sending" | "failed" = "waiting",
		afterSeq: number | null = null,
	) => ({
		key,
		text,
		created_at: "2026-01-01T09:10:00.000Z",
		state,
		error: state === "failed" ? "No connection." : null,
		uncertain: state === "failed",
		afterSeq,
	});
	const keysOf = (rows: readonly { key: string }[]) => rows.map((row) => row.key);

	// A row that gets a new key is a new row for React: the message flashes, and an open edit box closes.
	it("keeps the key of a send for the stored message, and puts the messages that wait at the end", () => {
		const rows = chatRows(
			[message(1, { author: BOT }), message(2)],
			{
				pending: [waiting("k3", "third", "sending", 2), waiting("k4", "fourth")],
				keys: new Map([["cmsg_2", "k2"]]),
				sendingKey: "k3",
			},
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
		const messages = [message(1), message(2, { author: BOT }), message(3), message(4, { author: BOT })];
		const sending = (afterSeq: number | null) => ({
			pending: [waiting("k3", "message 3", "sending", afterSeq), waiting("k5", "fifth")],
			keys: new Map<string, string>(),
			sendingKey: "k3",
		});
		const during = chatRows(messages, sending(2), ADA, ROOM);
		// The row of the send is the stored message, before the later message. It is not a second row at the end.
		expect(keysOf(during)).toEqual(["cmsg_1", "cmsg_2", "k3", "cmsg_4", "k5"]);
		expect(during[2]).toMatchObject({ pending: null, message: { id: "cmsg_3", seq: 3 } });
		// The answer of the send arrives: each row keeps its key and its position.
		const after = {
			pending: [waiting("k5", "fifth", "sending", 4)],
			keys: new Map([["cmsg_3", "k3"]]),
			sendingKey: "k5",
		};
		expect(keysOf(chatRows(messages, after, ADA, ROOM))).toEqual(["cmsg_1", "cmsg_2", "k3", "cmsg_4", "k5"]);
	});

	// A wrong pair shows a message of a different tab as the message of this send, and hides the send.
	it("shows a send at the end while the list has no message of the person with its text after the start of its call", () => {
		const messages = [
			message(1, { text: "Hello" }),
			message(2, { author: BOT, text: "Hello" }),
			message(3, { text: "Other" }),
		];
		const sending = (afterSeq: number | null) => ({
			pending: [waiting("k4", "Hello", "sending", afterSeq)],
			keys: new Map<string, string>(),
			sendingKey: "k4",
		});
		// Message 1 is from before the call, message 2 is of a different member, and message 3 has a different text.
		expect(keysOf(chatRows(messages, sending(1), ADA, ROOM))).toEqual(["cmsg_1", "cmsg_2", "cmsg_3", "k4"]);
		// The person opened a different room during the send, and came back: the list does not know the start of the call.
		expect(keysOf(chatRows(messages, sending(null), ADA, ROOM))).toEqual(["cmsg_1", "cmsg_2", "cmsg_3", "k4"]);
	});

	// "Not sent" next to the stored message tells the person to send a message that the room has.
	it("shows a failed send as its stored message when the answers of the send got lost", () => {
		const messages = [message(1), message(2, { text: "Lost answers" })];
		const lost = { ...waiting("k2", "Lost answers", "failed", 1), uncertain: true };
		const refused = { ...waiting("k2", "Lost answers", "failed", 1), uncertain: false };
		const state = (pending: typeof lost) => ({ pending: [pending], keys: new Map<string, string>(), sendingKey: null });
		expect(keysOf(chatRows(messages, state(lost), ADA, ROOM))).toEqual(["cmsg_1", "k2"]);
		// The server refused each attempt, so the message with the same text is a different message.
		expect(keysOf(chatRows(messages, state(refused), ADA, ROOM))).toEqual(["cmsg_1", "cmsg_2", "k2"]);
	});
});

describe("a failed send whose message the list has", () => {
	const failed = (key: string, text: string, afterSeq: number | null, uncertain = true) => ({
		key,
		text,
		created_at: "2026-01-01T09:10:00.000Z",
		state: "failed" as const,
		error: "No connection.",
		uncertain,
		afterSeq,
	});
	const outbox = (pending: ReturnType<typeof failed>[], keys: [string, string][] = []) => ({
		pending,
		keys: new Map(keys),
		sendingKey: null,
	});

	// The server stored the message and each answer got lost. Without the pair, the message shows two times, one time as "Not sent".
	it("is the message of the person with the same text that came after the start of the call", () => {
		const messages = [
			message(1, { text: "Hello" }),
			message(2, { author: BOT, text: "Hello" }),
			message(3, { text: "Hello" }),
		];
		expect(storedSends(messages, outbox([failed("k1", "Hello", 1)]), ADA)).toEqual([{ key: "k1", id: "cmsg_3" }]);
	});

	// A wrong pair removes a message that the server does not have.
	it("is not a message with a different text, from before the call, of a different send, or of a different member", () => {
		const messages = [
			message(1, { text: "Hello" }),
			message(2, { text: "Other" }),
			message(3, { author: BOT, text: "Hello" }),
		];
		expect(storedSends(messages, outbox([failed("k1", "Hello", 1)]), ADA)).toEqual([]);
		// The outbox sent message 4 with a different send.
		const sent = [...messages, message(4, { text: "Hello" })];
		expect(storedSends(sent, outbox([failed("k1", "Hello", 1)], [["cmsg_4", "k0"]]), ADA)).toEqual([]);
		// A refusal is an answer: the server does not have the message.
		expect(storedSends(sent, outbox([failed("k1", "Hello", 1, false)]), ADA)).toEqual([]);
		// The call started while no list showed the room.
		expect(storedSends(sent, outbox([failed("k1", "Hello", null)]), ADA)).toEqual([]);
	});

	// A person writes the text of a failed send again. A pair with the failed send removes a message that the room does not have.
	it("is the message of the send whose call runs, when that send has the text of an older failed send", () => {
		const messages = [message(1), message(2, { text: "Ping" })];
		const again = {
			key: "k2",
			text: "Ping",
			created_at: "2026-01-01T09:11:00.000Z",
			state: "sending" as const,
			error: null,
			uncertain: false,
			afterSeq: 1,
		};
		const state = { pending: [failed("k1", "Ping", 1), again], keys: new Map<string, string>(), sendingKey: "k2" };
		expect(storedSends(messages, state, ADA)).toEqual([]);
		// The stored message is the row of the new send. The failed send stays, with its actions.
		expect(
			chatRows(messages, state, ADA, "rm_01JD0000000000000000000001").map((row) => [
				row.key,
				row.pending?.state ?? "stored",
			]),
		).toEqual([
			["cmsg_1", "stored"],
			["k2", "stored"],
			["k1", "failed"],
		]);
	});

	// The list cannot know which of two sends with the same text the server has. A pair with the wrong one removes
	// a message that the room does not have.
	it("is no message for two failed sends with the same text, and one message for each of two different texts", () => {
		const messages = [message(1), message(2, { text: "Ping" }), message(3, { text: "Pong" })];
		const same = outbox([failed("k1", "Ping", 1), failed("k2", "Ping", 1)]);
		expect(storedSends(messages, same, ADA)).toEqual([]);
		// The stored message shows, and the two sends stay "Not sent".
		expect(chatRows(messages, same, ADA, "rm_01JD0000000000000000000001").map((row) => row.key)).toEqual([
			"cmsg_1",
			"cmsg_2",
			"cmsg_3",
			"k1",
			"k2",
		]);
		expect(storedSends(messages, outbox([failed("k1", "Ping", 1), failed("k2", "Pong", 1)]), ADA)).toEqual([
			{ key: "k1", id: "cmsg_2" },
			{ key: "k2", id: "cmsg_3" },
		]);
	});
});

describe("the messages with the changes that wait for the server", () => {
	const AT = "2026-01-01T10:00:00.000Z";

	// The socket brought the stored message of a send, and the person changed it before the answer of the send.
	// A match on the new text finds nothing, and the send shows a second time at the end.
	it("stay the row of their send when the person changes or deletes them before the answer of the send", () => {
		const messages = [message(1), message(2, { text: "Hello" })];
		const sending = {
			pending: [
				{
					key: "k2",
					text: "Hello",
					created_at: "2026-01-01T09:10:00.000Z",
					state: "sending" as const,
					error: null,
					uncertain: false,
					afterSeq: 1,
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
		afterSeq: null,
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
