import { useLayoutEffect, useRef } from "react";

// The focus after the X of a chip or of a link preview, so a keyboard keeps its place in the page.

/**
 * After the X of an item of a list, the focus goes to the X of the next item, or to `away` when no item
 * follows. The item goes when the list changes, so the focus moves at that time.
 */
export function useFocusAfterRemove<T>(items: readonly T[], keyOf: (item: T) => string, away: () => void) {
	const list = useRef<HTMLUListElement>(null);
	const removed = useRef<{ key: string; index: number } | null>(null);
	useLayoutEffect(() => {
		const pending = removed.current;
		if (!pending || items.some((item) => keyOf(item) === pending.key)) return;
		removed.current = null;
		const next = list.current?.querySelectorAll<HTMLButtonElement>("[data-remove]")[pending.index];
		if (next) next.focus();
		else away();
	});
	return {
		list,
		/** Call it before the item goes. */
		removing(key: string, index: number) {
			removed.current = { key, index };
		},
	};
}
