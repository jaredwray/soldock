import {
	type ChatBody,
	type ChatBodyBlock,
	DIRECTORY_LIMITS,
	type DirectoryEntry,
	groupMentionOf,
	type InputOf,
	type MentionDirectory,
	mentionKeys,
	type OutputOf,
} from "@asterra/contracts";

// The people and agents that Chat shows, without a read of the whole directory. A view tells the ids and the
// mention handles that it shows (`want`). The store asks the server for the ones that it does not have
// (`directory.get_principals`), and gives the answers as the directory of the views. So the reads follow
// the messages on the page, not the size of the organization. It has no DOM and no network of its own, so
// apps/web/test checks it.

/** The principals of ids and the principals that mention handles name. */
export interface PeopleNeeds {
	ids?: Iterable<string>;
	/** The text after the "@" of a mention: a handle, a full address or a name alias. */
	handles?: Iterable<string>;
}

/** One call of `directory.get_principals`. Its lists are texts with commas: the input of a GET. */
type Lookup = (input: InputOf<"directory.get_principals">) => Promise<OutputOf<"directory.get_principals">>;

/**
 * Takes the first entries of a queue for one call: at most `DIRECTORY_LIMITS.lookupSize` entries, and at
 * most `DIRECTORY_LIMITS.lookupChars` characters with their commas. The first entry always fits.
 */
function takeChunk(queue: string[]): string[] {
	let count = 0;
	let chars = 0;
	for (const entry of queue) {
		if (count === DIRECTORY_LIMITS.lookupSize || chars + entry.length + 1 > DIRECTORY_LIMITS.lookupChars) break;
		count += 1;
		chars += entry.length + 1;
	}
	return queue.splice(0, Math.max(count, 1));
}

export interface People {
	/** The principals and the handles of the answers until now. Each answer gives a new object. */
	directory(): MentionDirectory<DirectoryEntry>;
	/** Asks for each id and each handle that the store does not have and did not ask for. */
	want(needs: PeopleNeeds): void;
	subscribe(listener: () => void): () => void;
}

/** The times that the store sends a failed call again. */
const RETRIES = 2;
/** The wait before the store sends a failed call again, in ms. */
const RETRY_MS = 2000;

/**
 * The directory of the answers. A handle from the server is the handle of one principal, and a full
 * address is always a handle, as in `mentionDirectory`. A name alias is a handle that the server found
 * (`named`). The own handle of a principal also finds it, when no view asked for that handle.
 */
function directoryOf(
	people: ReadonlyMap<string, DirectoryEntry | null>,
	named: ReadonlyMap<string, string | null>,
): MentionDirectory<DirectoryEntry> {
	const byId = new Map<string, DirectoryEntry>();
	const byHandle = new Map<string, DirectoryEntry>();
	const handleOf = new Map<string, string>();
	for (const person of people.values()) {
		if (person === null) continue;
		byId.set(person.id, person);
		if (person.handle === null) continue;
		handleOf.set(person.id, person.handle);
		byHandle.set(person.address.toLowerCase(), person);
		byHandle.set(person.handle, person);
	}
	for (const [handle, id] of named) {
		const person = id === null ? undefined : byId.get(id);
		if (person) byHandle.set(handle, person);
	}
	return { byHandle, handleOf, byId, people: [...byId.values()] };
}

/**
 * The store of the people of a visit of Chat. `lookup` is one call of `directory.get_principals`.
 *
 * - The asks of one render go together: the store waits for the end of the task, so each message of a
 *   list adds to one call.
 * - One call has at most `DIRECTORY_LIMITS.lookupSize` ids and as many handles (`takeChunk`). More wait
 *   for the next call. A handle longer than an address names nobody, so the store does not ask for it.
 * - An answer stays for the life of the store: one visit of Chat. An id or a handle of no principal
 *   stays too, so the store does not ask for a deleted principal again.
 * - The store sends a failed call again, `RETRY_MS` after each failure, `RETRIES` times at most. A view
 *   that shows asks one time only, so without this a lost answer hides its people until the view goes.
 *   After the last failure, the ids and handles of the call are open again: the next `want` of one asks
 *   again.
 */
