import { afterEach, describe, expect, it, vi } from "vitest";
import { bodyText, textToBody } from "../src/features/chat/composerSchema.ts";
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

/**
 * The store with plain texts: a text goes in as the body of the text, and comes out as its text. An
 * empty text is no draft. The rules of the store do not depend on the formats of a body.
 */
function textStore(storage: DraftStorage | null, owner: string) {
	const store = createDraftStore(storage, owner);
	return {
		get: (roomId: string) => {
			const body = store.get(roomId);
			return body ? bodyText(body) : "";
		},
		set: (roomId: string, text: string) => store.set(roomId, text === "" ? null : textToBody(text)),
	};
}

afterEach(() => {
	vi.useRealTimers();
	forgetOtherDrafts(null, null);
});

describe("the drafts of the rooms", () => {
	it("stay for each room and each person, also for a new page with the same storage", () => {
		const storage = fakeStorage();
		const drafts = textStore(storage, ADA);
		drafts.set("rm_1", "Hello");
		drafts.set("rm_2", "Line one\nLine two");
		textStore(storage, BOB).set("rm_1", "From Bob");
		// A reload makes a new store on the same storage.
		const reloaded = textStore(storage, ADA);
		expect([reloaded.get("rm_1"), reloaded.get("rm_2"), reloaded.get("rm_3")]).toEqual([
			"Hello",
			"Line one\nLine two",
			"",
		]);
		expect(textStore(storage, BOB).get("rm_1")).toBe("From Bob");
	});

	// A send empties the box. The storage must not keep the text of a message that the person sent.
	it("go away with an empty text, and the storage has no record of a person without drafts", () => {
		const storage = fakeStorage();
		const drafts = textStore(storage, ADA);
		drafts.set("rm_1", "Hello");
		drafts.set("rm_1", "");
		expect(drafts.get("rm_1")).toBe("");
		expect(storage.items.size).toBe(0);
	});

	it("go away for each other person at a sign-in, and for each person at a sign-out", () => {
		const storage = fakeStorage({ "soldock:appearance": "dark" });
		textStore(storage, ADA).set("rm_1", "From Ada");
		textStore(storage, BOB).set("rm_1", "From Bob");
		forgetOtherDrafts(storage, BOB);
		expect(textStore(storage, ADA).get("rm_1")).toBe("");
		expect(textStore(storage, BOB).get("rm_1")).toBe("From Bob");
		forgetOtherDrafts(storage, null);
		// A value of a different part of the app stays.
		expect([...storage.items.keys()]).toEqual(["soldock:appearance"]);
	});

	it("are empty when the value in the storage is not from this app", () => {
		const key = `soldock:chat-drafts:${ADA}`;
		expect(textStore(fakeStorage({ [key]: "not json" }), ADA).get("rm_1")).toBe("");
		const wrong = fakeStorage({ [key]: JSON.stringify({ rm_1: "text", rm_2: { text: 5, at: 1 }, rm_3: null }) });
		const drafts = textStore(wrong, ADA);
		expect([drafts.get("rm_1"), drafts.get("rm_2"), drafts.get("rm_3")]).toEqual(["", "", ""]);
	});

	it("keep 100 rooms at most, and drop the draft with the oldest change", () => {
		vi.useFakeTimers();
		const drafts = textStore(fakeStorage(), ADA);
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
		const drafts = textStore(storage, ADA);
		drafts.set("rm_1", "Stored");
		const setItem = storage.setItem;
		storage.setItem = () => {
			throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
		};
		drafts.set("rm_2", "Not stored");
		drafts.set("rm_1", "Changed");
		const next = textStore(storage, ADA);
		expect([next.get("rm_1"), next.get("rm_2")]).toEqual(["Changed", "Not stored"]);
		storage.setItem = setItem;
		next.set("rm_3", "Stored again");
		// A reload has no memory of the page: each draft must be in the storage.
		forgetOtherDrafts(null, null);
		const reloaded = textStore(storage, ADA);
		expect([reloaded.get("rm_1"), reloaded.get("rm_2"), reloaded.get("rm_3")]).toEqual([
			"Changed",
			"Not stored",
			"Stored again",
		]);
	});

	// A write of this tab failed. A different tab then writes a draft for a different room. The next
	// write of this tab must not put its old copy of the drafts over that draft.
	it("keep a draft from a different tab after a write of this tab failed", () => {
		const storage = fakeStorage();
		const drafts = textStore(storage, ADA);
		drafts.set("rm_1", "Stored");
		const setItem = storage.setItem;
		storage.setItem = () => {
			throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
		};
		drafts.set("rm_2", "Not stored");
		storage.setItem = setItem;
		// The different tab has no memory of this page. It writes to the storage.
		setItem(
			`soldock:chat-drafts:${ADA}`,
			JSON.stringify({ rm_1: { text: "Stored", at: 1 }, rm_9: { text: "From a different tab", at: 2 } }),
		);
		expect(drafts.get("rm_9")).toBe("From a different tab");
		drafts.set("rm_3", "After");
		forgetOtherDrafts(null, null);
		const reloaded = textStore(storage, ADA);
		expect(["rm_1", "rm_2", "rm_3", "rm_9"].map((room) => reloaded.get(room))).toEqual([
			"Stored",
			"Not stored",
			"After",
			"From a different tab",
		]);
	});

	// The page keeps a mark for a removed draft only while the storage has that draft. A mark for a
	// draft that the storage never had stays for no reason, and hides a later draft of that room.
	it("keep no mark for a removed draft that the storage does not have", () => {
		const storage = fakeStorage();
		const drafts = textStore(storage, ADA);
		const setItem = storage.setItem;
		storage.setItem = () => {
			throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
		};
		drafts.set("rm_2", "A draft that stays");
		drafts.set("rm_1", "Only on this page");
		drafts.set("rm_1", "");
		// A different tab, with a storage that works for it, writes a draft for the same room.
		setItem(`soldock:chat-drafts:${ADA}`, JSON.stringify({ rm_1: { text: "From a different tab", at: 2 } }));
		expect(drafts.get("rm_1")).toBe("From a different tab");
	});

	// Some browsers refuse localStorage. The draft must still stay when the person opens a different room.
	it("stay in the memory of the page when the browser has no storage, until the person signs out", () => {
		textStore(null, ADA).set("rm_1", "Hello");
		expect(textStore(null, ADA).get("rm_1")).toBe("Hello");
		expect(textStore(null, BOB).get("rm_1")).toBe("");
		forgetOtherDrafts(null, null);
		expect(textStore(null, ADA).get("rm_1")).toBe("");
	});

	// The box keeps the formats of a draft. The storage of the browser is not checked by the contract.
	it("keep the body of a draft with its formats, read a draft from before the formats, and drop a body that the contract does not take", () => {
		const key = `soldock:chat-drafts:${ADA}`;
		const body = {
			type: "doc" as const,
			content: [
				{
					type: "paragraph" as const,
					content: [{ type: "text" as const, text: "Ship", marks: [{ type: "strong" as const }] }],
				},
				{
					type: "bullet_list" as const,
					content: [
						{
							type: "list_item" as const,
							content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text: "one" }] }],
						},
					],
				},
			],
		};
		const storage = fakeStorage();
		createDraftStore(storage, ADA).set("rm_1", body);
		expect(createDraftStore(storage, ADA).get("rm_1")).toEqual(body);
		const old = fakeStorage({
			[key]: JSON.stringify({
				rm_1: { text: "Line one\nLine two", at: 1 },
				rm_2: { body: { type: "doc", content: [{ type: "heading", content: [] }] }, at: 1 },
				rm_3: {
					body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "html", text: "<b>x</b>" }] }] },
					at: 1,
				},
			}),
		});
		const drafts = createDraftStore(old, ADA);
		expect([drafts.get("rm_1"), drafts.get("rm_2"), drafts.get("rm_3")]).toEqual([
			textToBody("Line one\nLine two"),
			null,
			null,
		]);
	});
});
