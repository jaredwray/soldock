import { describe, expect, it } from "vitest";
import {
	insertMention,
	type MentionPerson,
	mentionAt,
	mentionDirectory,
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
		// An address that the mention syntax cannot hold gets no handle.
		expect(DIRECTORY.handleOf.has(ODD.id)).toBe(false);
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

	// A wrong link would send a reader to a different person than the author meant.
	it("leaves addresses, links, unknown handles and shared handles as plain text", () => {
		for (const text of [
			"mail captain@example.com",
			"https://example.com/@captain",
			"@captainx",
			"@ada",
			"@captain@other.example",
		]) {
			expect(textParts(text, DIRECTORY), text).toEqual([plain(text)]);
		}
	});
});

describe("the mention that the person types", () => {
	it("starts at an @ after a space or at the start, and ends at the end of its word", () => {
		expect(mentionAt("@", 1)).toEqual({ start: 0, end: 1, query: "" });
		expect(mentionAt("hi @cap", 7)).toEqual({ start: 3, end: 7, query: "cap" });
		expect(mentionAt("hi @Élo", 7)).toEqual({ start: 3, end: 7, query: "Élo" });
		expect(mentionAt("hi @ada@ex", 10)).toEqual({ start: 3, end: 10, query: "ada@ex" });
		// The caret in the middle of a mention: the full word is replaced.
		expect(mentionAt("hi @captain now", 6)).toEqual({ start: 3, end: 11, query: "ca" });
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
		expect(mentionSuggestions(DIRECTORY, "", { memberIds: new Set(), ownId: ADA.id, limit: 1 })).toHaveLength(1);
	});
});

describe("a suggestion that the person takes", () => {
	it("replaces the typed text with the handle and one space, and puts the caret after the space", () => {
		const token = mentionAt("hi @cap", 7);
		if (!token) throw new Error("no mention");
		expect(insertMention("hi @cap", token, "captain")).toEqual({ value: "hi @captain ", caret: 12 });
		// The text after the mention keeps its space, and gets no second one.
		const inside = mentionAt("hi @cap now", 7);
		if (!inside) throw new Error("no mention");
		expect(insertMention("hi @cap now", inside, "captain")).toEqual({ value: "hi @captain now", caret: 12 });
	});
});
