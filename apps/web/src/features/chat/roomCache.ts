import type { ChatMessage, ChatRoom } from "@soldock/contracts";

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
	put(owner: string, roomId: string, entry: CachedRoom): void;
	/** Removes the list of a room, for example when the person is not a member of the room now. */
	remove(owner: string, roomId: string): void;
	/** Removes each list. The lists of a person must not stay for the next person of the page. */
	clear(): void;
}

/**
 * Makes a cache of the last list of each room, in the memory of the page. A list has the person that
 * it is for: a different person on the same page never gets it.
 */
export function createRoomCache(): RoomCache {
	// A Map keeps the order of its entries. The first entry is the room that was used the longest time ago.
	const entries = new Map<string, CachedRoom>();
	const name = (owner: string, roomId: string) => `${owner}/${roomId}`;
	return {
		get(owner, roomId) {
			const key = name(owner, roomId);
			const entry = entries.get(key);
			if (!entry) return null;
			entries.delete(key);
			entries.set(key, entry);
			return entry;
		},
		put(owner, roomId, entry) {
			const key = name(owner, roomId);
			entries.delete(key);
			entries.set(key, entry);
			while (entries.size > ROOMS_MAX) {
				const oldest = entries.keys().next().value;
				if (oldest === undefined) break;
				entries.delete(oldest);
			}
		},
		remove(owner, roomId) {
			entries.delete(name(owner, roomId));
		},
		clear() {
			entries.clear();
		},
	};
}
