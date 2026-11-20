import {
	CHAT_LIMITS,
	GROUP_MENTIONS,
	type GroupMention,
	MENTION_NOT_AFTER,
	type MentionDirectory,
	type MentionPerson,
	type RoomRole,
	searchFold,
} from "@asterra/contracts";
import { recipientKeyAction } from "../mail/compose.ts";

export {
	type MentionDirectory,
	type MentionPerson,
	mentionDirectory,
	type TextPart,
	textParts,
} from "@asterra/contracts";

// The pure rules of mentions in Chat. They have no DOM and no network, so apps/web/test checks them.
//
// A mention is plain text in a message: "@" and the handle of a person or an agent. The handle is the
// part of the address before the "@", for example "@ada" for ada@example.com. When two principals have
// the same part (on two mail domains), each of them has the full address as its handle, for example
// "@ada@example.org". A name alias (the first name, or the full name without spaces) finds a principal
// too, when only one principal has it and it is no handle. The room makes a mention node of each one.
// A client asks the server for the principal of a handle in a text (`directory.get_principals`), so a
// person and an agent write and read the same mention, and no client needs the whole directory.

/** The text from the "@" to the caret, while the person types a mention. A name can have each letter. */
const TYPED = new RegExp(`${MENTION_NOT_AFTER}@([\\p{L}\\p{N}._+\\-]*(?:@[\\p{L}\\p{N}.\\-]*)?)$`, "u");
/**
 * The text after a mention that needs no space between: a space, or a mark that ends a word. A "."
 * ends a word only when no letter or digit follows it.
 */
const ENDS_WORD = /^(?:[\s,;:!?)\]}'"’”]|\.(?![\p{L}\p{N}]))/u;

/** What the mentions of a view need: the people of the page, the members of the room, and the writer. */
export interface MentionContext {
	/** The principals that the views asked for, with their handles: not the directory of the organization. */
	directory: MentionDirectory;
	memberIds: ReadonlySet<string>;
	ownId: string;
	/** True when the writer can mention a group ("@here", "@channel") in the room: see `canMentionGroups`. */
	groups: boolean;
}

/**
 * True when a member with `role` can mention a group in a room of `memberCount` members. In a room
 * with more than `CHAT_LIMITS.groupMentionMembers` members, only an owner can, as the room checks.
 */
export function canMentionGroups(role: RoomRole | null, memberCount: number): boolean {
	return role === "owner" || (role !== null && memberCount <= CHAT_LIMITS.groupMentionMembers);
}

/**
 * The groups for a typed mention: each group that starts with the query, when the writer can mention a
 * group. Until presence (layer 7 of Chat), "@here" mentions each member too.
 */
export function groupSuggestions(query: string, allowed: boolean): GroupMention[] {
	if (!allowed) return [];
	const typed = fold(query);
	return GROUP_MENTIONS.filter((group) => group.startsWith(typed));
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

/** Lowercase, without accents, so "e" finds "É". The server folds the stored names with the same rule. */
const fold = searchFold;

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

/** The order of two texts by their characters (code units), the order of SQLite for text. */
function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
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
 * The principals for a typed mention: the members of the room (at most 500), with their handles from the
 * people of the page (`directory`: the room asks for its members), and the page of the server (`found`,
 * with the handle of the server). So a member always comes before a principal that is not a member with
 * the same rank, also when the server has more matches than its page. A principal in both comes one time.
 * A member whose read did not come yet is not in the list until it comes.
 */
export function typedMentionCandidates<P extends MentionPerson>(
	directory: MentionDirectory<P>,
	memberIds: ReadonlySet<string>,
	found: readonly (MentionPerson & { handle: string | null })[],
): { person: MentionPerson; handle: string | null }[] {
	const candidates = new Map<string, { person: MentionPerson; handle: string | null }>();
	for (const id of memberIds) {
		const person = directory.byId.get(id);
		if (person) candidates.set(id, { person, handle: directory.handleOf.get(id) ?? null });
	}
	for (const person of found) {
		if (!candidates.has(person.id)) candidates.set(person.id, { person, handle: person.handle });
	}
	return [...candidates.values()];
}

/**
 * The suggestions for a typed mention, from principals with their handles. A match at the start of a
 * handle, an address or a word of the name comes first. Then the members of the room come first, then the
 * order of the names. The handles come from the server (`directory.list_principals` and
 * `directory.get_principals` give each one), so a list needs no directory of the organization.
 * A principal without a handle, the writer and each archived principal stay out.
 */
export function rankMentions<P extends MentionPerson>(
	candidates: readonly { person: P; handle: string | null }[],
	query: string,
	options: { memberIds: ReadonlySet<string>; ownId: string },
): MentionSuggestion<P>[] {
	const typed = fold(query);
	const found: (MentionSuggestion<P> & { rank: number })[] = [];
	for (const { person, handle } of candidates) {
		if (!handle || person.id === options.ownId || person.archived_at !== null) continue;
		const rank = matchRank(typed, handle, person);
		if (rank !== null) found.push({ person, handle, member: options.memberIds.has(person.id), rank });
	}
	found.sort(
		(a, b) =>
			a.rank - b.rank ||
			Number(b.member) - Number(a.member) ||
			// The folded name in the order of its characters, as the server orders a page for the list.
			compareText(fold(a.person.display_name), fold(b.person.display_name)) ||
			compareText(a.person.display_name, b.person.display_name),
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
 * Mail composer, with two changes: Tab takes a suggestion and keeps the focus in the field, and
 * Shift+Enter keeps its usual action, a new line.
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
	if (composing || (key === "Enter" && shiftKey)) return { kind: "none" };
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
