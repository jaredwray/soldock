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
	kind: "human" | "agent";
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
	const byId = new Map(people.map((person) => [person.id, person]));
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
 * The name aliases of a display name: the first word, and the full name without spaces, in lowercase
 * and without accents. "Ada Lovelace" has "ada" and "adalovelace". An alias must have the form of a
 * handle, so a name in a different script has no alias. A word for a group, such as "here" for
 * "Here Maps", is not an alias.
 */
function nameAliases(displayName: string): string[] {
	const words = displayName
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.split(/\s+/)
		.filter((word) => word !== "");
	const aliases = new Set([words[0] ?? "", words.join("")]);
	return [...aliases].filter((alias) => LOCAL_ONLY.test(alias) && !GROUP_WORDS.has(alias));
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

/** True when a text has a mention in the form of the syntax: "@" and a handle, not in an address. */
export function hasMentionSyntax(text: string): boolean {
	MENTION.lastIndex = 0;
	const found = MENTION.test(text);
	MENTION.lastIndex = 0;
	return found;
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
