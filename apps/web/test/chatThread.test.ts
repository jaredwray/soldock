import type { ChatMessage } from "@soldock/contracts";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
	createThreadView,
	mergeThread,
	type RepliesPage,
	replyAttempt,
	THREAD_RETRY_MS,
	type ThreadState,
} from "../src/features/chat/thread.ts";

function message(seq: number, version: number, parentId: string | null, text = `message ${seq}`): ChatMessage {
	return {
		id: `cmsg_${seq}`,
		room_id: "rm_01JD0000000000000000000001",
		seq,
		author: { principal_id: "prn_01JD0000000000000000000ADA", kind: "human", display_name: "Ada Lovelace" },
		text,
		created_at: "2026-01-01T09:00:00.000Z",
		edited_at: null,
		deleted: false,
		version,
		idempotency_key: null,
		reactions: [],
		mentions: [],
		group_mentions: [],
		parent_id: parentId,
		also_in_room: false,
		thread: null,
	};
}

const parent = message(1, 1, null, "plan");
const start: ThreadState = { parent, replies: [message(3, 3, "cmsg_1")], version: 3 };

describe("the view of a thread", () => {
	// The socket and a read can bring the same message, in each order. The view must show each reply one
	// time, in its place, with its newest copy.
	it("takes the newer copy of the parent and of each reply, in the order of the seq, and nothing of other threads", () => {
		const merged = mergeThread(start, [
			message(2, 5, "cmsg_1", "earlier reply"),
			message(3, 6, "cmsg_1", "changed reply"),
			{ ...parent, version: 4, text: "plan, changed" },
			message(9, 7, "cmsg_8", "a different thread"),
			message(10, 8, null, "a message of the room"),
		]);
		expect(merged.parent.text).toBe("plan, changed");
		expect(merged.replies.map((reply) => [reply.seq, reply.text])).toEqual([
			[2, "earlier reply"],
			[3, "changed reply"],
		]);
		// An older copy changes nothing, so the same state comes back.
		expect(mergeThread(merged, [message(3, 3, "cmsg_1"), { ...parent, version: 2 }])).toBe(merged);
		// The read of a catch-up keeps the version of the thread: the panel sets it.
		expect(merged.version).toBe(3);
	});
});

/** A page of replies of the parent above. */
const page = (replies: ChatMessage[], version: number, has_more = false): RepliesPage => ({
	parent,
	replies,
	version,
	has_more,
});

describe("the data of the view of a thread", () => {
	// A reply can come on the socket while the first read runs. It must show after the load.
	it("keeps a change of the socket during the load, and reads the changes after the version of the first page", async () => {
		const calls: unknown[] = [];
		let release: (value: RepliesPage) => void = () => {};
		const read = (range: { after?: number; changed_after?: number }) => {
			calls.push(range);
			if (calls.length === 1) return new Promise<RepliesPage>((resolve) => (release = resolve));
			if (calls.length === 2) return Promise.resolve(page([message(3, 9, "cmsg_1", "second page")], 9));
			return Promise.resolve(page([message(2, 11, "cmsg_1", "changed during the load")], 12));
		};
		const shown: ThreadState[] = [];
		const view = createThreadView(read, (thread) => shown.push(thread));
		const loading = view.load();
		view.receive(message(4, 13, "cmsg_1", "from the socket"));
		release(page([message(2, 8, "cmsg_1", "first page")], 10, true));
		await loading;
		expect(calls).toEqual([{}, { after: 2 }, { changed_after: 10 }]);
		expect(view.current()?.replies.map((reply) => reply.text)).toEqual([
			"changed during the load",
			"second page",
			"from the socket",
		]);
		expect(view.current()?.version).toBe(12);
	});

	// After a gap with no socket, the view must get each change of the gap, also in pages. A room list after
	// a change of a different room must not read the thread, and must not repeat a failed read at once.
	it("reads the changes of a gap after a catch-up from the version of the last reply of each page, and again after a failure and a wait", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		onTestFinished(() => {
			vi.useRealTimers();
		});
		const pages: (RepliesPage | Error)[] = [
			page([], 5),
			page([], 5),
			page([message(2, 6, "cmsg_1", "one")], 6),
			new Error("offline"),
			page([message(3, 7, "cmsg_1", "two")], 7, true),
			page([], 8),
			page([], 8),
		];
		const calls: unknown[] = [];
		const read = async (range: { after?: number; changed_after?: number }) => {
			calls.push(range);
			const next = pages.shift();
			if (!next || next instanceof Error) throw next ?? new Error("no page");
			return next;
		};
		const view = createThreadView(read, () => {});
		await view.load();
		// The room is not after the thread, so the catch-up of a room list reads nothing.
		view.catchUp(5);
		expect(calls).toHaveLength(2);
		// A second room list during the read, after a change of a different room, adds no read.
		view.catchUp(6);
		view.catchUp(6);
		await vi.waitFor(() => expect(view.current()?.version).toBe(6));
		view.catchUp(7);
		await vi.waitFor(() => expect(calls).toHaveLength(4));
		// After the failure, a room list for a room version that the view has waits before it reads again.
		view.catchUp(6);
		expect(calls).toHaveLength(4);
		// The failed read kept the version, so the catch-up after the wait asks for the same changes.
		vi.setSystemTime(Date.now() + THREAD_RETRY_MS);
		view.catchUp(6);
		await vi.waitFor(() => expect(view.current()?.version).toBe(8));
		// A catch-up with no version (a new connect of the socket, or a room that is not in the list) always reads.
		view.catchUp();
		await vi.waitFor(() => expect(calls).toHaveLength(7));
		expect(calls.slice(2)).toEqual([
			{ changed_after: 5 },
			{ changed_after: 6 },
			{ changed_after: 6 },
			{ changed_after: 7 },
			{ changed_after: 8 },
		]);
		expect(view.current()?.replies.map((reply) => reply.text)).toEqual(["one", "two"]);
	});
});

describe("the idempotency key of a reply", () => {
	// A lost answer and a second send must post one reply. A changed reply must not get conflict forever.
	it("keeps the key for a second send of the same reply, and takes a new key for a changed reply", () => {
		let count = 0;
		const newKey = () => `key-${++count}`;
		const first = replyAttempt(null, '{"text":"hi"}', newKey);
		expect(replyAttempt(first, '{"text":"hi"}', newKey)).toEqual({ key: "key-1", request: '{"text":"hi"}' });
		expect(replyAttempt(first, '{"text":"hi there"}', newKey)).toEqual({
			key: "key-2",
			request: '{"text":"hi there"}',
		});
	});
});
