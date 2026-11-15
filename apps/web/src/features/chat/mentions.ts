import type { Principal } from "@soldock/contracts";
import { recipientKeyAction } from "../mail/compose.ts";

// The pure rules of mentions in Chat. They have no DOM and no network, so apps/web/test checks them.
//
// A mention is plain text in a message: "@" and the handle of a person or an agent. The handle is the
// part of the address before the "@", for example "@ada" for ada@example.com. When two principals have
// the same part (on two mail domains), each of them has the full address as its handle, for example
// "@ada@example.org". The room stores the text only. Each client finds the principal of a handle in
// the directory, so a person and an agent write and read the same mention.

/** The fields of a principal that a mention uses. */
export type MentionPerson = Pick<Principal, "id" | "kind" | "display_name" | "address" | "archived_at">;

/** The handles of the directory: the principal of each handle, and the handle of each principal. */
export interface MentionDirectory<P extends MentionPerson = MentionPerson> {
	/** The principal of each handle, by the handle in lowercase. A full address is always a handle. */
	byHandle: ReadonlyMap<string, P>;
	/** The handle that a new mention of a principal uses, by the id of the principal. */
	handleOf: ReadonlyMap<string, string>;
	people: readonly P[];
}

const LOCAL = "[a-z0-9](?:[a-z0-9._+-]*[a-z0-9])?";
const DOMAIN = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+";
const HANDLE = new RegExp(`^${LOCAL}(?:@${DOMAIN})?$`, "i");
/**
 * The "@" of a mention cannot come after a letter, a digit, a part of an address or a "/". So an
 * address such as ada@example.com has no mention. `inLink` removes the mentions in a link.
 */
const NOT_AFTER = "(?<![\\p{L}\\p{N}_.+\\-/@])";
const MENTION = new RegExp(`${NOT_AFTER}@(${LOCAL})(?:@(${DOMAIN}))?`, "giu");
/** The text from the "@" to the caret, while the person types a mention. A name can have each letter. */
const TYPED = new RegExp(`${NOT_AFTER}@([\\p{L}\\p{N}._+\\-]*(?:@[\\p{L}\\p{N}.\\-]*)?)$`, "u");
/**
 * The text after a mention that needs no space between: a space, or a mark that ends a word. A "."
 * ends a word only when no letter or digit follows it.
 */
const ENDS_WORD = /^(?:[\s,;:!?)\]}'"’”]|\.(?![\p{L}\p{N}]))/u;

function localPart(address: string): string {
	return address.slice(0, address.lastIndexOf("@"));
}

/**
 * The handles of the people and the agents of the directory. A principal whose address has no valid
 * handle form gets no handle: nobody can mention it.
 */
export function mentionDirectory<P extends MentionPerson>(people: readonly P[]): MentionDirectory<P> {
	const locals = new Map<string, number>();
	for (const person of people) {
		const local = localPart(person.address.toLowerCase());
		locals.set(local, (locals.get(local) ?? 0) + 1);
	}
	const byHandle = new Map<string, P>();
	const handleOf = new Map<string, string>();
	for (const person of people) {
		const address = person.address.toLowerCase();
		const local = localPart(address);
		if (!HANDLE.test(address)) continue;
		byHandle.set(address, person);
		if (locals.get(local) === 1) {
			byHandle.set(local, person);
			handleOf.set(person.id, local);
		} else {
			handleOf.set(person.id, address);
		}
	}
	return { byHandle, handleOf, people };
}

/** One part of the text of a message: plain text, or a mention with its principal. */
export interface TextPart<P extends MentionPerson = MentionPerson> {
	text: string;
	/** The principal of a mention, or null for plain text. */
	person: P | null;
}

/** True when the character at `at` is in a word with "://": a link, such as https://example.com/?u=@ada. */
function inLink(text: string, at: number): boolean {
	let start = at;
	while (start > 0 && !/\s/.test(text.charAt(start - 1))) start -= 1;
	return text.slice(start, at).includes("://");
}

/**
 * The text of a message in parts: plain text, and the mentions of principals in the directory. A
 * handle that the directory does not have stays plain text, as does a mention in a link. The parts
 * together are the full text.
 */
export function textParts<P extends MentionPerson>(text: string, directory: MentionDirectory<P>): TextPart<P>[] {
	const parts: TextPart<P>[] = [];
	let last = 0;
	for (const match of text.matchAll(MENTION)) {
		const whole = match[0];
		const [, local = "", domain] = match;
		const person = directory.byHandle.get((domain ? `${local}@${domain}` : local).toLowerCase());
		if (!person || inLink(text, match.index)) continue;
		if (match.index > last) parts.push({ text: text.slice(last, match.index), person: null });
		parts.push({ text: whole, person });
		last = match.index + whole.length;
	}
	if (last < text.length) parts.push({ text: text.slice(last), person: null });
	return parts;
}

