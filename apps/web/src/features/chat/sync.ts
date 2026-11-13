import type { ChatMessage } from "@soldock/contracts";

// The sync of one open room. It has no DOM and no network of its own, so apps/web/test checks it.

/** The result of `chat.list_messages` with `changed_after`. */
export interface ChangePage {
	messages: ChatMessage[];
	version: number;
	has_more: boolean;
}

export interface RoomSync {
	/** Sets the version of the room that the page has, after a load. It also starts a sync that stopped. */
	start(version: number): void;
	/**
	 * Takes the version of the room from a room list, and gets the changes when the room is ahead. Call
	 * it for each list, also when the version is the same: a sync that failed then runs again.
	 */
	notice(listedVersion: number): Promise<void>;
	/** Gets the changes now, for example after a change that this page made. */
	run(): Promise<void>;
	/** Stops the sync until the next `start`. A page of changes that arrives before that is dropped. */
	stop(): void;
}

/**
 * Gets each new, changed and deleted message after the version that the page has, and gives them to
 * `apply`. One sync runs at a time. A call during a sync makes the sync run one more time. After a
 * failed read, the version stays, so the next sync asks for the same changes again.
 */
export function createRoomSync(
	read: (changedAfter: number) => Promise<ChangePage>,
	apply: (messages: ChatMessage[]) => void,
): RoomSync {
	let version: number | null = null;
	let running = false;
	let again = false;
	let stopped = false;

	async function run(): Promise<void> {
		if (version === null || stopped) return;
		if (running) {
			again = true;
			return;
		}
		running = true;
		try {
			do {
				again = false;
				let more = true;
				while (more) {
					const page = await read(version);
					if (stopped) return;
					const last = page.messages[page.messages.length - 1];
					more = page.has_more && last !== undefined;
					// A page that is not the last one continues from the version of its last message.
					version = more && last ? last.version : page.version;
					if (page.messages.length > 0) apply(page.messages);
				}
			} while (again);
		} catch {
			// The version did not move. The next room list starts the sync again.
		} finally {
			running = false;
		}
	}

	return {
		start(loaded) {
			version = loaded;
			stopped = false;
		},
		notice(listedVersion) {
			return version !== null && listedVersion > version ? run() : Promise.resolve();
		},
		run,
		stop() {
			stopped = true;
		},
	};
}
