// The text that a person wrote in the box of a room and did not send. It stays when the person opens
// a different room, and after a reload of the page. It has no DOM, so apps/web/test checks it.

/** The part of `localStorage` that the drafts use. */
export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

/** The start of the `localStorage` key of the drafts of one person. The id of the person follows. */
const PREFIX = "soldock:chat-drafts:";

/** The largest number of rooms with a draft for one person. Above it, the oldest draft goes away. */
const MAX_DRAFTS = 100;

interface Draft {
	text: string;
	/** The time of the last change, in milliseconds. */
	at: number;
}

export interface DraftStore {
	/** The draft of a room, or an empty text. */
	get(roomId: string): string;
	/** Keeps the draft of a room. An empty text removes it. */
	set(roomId: string, text: string): void;
}

/**
 * The drafts of the page for a browser that refuses `localStorage`, or a write to it, by person. They
 * stay until a reload. While a person has drafts here, they are the drafts of that person: the
 * storage has an older state.
 */
const inMemory = new Map<string, Map<string, Draft>>();

function read(storage: DraftStorage | null, owner: string): Map<string, Draft> {
	const kept = inMemory.get(owner);
	if (kept) return kept;
	const drafts = new Map<string, Draft>();
	if (!storage) return drafts;
	try {
		const parsed: unknown = JSON.parse(storage.getItem(PREFIX + owner) ?? "{}");
		if (typeof parsed !== "object" || parsed === null) return drafts;
		for (const [roomId, value] of Object.entries(parsed)) {
			const draft = value as Partial<Draft> | null;
			if (typeof draft?.text === "string" && draft.text !== "" && typeof draft.at === "number") {
				drafts.set(roomId, { text: draft.text, at: draft.at });
			}
		}
	} catch {
		// The browser refused the read, or the value is not from this app. The person has no drafts then.
	}
	return drafts;
}

function write(storage: DraftStorage | null, owner: string, drafts: Map<string, Draft>): void {
	try {
		if (!storage) throw new Error("no storage");
		if (drafts.size === 0) storage.removeItem(PREFIX + owner);
		else storage.setItem(PREFIX + owner, JSON.stringify(Object.fromEntries(drafts)));
		// The storage has each draft again.
		inMemory.delete(owner);
	} catch {
		// The browser has no storage, refused the write, or the storage is full. The drafts stay in the
		// memory of the page, so the text does not go away when the person opens a different room.
		inMemory.set(owner, drafts);
	}
}

/**
 * The drafts of one person. `storage` is `localStorage`, or null when the browser refuses it. When
 * the browser has no storage, or refuses a write, the drafts stay in the memory of the page.
 *
 * Each call reads the storage again, so a draft from a different tab is not lost. Two tabs that
 * change the draft of the same room keep the last change.
 */
export function createDraftStore(storage: DraftStorage | null, owner: string): DraftStore {
	return {
		get: (roomId) => read(storage, owner).get(roomId)?.text ?? "",
		set(roomId, text) {
			const drafts = read(storage, owner);
			if (text === "") drafts.delete(roomId);
			else drafts.set(roomId, { text, at: Date.now() });
			while (drafts.size > MAX_DRAFTS) {
				const oldest = [...drafts].reduce((first, entry) => (entry[1].at < first[1].at ? entry : first));
				drafts.delete(oldest[0]);
			}
			write(storage, owner, drafts);
		},
	};
}

/**
 * Removes the drafts of each person that is not `owner`: all drafts when `owner` is null. The text of
 * a draft must not stay in the browser after its person signs out.
 */
export function forgetOtherDrafts(storage: DraftStorage | null, owner: string | null): void {
	for (const person of [...inMemory.keys()]) {
		if (person !== owner) inMemory.delete(person);
	}
	if (!storage) return;
	try {
		const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
		for (const key of keys) {
			if (key?.startsWith(PREFIX) && (owner === null || key !== PREFIX + owner)) storage.removeItem(key);
		}
	} catch {
		// The browser refused the storage. It has no drafts then.
	}
}

/** `localStorage`, or null when the browser refuses it. */
export function draftStorage(): DraftStorage | null {
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}
