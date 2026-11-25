// A page with text that the server does not have can ask before the app leaves it. The router asks each
// guard before it changes the route. The Back button of the browser does not ask: a popstate event cannot stop.

const guards = new Set<() => boolean>();

/** Adds a guard. It returns false to keep the page, for example after the person refuses a question. Returns the function that removes it. */
export function addNavigationGuard(guard: () => boolean): () => void {
	guards.add(guard);
	return () => {
		guards.delete(guard);
	};
}

/** True when each guard lets the app change the route. The first guard that refuses ends the check. */
export function navigationAllowed(): boolean {
	for (const guard of guards) {
		if (!guard()) return false;
	}
	return true;
}
