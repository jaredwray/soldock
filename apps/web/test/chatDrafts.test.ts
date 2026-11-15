import { afterEach, describe, expect, it, vi } from "vitest";
import { createDraftStore, type DraftStorage, forgetOtherDrafts } from "../src/features/chat/drafts.ts";

const ADA = "prn_01JD0000000000000000000ADA";
const BOB = "prn_01JD0000000000000000000B0B";

/** A `localStorage` in memory. */
function fakeStorage(start: Record<string, string> = {}): DraftStorage & { items: Map<string, string> } {
	const items = new Map(Object.entries(start));
	return {
		items,
		getItem: (key) => items.get(key) ?? null,
		setItem: (key, value) => {
			items.set(key, value);
		},
		removeItem: (key) => {
			items.delete(key);
		},
		key: (index) => [...items.keys()][index] ?? null,
		get length() {
			return items.size;
		},
	};
}

afterEach(() => {
	vi.useRealTimers();
	forgetOtherDrafts(null, null);
});

describe("the drafts of the rooms", () => {
	it("stay for each room and each person, also for a new page with the same storage", () => {
		const storage = fakeStorage();
		const drafts = createDraftStore(storage, ADA);
		drafts.set("rm_1", "Hello");
		drafts.set("rm_2", "Line one\nLine two");
		createDraftStore(storage, BOB).set("rm_1", "From Bob");
		// A reload makes a new store on the same storage.
		const reloaded = createDraftStore(storage, ADA);
		expect([reloaded.get("rm_1"), reloaded.get("rm_2"), reloaded.get("rm_3")]).toEqual([
			"Hello",
			"Line one\nLine two",
			"",
		]);
		expect(createDraftStore(storage, BOB).get("rm_1")).toBe("From Bob");
	});

	// A send empties the box. The storage must not keep the text of a message that the person sent.
	it("go away with an empty text, and the storage has no record of a person without drafts", () => {
		const storage = fakeStorage();
		const drafts = createDraftStore(storage, ADA);
		drafts.set("rm_1", "Hello");
		drafts.set("rm_1", "");
		expect(drafts.get("rm_1")).toBe("");
		expect(storage.items.size).toBe(0);
	});

	it("go away for each other person at a sign-in, and for each person at a sign-out", () => {
		const storage = fakeStorage({ "soldock:appearance": "dark" });
		createDraftStore(storage, ADA).set("rm_1", "From Ada");
		createDraftStore(storage, BOB).set("rm_1", "From Bob");
		forgetOtherDrafts(storage, BOB);
		expect(createDraftStore(storage, ADA).get("rm_1")).toBe("");
		expect(createDraftStore(storage, BOB).get("rm_1")).toBe("From Bob");
		forgetOtherDrafts(storage, null);
		// A value of a different part of the app stays.
		expect([...storage.items.keys()]).toEqual(["soldock:appearance"]);
	});

	it("are empty when the value in the storage is not from this app", () => {
		const key = `soldock:chat-drafts:${ADA}`;
		expect(createDraftStore(fakeStorage({ [key]: "not json" }), ADA).get("rm_1")).toBe("");
		const wrong = fakeStorage({ [key]: JSON.stringify({ rm_1: "text", rm_2: { text: 5, at: 1 }, rm_3: null }) });
		const drafts = createDraftStore(wrong, ADA);
		expect([drafts.get("rm_1"), drafts.get("rm_2"), drafts.get("rm_3")]).toEqual(["", "", ""]);
	});

	it("keep 100 rooms at most, and drop the draft with the oldest change", () => {
		vi.useFakeTimers();
		const drafts = createDraftStore(fakeStorage(), ADA);
		for (let room = 1; room <= 100; room++) {
			vi.setSystemTime(room * 1000);
			drafts.set(`rm_${room}`, `draft ${room}`);
		}
		// A new change makes room 1 the newest draft. Room 2 is then the oldest one.
		vi.setSystemTime(200_000);
		drafts.set("rm_1", "changed");
		vi.setSystemTime(300_000);
		drafts.set("rm_101", "draft 101");
		expect([drafts.get("rm_1"), drafts.get("rm_2"), drafts.get("rm_3"), drafts.get("rm_101")]).toEqual([
			"changed",
			"",
			"draft 3",
			"draft 101",
		]);
	});

	// The storage is full, or the browser refuses the write. The text must not go away when the person
	// opens a different room.
	it("stay in the memory of the page when a write to the storage fails, and go to the storage when it works again", () => {
		const storage = fakeStorage();
		const drafts = createDraftStore(storage, ADA);
		drafts.set("rm_1", "Stored");
		const setItem = storage.setItem;
		storage.setItem = () => {
			throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
		};
		drafts.set("rm_2", "Not stored");
		drafts.set("rm_1", "Changed");
		const next = createDraftStore(storage, ADA);
		expect([next.get("rm_1"), next.get("rm_2")]).toEqual(["Changed", "Not stored"]);
		storage.setItem = setItem;
		next.set("rm_3", "Stored again");
		// A reload has no memory of the page: each draft must be in the storage.
		forgetOtherDrafts(null, null);
		const reloaded = createDraftStore(storage, ADA);
		expect([reloaded.get("rm_1"), reloaded.get("rm_2"), reloaded.get("rm_3")]).toEqual([
			"Changed",
			"Not stored",
			"Stored again",
		]);
	});

	// Some browsers refuse localStorage. The draft must still stay when the person opens a different room.
	it("stay in the memory of the page when the browser has no storage, until the person signs out", () => {
		createDraftStore(null, ADA).set("rm_1", "Hello");
		expect(createDraftStore(null, ADA).get("rm_1")).toBe("Hello");
		expect(createDraftStore(null, BOB).get("rm_1")).toBe("");
		forgetOtherDrafts(null, null);
		expect(createDraftStore(null, ADA).get("rm_1")).toBe("");
	});
});
