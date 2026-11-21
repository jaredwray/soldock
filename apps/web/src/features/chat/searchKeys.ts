import { useEffect, useRef } from "react";

/** Handle a chat shortcut while its view is active. A modal dialog keeps control of the keyboard. */
export function useChatShortcut(key: "f" | "k", action: (() => void) | null): void {
	const handler = useRef(action);

	useEffect(() => {
		handler.current = action;
	});

	const active = action !== null;
	useEffect(() => {
		if (!active) return;
		function onKeyDown(event: KeyboardEvent) {
			if (event.defaultPrevented || event.altKey || event.shiftKey || event.isComposing) return;
			if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== key) return;
			if (document.querySelector("dialog[open]")) return;
			event.preventDefault();
			handler.current?.();
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [active, key]);
}
