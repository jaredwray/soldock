import { type CellFormat, type FormatPatch, SHEET_LIMITS } from "@soldock/contracts";
import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import { Icon, type IconName } from "../../lib/icons.tsx";
import { Menu, type MenuItem } from "../drive/Menu.tsx";
import { SUM_FUNCTIONS, type SumFunction } from "./autosum.ts";
import { CLEAR_FORMAT } from "./formats.ts";

const MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);

/** The tooltip text of a shortcut with Ctrl, or ⌘ on a Mac. */
function command(key: string, shift = false): { keys: string; hint: string } {
	return {
		keys: [MAC ? "Meta" : "Control", ...(shift ? ["Shift"] : []), key].join("+"),
		hint: MAC ? `${shift ? "⇧" : ""}⌘${key}` : `Ctrl+${shift ? "Shift+" : ""}${key}`,
	};
}

/** The shortcut of SUM in the grid, for the tooltip of the Σ menu. */
const SUM_HINT = MAC ? "⌥=" : "Alt+=";

/**
 * The colors of the text color menu. Each one has a contrast of at least 4.5:1 on the light
 * background of a cell, and at least 3.2:1 on the dark background.
 */
const TEXT_COLORS = [
	["Gray", "#6b7280"],
	["Red", "#dc2626"],
	["Orange", "#c2410c"],
	["Yellow", "#a16207"],
	["Green", "#15803d"],
	["Teal", "#0f766e"],
	["Blue", "#2563eb"],
	["Purple", "#9333ea"],
	["Pink", "#db2777"],
] as const;

/** The colors of the fill color menu: light colors, so text on them stays easy to read. */
const FILL_COLORS = [
	["Gray", "#e5e7eb"],
	["Red", "#fee2e2"],
	["Orange", "#ffedd5"],
	["Yellow", "#fef9c3"],
	["Green", "#dcfce7"],
	["Teal", "#ccfbf1"],
	["Blue", "#dbeafe"],
	["Purple", "#f3e8ff"],
	["Pink", "#fce7f3"],
] as const;

/**
 * The name of a color menu with the color of the active cell, so a screen reader tells it: "Text
 * color, Blue". A color that is not in the menu, for example of an agent, is its #rrggbb.
 */
function colorLabel(label: string, palette: readonly (readonly [string, string])[], color: string | undefined): string {
	if (!color) return label;
	return `${label}, ${palette.find(([, value]) => value === color)?.[0] ?? color}`;
}

interface SheetToolbarProps {
	/** The element id of the grid, which the toolbar changes. */
	gridId: string;
	/** True while no edit is possible, for example while the cells of the tab load. The buttons stay in the tab order. */
	disabled: boolean;
	canUndo: boolean;
	canRedo: boolean;
	/** The format of the active cell, which the buttons show. */
	format: CellFormat | undefined;
	/** The digits after the decimal point that the active cell shows now. */
	decimals: number;
	onUndo: () => void;
	onRedo: () => void;
	/** Changes the format of each selected cell. */
	onFormat: (patch: FormatPatch) => void;
	onFunction: (fn: SumFunction) => void;
}

interface ToolProps {
	label: string;
	/** An Iconoir icon, or text such as $ for a tool that Iconoir has no icon for. */
	icon: IconName | { text: string };
	/** The value of aria-keyshortcuts, and the shortcut in the tooltip. */
	shortcut?: { keys: string; hint: string };
	/** For a toggle button: true when it is on. */
	pressed?: boolean;
	enabled: boolean;
	groupStart?: boolean;
	stop: { tabIndex: number; onFocus: () => void };
	onClick: () => void;
}

function Tool({ label, icon, shortcut, pressed, enabled, groupStart, stop, onClick }: ToolProps) {
	return (
		<button
			type="button"
			className={`icon-button icon-button-small format-button${groupStart ? " format-group-start" : ""}${typeof icon === "string" ? "" : " sheet-glyph-button"}`}
			aria-label={label}
			aria-keyshortcuts={shortcut?.keys}
			aria-pressed={pressed}
			// Not the disabled attribute: the button then stays a tab stop of the toolbar.
			aria-disabled={enabled ? undefined : true}
			title={shortcut ? `${label} (${shortcut.hint})` : label}
			tabIndex={stop.tabIndex}
			onFocus={stop.onFocus}
			onClick={() => {
				if (enabled) onClick();
			}}
		>
			{typeof icon === "string" ? <Icon name={icon} size={18} /> : <span aria-hidden="true">{icon.text}</span>}
		</button>
	);
}

/** The icon of a color menu: a glyph with a bar of the color of the active cell under it. */
function ColorIcon({ children, color }: { children: ReactNode; color: string }) {
	return (
		<span className="sheet-color-icon" aria-hidden="true">
			{children}
			<span className="sheet-color-bar" style={{ background: color }} />
		</span>
	);
}

/**
 * The toolbar of the Sheets editor: Undo and Redo, the number formats, bold and italic, the text
 * and fill colors, the alignment, Clear formatting, and the Σ menu of functions. The buttons show
 * the format of the active cell, and a change goes to each selected cell. The toolbar is one tab
 * stop: the arrow keys, Home and End move between its buttons. A click on a button ends an edit
 * first, because the editor of the cell loses the focus.
 */
