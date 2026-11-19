// The order of the calls that change one message. It has no DOM and no network, so apps/web/test
// checks it.

/**
 * Makes a function that runs the calls for each id one at a time, in the order that it got them. So
 * the room gets the newest change of a message last.
 *
 * A call that waits can start after the page left the room, and after a sign-out. The page sends
 * each call with the session of its person at that time. So a call does not start while `active()`
 * is false: it would be a change in a different session, and possibly by a different person.
 */
export function createCallLine(active: () => boolean): (id: string, call: () => Promise<void>) => void {
	const ends = new Map<string, Promise<void>>();
	return (id, call) => {
		const end = (ends.get(id) ?? Promise.resolve()).then(() => (active() ? call() : undefined));
		ends.set(id, end);
	};
}

/**
 * Makes a function for the calls of a toggle, such as a reaction: add or remove, for each key.
 *
 * - A call of the same kind as the call that runs for the key does nothing. So a double click on an emoji
 *   sends one call, and one reaction counts one time.
 * - A call of the other kind waits for the call that runs, then goes out. The socket of the room can show
 *   a reaction before the answer of its call. A click to remove it then must not get lost, and the room must
 *   get the add first.
 */
export function createToggleLine(): (key: string, add: boolean, call: () => Promise<void>) => void {
	const running = new Map<string, { add: boolean; end: Promise<void> }>();
	return (key, add, call) => {
		const current = running.get(key);
		if (current?.add === add) return;
		const end: Promise<void> = (current?.end ?? Promise.resolve()).then(call).finally(() => {
			if (running.get(key)?.end === end) running.delete(key);
		});
		running.set(key, { add, end });
	};
}
