import { describe, expect, it } from "vitest";
import { type ChangePage, catchUp, createSync, type SyncParts } from "../src/features/calendar/sync.ts";

function change(id: string): ChangePage["changes"][number] {
	return {
		id,
		type: "calendar.rsvp.changed",
		calendar_id: "prn_1",
		event_id: "evt_1",
		uid: "evt_1",
		occurrence_id: null,
		revision: 1,
		actor_id: null,
		at: "2026-12-01T00:00:00.000Z",
		cursor: `after-${id}`,
	};
}

/** A feed with pages keyed by the cursor that reads them. It records each cursor that the catch-up reads. */
function feed(pages: Record<string, ChangePage>) {
	const asked: string[] = [];
	const list = async (cursor: string) => {
		asked.push(cursor);
		const page = pages[cursor];
		if (!page) throw new Error(`no page for ${cursor}`);
		return page;
	};
	return { asked, list };
}

describe("the catch-up of the web calendar from its cursor", () => {
	// No change since the cursor: the page must not load its range again for each hint and each connect.
	it("keeps the cursor and loads nothing when no change came", async () => {
		const { list } = feed({ c0: { changes: [], cursor: "c0", has_more: false, expired: false } });
		expect(await catchUp("c0", list)).toEqual({ cursor: "c0", reload: false });
	});

	// A reconnect after many edits reads each page, so the cursor ends after the last change and nothing is lost.
	it("reads each page after the cursor and asks for one reload", async () => {
		const { asked, list } = feed({
			c0: { changes: [change("a"), change("b")], cursor: "after-b", has_more: true, expired: false },
			"after-b": { changes: [change("c")], cursor: "after-c", has_more: false, expired: false },
		});
		expect(await catchUp("c0", list)).toEqual({ cursor: "after-c", reload: true });
		expect(asked).toEqual(["c0", "after-b"]);
	});

	// An expired cursor must not keep the old state: the range loads again from the head cursor.
	it("loads the range again from the head cursor when the cursor expired", async () => {
		const { list } = feed({ old: { changes: [], cursor: "head", has_more: false, expired: true } });
		expect(await catchUp("old", list)).toEqual({ cursor: "head", reload: true });
	});
});

const NONE: ChangePage = { changes: [], cursor: "c0", has_more: false, expired: false };
const ONE: ChangePage = { changes: [change("a")], cursor: "after-a", has_more: false, expired: false };

/** A promise that the test settles, to hold a read open. */
function gate<T>() {
	let open: (value: T) => void = () => {};
	const promise = new Promise<T>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

/** The parts of a sync with a log of each call. A test replaces the parts that it controls. */
function parts(over: Partial<Omit<SyncParts, "cursor">> & { cursor?: string | null }) {
	const log: string[] = [];
	const cursor = { current: over.cursor ?? null };
	const base: SyncParts = {
		cursor,
		head: async () => "c0",
		list: async () => NONE,
		load: async () => true,
		stopped: () => false,
	};
	const all = { ...base, ...over, cursor };
	const logged: SyncParts = {
		cursor,
		head: () => {
			log.push("head");
			return all.head();
		},
		list: (after) => {
			log.push(`list ${after}`);
			return all.list(after);
		},
		load: (fresh) => {
			log.push(`load ${fresh ? "fresh" : "kept"}`);
			return all.load(fresh);
		},
		stopped: all.stopped,
	};
	return { log, cursor, sync: createSync(logged) };
}

describe("the sync of one range of the web calendar", () => {
	// A change that commits during the first read of the range must be after the cursor. If the range loaded
	// first, that change would be before the cursor and not on screen, and no catch-up would read it.
	it("reads the head cursor before the first load of the range", async () => {
		const { log, cursor, sync } = parts({});
		await sync();
		expect(log).toEqual(["head", "load fresh"]);
		expect(cursor.current).toBe("c0");
	});

	// The hint of a change that commits after the catch-up read the feed must not be lost: the socket sends
	// no second hint for it.
	it("runs one more catch-up for a hint that comes during a catch-up", async () => {
		const held = gate<ChangePage>();
		let reads = 0;
		const { log, sync } = parts({ cursor: "c0", list: () => (++reads === 1 ? held.promise : Promise.resolve(NONE)) });
		const running = sync();
		await sync();
		await sync();
		expect(log).toEqual(["list c0"]);
		held.open(NONE);
		await running;
		expect(log).toEqual(["list c0", "list c0"]);
	});

	// The page moved to a different range during the catch-up. The read of the new range can be older than the
	// changes of this catch-up, so the cursor that each range uses must stay before them.
	it("does not move the cursor after the page left the range", async () => {
		let stopped = false;
		const { log, cursor, sync } = parts({
			cursor: "c0",
			list: async () => {
				stopped = true;
				return ONE;
			},
			stopped: () => stopped,
		});
		await sync();
		expect(cursor.current).toBe("c0");
		expect(log).toEqual(["list c0"]);
	});

	// The feed read was good and the read of the range failed. If the cursor moved, the next catch-up would
	// read no change, and the change would never show.
	it("keeps the cursor after a failed load, so the next sync loads the range again", async () => {
		let fail = true;
		const { log, cursor, sync } = parts({ cursor: "c0", list: async () => ONE, load: async () => !fail });
		await sync();
		expect(cursor.current).toBe("c0");
		fail = false;
		await sync();
		expect(log).toEqual(["list c0", "load kept", "list c0", "load kept"]);
		expect(cursor.current).toBe("after-a");
	});

	// While the feed gives no cursor, each sync reads the range. A read after the first must keep the events on
	// screen: a fresh read each 30 seconds would show an empty calendar again and again.
	it("keeps the events on screen when the feed fails again after the range loaded", async () => {
		const { log, cursor, sync } = parts({
			head: async () => {
				throw new Error("no feed");
			},
		});
		await sync();
		await sync();
		expect(log).toEqual(["head", "load fresh", "head", "load kept"]);
		expect(cursor.current).toBeNull();
	});
});
