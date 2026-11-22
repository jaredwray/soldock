import type { ChatMessage, ChatThreadFollow } from "@asterra/contracts";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
	createFollowKeeper,
	createThreadView,
	firstUnread,
	mergeThread,
	type RepliesPage,
	replyAttempt,
	THREAD_POLL_MS,
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
		files: [],
		link_previews: [],
		pinned: false,
		untrusted: false,
		forwarded: null,
		cards: [],
	};
}

const parent = message(1, 1, null, "plan");
const start: ThreadState = { parent, replies: [message(3, 3, "cmsg_1")], version: 3, hasOlder: false };

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
		// With older replies that do not show, a reply before the first one would make a gap: it waits for its page.
		const newestOnly = { ...start, hasOlder: true };
		expect(mergeThread(newestOnly, [message(2, 5, "cmsg_1", "older reply")])).toBe(newestOnly);
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
	// A thread of many replies must show its newest replies after one request. A reply can come on the socket
	// while that read runs, and must show after the load.
	it("reads the newest page in one request, keeps a change of the socket during the load, and reads the changes after the version of the page", async () => {
		const calls: unknown[] = [];
		let release: (value: RepliesPage) => void = () => {};
		const read = (range: { newest?: "true"; before?: number; changed_after?: number }) => {
			calls.push(range);
			if (calls.length === 1) return new Promise<RepliesPage>((resolve) => (release = resolve));
			return Promise.resolve(page([message(5, 11, "cmsg_1", "changed during the load")], 12));
		};
		const view = createThreadView(read, () => {});
		const loading = view.load();
		view.receive(message(6, 13, "cmsg_1", "from the socket"));
		release(page([message(5, 8, "cmsg_1", "newest page")], 10, true));
		await loading;
		expect(calls).toEqual([{ newest: "true" }, { changed_after: 10 }]);
		expect(view.current()?.replies.map((reply) => reply.text)).toEqual(["changed during the load", "from the socket"]);
		expect(view.current()?.version).toBe(12);
		expect(view.current()?.hasOlder).toBe(true);
	});

	// An older page can be at a version before a change that the socket brought during its read. The old copy
	// of the page must not replace the newer copy.
	it("reads the page before the first reply, and keeps a newer copy that came during the read", async () => {
		let release: (value: RepliesPage) => void = () => {};
		const calls: unknown[] = [];
		const read = (range: { newest?: "true"; before?: number; changed_after?: number }) => {
			calls.push(range);
			if (range.newest) return Promise.resolve(page([message(5, 5, "cmsg_1", "newest")], 5, true));
			if (range.before) return new Promise<RepliesPage>((resolve) => (release = resolve));
			return Promise.resolve(page([], 5));
		};
		const view = createThreadView(read, () => {});
		await view.load();
		const loading = view.loadOlder();
		// A second call while the read runs adds no read.
		void view.loadOlder();
		view.receive(message(2, 7, "cmsg_1", "older, changed"));
		release(page([message(2, 4, "cmsg_1", "older"), message(3, 3, "cmsg_1", "middle")], 6, false));
		await loading;
		expect(calls).toEqual([{ newest: "true" }, { changed_after: 5 }, { before: 5 }]);
		expect(view.current()?.replies.map((reply) => reply.text)).toEqual(["older, changed", "middle", "newest"]);
		expect(view.current()?.hasOlder).toBe(false);
		// With no older replies, nothing more is read.
		await view.loadOlder();
		expect(calls).toHaveLength(3);
	});

	// A change of a reply before the page that a read brings must not go in: the next read would start
	// from that reply, and skip the replies between it and the page.
	it("keeps a change of a reply before the older page out, and reads the next page from the first reply of the page", async () => {
		let release: (value: RepliesPage) => void = () => {};
		const calls: unknown[] = [];
		const read = (range: { newest?: "true"; before?: number; changed_after?: number }) => {
			calls.push(range);
			if (range.newest) return Promise.resolve(page([message(9, 9, "cmsg_1", "newest")], 9, true));
			if (range.before === 9) return new Promise<RepliesPage>((resolve) => (release = resolve));
			if (range.before) return Promise.resolve(page([message(2, 2, "cmsg_1", "oldest")], 9, false));
			return Promise.resolve(page([], 9));
		};
		const view = createThreadView(read, () => {});
		await view.load();
		const loading = view.loadOlder();
		view.receive(message(2, 10, "cmsg_1", "oldest, changed"));
		release(page([message(5, 5, "cmsg_1", "middle")], 9, true));
		await loading;
		expect(view.current()?.replies.map((reply) => reply.text)).toEqual(["middle", "newest"]);
		expect(view.current()?.hasOlder).toBe(true);
		await view.loadOlder();
		expect(calls.at(-1)).toEqual({ before: 5 });
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
			page([], 8),
			page([], 8),
		];
		const calls: unknown[] = [];
		const read = async (range: { newest?: "true"; before?: number; changed_after?: number }) => {
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
		// A catch-up with no version (a new connect of the socket) always reads.
		view.catchUp();
		await vi.waitFor(() => expect(calls).toHaveLength(7));
		// A room list that does not have the room (null) reads at most one time in THREAD_POLL_MS.
		view.catchUp(null);
		await vi.waitFor(() => expect(calls).toHaveLength(8));
		await new Promise((resolve) => setTimeout(resolve, 0));
		view.catchUp(null);
		expect(calls).toHaveLength(8);
		vi.setSystemTime(Date.now() + THREAD_POLL_MS);
		view.catchUp(null);
		expect(calls).toHaveLength(9);
		expect(calls.slice(2)).toEqual([
			{ changed_after: 5 },
			{ changed_after: 6 },
			{ changed_after: 6 },
			{ changed_after: 7 },
			{ changed_after: 8 },
			{ changed_after: 8 },
			{ changed_after: 8 },
		]);
		expect(view.current()?.replies.map((reply) => reply.text)).toEqual(["one", "two"]);
	});
});