/**
 * The mention that the person types: from its "@" (`start`) to the caret (`end`), and the text
 * between. A suggestion replaces this text only, so the text after the caret stays.
 */
export interface MentionToken {
	start: number;
	end: number;
	query: string;
}

/** The mention before the caret, or null when the caret is not at the end of a typed mention. */
export function mentionAt(text: string, caret: number): MentionToken | null {
	const match = TYPED.exec(text.slice(0, caret));
	if (!match) return null;
	return { start: match.index, end: caret, query: match[1] ?? "" };
}

/**
 * The token while the text still has it, or null. The parent of the field can replace the text
 * without a key in the field, for example after a send. The list then closes.
 */
export function liveMention(text: string, token: MentionToken | null): MentionToken | null {
	return token && text.charAt(token.start) === "@" && token.end <= text.length ? token : null;
}

/** Lowercase, without accents, so "e" finds "É". */
function fold(text: string): string {
	return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** 0 when a handle, the address or a word of the name starts with the query. 1 when one has it. Null without a match. */
function matchRank(query: string, handle: string, person: MentionPerson): number | null {
	if (query === "") return 0;
	const name = fold(person.display_name);
	const address = fold(person.address);
	if (
		handle.startsWith(query) ||
		address.startsWith(query) ||
		name.startsWith(query) ||
		name.split(/[\s.'-]+/).some((word) => word.startsWith(query))
	) {
		return 0;
	}
	return name.includes(query) || address.includes(query) ? 1 : null;
}

/** One suggestion of the list: a principal, its handle, and true when it is a member of the room. */
export interface MentionSuggestion<P extends MentionPerson = MentionPerson> {
	person: P;
	handle: string;
	member: boolean;
}

/** The suggestions that the list shows at most. */
const MENTION_SUGGESTIONS = 8;

/**
 * The principals for a typed mention. A match at the start of a handle, an address or a word of the
 * name comes first. Then the members of the room come first, then the order of the names. The list
 * leaves out the person who writes, and each archived principal.
 */
export function mentionSuggestions<P extends MentionPerson>(
	directory: MentionDirectory<P>,
	query: string,
	options: { memberIds: ReadonlySet<string>; ownId: string },
): MentionSuggestion<P>[] {
	const typed = fold(query);
	const found: (MentionSuggestion<P> & { rank: number })[] = [];
	for (const person of directory.people) {
		const handle = directory.handleOf.get(person.id);
		if (!handle || person.id === options.ownId || person.archived_at !== null) continue;
		const rank = matchRank(typed, handle, person);
		if (rank !== null) found.push({ person, handle, member: options.memberIds.has(person.id), rank });
	}
	found.sort(
		(a, b) =>
			a.rank - b.rank ||
			Number(b.member) - Number(a.member) ||
			a.person.display_name.localeCompare(b.person.display_name),
	);
	return found.slice(0, MENTION_SUGGESTIONS).map(({ person, handle, member }) => ({
		person,
		handle,
		member,
	}));
}

/**
 * The text after the person takes a suggestion. The mention replaces the typed text. A space goes
 * after it, unless the text after it starts with a space or with a mark that ends a word. `caret` is
 * the position after the mention and its space.
 */
export function insertMention(text: string, token: MentionToken, handle: string): { value: string; caret: number } {
	const after = text.slice(token.end);
	const mention = `@${handle}`;
	const ends = ENDS_WORD.exec(after)?.[0];
	const space = ends === undefined ? " " : "";
	const caret = token.start + mention.length + (ends === undefined || /^\s$/.test(ends) ? 1 : 0);
	return { value: `${text.slice(0, token.start)}${mention}${space}${after}`, caret };
}

/** What a key does in a field with the list of suggestions. */
export type MentionKeyAction =
	| { kind: "none" }
	| { kind: "select"; index: number }
	| { kind: "take"; index: number }
	| { kind: "close" };

/**
 * The action of a key in the field. The keys of the list are the keys of the address list of the
 * Mail composer, with one change: Tab takes a suggestion and keeps the focus in the field.
 *
 * Each action other than "none" replaces the usual action of the key. So Enter does not send and
 * Escape does not close the edit box while the list is open. A key during text composition belongs
 * to the input method.
 */
export function mentionKeyAction(
	key: string,
	shiftKey: boolean,
	composing: boolean,
	list: { open: boolean; active: number; count: number },
): MentionKeyAction {
	if (composing) return { kind: "none" };
	const action = recipientKeyAction(key, shiftKey, list);
	switch (action.kind) {
		case "select":
		case "take":
			return { kind: action.kind, index: action.index };
		case "close":
			return { kind: "close" };
		default:
			return { kind: "none" };
	}
}
