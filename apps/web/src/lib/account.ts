// The person of the page, for code that is not below the signed-in app. It has no DOM, so
// apps/web/test checks it.

let account: string | null = null;
const listeners = new Set<() => void>();

/** The id of the signed-in person, or null while nobody is signed in. */
export function currentAccount(): string | null {
	return account;
}

/**
 * Sets the signed-in person. The app calls it in the same step as it shows a sign-in or a sign-out.
 * Each listener runs when the person changes, also to nobody.
 */
export function setAccount(next: string | null): void {
	if (next === account) return;
	account = next;
	for (const listener of listeners) listener();
}

/**
 * Calls `listener` when the signed-in person changes. Work that waits for one person must stop then:
 * the page sends each later call with the session of the new person. Returns a function that removes
 * the listener.
 */
export function onAccountChange(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
