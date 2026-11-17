import type { DraftStorage } from "./drafts.ts";

// The emoji that a person uses most for reactions, for the quick reactions of a message. The browser
// counts each reaction that the person adds. It has no DOM, so apps/web/test checks it.

/** The start of the `localStorage` key of the counts of one person. The id of the person follows. */
const PREFIX = "soldock:chat-emoji:";

/** The quick reactions of a message. */
export const QUICK_REACTIONS = 3;

/** The quick reactions before the person adds reactions. */
export const DEFAULT_REACTIONS: readonly string[] = ["👍", "❤️", "😂"];

/** The largest number of emoji with a count. Above it, the emoji that the person used last the longest time ago goes. */
const MAX_COUNTED = 50;

/** One emoji, as the server takes it for a reaction. Other values in the storage are not from this app. */
const ONE_EMOJI = /^\p{RGI_Emoji}$/v;

interface Use {
	count: number;
	/** The time of the last use, in milliseconds. */
	at: number;
}

function read(storage: DraftStorage | null, owner: string): Map<string, Use> {
	const uses = new Map<string, Use>();
	if (!storage) return uses;
	try {
		const parsed: unknown = JSON.parse(storage.getItem(PREFIX + owner) ?? "{}");
		if (typeof parsed !== "object" || parsed === null) return uses;
		for (const [emoji, value] of Object.entries(parsed)) {
			const use = value as Partial<Use> | null;
			if (
				ONE_EMOJI.test(emoji) &&
				typeof use?.count === "number" &&
				Number.isSafeInteger(use.count) &&
				use.count > 0 &&
				typeof use.at === "number"
			) {
				uses.set(emoji, { count: use.count, at: use.at });
			}
		}
	} catch {
		// The browser refused the read, or the value is not from this app. The person has no counts then.
	}
	return uses;
}

/**
 * The quick reactions of a person: the emoji with the highest counts, the most recent first for the
 * same count. The default emoji fill the places that have no count.
 */
export function frequentEmoji(storage: DraftStorage | null, owner: string): string[] {
	const used = [...read(storage, owner)]
		.sort(([, a], [, b]) => b.count - a.count || b.at - a.at)
		.map(([emoji]) => emoji)
		.slice(0, QUICK_REACTIONS);
	for (const emoji of DEFAULT_REACTIONS) {
		if (used.length >= QUICK_REACTIONS) break;
		if (!used.includes(emoji)) used.push(emoji);
	}
	return used;
}

/** Counts one reaction of a person with `emoji`. A write that the browser refuses changes nothing. */
export function countEmoji(storage: DraftStorage | null, owner: string, emoji: string, now = Date.now()): void {
	if (!storage || !ONE_EMOJI.test(emoji)) return;
	const uses = read(storage, owner);
	uses.set(emoji, { count: (uses.get(emoji)?.count ?? 0) + 1, at: now });
	while (uses.size > MAX_COUNTED) {
		const oldest = [...uses].reduce((first, entry) => (entry[1].at < first[1].at ? entry : first));
		uses.delete(oldest[0]);
	}
	try {
		storage.setItem(PREFIX + owner, JSON.stringify(Object.fromEntries(uses)));
	} catch {
		// The storage is full or refused. The quick reactions stay as they are.
	}
}

/** Removes the counts of each person that is not `owner`: all counts when `owner` is null. */
export function forgetOtherEmoji(storage: DraftStorage | null, owner: string | null): void {
	if (!storage) return;
	try {
		const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
		for (const key of keys) {
			if (key?.startsWith(PREFIX) && (owner === null || key !== PREFIX + owner)) storage.removeItem(key);
		}
	} catch {
		// The browser refused the storage. It has no counts then.
	}
}
