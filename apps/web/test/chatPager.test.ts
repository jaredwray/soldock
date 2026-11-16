import type { ChatMessage } from "@soldock/contracts";
import { describe, expect, it } from "vitest";
import { createRoomPager, type PagerState } from "../src/features/chat/pager.ts";
import { type ChangePage, createRoomSync } from "../src/features/chat/sync.ts";

const PAGE = 50;

/** A room with the messages 1 to `count`, as `chat.list_messages` reads it. */
function fakeRoom(count: number) {
	const messages: ChatMessage[] = [];
	let version = 0;
	const add = (): ChatMessage => {
		version += 1;
		const message: ChatMessage = {
			id: `cmsg_${messages.length + 1}`,
			room_id: "rm_01JD0000000000000000000001",
			seq: messages.length + 1,
			author: { principal_id: "prn_01JD0000000000000000000ADA", kind: "human", display_name: "Ada Lovelace" },
			text: `message ${messages.length + 1}`,
			created_at: "2026-01-01T09:00:00.000Z",
			edited_at: null,
			deleted: false,
			version,
			idempotency_key: null,
		};
		messages.push(message);
		return message;
	};
	for (let i = 0; i < count; i++) add();
	return {
		post: add,
		edit(seq: number, text: string): ChatMessage {
			version += 1;
			const edited = { ...(messages[seq - 1] as ChatMessage), text, version };
			messages[seq - 1] = edited;
			return edited;
		},
		list(range: { before?: number; after?: number; changedAfter?: number }): ChangePage {
			let rows: ChatMessage[];
			if (range.changedAfter !== undefined) {
				const after = range.changedAfter;
				rows = messages.filter((message) => message.version > after).sort((a, b) => a.version - b.version);
			} else if (range.after !== undefined) {
				rows = messages.slice(range.after);
			} else {
				rows = messages.slice(0, (range.before ?? messages.length + 1) - 1).reverse();
			}
			const page = rows.slice(0, PAGE);
			if (range.changedAfter === undefined && range.after === undefined) page.reverse();
			return { messages: page, version, has_more: rows.length > PAGE };
		},
	};
}

/**
 * The pager and the sync of a page that shows `room`. The room answers a read with its state at the
 * time of the call. With `hold()`, the answers wait, and `answer()` gives the oldest one to the page.
 * With `hold(true)`, the room reads its state when the answer goes to the page, as a slow server does.
 */
function openRoom(room: ReturnType<typeof fakeRoom>) {
	let state: PagerState = { messages: [], hasOlder: false, hasNewer: false, paging: null };
	const waiting: (() => void)[] = [];
	let held = false;
	let late = false;
	const answered = <T>(read: () => T): Promise<T> => {
		if (!held) return Promise.resolve(read());
		if (late) return new Promise((resolve) => waiting.push(() => resolve(read())));
		const result = read();
		return new Promise((resolve) => waiting.push(() => resolve(result)));
	};
	const sync = createRoomSync(
		(changedAfter) => answered(() => room.list({ changedAfter })),
		(changes) => pager.apply(changes),
	);
	const pager = createRoomPager({
		read: (range) => answered(() => room.list(range)),
		sync,
		state: () => state,
		update: (change) => {
			state = change(state);
		},
		alive: () => true,
	});
	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
	return {
		pager,
		sync,
		state: () => state,
		seqs: () => state.messages.map((message) => message.seq),
		/** Loads the newest messages, as the load of a room does. */
		async load() {
			state = pager.replace(room.list({}));
			await sync.run();
		},
		hold(readLate = false) {
			held = true;
			late = readLate;
		},
		async answer() {
			waiting.shift()?.();
			await settle();
		},
		/** Gives each answer that waits, and each answer of a read that starts from them, to the page. */
		async answerAll() {
			held = false;
			late = false;
			while (waiting.length > 0) waiting.shift()?.();
			await settle();
		},
	};
}

