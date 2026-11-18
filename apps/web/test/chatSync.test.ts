import type { ChatMessage } from "@soldock/contracts";
import { describe, expect, it } from "vitest";
import { type ChangePage, createRoomSync } from "../src/features/chat/sync.ts";

function message(seq: number, version: number): ChatMessage {
	return {
		id: `cmsg_${seq}`,
		room_id: "rm_01JD0000000000000000000001",
		seq,
		author: { principal_id: "prn_01JD0000000000000000000ADA", kind: "human", display_name: "Ada Lovelace" },
		text: `message ${seq}`,
		created_at: "2026-01-01T09:00:00.000Z",
		edited_at: null,
		deleted: false,
		version,
		idempotency_key: null,
		reactions: [],
		mentions: [],
		group_mentions: [],
	};
}

/** A room with changes at versions 1 to `changes.length`, read in pages of `pageSize`. */
function fakeRoom(changes: ChatMessage[], pageSize = 50) {
	const calls: number[] = [];
	const state = { fail: false };
	const read = async (changedAfter: number): Promise<ChangePage> => {
		calls.push(changedAfter);
		if (state.fail) throw new TypeError("offline");
		const after = changes.filter((change) => change.version > changedAfter);
		return {
			messages: after.slice(0, pageSize),
			version: changes[changes.length - 1]?.version ?? 0,
			has_more: after.length > pageSize,
		};
	};
	return { read, calls, state };
}

describe("the sync of an open room", () => {
	it("gets the changes only when the room list has a higher version", async () => {
		const room = fakeRoom([message(1, 1), message(2, 2), message(3, 3)]);
		const applied: number[] = [];
		const sync = createRoomSync(room.read, (messages) => applied.push(...messages.map((entry) => entry.seq)));
		sync.start(2);
		await sync.notice(2);
		expect(room.calls).toEqual([]);
		await sync.notice(3);
		expect(room.calls).toEqual([2]);
		expect(applied).toEqual([3]);
		await sync.notice(3);
		expect(room.calls).toEqual([2]);
	});

	// The room list has the same version on each poll after a failure. The sync must still run again.
	it("runs again on the next room list after a read that failed", async () => {
		const room = fakeRoom([message(1, 1), message(2, 2)]);
		const applied: number[] = [];
		const sync = createRoomSync(room.read, (messages) => applied.push(...messages.map((entry) => entry.seq)));
		sync.start(1);
		room.state.fail = true;
		await sync.notice(2);
		expect(applied).toEqual([]);
		room.state.fail = false;
		await sync.notice(2);
		expect(room.calls).toEqual([1, 1]);
		expect(applied).toEqual([2]);
	});

	it("continues a long list of changes from the version of the last message of each page", async () => {
		const room = fakeRoom([message(1, 1), message(2, 2), message(3, 3), message(4, 4), message(5, 5)], 2);
		const applied: number[] = [];
		const sync = createRoomSync(room.read, (messages) => applied.push(...messages.map((entry) => entry.seq)));
		sync.start(0);
		await sync.notice(5);
		expect(room.calls).toEqual([0, 2, 4]);
		expect(applied).toEqual([1, 2, 3, 4, 5]);
	});

	it("runs one more time for a call during a sync, and drops a page after stop", async () => {
		const changes = [message(1, 1)];
		const room = fakeRoom(changes);
		const applied: number[] = [];
		const sync = createRoomSync(room.read, (messages) => applied.push(...messages.map((entry) => entry.seq)));
		sync.start(0);
		const first = sync.run();
		// A message arrives during the first read. The second call does not start a second read at once.
		changes.push(message(2, 2));
		await sync.run();
		await first;
		expect(room.calls).toEqual([0, 1]);
		expect(applied).toEqual([1, 2]);

		changes.push(message(3, 3));
		const late = sync.run();
		sync.stop();
		await late;
		expect(applied).toEqual([1, 2]);
	});

	// A reload of the room replaces the list with an older snapshot while a sync reads newer changes.
	// The page of that read is for the old list: after it, the list has a gap that no later sync fills.
	it("drops a page that it read before a new start, and reads again from the new version", async () => {
		const changes = [10, 11, 12, 13].map((version) => message(version, version));
		const calls: number[] = [];
		let releaseFirst = () => {};
		const firstRead = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const read = async (changedAfter: number): Promise<ChangePage> => {
			calls.push(changedAfter);
			if (calls.length === 1) await firstRead;
			return { messages: changes.filter((change) => change.version > changedAfter), version: 13, has_more: false };
		};
		const applied: number[] = [];
		const sync = createRoomSync(read, (messages) => applied.push(...messages.map((entry) => entry.seq)));
		sync.start(12);
		const running = sync.run();
		// The reload installs a snapshot of version 10 during the read after version 12.
		sync.start(10);
		releaseFirst();
		await running;
		expect(calls).toEqual([12, 10]);
		expect(applied).toEqual([11, 12, 13]);
	});

	// A page of older messages has the messages as they were at its version. The sync dropped each
	// later change to them, because the list did not have them then.
	it("reads the changes again from the version of a page that is older than its own version", async () => {
		const room = fakeRoom([10, 11, 12, 13].map((version) => message(version, version)));
		const applied: number[] = [];
		const sync = createRoomSync(room.read, (messages) => applied.push(...messages.map((entry) => entry.seq)));
		sync.start(13);
		sync.rewind(13);
		sync.rewind(14);
		await sync.run();
		expect(room.calls).toEqual([13]);
		sync.rewind(11);
		// The rewind starts the read itself.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(room.calls).toEqual([13, 11]);
		expect(applied).toEqual([12, 13]);
	});

	it("drops a page that it read before a rewind, and reads again from the older version", async () => {
		const changes = [10, 11, 12, 13].map((version) => message(version, version));
		const calls: number[] = [];
		let releaseFirst = () => {};
		const firstRead = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const read = async (changedAfter: number): Promise<ChangePage> => {
			calls.push(changedAfter);
			if (calls.length === 1) await firstRead;
			return { messages: changes.filter((change) => change.version > changedAfter), version: 13, has_more: false };
		};
		const applied: number[] = [];
		const sync = createRoomSync(read, (messages) => applied.push(...messages.map((entry) => entry.seq)));
		sync.start(12);
		const running = sync.run();
		sync.rewind(10);
		releaseFirst();
		await running;
		expect(calls).toEqual([12, 10]);
		expect(applied).toEqual([11, 12, 13]);
	});

	// React runs the cleanup of an effect and then the effect again, on the same sync, in development.
	it("works again when it starts after a stop", async () => {
		const room = fakeRoom([message(1, 1), message(2, 2)]);
		const applied: number[] = [];
		const sync = createRoomSync(room.read, (messages) => applied.push(...messages.map((entry) => entry.seq)));
		sync.start(1);
		sync.stop();
		await sync.notice(2);
		expect(room.calls).toEqual([]);
		sync.start(1);
		await sync.notice(2);
		expect(applied).toEqual([2]);
	});
});

