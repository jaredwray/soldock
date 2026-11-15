import { type KeyboardEvent, useRef, useState } from "react";
import { Icon, type IconName } from "../../lib/icons.tsx";
import { Menu, type MenuItem } from "../drive/Menu.tsx";
import { SUM_FUNCTIONS, type SumFunction } from "./autosum.ts";

const MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);

/** The shortcut of SUM in the grid, for the tooltip of the Σ menu. */
const SUM_HINT = MAC ? "⌥=" : "Alt+=";

interface SheetToolbarProps {
	/** The element id of the grid, which the toolbar changes. */
	gridId: string;
	/** True while no edit is possible, for example while the cells of the tab load. The buttons stay in the tab order. */
	disabled: boolean;
	canUndo: boolean;
	canRedo: boolean;
	onUndo: () => void;
	onRedo: () => void;
	onFunction: (fn: SumFunction) => void;
}

interface ToolProps {
	name: string;
	icon: IconName;
	/** The value of aria-keyshortcuts, and the shortcut in the tooltip. */
	keys: string;
	hint: string;
	enabled: boolean;
	tabIndex: number;
	onFocus: () => void;
	onClick: () => void;
}

function Tool({ name, icon, keys, hint, enabled, tabIndex, onFocus, onClick }: ToolProps) {
	return (
		<button
			type="button"
			className="icon-button icon-button-small format-button"
			aria-label={name}
			aria-keyshortcuts={keys}
			// Not the disabled attribute: the button then stays a tab stop of the toolbar.
			aria-disabled={enabled ? undefined : true}
			title={`${name} (${hint})`}
			tabIndex={tabIndex}
			onFocus={onFocus}
			onClick={() => {
				if (enabled) onClick();
			}}
		>
			<Icon name={icon} size={18} />
		</button>
	);
}

/**
 * The toolbar of the Sheets editor: Undo, Redo and the Σ menu of functions. The toolbar is one tab
 * stop: the arrow keys, Home and End move between its buttons. A click on a button ends an edit
 * first, because the editor of the cell loses the focus.
 */
export function SheetToolbar({ gridId, disabled, canUndo, canRedo, onUndo, onRedo, onFunction }: SheetToolbarProps) {
	const [focusIndex, setFocusIndex] = useState(0);
	const barRef = useRef<HTMLDivElement>(null);

	function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		// The open menu of Σ is in the toolbar, and it uses the arrow keys, Home and End itself.
		if (event.target instanceof Element && event.target.closest('[role="menu"]')) return;
		const buttons = [...(barRef.current?.querySelectorAll<HTMLElement>(":scope > button") ?? [])];
		const last = buttons.length - 1;
		const moves: Record<string, number> = {
			ArrowRight: focusIndex >= last ? 0 : focusIndex + 1,
			ArrowLeft: focusIndex <= 0 ? last : focusIndex - 1,
			Home: 0,
			End: last,
		};
		const next = moves[event.key];
		if (next === undefined) return;
		event.preventDefault();
		setFocusIndex(next);
		buttons[next]?.focus();
	}

	const functions: MenuItem[] = SUM_FUNCTIONS.map((fn) => ({ key: fn, label: fn, onSelect: () => onFunction(fn) }));

	return (
		<div
			ref={barRef}
			role="toolbar"
			aria-label="Sheet tools"
			aria-controls={gridId}
			className="editor-toolbar"
			onKeyDown={onKeyDown}
		>
			<Tool
				name="Undo"
				icon="undo"
				keys={MAC ? "Meta+Z" : "Control+Z"}
				hint={MAC ? "⌘Z" : "Ctrl+Z"}
				enabled={!disabled && canUndo}
				tabIndex={focusIndex === 0 ? 0 : -1}
				onFocus={() => setFocusIndex(0)}
				onClick={onUndo}
			/>
			<Tool
				name="Redo"
				icon="redo"
				keys={MAC ? "Meta+Shift+Z" : "Control+Y"}
				hint={MAC ? "⇧⌘Z" : "Ctrl+Y"}
				enabled={!disabled && canRedo}
				tabIndex={focusIndex === 1 ? 0 : -1}
				onFocus={() => setFocusIndex(1)}
				onClick={onRedo}
			/>
			<Menu
				label="Functions"
				title={`Functions (SUM: ${SUM_HINT})`}
				className="icon-button icon-button-small format-button format-group-start sheet-function-button"
				items={functions}
				align="start"
				unavailable={disabled}
				tabIndex={focusIndex === 2 ? 0 : -1}
				onFocus={() => setFocusIndex(2)}
			>
				<span aria-hidden="true">Σ</span>
			</Menu>
		</div>
	);
}
