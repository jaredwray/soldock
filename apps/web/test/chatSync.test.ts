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
