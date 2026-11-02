import { useEffect, useRef } from "react";

/** The properties of an element that `isTypingTarget` reads. Each HTMLElement has them. */
export interface KeyTarget {
	readonly tagName: string;
	readonly isContentEditable: boolean;
	/** The type of an input element. An input element without a type is a text field. */
	readonly type?: string;
}

/** Input types that take no text. A key press on one of them can be a shortcut. */
const NON_TEXT_INPUTS: readonly string[] = ["checkbox", "radio", "button", "submit", "reset", "file"];

/** True when a key press goes to a text field, so a shortcut must not act on it. */
export function isTypingTarget(target: KeyTarget): boolean {
	if (target.isContentEditable) return true;
	const tag = target.tagName.toUpperCase();
	if (tag === "TEXTAREA" || tag === "SELECT") return true;
	if (tag === "INPUT") return !NON_TEXT_INPUTS.includes(target.type ?? "text");
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
			if (event.target instanceof HTMLElement && isTypingTarget(event.target)) return;
			if (document.querySelector("dialog[open]")) return;
			handlerRef.current(event);
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);
}
