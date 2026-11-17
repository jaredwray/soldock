import { describe, expect, it } from "vitest";
import {
	insertMention,
	liveMention,
	type MentionPerson,
	mentionAt,
	mentionDirectory,
	mentionKeyAction,
	mentionSuggestions,
	textParts,
} from "../src/features/chat/mentions.ts";

function person(id: string, display_name: string, address: string, change: Partial<MentionPerson> = {}): MentionPerson {
	return { id: `prn_${id}`, kind: "human", display_name, address, archived_at: null, ...change };
}

const CAPTAIN = person("captain", "Captain Hook", "captain@example.com", { kind: "agent" });
const ADA = person("ada", "Ada Lovelace", "ada@example.com");
const ADA_ORG = person("adaorg", "Ada Byron", "ada@example.org");
const ELLE = person("elle", "Élodie Martin", "elodie.martin@example.com");
const OLD = person("old", "Ola Old", "ola@example.com", { archived_at: "2026-01-01T00:00:00.000Z" });
const ODD = person("odd", "Odd Quote", "o'neil@example.com");
const PEOPLE = [CAPTAIN, ADA, ADA_ORG, ELLE, OLD, ODD];
const DIRECTORY = mentionDirectory(PEOPLE);

describe("the handle of a principal", () => {
	// Two principals with the same part before the "@" must not get one handle.
	it("is the part before the @, or the full address when two principals have the same part", () => {
		expect(DIRECTORY.handleOf.get(CAPTAIN.id)).toBe("captain");
		expect(DIRECTORY.handleOf.get(ELLE.id)).toBe("elodie.martin");
		expect(DIRECTORY.handleOf.get(ADA.id)).toBe("ada@example.com");
		expect(DIRECTORY.handleOf.get(ADA_ORG.id)).toBe("ada@example.org");
		expect(DIRECTORY.byHandle.has("ada")).toBe(false);
		// The full address of each principal is a handle too.
		expect(DIRECTORY.byHandle.get("captain@example.com")).toBe(CAPTAIN);
		// An address that the mention syntax cannot hold gets no handle. The principal still has a profile.
		expect(DIRECTORY.handleOf.has(ODD.id)).toBe(false);
		expect(DIRECTORY.byId.get(ODD.id)).toBe(ODD);
	});
});

describe("the mentions in the text of a message", () => {
	const plain = (text: string) => ({ text, person: null });

	it("finds a mention of a known handle, in each letter case, and keeps the full text", () => {
		expect(textParts("Hi @captain, see @Captain@Example.com and @ada@example.org.", DIRECTORY)).toEqual([
			plain("Hi "),
			{ text: "@captain", person: CAPTAIN },
			plain(", see "),
			{ text: "@Captain@Example.com", person: CAPTAIN },
			plain(" and "),
			{ text: "@ada@example.org", person: ADA_ORG },
			plain("."),
		]);
		expect(textParts("@elodie.martin's notes", DIRECTORY)).toEqual([
			{ text: "@elodie.martin", person: ELLE },
			plain("'s notes"),
		]);
	});

	// People and agents write the name of a person, not the part of the address: "@jared" for Jared Wray,
	// whose address is me@example.com.
	it("finds a principal by its first name, or its full name without spaces, when only it has that alias", () => {
		const JARED = person("jared", "Jared Wray", "me@example.com");
		const directory = mentionDirectory([...PEOPLE, JARED]);
		expect(textParts("@jared Seattle today", directory)).toEqual([
			{ text: "@jared", person: JARED },
			plain(" Seattle today"),
		]);
		// The full name without spaces, in each letter case, and a name without its accents.
		expect(textParts("@JaredWray and @elodie", directory)).toEqual([
			{ text: "@JaredWray", person: JARED },
			plain(" and "),
			{ text: "@elodie", person: ELLE },
		]);
		// A new mention from the list uses the handle.
		expect(directory.handleOf.get(JARED.id)).toBe("me");

		// Two principals with one first name: neither of them has it. Each keeps its full name.
		const SMITH = person("smith", "Jared Smith", "jsmith@example.com");
		const shared = mentionDirectory([...PEOPLE, JARED, SMITH]);
		expect(textParts("@jared", shared)).toEqual([plain("@jared")]);
		expect(textParts("@jaredsmith", shared)).toEqual([{ text: "@jaredsmith", person: SMITH }]);
		// A handle and a local part win over a name: "Captain Cook" does not take "@captain", and
		// "Ada Lovelace" does not take "@ada", the local part of two addresses.
		const COOK = person("cook", "Captain Cook", "cook@example.com");
		const withCook = mentionDirectory([...PEOPLE, COOK]);
		expect(textParts("@captain", withCook)).toEqual([{ text: "@captain", person: CAPTAIN }]);
		expect(textParts("@ada", withCook)).toEqual([plain("@ada")]);
		// A word for a group is never the name of one principal.
		const groups = mentionDirectory([...PEOPLE, person("here", "Here Maps", "maps@example.com")]);
		expect(textParts("@here", groups)).toEqual([plain("@here")]);
		expect(textParts("@heremaps", groups)[0]?.person?.display_name).toBe("Here Maps");
	});

	// A wrong link would send a reader to a different person than the author meant.
	it("leaves addresses, links, unknown handles and shared handles as plain text", () => {
		for (const text of [
			"mail captain@example.com",
			"https://example.com/@captain",
			"https://example.com/?u=@captain",
			// A known handle at the start of a longer word is not a mention.
			"@captainé",
			"@captain_",
			"@captain@other",
			"@captain.x",
			"@captainx",
			"@ada",
			"@captain@other.example",
		]) {
			expect(textParts(text, DIRECTORY), text).toEqual([plain(text)]);
		}
	});
});

