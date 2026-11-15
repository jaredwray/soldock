// The order of the calls that change one message. It has no DOM and no network, so apps/web/test
// checks it.

/**
 * Makes a function that runs the calls for each id one at a time, in the order that it got them. So
 * the room gets the newest change of a message last.
 *
 * A call that waits can start after the page left the room, and after a sign-out. The page sends
 * each call with the session of its person at that time. So a call does not start while `active()`
 * is false: it would be a change by a different person.
 */
export function createCallLine(active: () => boolean): (id: string, call: () => Promise<void>) => void {
	const ends = new Map<string, Promise<void>>();
	return (id, call) => {
		const end = (ends.get(id) ?? Promise.resolve()).then(() => (active() ? call() : undefined));
		ends.set(id, end);
	};
}