describe("a message from the socket of the room", () => {
	// The socket brings each change. A read for each message would make the socket useless.
	it("shows without a read when it has the next version, and one time when it arrives two times", async () => {
		const room = fakeRoom([message(1, 1), message(2, 2), message(3, 3)]);
		const applied: number[] = [];
		const sync = createRoomSync(room.read, (messages) => applied.push(...messages.map((entry) => entry.seq)));
		sync.start(1);
		sync.push(message(2, 2));
		// The answer of the operation and the event of the socket have the same message.
		sync.push(message(2, 2));
		sync.push(message(3, 3));
		expect(applied).toEqual([2, 3]);
		// The page is current, so the next room list starts no read.
		await sync.notice(3);
		expect(room.calls).toEqual([]);
	});

	// An event can get lost, for example while the socket connects again. The version shows the gap.
	it("shows at once, and gets the changes that the page did not get, when a version is missing", async () => {
		const room = fakeRoom([message(1, 1), message(2, 2), message(3, 3), message(4, 4)]);
		const applied: number[] = [];
		const sync = createRoomSync(room.read, (messages) => applied.push(...messages.map((entry) => entry.seq)));
		sync.start(1);
		sync.push(message(4, 4));
		expect(applied).toEqual([4]);
		await sync.run();
		expect(room.calls[0]).toBe(1);
		expect(applied).toEqual([4, 2, 3, 4]);
		// The sync has version 4 now: the same message again changes nothing.
		sync.push(message(4, 4));
		expect(applied).toEqual([4, 2, 3, 4]);
	});

	// A read that started before the message can answer without it. The sync must not stop at that answer.
	it("reads again when it arrives during a read", async () => {
		const changes = [message(1, 1)];
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const calls: number[] = [];
		const read = async (changedAfter: number): Promise<ChangePage> => {
			calls.push(changedAfter);
			// The first read saw the room before the new message, and answers late.
			const seen = calls.length === 1 ? [...changes] : changes;
			if (calls.length === 1) await held;
			const after = seen.filter((change) => change.version > changedAfter);
			return { messages: after, version: seen[seen.length - 1]?.version ?? 0, has_more: false };
		};
		const applied: number[] = [];
		const sync = createRoomSync(read, (messages) => applied.push(...messages.map((entry) => entry.seq)));
		sync.start(1);
		const running = sync.run();
		changes.push(message(2, 2), message(3, 3));
		sync.push(message(3, 3));
		release();
		await running;
		expect(calls).toEqual([1, 1]);
		expect(applied).toEqual([3, 2, 3]);
	});

	it("is dropped before the load of the room and after a stop", () => {
		const applied: number[] = [];
		const sync = createRoomSync(fakeRoom([]).read, (messages) => applied.push(...messages.map((entry) => entry.seq)));
		sync.push(message(1, 1));
		sync.start(0);
		sync.stop();
		sync.push(message(1, 1));
		expect(applied).toEqual([]);
	});
});
