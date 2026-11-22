// The syntax and the handles of a mention in Chat, for the server and the clients. It has no DOM and
// no network.
//
// A mention in text is "@" and the handle of a person or an agent. The handle is the part of the address
// before the "@", for example "@ada" for ada@example.com. When two principals have the same part (on two
// mail domains), each of them has the full address as its handle, for example "@ada@example.org". A name
// alias (the first name, or the full name without spaces) finds a principal too, when only one principal
// has it and it is no handle. The server reads these mentions in the text and the Markdown of a message,
// and stores each one as a mention node with the id of its principal.

/** The fields of a principal that a mention uses. */
export interface MentionPerson {
	id: string;
	kind: "human" | "agent" | "service";
	display_name: string;
	address: string;
	archived_at: string | null;
}

/** The handles of the directory: the principal of each handle, and the handle of each principal. */
export interface MentionDirectory<P extends MentionPerson = MentionPerson> {
	/**
	 * The principal of each handle and each name alias, in lowercase. A full address is always a handle.
	 */
	byHandle: ReadonlyMap<string, P>;
	/** The handle that a new mention of a principal uses, by the id of the principal. */
	handleOf: ReadonlyMap<string, string>;
	/** Each principal of the directory, by its id. A principal without a handle is here too. */
	byId: ReadonlyMap<string, P>;
	people: readonly P[];
}

const LOCAL = "[a-z0-9](?:[a-z0-9._+-]*[a-z0-9])?";
const DOMAIN = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+";
const HANDLE = new RegExp(`^${LOCAL}(?:@${DOMAIN})?$`, "i");
/**
 * The "@" of a mention cannot come after a letter, a digit, a part of an address or a "/". So an
 * address such as ada@example.com has no mention. `inLink` removes the mentions in a link.
 */
export const MENTION_NOT_AFTER = "(?<![\\p{L}\\p{N}_.+\\-/@])";
/**
 * The end of a mention: no letter, digit, "_" or "@" follows it, and no mark of an address before
 * one of them. So "@ada." is a mention, and "@adaé", "@ada_" and "@ada@other" are not.
 */
const NOT_BEFORE = "(?![\\p{L}\\p{N}_@]|[._+\\-][\\p{L}\\p{N}_@])";
const MENTION = new RegExp(`${MENTION_NOT_AFTER}@(${LOCAL})(?:@(${DOMAIN}))?${NOT_BEFORE}`, "giu");
/**
 * The words of a mention of a group. "@here" and "@channel" mention each member of the room. A group
 * word is never the handle of one principal: a principal with the address here@example.com has its
 * full address as its handle.
 */
export const GROUP_MENTIONS = ["here", "channel"] as const;
export type GroupMention = (typeof GROUP_MENTIONS)[number];
const GROUP_MENTION_WORDS: ReadonlySet<string> = new Set(GROUP_MENTIONS);

/** The group of a word, in each letter case, or null. */
export function groupMentionOf(word: string): GroupMention | null {
	const lower = word.toLowerCase();
	return GROUP_MENTION_WORDS.has(lower) ? (lower as GroupMention) : null;
}

function localPart(address: string): string {
	return address.slice(0, address.lastIndexOf("@"));
}

/**
 * The handle that a new mention of a principal uses: the part of its address before the "@", or the full
 * address when a different principal has the same part (`shared`) or the part is a group word. Null for
 * an address without the form of a handle: nobody can mention that principal.
 */
export function mentionHandle(address: string, shared: boolean): string | null {
	const lower = address.toLowerCase();
	if (!HANDLE.test(lower)) return null;
	const local = localPart(lower);
	return shared || GROUP_MENTION_WORDS.has(local) ? lower : local;
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
	const byId = new Map(people.map((person) => [person.id, person]));
	for (const person of people) {
		const address = person.address.toLowerCase();
		const handle = mentionHandle(address, locals.get(localPart(address)) !== 1);
		if (handle === null) continue;
		byHandle.set(address, person);
		byHandle.set(handle, person);
		handleOf.set(person.id, handle);
	}
	// A name alias finds a principal too, so "@ada" for "Ada Lovelace" is a mention when only she has
	// that name. An alias that a different principal has, or that is a handle or a local part, is not
	// an alias: a handle always wins. A new mention from the list uses the handle.
	const aliasCount = new Map<string, number>();
	const aliasesOf = new Map<string, string[]>();
	for (const person of people) {
		const aliases = nameAliases(person.display_name).filter((alias) => !locals.has(alias) && !byHandle.has(alias));
		aliasesOf.set(person.id, aliases);
		for (const alias of aliases) aliasCount.set(alias, (aliasCount.get(alias) ?? 0) + 1);
	}
	for (const person of people) {
		for (const alias of aliasesOf.get(person.id) ?? []) {
			if (aliasCount.get(alias) === 1) byHandle.set(alias, person);
		}
	}
	return { byHandle, handleOf, byId, people };
}