describe("the page reads of an open room", () => {
	it("read the history in pages to its start, and put the newest messages out of a full list", async () => {
		const page = openRoom(fakeRoom(420));
		await page.load();
		expect(page.seqs()).toEqual(Array.from({ length: 50 }, (_, index) => 371 + index));
		for (let i = 0; i < 5; i++) await page.pager.readPage("older");
		expect([page.seqs()[0], page.seqs().length, page.state().hasNewer]).toEqual([121, 300, false]);
		await page.pager.readPage("older");
		expect([page.seqs()[0], page.seqs()[299], page.seqs().length]).toEqual([71, 370, 300]);
		expect(page.state()).toMatchObject({ hasOlder: true, hasNewer: true, paging: null });
		await page.pager.readPage("newer");
		expect([page.seqs()[0], page.seqs()[299], page.state().hasNewer]).toEqual([121, 420, false]);
	});

	// The room changes message 360 during the read of the page that has it. The socket brings the
	// change first: the list does not have the message then, and drops the change.
	it("show the newest text of a message that changed during the read of its page", async () => {
		const room = fakeRoom(420);
		const page = openRoom(room);
		await page.load();
		page.hold();
		const read = page.pager.readPage("older");
		expect(page.state().paging).toBe("older");
		page.sync.push(room.edit(360, "changed"));
		await page.answerAll();
		await read;
		expect(page.state().messages.find((message) => message.seq === 360)?.text).toBe("changed");
		expect(page.state().paging).toBeNull();
	});

	// The last page of newer messages tells that the list has the end of the room. A message that came
	// during the read is not in the page, and the list dropped it from the socket.
	it("have each message of the room after the last page of newer messages", async () => {
		const room = fakeRoom(420);
		const page = openRoom(room);
		await page.load();
		for (let i = 0; i < 6; i++) await page.pager.readPage("older");
		expect(page.state().hasNewer).toBe(true);
		page.hold();
		const read = page.pager.readPage("newer");
		page.sync.push(room.post());
		expect(page.seqs()).not.toContain(421);
		await page.answerAll();
		await read;
		expect(page.state().hasNewer).toBe(false);
		expect(page.seqs().slice(-2)).toEqual([420, 421]);
	});

	it("drop a page that arrives after the list went to the newest messages", async () => {
		const page = openRoom(fakeRoom(420));
		await page.load();
		for (let i = 0; i < 6; i++) await page.pager.readPage("older");
		page.hold();
		const read = page.pager.readPage("older");
		const latest = page.pager.toLatest();
		// The answer of the page read is the first one. The list still has the old part of the history.
		await page.answer();
		await page.answerAll();
		await read;
		expect(await latest).toBe(true);
		expect([page.seqs()[0], page.seqs().length]).toEqual([371, 50]);
		expect(page.state()).toMatchObject({ hasOlder: true, hasNewer: false, paging: null });
	});

	// Two reads of the newest messages run. The caller of the first one must know that it did not apply.
	it("tell when a read of the newest messages did not apply", async () => {
		const page = openRoom(fakeRoom(120));
		await page.load();
		page.hold();
		const first = page.pager.toLatest();
		const second = page.pager.toLatest();
		await page.answerAll();
		expect([await first, await second]).toEqual([false, true]);
	});

	// A link to one message: the list has the message, the messages before it and the messages after it.
	it("put the list at one message, with the page before it and the page after it", async () => {
		const room = fakeRoom(420);
		const page = openRoom(room);
		await page.load();
		expect(await page.pager.toMessage(200)).toBe(true);
		expect([page.seqs()[0], page.seqs()[49], page.seqs()[50], page.seqs()[99], page.seqs().length]).toEqual([
			151, 200, 201, 250, 100,
		]);
		expect(page.state()).toMatchObject({ hasOlder: true, hasNewer: true, paging: null });
		// The list is a part of the history as each other one: it gets the changes of its messages,
		// and its page reads continue from its ends.
		page.sync.push(room.edit(200, "changed"));
		expect(page.state().messages.find((message) => message.seq === 200)?.text).toBe("changed");
		await page.pager.readPage("newer");
		expect([page.seqs()[0], page.seqs().at(-1)]).toEqual([151, 300]);
	});

	it("put the list at the newest messages when the room does not have the message of a link", async () => {
		const page = openRoom(fakeRoom(120));
		await page.load();
		expect(await page.pager.toMessage(5000)).toBe(true);
		expect([page.seqs()[0], page.seqs().at(-1)]).toEqual([71, 120]);
		expect(page.state()).toMatchObject({ hasOlder: true, hasNewer: false });
	});

	// The two reads of a link can be at different versions of the room. A change between them must
	// not stay out of the list.
	it("start the sync at the older version of the two reads of a link", async () => {
		const room = fakeRoom(420);
		const page = openRoom(room);
		await page.load();
		page.hold(true);
		const going = page.pager.toMessage(200);
		// The room reads the first page. Then a message of that page changes, and the room reads the
		// second page at the new version.
		await page.answer();
		room.edit(180, "changed between the reads");
		await page.answerAll();
		expect(await going).toBe(true);
		expect(page.state().messages.find((message) => message.seq === 180)?.text).toBe("changed between the reads");
	});

	// The person opens a link, and goes to a different place before the answer. The answer must not
	// move the list to the message of the link.
	it("do not put the list at a message after the read was cancelled", async () => {
		const page = openRoom(fakeRoom(420));
		await page.load();
		page.hold();
		const going = page.pager.toMessage(200);
		page.pager.cancel();
		await page.answerAll();
		expect(await going).toBe(false);
		expect([page.seqs()[0], page.seqs().at(-1)]).toEqual([371, 420]);
	});

	it("keep the messages that the person reads in a full list, and take new messages again at its end", async () => {
		const room = fakeRoom(420);
		const page = openRoom(room);
		await page.load();
		for (let i = 0; i < 5; i++) await page.pager.readPage("older");
		page.pager.follow(false);
		page.sync.push(room.post());
		expect([page.seqs()[0], page.seqs().length, page.state().hasNewer]).toEqual([121, 300, true]);
		expect(await page.pager.toLatest()).toBe(true);
		page.pager.follow(true);
		page.sync.push(room.post());
		expect(page.seqs().slice(-2)).toEqual([421, 422]);
	});
});
