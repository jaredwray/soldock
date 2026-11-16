import { describe, expect, it } from "vitest";
import { type ListboxOption, matchIndex, moveIndex, stepIndex } from "../src/lib/listbox.ts";

function options(...labels: string[]): ListboxOption[] {
	// A label in brackets is a disabled option.
	return labels.map((label) =>
		label.startsWith("[") ? { label: label.slice(1, -1), disabled: true } : { label: label },
	);
}

describe("listbox keys", () => {
	it("moves with the navigation keys, skips disabled options and stops at the ends", () => {
		const list = options("[Owner]", "Manager", "[Archived]", "Editor", "Viewer", "[Gone]");
		const cases: readonly [key: string, active: number, expected: number | null][] = [
			["ArrowDown", 1, 3],
			["ArrowDown", 4, 4],
			["ArrowDown", -1, 1],
			["ArrowUp", 3, 1],
			["ArrowUp", 1, 1],
			["ArrowUp", -1, 4],
			["Home", 4, 1],
			["End", 1, 4],
			["PageDown", 1, 4],
			["PageUp", 4, 1],
			["Enter", 3, null],
			["ArrowLeft", 3, null],
		];
		for (const [key, active, expected] of cases) {
			expect(moveIndex(list, active, key), `${key} from ${active}`).toBe(expected);
		}
	});

	it("gives -1 when no option can get the focus", () => {
		expect(stepIndex([], -1, 1)).toBe(-1);
		expect(moveIndex(options("[Owner]", "[Manager]"), -1, "Home")).toBe(-1);
		expect(matchIndex(options("[Owner]"), -1, "o")).toBe(-1);
	});

	it("goes to the option for the typed text, with no attention to case", () => {
		const list = options("Editor", "Edith", "Eve", "[Ezra]", "Manager", "Viewer");
		const cases: readonly [from: number, typed: string, expected: number][] = [
			// One letter goes to the next option with that letter, and continues from the start.
			[-1, "e", 0],
			[0, "e", 1],
			[2, "e", 0],
			// The same letter again and again does the same.
			[0, "ee", 1],
			// A word stays on the option that matches it now, and else goes to the next match.
			[0, "edit", 0],
			[1, "edit", 1],
			[2, "ED", 0],
			[4, "v", 5],
			// A disabled option and text that no option starts with give no match.
			[2, "ez", -1],
			[0, "x", -1],
		];
		for (const [from, typed, expected] of cases) {
			expect(matchIndex(list, from, typed), `"${typed}" from ${from}`).toBe(expected);
		}
	});
});