describe("the first new reply", () => {
	// The "New" line and the read marker of the view must follow the unread count of the server.
	it("is the first reply after the marker that stays and that a different principal wrote", () => {
		const own = { principal_id: "prn_01JD0000000000000000000OWN", kind: "human" as const, display_name: "Me" };
		const replies = [
			message(2, 2, "cmsg_1", "read"),
			{ ...message(3, 3, "cmsg_1", "mine"), author: own },
			{ ...message(4, 4, "cmsg_1", "gone"), deleted: true },
			message(5, 5, "cmsg_1", "new"),
		];
		expect(firstUnread(replies, 2, own.principal_id)).toBe(5);
		expect(firstUnread(replies, 5, own.principal_id)).toBeNull();
		// With no marker, each reply of a different principal is new.
		expect(firstUnread(replies, 0, own.principal_id)).toBe(2);
	});
});

describe("the state of a thread for a person", () => {
	// A read of the marker and a click of Follow can overlap, and the server can answer them in a different
	// order. The button must show the follow of the click, and the marker the newest marker.
	it("keeps an own change of each part when an older answer comes after it", () => {
		const shown: ChatThreadFollow[] = [];
		const keeper = createFollowKeeper((follow) => shown.push(follow));
		keeper.apply(keeper.ticket(), { following: false, last_read_seq: 0, unread_count: 2 });
		const read = keeper.ticket();
		// The person clicks Follow. A new reply starts a call of the marker during that call.
		const follow = keeper.begin("following");
		const mark = keeper.begin("marker");
		keeper.finish(follow, "following", { following: true, last_read_seq: 0, unread_count: 2 });
		// The server did the marker before the follow, so its answer has the follow from before the click.
		keeper.finish(mark, "marker", { following: false, last_read_seq: 5, unread_count: 0 });
		expect(keeper.current()).toEqual({ following: true, last_read_seq: 5, unread_count: 0 });
		// A read that started before the two calls shows neither part.
		keeper.apply(read, { following: false, last_read_seq: 0, unread_count: 2 });
		expect(keeper.current()).toEqual({ following: true, last_read_seq: 5, unread_count: 0 });
		// A read that starts now shows both parts. An own reply changes both.
		keeper.apply(keeper.ticket(), { following: true, last_read_seq: 6, unread_count: 0 });
		// An own reply during a marker call moves the marker past the answer of the call.
		const late = keeper.begin("marker");
		keeper.local((current) => ({ ...current, last_read_seq: 9 }));
		// The server order of the two is not known, so the keeper asks for a new read.
		expect(keeper.finish(late, "marker", { following: true, last_read_seq: 7, unread_count: 0 })).toBe(true);
		expect(shown.at(-1)).toEqual({ following: true, last_read_seq: 9, unread_count: 0 });
		keeper.apply(keeper.ticket(), { following: true, last_read_seq: 7, unread_count: 0 });
		expect(keeper.current()?.last_read_seq).toBe(7);
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
