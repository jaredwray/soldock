import { Emoji } from "@asterra/contracts";
import { describe, expect, it } from "vitest";
import {
	EMOJI,
	emojiCode,
	emojiName,
	emojiOfCode,
	emojiQueryAt,
	emojiSuggestions,
	findEmoji,
} from "../src/features/chat/emoji.ts";

describe("the emoji of the reaction picker", () => {
	it("finds an emoji by its name first, then by its other words", () => {
		expect(findEmoji("").length).toBe(EMOJI.length);
		// "thumbs up" starts with "thu". "thinking face" does not, so it does not come first.
		expect(findEmoji("thu")[0]?.emoji).toBe("👍");
		// "party popper" and "partying face" start with "party". The rocket has "ship" in its words.
		expect(findEmoji("PARTY").map((choice) => choice.emoji)).toEqual(["🎉", "🥳"]);
		expect(findEmoji("ship").map((choice) => choice.emoji)).toEqual(["🚀"]);
		expect(findEmoji("nothing like this")).toEqual([]);
	});

	it("has one entry for each emoji, each a value that the server takes", () => {
		const emoji = EMOJI.map((choice) => choice.emoji);
		expect(new Set(emoji).size).toBe(emoji.length);
		for (const one of emoji) expect(Emoji.safeParse(one).success, one).toBe(true);
		expect(emojiName("👍")).toBe("thumbs up");
		expect(emojiName("🦄")).toBe("🦄");
	});
});

describe("the emoji codes of the message box", () => {
	// A person types `:tada:` or `:thumbs_up:`, as in other chat apps.
	it("find an emoji by its code or a word, with the first emoji of the list for a shared word", () => {
		expect(emojiCode(EMOJI.find((choice) => choice.emoji === "👍") as (typeof EMOJI)[number])).toBe("thumbs_up");
		expect(emojiCode(EMOJI.find((choice) => choice.emoji === "🙈") as (typeof EMOJI)[number])).toBe(
			"see_no_evil_monkey",
		);
		expect(emojiOfCode("thumbs_up")?.emoji).toBe("👍");
		expect(emojiOfCode("TADA")?.emoji).toBe("🎉");
		// "+1" is a word of 👍 and of ➕. The first emoji of the list wins.
		expect(emojiOfCode("+1")?.emoji).toBe("👍");
		expect(emojiOfCode("no_such_emoji")).toBeNull();
		// Every code of the list finds its emoji, and a person can type it after ":".
		for (const choice of EMOJI) {
			expect(emojiOfCode(emojiCode(choice))?.emoji, choice.name).toBe(choice.emoji);
			expect(emojiQueryAt(`:${emojiCode(choice)}`)?.query, choice.name).toBe(emojiCode(choice));
		}
	});

	// A ":" in a time, a word or a link must not open the list.
	it("start at a ':' after a space or at the start, with two characters or more, and list the emoji of each code", () => {
		expect(emojiQueryAt("ship it :ta")).toEqual({ start: 8, query: "ta" });
		expect(emojiQueryAt(":+1")).toEqual({ start: 0, query: "+1" });
		for (const text of ["at 10:30", "note:ab", "see https://ex", "a :t", "a ::ta", "a :ta b"]) {
			expect(emojiQueryAt(text), text).toBeNull();
		}
		// The list finds a code, also of a name with "-" or a capital letter. The list has eight emoji at most.
		expect(emojiSuggestions("thumbs_u").map((choice) => choice.emoji)).toEqual(["👍"]);
		expect(emojiSuggestions("see_no").map((choice) => choice.emoji)).toEqual(["🙈"]);
		expect(emojiSuggestions("ok_ha").map((choice) => choice.emoji)).toEqual(["👌"]);
		expect(emojiSuggestions("tad").map((choice) => choice.emoji)).toContain("🎉");
		for (const choice of EMOJI) expect(emojiSuggestions(emojiCode(choice)), choice.name).toContain(choice);
		expect(emojiSuggestions("e").length).toBe(8);
	});
});