describe("the mention that the person types", () => {
	it("starts at an @ after a space or at the start, and ends at the caret", () => {
		expect(mentionAt("@", 1)).toEqual({ start: 0, end: 1, query: "" });
		expect(mentionAt("hi @cap", 7)).toEqual({ start: 3, end: 7, query: "cap" });
		expect(mentionAt("hi @Élo", 7)).toEqual({ start: 3, end: 7, query: "Élo" });
		expect(mentionAt("hi @ada@ex", 10)).toEqual({ start: 3, end: 10, query: "ada@ex" });
		// The text after the caret is not part of the mention, so a suggestion keeps it.
		expect(mentionAt("@capthanks", 4)).toEqual({ start: 0, end: 4, query: "cap" });
	});

	it("is null in an address, after a space, and before the @", () => {
		expect(mentionAt("ada@ex", 6)).toBeNull();
		expect(mentionAt("@captain ", 9)).toBeNull();
		expect(mentionAt("hi @captain", 3)).toBeNull();
	});
});

describe("the suggestions for a mention", () => {
	const ids = (list: { person: MentionPerson }[]) => list.map((entry) => entry.person.id);

	it("matches the start of a handle, an address or a word of the name before a match inside", () => {
		expect(ids(mentionSuggestions(DIRECTORY, "cap", { memberIds: new Set(), ownId: ADA.id }))).toEqual([CAPTAIN.id]);
		expect(ids(mentionSuggestions(DIRECTORY, "hook", { memberIds: new Set(), ownId: ADA.id }))).toEqual([CAPTAIN.id]);
		// "Élodie" for "elo", without the accent. "Lovelace" has "ela" inside, so it comes after "Élodie".
		expect(ids(mentionSuggestions(DIRECTORY, "el", { memberIds: new Set(), ownId: CAPTAIN.id }))).toEqual([
			ELLE.id,
			ADA.id,
		]);
	});

	// A person mentions the members of the room most of the time.
	it("puts the members of the room first, and leaves out the writer, archived principals and principals without a handle", () => {
		const list = mentionSuggestions(DIRECTORY, "", { memberIds: new Set([ELLE.id]), ownId: ADA.id });
		expect(ids(list)).toEqual([ELLE.id, ADA_ORG.id, CAPTAIN.id]);
		expect(list.map((entry) => [entry.handle, entry.member])).toEqual([
			["elodie.martin", true],
			["ada@example.org", false],
			["captain", false],
		]);
	});

	it("shows eight suggestions at most", () => {
		const many = mentionDirectory(
			Array.from({ length: 10 }, (_, index) => person(`p${index}`, `Person ${index}`, `p${index}@example.com`)),
		);
		expect(mentionSuggestions(many, "", { memberIds: new Set(), ownId: ADA.id })).toHaveLength(8);
	});
});

describe("a suggestion that the person takes", () => {
	function take(text: string, caret: number) {
		const token = mentionAt(text, caret);
		if (!token) throw new Error(`no mention in ${text}`);
		return insertMention(text, token, "captain");
	}

	// The text after the caret must stay: a person often puts a mention before text that exists.
	it("replaces only the typed text, and puts one space and the caret after the mention", () => {
		expect(take("hi @cap", 7)).toEqual({ value: "hi @captain ", caret: 12 });
		expect(take("@capthanks for the help", 4)).toEqual({ value: "@captain thanks for the help", caret: 9 });
		expect(take("hi @cap@ada", 7)).toEqual({ value: "hi @captain @ada", caret: 12 });
		// A space after the mention stays, and gets no second one. The caret goes after it.
		expect(take("hi @cap now", 7)).toEqual({ value: "hi @captain now", caret: 12 });
		// A mark that ends a word gets no space before it. The caret goes before the mark.
		expect(take("hi @cap.", 7)).toEqual({ value: "hi @captain.", caret: 11 });
		expect(take("(@cap)", 5)).toEqual({ value: "(@captain)", caret: 9 });
	});
});

describe("the keys of the field", () => {
	const open = { open: true, active: 1, count: 3 };

	// Enter must take a suggestion and not send, and Escape must close the list and not the edit box.
	it("gives the keys to the list while it is open, and to the field otherwise", () => {
		const cases: [string, boolean, boolean, typeof open, ReturnType<typeof mentionKeyAction>][] = [
			["Enter", false, false, open, { kind: "take", index: 1 }],
			["Tab", false, false, open, { kind: "take", index: 1 }],
			["Escape", false, false, open, { kind: "close" }],
			["ArrowDown", false, false, open, { kind: "select", index: 2 }],
			["ArrowUp", false, false, { ...open, active: 0 }, { kind: "select", index: 2 }],
			// The list is closed: Enter sends, and Escape closes the edit box.
			["Enter", false, false, { ...open, open: false }, { kind: "none" }],
			["Escape", false, false, { ...open, open: false }, { kind: "none" }],
			// A key during text composition belongs to the input method.
			["Enter", false, true, open, { kind: "none" }],
			["Tab", true, false, open, { kind: "none" }],
			// Shift+Enter makes a new line, also while the list is open.
			["Enter", true, false, open, { kind: "none" }],
			["a", false, false, open, { kind: "none" }],
		];
		for (const [key, shift, composing, list, action] of cases) {
			expect([key, composing, list, mentionKeyAction(key, shift, composing, list)]).toEqual([
				key,
				composing,
				list,
				action,
			]);
		}
	});

	// After a send, the parent empties the field without a key in it. The list must close.
	it("closes the list when the text no longer has the mention", () => {
		const token = mentionAt("hi @cap", 7);
		expect(liveMention("hi @cap", token)).toBe(token);
		expect(liveMention("", token)).toBeNull();
		expect(liveMention("hi cap", token)).toBeNull();
	});
});
