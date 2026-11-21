import { ChatBody } from "@asterra/contracts";
import { textToBody } from "./composerSchema.ts";

// The message that a person wrote in the box of a room, or in the box of a thread, and did not send. It
// stays when the person opens a different room or thread, and after a reload of the page. It has no DOM,
// so apps/web/test checks it.

/** The part of `localStorage` that the drafts use. */
export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

/** The start of the `localStorage` key of the drafts of one person. The id of the person follows. */
const PREFIX = "soldock:chat-drafts:";

/** The largest number of rooms with a draft for one person. Above it, the oldest draft goes away. */
const MAX_DRAFTS = 100;

export interface DraftCopy {
	body: ChatBody | null;
	revision: number;
	dirty: boolean;
}

export function sameDraftBody(left: ChatBody | null, right: ChatBody | null): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

interface Draft extends DraftCopy {
	/** The time of the last change, in milliseconds. */
	at: number;
}

export interface DraftStore {
	/** The local copy, including the revision it came from. */
	get(key: string): DraftCopy | null;
	/** Store a user edit and return the server revision on which that edit is based. */
	edit(key: string, previous: Pick<DraftCopy, "body" | "revision">, body: ChatBody | null): number;
	/** Rooms and threads with a local edit that the server has not acknowledged. */
	pending(): string[];
	/** A null copy removes the cache entry. A copy with a null body records a clear. */
	set(key: string, copy: DraftCopy | null): void;
}

/**
 * The changes of the drafts that the storage does not have, by person: a draft, or null for a draft
 * that went away. The browser has no `localStorage`, or refused a write to it. The changes stay in
 * the memory of the page until a write works, or until a reload.
 *
 * The page keeps only its changes, not each draft. So a draft that a different tab wrote to the
 * storage stays when a later write of this page works.
 */
const inMemory = new Map<string, Map<string, Draft | null>>();

/** The drafts of a person in the storage. */
function stored(storage: DraftStorage | null, owner: string): Map<string, Draft> {
	const drafts = new Map<string, Draft>();
	if (!storage) return drafts;
	try {
		const parsed: unknown = JSON.parse(storage.getItem(PREFIX + owner) ?? "{}");
		if (typeof parsed !== "object" || parsed === null) return drafts;
		for (const [roomId, value] of Object.entries(parsed)) {
			const draft = value as (Partial<Draft> & { text?: unknown }) | null;
			if (typeof draft?.at !== "number") continue;
			// The storage is not checked by the contract, so a body that the contract does not take goes.
			// A draft from before the box had formats has the text that the person typed.
			const body =
				draft.body !== undefined
					? ChatBody.safeParse(draft.body).data
					: typeof draft.text === "string" && draft.text !== ""
						? textToBody(draft.text)
						: undefined;
			if (body || (draft.body === null && typeof draft.revision === "number")) {
				drafts.set(roomId, {
					body: body ?? null,
					at: draft.at,
					revision: typeof draft.revision === "number" ? draft.revision : 0,
					dirty: draft.dirty !== false,
				});
			}
		}
	} catch {
		// The browser refused the read, or the value is not from this app. The person has no drafts then.
	}
	return drafts;
}

/** The drafts of a person: the drafts in the storage, with the changes that the storage does not have. */
function read(storage: DraftStorage | null, owner: string): Map<string, Draft> {
	const drafts = stored(storage, owner);
	for (const [roomId, draft] of inMemory.get(owner) ?? []) {
		if (draft === null) drafts.delete(roomId);
		else drafts.set(roomId, draft);
	}
	return drafts;
}

/**
 * Writes the drafts of a person to the storage. `changed` has the rooms that this call changed. When
 * the write fails, the page keeps those changes in its memory.
 */
function write(storage: DraftStorage | null, owner: string, drafts: Map<string, Draft>, changed: string[]): void {
	try {
		if (!storage) throw new Error("no storage");
		if (drafts.size === 0) storage.removeItem(PREFIX + owner);
		else storage.setItem(PREFIX + owner, JSON.stringify(Object.fromEntries(drafts)));
		// The storage has each change now.
		inMemory.delete(owner);
	} catch {
		// The browser has no storage, refused the write, or the storage is full. The changes stay in the
		// memory of the page, so the draft does not go away when the person opens a different room.
		const changes = inMemory.get(owner) ?? new Map<string, Draft | null>();
		const inStorage = stored(storage, owner);
		for (const roomId of changed) {
			const draft = drafts.get(roomId) ?? null;
			// A draft that went away needs a mark only while the storage has that draft. Without this
			// rule, the page keeps a mark for each room that the person wrote in.
			if (draft === null && !inStorage.has(roomId)) changes.delete(roomId);
			else changes.set(roomId, draft);
		}
		if (changes.size === 0) inMemory.delete(owner);
		else inMemory.set(owner, changes);
	}
}

/**
 * The drafts of one person. `storage` is `localStorage`, or null when the browser refuses it. When
 * the browser has no storage, or refuses a write, the drafts stay in the memory of the page.
 *
 * Each call reads the storage again, so a draft from a different tab is not lost, also after a
 * write that failed. Two tabs that change the draft of the same room keep the last change.
 */
export function createDraftStore(storage: DraftStorage | null, owner: string): DraftStore {
	function put(drafts: Map<string, Draft>, roomId: string, copy: DraftCopy | null) {
		const changed = [roomId];
		if (copy === null) drafts.delete(roomId);
		else drafts.set(roomId, { ...copy, at: Date.now() });
		while (drafts.size > MAX_DRAFTS) {
			const entries = [...drafts];
			const synced = entries.filter(([, draft]) => !draft.dirty);
			const oldest = (synced.length ? synced : entries).reduce((first, entry) =>
				entry[1].at < first[1].at ? entry : first,
			);
			drafts.delete(oldest[0]);
			changed.push(oldest[0]);
		}
		write(storage, owner, drafts, changed);
	}
	return {
		get: (key) => read(storage, owner).get(key) ?? null,
		pending: () => [...read(storage, owner)].filter(([, draft]) => draft.dirty).map(([key]) => key),
		set: (key, copy) => put(read(storage, owner), key, copy),
		edit(key, previous, body) {
			const drafts = read(storage, owner);
			const cached = drafts.get(key);
			// Sign-out or another tab can acknowledge the exact body the person is now editing.
			// A different body is a concurrent change and must still go through the conflict check.
			const revision =
				cached && !cached.dirty && cached.revision > previous.revision && sameDraftBody(cached.body, previous.body)
					? cached.revision
					: previous.revision;
			put(drafts, key, { body, revision, dirty: true });
			return revision;
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

/**
 * The key of the draft of a reply in a thread, in the store of the drafts of the rooms. A room id has no
 * "/", so the key of a thread never is the key of a room.
 */
export function threadDraftKey(roomId: string, parentId: string): string {
	return `${roomId}/${parentId}`;
}

/** `localStorage`, or null when the browser refuses it. */
export function draftStorage(): DraftStorage | null {
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}