export function createPeople(lookup: Lookup): People {
	/** The answers: the principal of an id, or null for an id of no principal. */
	const people = new Map<string, DirectoryEntry | null>();
	/** The answers: the id of the principal that a handle names, or null. */
	const named = new Map<string, string | null>();
	/** The ids and the handles that wait for a call or for its answer. */
	const asked = { ids: new Set<string>(), handles: new Set<string>() };
	const queue = { ids: [] as string[], handles: [] as string[] };
	const listeners = new Set<() => void>();
	let current = directoryOf(people, named);
	let running = false;

	/** One call, and the same call again after each failure: `RETRIES` times at most, `RETRY_MS` apart. */
	async function lookupWithRetries(input: Parameters<Lookup>[0]): ReturnType<Lookup> {
		for (let failures = 0; ; failures++) {
			try {
				return await lookup(input);
			} catch (error) {
				if (failures === RETRIES) throw error;
				await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
			}
		}
	}

	async function run(): Promise<void> {
		while (queue.ids.length > 0 || queue.handles.length > 0) {
			const ids = queue.ids.length > 0 ? takeChunk(queue.ids) : [];
			const handles = queue.handles.length > 0 ? takeChunk(queue.handles) : [];
			try {
				const answer = await lookupWithRetries({
					...(ids.length > 0 ? { ids: ids.join(",") } : {}),
					...(handles.length > 0 ? { handles: handles.join(",") } : {}),
				});
				for (const id of ids) people.set(id, null);
				for (const person of answer.principals) people.set(person.id, person);
				for (const handle of handles) named.set(handle, null);
				for (const mention of answer.mentions) named.set(mention.handle, mention.principal_id);
				current = directoryOf(people, named);
				for (const listener of listeners) listener();
			} catch {
				// The views show the text of a mention without its link. A later `want` asks again.
			}
			for (const id of ids) asked.ids.delete(id);
			for (const handle of handles) asked.handles.delete(handle);
		}
		running = false;
	}

	return {
		directory: () => current,
		want(needs) {
			for (const id of needs.ids ?? []) {
				if (people.has(id) || asked.ids.has(id)) continue;
				asked.ids.add(id);
				queue.ids.push(id);
			}
			for (const raw of needs.handles ?? []) {
				const handle = raw.toLowerCase();
				// A word of a group ("here", "channel") is never the handle of one principal.
				if (groupMentionOf(handle) || handle.length > DIRECTORY_LIMITS.handleChars) continue;
				if (named.has(handle) || asked.handles.has(handle)) continue;
				asked.handles.add(handle);
				queue.handles.push(handle);
			}
			if (running || (queue.ids.length === 0 && queue.handles.length === 0)) return;
			running = true;
			setTimeout(() => void run(), 0);
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

/**
 * What the body of a message needs to show its mentions: the principals of its mention nodes, and the
 * handles in its texts that can hold a mention (no code, no link). A message without a body (from an
 * older server) has its mentions in its text.
 */
export function bodyPeople(body: ChatBody | undefined, text: string): { ids: string[]; handles: string[] } {
	if (!body) return { ids: [], handles: mentionKeys(text) };
	const ids = new Set<string>();
	const handles = new Set<string>();
	const walk = (blocks: readonly ChatBodyBlock[]) => {
		for (const block of blocks) {
			if (block.type === "paragraph") {
				for (const node of block.content ?? []) {
					if (node.type === "mention") ids.add(node.attrs.id);
					if (node.type !== "text" || !node.text.includes("@")) continue;
					if ((node.marks ?? []).some((mark) => mark.type === "code" || mark.type === "link")) continue;
					for (const key of mentionKeys(node.text)) handles.add(key);
				}
			} else if (block.type === "blockquote") walk(block.content);
			else if (block.type === "bullet_list" || block.type === "ordered_list") {
				for (const item of block.content) walk(item.content);
			}
		}
	};
	walk(body.content);
	return { ids: [...ids], handles: [...handles] };
}
