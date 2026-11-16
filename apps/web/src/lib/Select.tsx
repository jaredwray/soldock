import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./icons.tsx";
import { type ListboxOption, matchIndex, moveIndex, stepIndex } from "./listbox.ts";

export interface SelectOption<T extends string> extends ListboxOption {
	value: T;
	label: string;
	/** Muted text after the label, for example the address of a person. */
	description?: string;
}

interface SelectProps<T extends string> {
	value: T;
	options: readonly SelectOption<T>[];
	/** Called when the user chooses an option with a different value. */
	onChange: (value: T) => void;
	/** The id of the button, for a `<label htmlFor>`. */
	id?: string | undefined;
	/** The accessible name, when no label element names the control. */
	label?: string | undefined;
	/** The text of the button when no option has the value. */
	placeholder?: string | undefined;
	/** The class of the button. The default `input` gives it the look of a text field. */
	className?: string;
	/** An icon before the text of the button. */
	icon?: IconName;
	title?: string | undefined;
	disabled?: boolean;
	"aria-describedby"?: string | undefined;
	/** The control gets the focus first when a `Dialog` opens. */
	"data-autofocus"?: boolean;
}

const GAP = 4;
const EDGE = 8;
/** The time in milliseconds after which the typed text starts again. */
const TYPEAHEAD_MS = 500;

/**
 * A button that opens a list of options: the "select-only combobox" of the WAI-ARIA Authoring
 * Practices. The focus stays on the button, and `aria-activedescendant` gives the current option.
 *
 * - The arrow keys, Enter and Space open the list. Home and End open it at the first or the last
 *   option. A letter opens it at the first option that starts with that letter.
 * - In the list, the arrow keys, Home, End, Page Up, Page Down and the typed text move between the
 *   options. Enter, Space and a click choose an option. Escape and Tab close the list and keep the
 *   value.
 *
 * The list has a fixed position, so a container that scrolls cannot cut it. It goes into the open
 * `<dialog>` of the button, or else into `<body>`, so that a modal dialog does not make it inert.
 */
