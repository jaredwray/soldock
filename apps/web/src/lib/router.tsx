import { type AnchorHTMLAttributes, type MouseEvent, type Ref, useSyncExternalStore } from "react";

// A small router on the History API. The dock Worker serves index.html for each app path, so a
// deep link works on reload.

const NAVIGATE_EVENT = "soldock:navigate";

function subscribe(callback: () => void): () => void {
	window.addEventListener("popstate", callback);
	window.addEventListener(NAVIGATE_EVENT, callback);
	return () => {
		window.removeEventListener("popstate", callback);
		window.removeEventListener(NAVIGATE_EVENT, callback);
	};
}

function snapshot(): string {
	return window.location.pathname + window.location.search;
}

/** The path and the query string of the current location, for example `/mail/search?q=invoice`. */
export function useLocation(): string {
	return useSyncExternalStore(subscribe, snapshot);
}

export function navigate(to: string, options: { replace?: boolean } = {}): void {
	if (to === snapshot()) return;
	if (options.replace) window.history.replaceState(null, "", to);
	else window.history.pushState(null, "", to);
	window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
	to: string;
	ref?: Ref<HTMLAnchorElement>;
};

/** An anchor that changes the route without a page load. A modified click still opens a new tab. */
export function Link({ to, onClick, ...props }: LinkProps) {
	function handleClick(event: MouseEvent<HTMLAnchorElement>) {
		onClick?.(event);
		if (event.defaultPrevented || event.button !== 0) return;
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		event.preventDefault();
		navigate(to);
	}
	return <a {...props} href={to} onClick={handleClick} />;
}