export function SheetToolbar({
	gridId,
	disabled,
	canUndo,
	canRedo,
	format,
	decimals,
	onUndo,
	onRedo,
	onFormat,
	onFunction,
}: SheetToolbarProps) {
	const [focusIndex, setFocusIndex] = useState(0);
	const barRef = useRef<HTMLDivElement>(null);
	const enabled = !disabled;

	/** The roving tab stop of the control at `index`, in the order of the toolbar. */
	const stop = (index: number) => ({ tabIndex: focusIndex === index ? 0 : -1, onFocus: () => setFocusIndex(index) });

	function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		// An open menu is in the toolbar, and it uses the arrow keys, Home and End itself.
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

	const toggle = (on: boolean, patch: FormatPatch, off: FormatPatch) => () => onFormat(on ? off : patch);
	const currency = format?.number_format === "currency";
	const percent = format?.number_format === "percent";
	const textColors: MenuItem[] = [
		{ key: "auto", label: "Automatic", swatch: "var(--foreground)", onSelect: () => onFormat({ color: null }) },
		...TEXT_COLORS.map(([label, color]) => ({ key: color, label, swatch: color, onSelect: () => onFormat({ color }) })),
	];
	const fillColors: MenuItem[] = [
		{ key: "none", label: "No fill", swatch: "var(--background)", onSelect: () => onFormat({ fill: null }) },
		...FILL_COLORS.map(([label, fill]) => ({ key: fill, label, swatch: fill, onSelect: () => onFormat({ fill }) })),
	];
	const functions: MenuItem[] = SUM_FUNCTIONS.map((fn) => ({ key: fn, label: fn, onSelect: () => onFunction(fn) }));
	const align = (side: "left" | "center" | "right") => toggle(format?.align === side, { align: side }, { align: null });

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
				label="Undo"
				icon="undo"
				shortcut={command("Z")}
				enabled={enabled && canUndo}
				stop={stop(0)}
				onClick={onUndo}
			/>
			<Tool
				label="Redo"
				icon="redo"
				shortcut={MAC ? command("Z", true) : command("Y")}
				enabled={enabled && canRedo}
				stop={stop(1)}
				onClick={onRedo}
			/>
			<Tool
				label="Format as currency"
				icon={{ text: "$" }}
				pressed={currency}
				enabled={enabled}
				groupStart
				stop={stop(2)}
				onClick={toggle(currency, { number_format: "currency" }, { number_format: null })}
			/>
			<Tool
				label="Format as percent"
				icon={{ text: "%" }}
				pressed={percent}
				enabled={enabled}
				stop={stop(3)}
				onClick={toggle(percent, { number_format: "percent" }, { number_format: null })}
			/>
			<Tool
				label="Fewer decimals"
				icon={{ text: ".0" }}
				enabled={enabled && decimals > 0}
				stop={stop(4)}
				onClick={() => onFormat({ decimals: decimals - 1 })}
			/>
			<Tool
				label="More decimals"
				icon={{ text: ".00" }}
				enabled={enabled && decimals < SHEET_LIMITS.decimals}
				stop={stop(5)}
				onClick={() => onFormat({ decimals: decimals + 1 })}
			/>
			<Tool
				label="Bold"
				icon="bold"
				shortcut={command("B")}
				pressed={format?.bold === true}
				enabled={enabled}
				groupStart
				stop={stop(6)}
				onClick={() => onFormat({ bold: format?.bold !== true })}
			/>
			<Tool
				label="Italic"
				icon="italic"
				shortcut={command("I")}
				pressed={format?.italic === true}
				enabled={enabled}
				stop={stop(7)}
				onClick={() => onFormat({ italic: format?.italic !== true })}
			/>
			<Menu
				label={colorLabel("Text color", TEXT_COLORS, format?.color)}
				className="icon-button icon-button-small format-button format-group-start"
				items={textColors}
				align="start"
				unavailable={disabled}
				{...stop(8)}
			>
				<ColorIcon color={format?.color ?? "currentColor"}>
					<span className="sheet-color-letter">A</span>
				</ColorIcon>
			</Menu>
			<Menu
				label={colorLabel("Fill color", FILL_COLORS, format?.fill)}
				className="icon-button icon-button-small format-button"
				items={fillColors}
				align="start"
				unavailable={disabled}
				{...stop(9)}
			>
				<ColorIcon color={format?.fill ?? "transparent"}>
					<Icon name="fill" size={16} />
				</ColorIcon>
			</Menu>
			<Tool
				label="Align left"
				icon="alignLeft"
				pressed={format?.align === "left"}
				enabled={enabled}
				groupStart
				stop={stop(10)}
				onClick={align("left")}
			/>
			<Tool
				label="Align center"
				icon="alignCenter"
				pressed={format?.align === "center"}
				enabled={enabled}
				stop={stop(11)}
				onClick={align("center")}
			/>
			<Tool
				label="Align right"
				icon="alignRight"
				pressed={format?.align === "right"}
				enabled={enabled}
				stop={stop(12)}
				onClick={align("right")}
			/>
			<Tool
				label="Clear formatting"
				icon="clearFormat"
				shortcut={command("\\")}
				enabled={enabled}
				groupStart
				stop={stop(13)}
				onClick={() => onFormat(CLEAR_FORMAT)}
			/>
			<Menu
				label="Functions"
				title={`Functions (SUM: ${SUM_HINT})`}
				className="icon-button icon-button-small format-button format-group-start sheet-glyph-button sheet-sigma-button"
				items={functions}
				align="start"
				unavailable={disabled}
				{...stop(14)}
			>
				<span aria-hidden="true">Σ</span>
			</Menu>
		</div>
	);
}
