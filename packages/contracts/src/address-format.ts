import { z } from "./zod.ts";

/**
 * The format of the address of a new person, from the display name. `first.last` gives `ada.lovelace`,
 * `first` gives `ada`, and `flast` gives `alovelace`: the first letter of the first name and the last name.
 */
export const AddressFormat = z.enum(["first.last", "first", "flast"]);
export type AddressFormat = z.infer<typeof AddressFormat>;

/** The longest local part of an address (RFC 5321). */
const LOCAL_PART_CHARS = 64;

/**
 * The local part of an address (the part before `@`) from a display name, in the format. The function
 * removes accents, changes the letters to lowercase and keeps only `a` to `z` and `0` to `9` in each word.
 * The first word is the first name, and the last word is the last name. With one word, each format gives
 * that word. A name with no usable letter, for example a name in a script other than Latin, gives "".
 */
export function addressLocalPart(displayName: string, format: AddressFormat): string {
	const words = displayName
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.split(/\s+/)
		.map((word) => word.replace(/[^a-z0-9]/g, ""))
		.filter((word) => word !== "");
	const first = words[0];
	if (first === undefined) return "";
	const last = words.length > 1 ? words[words.length - 1] : undefined;
	const local =
		last === undefined || format === "first" ? first : format === "flast" ? `${first[0]}${last}` : `${first}.${last}`;
	// A cut can leave a dot at the end: remove it.
	return local.slice(0, LOCAL_PART_CHARS).replace(/\.$/, "");
}
