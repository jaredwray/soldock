import { describe, expect, it } from "vitest";
import type { DraftStorage } from "../src/features/chat/drafts.ts";
import { countEmoji, forgetOtherEmoji, frequentEmoji } from "../src/features/chat/frequentEmoji.ts";

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

describe("the quick reactions of a person", () => {
	it("are the emoji with the most uses, the most recent first for one count, with the defaults after them", () => {
		const storage = fakeStorage();
		expect(frequentEmoji(storage, ADA)).toEqual(["👍", "❤️", "😂"]);
		countEmoji(storage, ADA, "🎉", 1);
		countEmoji(storage, ADA, "🎉", 2);
		countEmoji(storage, ADA, "🚀", 3);
		// A default emoji with a count is not shown two times.
		countEmoji(storage, ADA, "👍", 4);
		expect(frequentEmoji(storage, ADA)).toEqual(["🎉", "👍", "🚀"]);
		// The counts of a person are not the counts of a different person.
		expect(frequentEmoji(storage, BOB)).toEqual(["👍", "❤️", "😂"]);
		// Above 50 emoji, the emoji with the oldest use goes.
		for (let index = 0; index < 50; index++)
			countEmoji(storage, ADA, String.fromCodePoint(0x1f600 + index), 10 + index);
		const kept = Object.keys(JSON.parse(storage.items.get(`soldock:chat-emoji:${ADA}`) ?? "{}"));
		expect(kept).toHaveLength(50);
		expect(kept).not.toContain("🎉");
	});

	// The storage is shared with other code of the origin, and a person on the same device.
	it("ignores values that are not one emoji with a count, and forgets the counts of other people", () => {
		const storage = fakeStorage({
			[`soldock:chat-emoji:${ADA}`]: JSON.stringify({
				"<b>": { count: 9, at: 1 },
				"👍👍": { count: 9, at: 1 },
				"🎉": { count: "9", at: 1 },
				"🚀": { count: 2, at: 1 },
			}),
			[`soldock:chat-emoji:${BOB}`]: JSON.stringify({ "🎉": { count: 1, at: 1 } }),
			"soldock:other": "stays",
		});
		expect(frequentEmoji(storage, ADA)).toEqual(["🚀", "👍", "❤️"]);
		countEmoji(storage, ADA, "not an emoji");
		expect(frequentEmoji(storage, ADA)).toEqual(["🚀", "👍", "❤️"]);
		forgetOtherEmoji(storage, ADA);
		expect([...storage.items.keys()].sort()).toEqual([`soldock:chat-emoji:${ADA}`, "soldock:other"]);
		forgetOtherEmoji(storage, null);
		expect([...storage.items.keys()]).toEqual(["soldock:other"]);
	});
});
