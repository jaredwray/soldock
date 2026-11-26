import { describe, expect, it } from "vitest";
import { type ChangePage, catchUp } from "../src/features/calendar/sync.ts";

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