export function Select<T extends string>({
	value,
	options,
	onChange,
	id,
	label,
	placeholder,
	className = "input",
	icon,
	title,
	disabled = false,
	"aria-describedby": describedBy,
	"data-autofocus": autofocus,
}: SelectProps<T>) {
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(-1);
	const [host, setHost] = useState<HTMLElement | null>(null);
	const [listName, setListName] = useState<string>();
	const buttonRef = useRef<HTMLButtonElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const typed = useRef({ text: "", time: 0 });
	const listId = useId();

	const selectedIndex = options.findIndex((option) => option.value === value);
	const selected = options[selectedIndex];

	function show(index: number) {
		const button = buttonRef.current;
		if (disabled || !button) return;
		setHost(button.closest("dialog") ?? document.body);
		// The list has the name of the control: the `label` prop, or else the text of its label element.
		setListName(label ?? button.labels?.item(0)?.textContent?.trim() ?? placeholder);
		setActive(index);
		setOpen(true);
		// Safari does not focus a button on a click. The keys go to the button.
		button.focus({ preventScroll: true });
	}

	/** The option that the list opens at: the chosen option, or else the first that is not disabled. */
	function startIndex(): number {
		return selected && !selected.disabled ? selectedIndex : stepIndex(options, -1, 1);
	}

	function choose(index: number) {
		const option = options[index];
		if (!option || option.disabled) return;
		setOpen(false);
		if (option.value !== value) onChange(option.value);
	}

	function typeahead(letter: string, from: number): number {
		const now = Date.now();
		const text = now - typed.current.time > TYPEAHEAD_MS ? letter : typed.current.text + letter;
		typed.current = { text, time: now };
		return matchIndex(options, from, text);
	}

	function typing(): boolean {
		return typed.current.text !== "" && Date.now() - typed.current.time <= TYPEAHEAD_MS;
	}

	// A control that becomes disabled, for example while a request runs, closes its list.
	useEffect(() => {
		if (disabled) setOpen(false);
	}, [disabled]);

	// The list goes below the button, or above it when the window has more room there. It is at
	// least as wide as the button, and it scrolls when the window has no room for each option.
	useLayoutEffect(() => {
		const button = buttonRef.current;
		const list = listRef.current;
		if (!open || !button || !list) return;
		function place() {
			if (!button || !list) return;
			const anchor = button.getBoundingClientRect();
			list.style.maxHeight = "";
			list.style.minWidth = `${anchor.width}px`;
			const height = list.offsetHeight;
			const width = list.offsetWidth;
			const below = window.innerHeight - anchor.bottom - GAP - EDGE;
			const above = anchor.top - GAP - EDGE;
			const down = height <= below || below >= above;
			const room = Math.max(0, Math.min(height, down ? below : above));
			list.style.maxHeight = `${room}px`;
			list.style.top = `${down ? anchor.bottom + GAP : anchor.top - GAP - room}px`;
			list.style.left = `${Math.max(EDGE, Math.min(anchor.left, window.innerWidth - width - EDGE))}px`;
			list.style.visibility = "visible";
		}
		place();
		// The list follows the button when the page scrolls or the window changes size. A scroll of
		// the list itself does not move it.
		function onScroll(event: Event) {
			if (!(event.target instanceof Node && list?.contains(event.target))) place();
		}
		window.addEventListener("resize", place);
		window.addEventListener("scroll", onScroll, true);
		return () => {
			window.removeEventListener("resize", place);
			window.removeEventListener("scroll", onScroll, true);
		};
	}, [open]);

	// The current option stays in view in a list that scrolls.
	useLayoutEffect(() => {
		const list = listRef.current;
		const option = open && active >= 0 ? list?.children[active] : undefined;
		if (!list || !(option instanceof HTMLElement)) return;
		const top = option.offsetTop - GAP;
		const bottom = option.offsetTop + option.offsetHeight + GAP;
		if (top < list.scrollTop) list.scrollTop = top;
		else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
	}, [open, active]);

	// A press outside the button and the list closes the list. iOS does not move the focus for a tap
	// on text, so the blur of the button is not sufficient.
	useEffect(() => {
		if (!open) return;
		function onPointerDown(event: PointerEvent) {
			const target = event.target;
			if (!(target instanceof Node)) return;
			if (!listRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
		}
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [open]);

	function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
		const { key } = event;
		const letter = key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
		if (!open) {
			if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") {
				event.preventDefault();
				show(startIndex());
			} else if (key === "Home" || key === "End") {
				event.preventDefault();
				show(moveIndex(options, -1, key) ?? -1);
			} else if (letter) {
				event.preventDefault();
				const match = typeahead(key, selectedIndex);
				show(match >= 0 ? match : startIndex());
			}
			return;
		}
		if (key === "Escape") {
			// Only the list closes, not a dialog around it.
			event.preventDefault();
			event.stopPropagation();
			setOpen(false);
		} else if (key === "Tab") {
			setOpen(false);
		} else if (key === "Enter" || (key === " " && !typing()) || (event.altKey && key === "ArrowUp")) {
			event.preventDefault();
			choose(active);
		} else if (letter) {
			event.preventDefault();
			const match = typeahead(key, active);
			if (match >= 0) setActive(match);
		} else {
			const next = moveIndex(options, active, key);
			if (next === null) return;
			event.preventDefault();
			if (next >= 0) setActive(next);
		}
	}

	return (
		<>
			<button
				ref={buttonRef}
				id={id}
				type="button"
				role="combobox"
				className={`select-trigger ${className}`}
				aria-label={label}
				aria-describedby={describedBy}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-controls={open ? listId : undefined}
				aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
				title={title}
				disabled={disabled}
				data-autofocus={autofocus || undefined}
				// The button keeps the focus, so a click on it cannot close the list with a blur first.
				onMouseDown={(event) => event.preventDefault()}
				onClick={() => (open ? setOpen(false) : show(startIndex()))}
				onKeyDown={onKeyDown}
				// Space opens the list on the key press. The release must not click the button again.
				onKeyUp={(event) => {
					if (event.key === " ") event.preventDefault();
				}}
				onBlur={() => setOpen(false)}
			>
				{icon && <Icon name={icon} size={18} className="select-icon" />}
				{selected ? (
					<span className="select-value">
						{selected.label}
						{selected.description && <span className="select-description"> {selected.description}</span>}
					</span>
				) : (
					<span className="select-value select-placeholder">{placeholder}</span>
				)}
				<Icon name="chevronDown" size={16} className="select-chevron" />
			</button>
			{open &&
				host &&
				createPortal(
					<div
						ref={listRef}
						id={listId}
						role="listbox"
						aria-label={listName}
						className="select-list"
						// A press in the list keeps the focus on the button.
						onMouseDown={(event) => event.preventDefault()}
					>
						{options.map((option, index) => {
							const isSelected = option.value === value;
							return (
								// biome-ignore lint/a11y/useKeyWithClickEvents: the keys go to the button, as the ARIA combobox pattern asks.
								<div
									key={option.value}
									id={`${listId}-${index}`}
									role="option"
									tabIndex={-1}
									aria-selected={isSelected}
									aria-disabled={option.disabled || undefined}
									className={index === active ? "select-option select-option-active" : "select-option"}
									onPointerMove={() => {
										if (!option.disabled && index !== active) setActive(index);
									}}
									onClick={() => choose(index)}
								>
									<span className="select-option-text">
										{option.label}
										{option.description && <span className="select-description"> {option.description}</span>}
									</span>
									{isSelected && <Icon name="check" size={16} className="select-check" />}
								</div>
							);
						})}
					</div>,
					host,
				)}
		</>
	);
}
