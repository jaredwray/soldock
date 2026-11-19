import type { ChatMessage } from "@asterra/contracts";

// The sync of one open room. It has no DOM and no network of its own, so apps/web/test checks it.

/** The result of `chat.list_messages` with `changed_after`. */
export interface ChangePage {
	messages: ChatMessage[];
	version: number;
	has_more: boolean;
}

export interface RoomSync {
	/**
	 * Sets the version of the room that the page has, after a load of the room. It also starts a sync
	 * that stopped. Call it in the same step as the list of that load goes on the page.
	 */
	start(version: number): void;
	/**
	 * Takes the version of the room from a room list, and gets the changes when the room is ahead. Call
	 * it for each list, also when the version is the same: a sync that failed then runs again.
	 */
	notice(listedVersion: number): Promise<void>;
	/** Gets the changes now, for example after a change that this page made. */
	run(): Promise<void>;
	/**
	 * Takes one message from the socket of the room, or from the answer of an operation. The message
	 * shows at once. When its version is the next version of the room, the page is current, and no read
	 * runs. When it is later than that, the page did not get a change, and a sync gets it.
	 */
	push(message: ChatMessage): void;
	/**
	 * Tells the sync that the page got messages as they were at `version` of the room, for example a
	 * page of older messages. When the sync is after that version, it reads the changes after that
	 * version again: the page did not keep a change to a message that it did not have at that time.
	 */
	rewind(version: number): void;
	/** Stops the sync until the next `start`. A page of changes that arrives before that is dropped. */
	stop(): void;
}

/**
 * Gets each new, changed and deleted message after the version that the page has, and gives them to
 * `apply`. `apply` can get the same message two times: from `push` and from a read. One sync runs at
 * a time. A call during a sync makes the sync run one more time. After a failed read, the version
 * stays, so the next sync asks for the same changes again. A page that was read before a new `start`
 * or a `rewind` is dropped, and the sync reads again from the new version: that page was for the
 * version from before.
 */
export function createRoomSync(
	read: (changedAfter: number) => Promise<ChangePage>,
	apply: (messages: ChatMessage[]) => void,
): RoomSync {
	let version: number | null = null;
	let running = false;
	let again = false;
	let stopped = false;
	/** The number of starts and rewinds. A read knows from it that the version changed during the read. */
	let starts = 0;

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
					const startsBefore = starts;
					const page = await read(version);
					if (stopped) return;
					if (startsBefore !== starts) {
						again = true;
						break;
					}
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
			starts += 1;
		},
		notice(listedVersion) {
			return version !== null && listedVersion > version ? run() : Promise.resolve();
		},
		run,
		push(message) {
			if (version === null || stopped || message.version <= version) return;
			apply([message]);
			// A sync that runs read the room before this message, or reads it now. It must run again.
			if (!running && message.version === version + 1) version = message.version;
			else void run();
		},
		rewind(to) {
			if (version === null || stopped || to >= version) return;
			version = to;
			// A read that runs now is for the later version. The sync drops it, and reads from this one.
			starts += 1;
			void run();
		},
		stop() {
			stopped = true;
		},
	};
}
