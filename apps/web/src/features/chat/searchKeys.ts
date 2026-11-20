import { useEffect, useRef } from "react";

/**
 * Calls `onSearch` for Ctrl+F and ⌘F, the keys that open the search of Chat. A search of the browser finds
 * only the messages that show, so Chat takes these keys. While a dialog is open, the keys stay with the
 * browser. `null` takes no key: a different part of the page handles them.
 */
export function useSearchKeys(onSearch: (() => void) | null): void {
	const handler = useRef(onSearch);

	useEffect(() => {
		handler.current = onSearch;
	});

	const active = onSearch !== null;
	useEffect(() => {
		if (!active) return;
		function onKeyDown(event: KeyboardEvent) {
			if (event.defaultPrevented || event.altKey || event.shiftKey || event.isComposing) return;
			if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "f") return;
			if (document.querySelector("dialog[open]")) return;
			event.preventDefault();
			handler.current?.();
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [active]);
}
