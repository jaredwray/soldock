import { ApiError, type ChatMessage } from "@soldock/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOutbox, RETRY_WAITS_MS } from "../src/features/chat/outbox.ts";

interface Call {
	text: string;
	key: string;
	succeed(): Promise<void>;
	fail(error: unknown): Promise<void>;
}

/** A room that answers each post when the test says so. */
function fakeRoom() {
	const calls: Call[] = [];
	const sent: ChatMessage[] = [];
	const view = { lastSeq: 10 as number | null };
	const page = { account: "ada" };
	let seq = 0;
	const outbox = createOutbox({
		active: () => page.account === "ada",
		post: (text, key) =>
			new Promise<ChatMessage>((resolve, reject) => {
				// The answers go through the promise, as the answers of fetch do.
				const settle = async () => {
					await Promise.resolve();
					await Promise.resolve();
				};
				calls.push({
					text,
					key,
					succeed() {
						seq += 1;
						resolve({
							id: `cmsg_${seq}`,
							room_id: "rm_01JD0000000000000000000001",
							seq,
							author: { principal_id: "prn_01JD0000000000000000000ADA", kind: "human", display_name: "Ada Lovelace" },
							text,
							created_at: "2026-01-01T09:00:00.000Z",
							edited_at: null,
							deleted: false,
							version: seq,
						});
						return settle();
					},
					fail(error) {
						reject(error);
						return settle();
					},
				});
			}),
		describe: (error) => (error instanceof ApiError ? error.message : "No connection."),
	});
	outbox.attach({ deliver: (message) => void sent.push(message), lastSeq: () => view.lastSeq });
	const pending = () => outbox.getState().pending.map((message) => [message.text, message.state]);
	return { outbox, calls, sent, pending, view, page };
}

