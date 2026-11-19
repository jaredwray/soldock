import type { ChatMessage, ChatRoom } from "@asterra/contracts";

// The last list of each room that the page showed. A room that opens again shows that list at once,
// before the answer of the server. It has no DOM and no network, so apps/web/test checks it.

/** The largest number of rooms in the cache. Above it, the room that the person opened the longest time ago goes out. */
const ROOMS_MAX = 20;

/** The newest messages of a room, as the page showed them last. */
export interface CachedRoom {
	room: ChatRoom;
	messages: ChatMessage[];
	/** True when the room has messages before the first message of the list. */
	hasOlder: boolean;
}

export interface RoomCache {
	/** The last list of a room of a person, or null. The room is then the newest room of the cache. */
	get(owner: string, roomId: string): CachedRoom | null;
	/**
	 * Keeps the list of a room. `mark` is the mark of the load that the list is from: the last load of
	 * the room that gave its messages to the person.
	 */
	put(owner: string, roomId: string, entry: CachedRoom, mark: number): void;
	/** A new mark, higher than each mark before it. Take one when a load of a room starts. */
	mark(): number;
	/**
	 * Removes the list of a room after a load that failed, or that found that the person is not a
	 * member of the room now. `mark` is the mark of that load. A list from a load that started later
	 * stays: the answer of that load is the newer fact.
	 */
	remove(owner: string, roomId: string, mark: number): void;
	/** Removes each list. The lists of a person must not stay for the next person of the page. */
	clear(): void;
}

/**
 * Makes a cache of the last list of each room, in the memory of the page. A list has the person that
 * it is for: a different person on the same page never gets it.
 */
export function createRoomCache(): RoomCache {
	// A Map keeps the order of its entries. The first entry is the room that was used the longest time ago.
	const entries = new Map<string, { entry: CachedRoom; mark: number }>();
	/** The last mark. */
	let marks = 0;
	const name = (owner: string, roomId: string) => `${owner}/${roomId}`;
	return {
		get(owner, roomId) {
			const key = name(owner, roomId);
			const kept = entries.get(key);
			if (!kept) return null;
			entries.delete(key);
			entries.set(key, kept);
			return kept.entry;
		},
		put(owner, roomId, entry, mark) {
			const key = name(owner, roomId);
			entries.delete(key);
			entries.set(key, { entry, mark });
			while (entries.size > ROOMS_MAX) {
				const oldest = entries.keys().next().value;
				if (oldest === undefined) break;
				entries.delete(oldest);
			}
		},
		mark() {
			marks += 1;
			return marks;
		},
		remove(owner, roomId, mark) {
			const key = name(owner, roomId);
			const kept = entries.get(key);
			if (kept && kept.mark <= mark) entries.delete(key);
		},
		clear() {
			entries.clear();
		},
	};
}
