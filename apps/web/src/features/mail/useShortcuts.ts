import { useEffect, useRef } from "react";

/** True when a key press goes to a text field, so a shortcut must not act on it. */
export function isTypingTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
	if (target instanceof HTMLInputElement) {
		return !["checkbox", "radio", "button", "submit", "reset", "file"].includes(target.type);
	}
	return false;
}

/**
 * Sends single-key shortcuts to `handler`. Keys with Ctrl, Alt or Meta, keys in a text field, and
 * keys while a modal dialog is open do not reach it. The handler calls preventDefault for a key that
 * it uses.
 */
export function useShortcuts(handler: (event: KeyboardEvent) => void): void {
	const handlerRef = useRef(handler);

	useEffect(() => {
		handlerRef.current = handler;
	});

	useEffect(() => {
		function onKeyDown(event: KeyboardEvent) {
			if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
			if (isTypingTarget(event.target)) return;
			if (document.querySelector("dialog[open]")) return;
			handlerRef.current(event);
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);
}