const refusal = (status: number, code: string, detail: string) => new ApiError(status, { code, detail });

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("the outbox of a room", () => {
	// The room must have the messages in the order in which the person wrote them.
	it("shows each message at once, and sends one at a time in the order of the sends", async () => {
		const room = fakeRoom();
		room.outbox.send("First");
		room.outbox.send("Second");
		expect(room.pending()).toEqual([
			["First", "sending"],
			["Second", "waiting"],
		]);
		expect(room.calls.map((call) => call.text)).toEqual(["First"]);

		await room.calls[0]?.succeed();
		expect(room.pending()).toEqual([["Second", "sending"]]);
		expect(room.calls.map((call) => call.text)).toEqual(["First", "Second"]);
		await room.calls[1]?.succeed();
		expect(room.pending()).toEqual([]);
		expect(room.sent.map((message) => message.text)).toEqual(["First", "Second"]);
		// The stored message has the key of its send, so its row stays the same row.
		const keys = room.outbox.getState().keys;
		expect([keys.get("cmsg_1"), keys.get("cmsg_2")]).toEqual([room.calls[0]?.key, room.calls[1]?.key]);
		expect(room.calls[0]?.key).not.toBe(room.calls[1]?.key);
	});

	// An answer can get lost after the server stored the message. A new key would make a second message.
	it("tries again with the same key after a failure that can go away", async () => {
		const room = fakeRoom();
		room.outbox.send("Hello");
		await room.calls[0]?.fail(new TypeError("fetch failed"));
		expect(room.pending()).toEqual([["Hello", "sending"]]);
		expect(room.calls).toHaveLength(1);
		vi.advanceTimersByTime(RETRY_WAITS_MS[0] as number);
		expect(room.calls).toHaveLength(2);
		// The room refuses a message above its rate limit, and takes it a moment later.
		await room.calls[1]?.fail(refusal(429, "rate_limited", "Try again in 1 second."));
		vi.advanceTimersByTime(RETRY_WAITS_MS[1] as number);
		expect(room.calls.map((call) => call.key)).toEqual([room.calls[0]?.key, room.calls[0]?.key, room.calls[0]?.key]);
		await room.calls[2]?.succeed();
		expect(room.pending()).toEqual([]);
		expect(room.sent.map((message) => message.text)).toEqual(["Hello"]);
	});

	it("marks a message as failed after the last attempt, sends the next message, and sends the failed one again on request", async () => {
		const room = fakeRoom();
		room.outbox.send("Offline");
		room.outbox.send("Next");
		for (const wait of RETRY_WAITS_MS) {
			await room.calls[room.calls.length - 1]?.fail(new TypeError("fetch failed"));
			vi.advanceTimersByTime(wait);
		}
		await room.calls[room.calls.length - 1]?.fail(new TypeError("fetch failed"));
		expect(room.calls).toHaveLength(RETRY_WAITS_MS.length + 2);
		// The answers did not arrive, so the server can have the message.
		expect(room.outbox.getState().pending).toMatchObject([
			{ text: "Offline", state: "failed", error: "No connection.", uncertain: true },
			{ text: "Next", state: "sending", error: null },
		]);
		await room.calls[room.calls.length - 1]?.succeed();

		const key = room.outbox.getState().pending[0]?.key as string;
		room.outbox.retry(key);
		expect(room.pending()).toEqual([["Offline", "sending"]]);
		expect(room.calls[room.calls.length - 1]?.key).toBe(key);
		await room.calls[room.calls.length - 1]?.succeed();
		expect(room.sent.map((message) => message.text)).toEqual(["Next", "Offline"]);
	});

	// More attempts cannot help a person that the room removed, or a text that the room refuses.
	it("marks a message as failed at once after a final refusal, and removes it on request", async () => {
		const room = fakeRoom();
		room.outbox.send("To a room that removed me");
		const key = room.outbox.getState().pending[0]?.key as string;
		// The message whose call runs stays: its answer can still arrive.
		room.outbox.discard(key);
		expect(room.pending()).toEqual([["To a room that removed me", "sending"]]);

		await room.calls[0]?.fail(refusal(403, "forbidden", "You are not a member of this room."));
		vi.advanceTimersByTime(60_000);
		expect(room.calls).toHaveLength(1);
		// A refusal is an answer: the server does not have the message.
		expect(room.outbox.getState().pending).toMatchObject([
			{ state: "failed", error: "You are not a member of this room.", uncertain: false },
		]);
		room.outbox.discard(key);
		expect(room.pending()).toEqual([]);
		expect(room.sent).toEqual([]);
	});

	it("tells its listeners about each change, and gives a stored message to nobody while no list shows the room", async () => {
		const room = fakeRoom();
		let changes = 0;
		const remove = room.outbox.subscribe(() => {
			changes += 1;
		});
		room.outbox.attach(null);
		room.outbox.send("Sent from a room that the person left");
		// No list showed the room at the start of the call, so the call has no limit for the stored message.
		expect(room.outbox.getState().pending[0]?.afterSeq).toBeNull();
		expect(changes).toBeGreaterThan(0);
		await room.calls[0]?.succeed();
		expect(room.sent).toEqual([]);
		expect(room.pending()).toEqual([]);
		remove();
		const before = changes;
		room.outbox.send("After the list went away");
		expect(changes).toBe(before);
	});

	// The list leaves out the stored message of a call until the call ends. It needs the last message at the start of the call.
	it("records the last message of the list at the start of each call", async () => {
		const room = fakeRoom();
		room.outbox.send("First");
		room.outbox.send("Second");
		expect(room.outbox.getState().pending.map((message) => message.afterSeq)).toEqual([10, null]);
		// The list got more messages before the second call starts.
		room.view.lastSeq = 14;
		await room.calls[0]?.succeed();
		expect(room.outbox.getState().pending.map((message) => message.afterSeq)).toEqual([14]);
	});

	// The server stored the message, and each answer got lost. The list has the message, so the send did not fail.
	it("takes a failed message as sent when the list has its stored message", async () => {
		const room = fakeRoom();
		room.outbox.send("Stored, with lost answers");
		const key = room.outbox.getState().pending[0]?.key as string;
		// A message whose call runs cannot settle: its answer gives the stored message.
		room.outbox.settle(key, "cmsg_77");
		expect(room.pending()).toEqual([["Stored, with lost answers", "sending"]]);
		for (const wait of [...RETRY_WAITS_MS, 0]) {
			await room.calls[room.calls.length - 1]?.fail(new TypeError("fetch failed"));
			vi.advanceTimersByTime(wait);
		}
		expect(room.pending()).toEqual([["Stored, with lost answers", "failed"]]);
		room.outbox.settle(key, "cmsg_77");
		expect(room.pending()).toEqual([]);
		expect(room.outbox.getState().keys.get("cmsg_77")).toBe(key);
	});

	// The page sends each call with the session of its person. A message of the person from before must not go out.
	it("sends nothing after the person of the page changes, and nothing after a stop", async () => {
		const room = fakeRoom();
		room.outbox.send("From Ada");
		room.outbox.send("Also from Ada");
		await room.calls[0]?.fail(new TypeError("fetch failed"));
		// Ada signs out during the wait, and a different person signs in.
		room.page.account = "bob";
		vi.advanceTimersByTime(RETRY_WAITS_MS[0] as number);
		expect(room.calls).toHaveLength(1);
		expect(room.pending()).toEqual([]);
		room.outbox.send("Too late");
		expect(room.calls).toHaveLength(1);
		expect(room.pending()).toEqual([]);

		const stopped = fakeRoom();
		stopped.outbox.send("In flight at the sign-out");
		stopped.outbox.stop();
		// The answer of the call that ran arrives: the list of the new person gets nothing.
		await stopped.calls[0]?.succeed();
		vi.advanceTimersByTime(60_000);
		expect(stopped.sent).toEqual([]);
		expect(stopped.pending()).toEqual([]);
		expect(stopped.calls).toHaveLength(1);
	});

	// The server stored the message, the answer got lost, and the room then removed the person. The refusal of
	// the next attempt says nothing about the first attempt.
	it("keeps a failed message uncertain when an earlier answer got lost, also after a refusal and a new send", async () => {
		const room = fakeRoom();
		room.outbox.send("Stored before the room removed me");
		await room.calls[0]?.fail(new TypeError("fetch failed"));
		vi.advanceTimersByTime(RETRY_WAITS_MS[0] as number);
		await room.calls[1]?.fail(refusal(403, "forbidden", "You are not a member of this room."));
		expect(room.outbox.getState().pending).toMatchObject([{ state: "failed", uncertain: true, afterSeq: 10 }]);

		// The person sends it again. The send keeps the start of its first call, where its message can be.
		room.view.lastSeq = 30;
		room.outbox.retry(room.outbox.getState().pending[0]?.key as string);
		expect(room.outbox.getState().pending).toMatchObject([{ state: "sending", uncertain: true, afterSeq: 10 }]);
		await room.calls[2]?.fail(refusal(403, "forbidden", "You are not a member of this room."));
		expect(room.outbox.getState().pending).toMatchObject([{ state: "failed", uncertain: true, afterSeq: 10 }]);
	});
});
