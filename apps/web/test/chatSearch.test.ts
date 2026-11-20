import { describe, expect, it } from "vitest";
import type { DraftStorage } from "../src/features/chat/drafts.ts";
import {
	clearSearches,
	forgetOtherSearches,
	recentSearches,
	rememberSearch,
	resultParts,
} from "../src/features/chat/searchModel.ts";

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

describe("the text of a search result", () => {
	const marked = (text: string, highlights: { start: number; end: number }[], max?: number) =>
		resultParts(text, highlights, max)
			.map((part) => (part.marked ? `[${part.text}]` : part.text))
			.join("");

	it("marks each found word at its place, and shows a line break as a space", () => {
		const text = "The budget\nis the budget.";
		expect(
			marked(text, [
				{ start: 4, end: 10 },
				{ start: 18, end: 24 },
			]),
		).toBe("The [budget] is the [budget].");
		expect(marked("No word", [])).toBe("No word");
		expect(resultParts("", [])).toEqual([]);
	});

	// The server sends the positions. A position that the text does not have must not break the view.
	it("ignores a position outside the text, and marks two positions that overlap one time", () => {
		const text = "The budget.";
		const ranges = [
			{ start: 6, end: 10 },
			{ start: 4, end: 8 },
			{ start: 9, end: 400 },
			{ start: 50, end: 60 },
			{ start: 3, end: 3 },
			{ start: 1.5, end: 2 },
		];
		expect(marked(text, ranges)).toBe("The [budg][et][.]");
	});

	it("shows the part of a long text around its first found word, and never half of a character", () => {
		const text = `${"a".repeat(100)} budget ${"b".repeat(100)}`;
		const shown = marked(text, [{ start: 101, end: 107 }], 40);
		expect(shown).toBe(`…${"a".repeat(9)} [budget] ${"b".repeat(23)}…`);
		// A long text without a found word shows its start.
		expect(marked(text, [], 10)).toBe(`${"a".repeat(10)}…`);
		// The cut would fall in the middle of an emoji: the emoji stays whole or goes.
		const emoji = `${"😀".repeat(30)} budget`;
		for (const part of resultParts(emoji, [{ start: 61, end: 67 }], 22)) {
			expect(part.text.isWellFormed()).toBe(true);
		}
	});
});

describe("the recent searches of a person", () => {
	it("keeps the newest first, each query one time, at most 8, for each person apart", () => {
		const storage = fakeStorage();
		expect(recentSearches(storage, ADA)).toEqual([]);
		for (let index = 1; index <= 9; index++) rememberSearch(storage, ADA, `query ${index}`);
		expect(recentSearches(storage, ADA)).toEqual([9, 8, 7, 6, 5, 4, 3, 2].map((index) => `query ${index}`));
		// A query that is in the list moves to the start, in each letter case, without its spaces at the ends.
		rememberSearch(storage, ADA, "  QUERY 5 ");
		expect(recentSearches(storage, ADA).slice(0, 2)).toEqual(["QUERY 5", "query 9"]);
		expect(recentSearches(storage, ADA)).toHaveLength(8);
		rememberSearch(storage, ADA, "   ");
		expect(recentSearches(storage, ADA)[0]).toBe("QUERY 5");
		expect(recentSearches(storage, BOB)).toEqual([]);
	});

	// The storage is shared with other code of the origin, and with a different person on the same device.
	it("ignores values that are not from the app, and forgets the searches of other people", () => {
		const storage = fakeStorage({
			[`soldock:chat-searches:${ADA}`]: JSON.stringify(["budget", 7, "", "x".repeat(501), { q: 1 }, "plan"]),
			[`soldock:chat-searches:${BOB}`]: "not json",
			"asterra:other": "stays",
		});
		expect(recentSearches(storage, ADA)).toEqual(["budget", "plan"]);
		expect(recentSearches(storage, BOB)).toEqual([]);
		expect(recentSearches(null, ADA)).toEqual([]);
		forgetOtherSearches(storage, ADA);
		expect([...storage.items.keys()].sort()).toEqual(["asterra:other", `soldock:chat-searches:${ADA}`]);
		clearSearches(storage, ADA);
		expect(recentSearches(storage, ADA)).toEqual([]);
		// With nobody signed in, the searches of each person go.
		rememberSearch(storage, BOB, "secret");
		forgetOtherSearches(storage, null);
		expect([...storage.items.keys()]).toEqual(["asterra:other"]);
	});
});
