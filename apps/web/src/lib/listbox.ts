// The keyboard model of a list box. These functions are pure, so the tests need no DOM.

/** An option of a list box. A disabled option shows in the list, but the keys and the pointer skip it. */
export interface ListboxOption {
	readonly label: string;
	readonly disabled?: boolean;
}

/** The number of options that Page Up and Page Down move. */
const PAGE = 10;

/**
 * The option `delta` steps from `from`, or the nearest option after it that is not disabled. The
 * move stops at the first and the last option. If each option in the direction of the move is
 * disabled, the result is the nearest option in the other direction. -1 when no option can get
 * the focus.
 */
export function stepIndex(options: readonly ListboxOption[], from: number, delta: number): number {
	const last = options.length - 1;
	const target = Math.max(0, Math.min(last, from + delta));
	const direction = delta >= 0 ? 1 : -1;
	for (let index = target; index >= 0 && index <= last; index += direction) {
		if (!options[index]?.disabled) return index;
	}
	for (let index = target - direction; index >= 0 && index <= last; index -= direction) {
		if (!options[index]?.disabled) return index;
	}
	return -1;
}

/**
 * The option that a navigation key moves to from the `active` option: the arrow keys, Home, End,
 * Page Up and Page Down. Null for a different key, so the key keeps its usual action.
 */
export function moveIndex(options: readonly ListboxOption[], active: number, key: string): number | null {
	switch (key) {
		case "ArrowDown":
			return stepIndex(options, active, 1);
		case "ArrowUp":
			return stepIndex(options, active < 0 ? options.length : active, -1);
		case "Home":
			return stepIndex(options, -1, 1);
		case "End":
			return stepIndex(options, options.length, -1);
		case "PageDown":
			return stepIndex(options, active, PAGE);
		case "PageUp":
			return stepIndex(options, active < 0 ? options.length : active, -PAGE);
		default:
			return null;
	}
}

/**
 * The option for the text that the user types quickly, with no attention to case. A new word can
 * stay on the `from` option when it matches. One letter, or the same letter again and again, goes
 * to the next option that starts with that letter, so each press of "e" goes to the next "E…".
 * The search continues from the start of the list. -1 when no option matches.
 */
export function matchIndex(options: readonly ListboxOption[], from: number, typed: string): number {
	const text = typed.toLocaleLowerCase();
	const first = text[0];
	if (first === undefined) return -1;
	const repeated = [...text].every((letter) => letter === first);
	const prefix = repeated ? first : text;
	const start = from < 0 ? 0 : from + (repeated ? 1 : 0);
	for (let step = 0; step < options.length; step++) {
		const index = (start + step) % options.length;
		const option = options[index];
		if (option && !option.disabled && option.label.toLocaleLowerCase().startsWith(prefix)) return index;
	}
	return -1;
}
