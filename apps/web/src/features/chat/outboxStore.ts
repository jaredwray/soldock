import type { SavedMessage } from "./saved.ts";

// The messages that wait for the server, in IndexedDB, so a message stays after a reload of the
// page. The store has the messages of one person at most. Each function does nothing when the
// browser has no IndexedDB, or refuses it: the messages then stay in the memory of the page only.

const DATABASE = "soldock-chat";
const STORE = "outbox";
const OWNER_INDEX = "owner";

let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
	opening ??= new Promise((resolve) => {
		try {
			const request = indexedDB.open(DATABASE, 1);
			request.onupgradeneeded = () => {
				request.result.createObjectStore(STORE, { keyPath: "key" }).createIndex(OWNER_INDEX, "owner");
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => resolve(null);
			request.onblocked = () => resolve(null);
		} catch {
			resolve(null);
		}
	});
	return opening;
}

/** Runs one request on the store. Null when the browser refuses it. */
async function run<T>(mode: IDBTransactionMode, request: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
	const database = await open();
	if (!database) return null;
	return new Promise((resolve) => {
		try {
			const pending = request(database.transaction(STORE, mode).objectStore(STORE));
			pending.onsuccess = () => resolve(pending.result);
			pending.onerror = () => resolve(null);
		} catch {
			resolve(null);
		}
	});
}

/** The messages of one person that wait, from before the reload. */
export async function loadSaved(owner: string): Promise<SavedMessage[]> {
	return (await run("readonly", (store) => store.index(OWNER_INDEX).getAll(owner))) ?? [];
}

export async function putSaved(record: SavedMessage): Promise<void> {
	await run("readwrite", (store) => store.put(record));
}

export async function removeSaved(key: string): Promise<void> {
	await run("readwrite", (store) => store.delete(key));
}

/**
 * Removes the messages of each person that is not `owner`: all messages when `owner` is null. The
 * text of a message must not stay in the browser after its person signs out.
 */
export async function forgetOthers(owner: string | null): Promise<void> {
	const all = (await run<SavedMessage[]>("readonly", (store) => store.getAll())) ?? [];
	await Promise.all(all.filter((record) => record.owner !== owner).map((record) => removeSaved(record.key)));
}
