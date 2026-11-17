import { Emoji } from "@soldock/contracts";
import { describe, expect, it } from "vitest";
import { EMOJI, emojiName, findEmoji } from "../src/features/chat/emoji.ts";

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