const LOCAL_ONLY = new RegExp(`^${LOCAL}$`);

/** Words that a chat uses for a group of people, never the name alias of one principal. */
const GROUP_WORDS: ReadonlySet<string> = new Set(["all", "channel", "everyone", "here", "room"]);

/**
 * The name aliases of a display name, apart: the first word, and the full name without spaces, in
 * lowercase and without accents. "Ada Lovelace" has "ada" and "adalovelace". An alias must have the form
 * of a handle, so a name in a different script has no alias: that part is null. A word for a group, such
 * as "here" for "Here Maps", is not an alias. The directory stores the two parts, so the server finds the
 * principal of an alias with an index. A change of these rules (or of `LOCAL` and `GROUP_WORDS`) needs a
 * migration that sets `aliases_set = 0` on each principal, so the server writes the stored parts again.
 */
export function nameAliasParts(displayName: string): { first: string | null; full: string | null } {
	const words = displayName
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.split(/\s+/)
		.filter((word) => word !== "");
	const alias = (word: string) => (LOCAL_ONLY.test(word) && !GROUP_WORDS.has(word) ? word : null);
	return { first: alias(words[0] ?? ""), full: alias(words.join("")) };
}

/**
 * A text in the form of a search: lowercase and without accents, with its spaces. The directory stores
 * the display name in this form (`name_folded`), so "garcia" finds "María García", as the `@` list of the
 * web app folds a name. A change of this rule needs a migration that sets `aliases_set = 0`.
 */
export function searchFold(text: string): string {
	return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** The name aliases of a display name (`nameAliasParts`), each one time. */
function nameAliases(displayName: string): string[] {
	const { first, full } = nameAliasParts(displayName);
	return [...new Set([first, full])].filter((alias) => alias !== null);
}

/** One part of the text of a message: plain text, a mention with its principal, or a mention of a group. */
export interface TextPart<P extends MentionPerson = MentionPerson> {
	text: string;
	/** The principal of a mention, or null for plain text and for a group. */
	person: P | null;
	/** The group of a mention of a group ("@here", "@channel"), or null. */
	group: GroupMention | null;
}

/** True when the character at `at` is in a word with "://": a link, such as https://example.com/?u=@ada. */
function inLink(text: string, at: number): boolean {
	let start = at;
	while (start > 0 && !/\s/.test(text.charAt(start - 1))) start -= 1;
	return text.slice(start, at).includes("://");
}

/**
 * The text of a message in parts: plain text, the mentions of principals in the directory, and the
 * mentions of a group. A handle that the directory does not have stays plain text, as does a mention in
 * a link. The parts together are the full text.
 */
export function textParts<P extends MentionPerson>(text: string, directory: MentionDirectory<P>): TextPart<P>[] {
	const parts: TextPart<P>[] = [];
	let last = 0;
	for (const match of text.matchAll(MENTION)) {
		const whole = match[0];
		const [, local = "", domain] = match;
		const group = domain ? null : groupMentionOf(local);
		const person = group ? null : directory.byHandle.get((domain ? `${local}@${domain}` : local).toLowerCase());
		if ((!person && !group) || inLink(text, match.index)) continue;
		if (match.index > last) parts.push({ text: text.slice(last, match.index), person: null, group: null });
		parts.push({ text: whole, person: person ?? null, group });
		last = match.index + whole.length;
	}
	if (last < text.length) parts.push({ text: text.slice(last), person: null, group: null });
	return parts;
}

/**
 * The handles and name aliases that the mentions of a text can name, in lowercase: the local part, or the
 * full address. A server reads only the principals of these keys, so they are a superset: a mention of a
 * group or in a link gives a key too. The rules of `mentionDirectory` then decide.
 */
export function mentionKeys(text: string): string[] {
	const keys = new Set<string>();
	for (const match of text.matchAll(MENTION)) {
		const [, local = "", domain] = match;
		keys.add((domain ? `${local}@${domain}` : local).toLowerCase());
	}
	return [...keys];
}

const BEFORE_MENTION = /[\p{L}\p{N}_.+\-/@]$/u;
const AFTER_MENTION = /^(?:[\p{L}\p{N}_@]|[._+-][\p{L}\p{N}_@])/u;

/**
 * True when "@" and a label between the text `before` and the text `after` read back as a mention: no
 * letter, digit or mark of an address touches it, and it is not in a link (a word with "://", as
 * `textParts` reads it). `before` is the text of the line before the mention. A mention node that does
 * not fit would become a different mention, or text, in its Markdown.
 */
export function mentionFits(before: string, after: string): boolean {
	return !BEFORE_MENTION.test(before) && !AFTER_MENTION.test(after) && !inLink(before, before.length);
}
