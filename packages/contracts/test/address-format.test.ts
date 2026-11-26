import { describe, expect, it } from "vitest";
import { addressLocalPart, EmailAddress } from "../src/index.ts";

describe("the local part of an address from a display name", () => {
	it.each([
		{ name: "Ada Lovelace", format: "first.last", expected: "ada.lovelace" },
		{ name: "Ada Lovelace", format: "first", expected: "ada" },
		{ name: "Ada Lovelace", format: "flast", expected: "alovelace" },
		// The first word and the last word. A middle name is not in the address.
		{ name: "Ada King Lovelace", format: "first.last", expected: "ada.lovelace" },
		{ name: "  Ada   Lovelace  ", format: "flast", expected: "alovelace" },
		// The accents go, and the letters are lowercase.
		{ name: "María José García", format: "first.last", expected: "maria.garcia" },
		// An apostrophe, a hyphen and other punctuation go.
		{ name: "Seán O'Brien-Smith", format: "first.last", expected: "sean.obriensmith" },
		// With one word, each format gives that word.
		{ name: "Plato", format: "first.last", expected: "plato" },
		{ name: "Plato", format: "flast", expected: "plato" },
		// A name with no letter from a to z gives no address. A word without one is not a name part.
		{ name: "李 小龍", format: "first.last", expected: "" },
		{ name: "Ada 李", format: "first.last", expected: "ada" },
		{ name: "", format: "first", expected: "" },
		// The local part of an address has at most 64 characters, and it does not end with a dot.
		{ name: `${"a".repeat(63)} Lovelace`, format: "first.last", expected: "a".repeat(63) },
	] as const)("is '$expected' for '$name' in $format", ({ name, format, expected }) => {
		const local = addressLocalPart(name, format);
		expect(local).toBe(expected);
		if (local) expect(EmailAddress.safeParse(`${local}@example.com`).success).toBe(true);
	});
});
