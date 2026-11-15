import {
	type Cell,
	type CellFormat,
	type FormatPatch,
	formatCellNumber,
	patchFormat,
	SHEET_LIMITS,
	type Tab,
} from "@soldock/contracts";
import { type CellPosition, cellName, ErrorValue, parseCellName, type TabInputs, type Value } from "./formula.ts";

// The stored form of a sheet and its output form. A sheet has one or more tabs. Each tab stores the
// input of each cell that is not empty, and the format of each cell that has one, by cell name. The
// results are never stored: each read calculates them.

/** A tab in memory: the inputs that the engine calculates, and the format of each cell that has one. */
export interface SheetTab extends TabInputs {
	formats: ReadonlyMap<string, CellFormat>;
}

/** A sheet in memory: its tabs in order, and the number of the next new tab id. */
export interface Workbook {
	tabs: SheetTab[];
	nextTab: number;
}

/**
 * The stored JSON. The first layer stored `{ cells }` with one grid: that is one tab, Sheet1. A tab
 * without a format has no `formats`, so a sheet that nobody formatted keeps the same stored form.
 */
type StoredSheet =
	| {
			tabs: { id: string; name: string; cells: Record<string, string>; formats?: Record<string, CellFormat> }[];
			next_tab: number;
	  }
	| { cells: Record<string, string> };

/** The name of the first tab of a new sheet. */
export const FIRST_TAB_NAME = "Sheet1";

function firstTab(cells: Record<string, string>): Workbook {
	return {
		tabs: [{ id: "tab_1", name: FIRST_TAB_NAME, inputs: new Map(Object.entries(cells)), formats: new Map() }],
		nextTab: 2,
	};
}

/** The sheet from the stored JSON. A sheet that nobody wrote has one empty tab. */
export function readWorkbook(content: string | null): Workbook {
	if (content === null) return firstTab({});
	const stored = JSON.parse(content) as StoredSheet;
	if (!("tabs" in stored)) return firstTab(stored.cells);
	return {
		tabs: stored.tabs.map((tab) => ({
			id: tab.id,
			name: tab.name,
			inputs: new Map(Object.entries(tab.cells)),
			formats: new Map(Object.entries(tab.formats ?? {})),
		})),
		nextTab: stored.next_tab,
	};
}

export function storeWorkbook(book: Workbook): string {
	const stored: StoredSheet = {
		tabs: book.tabs.map((tab) => ({
			id: tab.id,
			name: tab.name,
			cells: Object.fromEntries(tab.inputs),
			...(tab.formats.size > 0 ? { formats: Object.fromEntries(tab.formats) } : {}),
		})),
		next_tab: book.nextTab,
	};
	return JSON.stringify(stored);
}

/** The tabs for the output, in order, each with its extent. */
export function toTabs(book: Workbook): Tab[] {
	return book.tabs.map((tab) => ({ id: tab.id, name: tab.name, ...extent(tab.inputs) }));
}

/** The position of a cell name from a call. Throws the message for a name outside the grid. */
export function positionOf(name: string): CellPosition {
	const position = parseCellName(name);
	if (!position) throw new RangeError(`${name} is outside the grid. The last cell is AZ${SHEET_LIMITS.rows}.`);
	return position;
}

/** The first and the last cell of a range such as B2 or A1:D20. Throws the message for a cell outside the grid. */
export function parseRange(range: string): { from: CellPosition; to: CellPosition } {
	const [first, last = first] = range.split(":") as [string, string?];
	const a = positionOf(first);
	const b = positionOf(last);
	return {
		from: { col: Math.min(a.col, b.col), row: Math.min(a.row, b.row) },
		to: { col: Math.max(a.col, b.col), row: Math.max(a.row, b.row) },
	};
}

/** The most cells that one call can format: each cell of a tab. */
export const MAX_FORMAT_CELLS = SHEET_LIMITS.rows * SHEET_LIMITS.columns;

/** The formats after the changes, in order. Throws the message for a cell outside the grid, or for too many cells. */
export function applyFormats(
	formats: ReadonlyMap<string, CellFormat>,
	changes: readonly { range: string; format: FormatPatch }[],
): Map<string, CellFormat> {
	const next = new Map(formats);
	let count = 0;
	for (const change of changes) {
		const { from, to } = parseRange(change.range);
		count += (to.row - from.row + 1) * (to.col - from.col + 1);
		if (count > MAX_FORMAT_CELLS) {
			throw new RangeError(`One call can change the format of at most ${MAX_FORMAT_CELLS} cells.`);
		}
		for (let row = from.row; row <= to.row; row++) {
			for (let col = from.col; col <= to.col; col++) {
				const name = cellName({ col, row });
				const format = patchFormat(next.get(name), change.format);
				if (format) next.set(name, format);
				else next.delete(name);
			}
		}
	}
	return next;
}

/** The inputs after the changes. An empty input clears its cell. */
export function applyChanges(
	inputs: ReadonlyMap<string, string>,
	changes: readonly { cell: string; input: string }[],
): Map<string, string> {
	const next = new Map(inputs);
	for (const change of changes) {
		positionOf(change.cell);
		if (change.input === "") next.delete(change.cell);
		else next.set(change.cell, change.input);
	}
	return next;
}

/** A cell for the output, with its format, and with the text of its number when the format changes it. */
export function toCell(name: string, input: string | undefined, value: Value | undefined, format?: CellFormat): Cell {
	const cell = plainCell(name, input, value);
	if (!format) return cell;
	const text = typeof cell.value === "number" ? formatCellNumber(cell.value, format) : null;
	return text === null ? { ...cell, format } : { ...cell, format, text };
}

function plainCell(name: string, input: string | undefined, value: Value | undefined): Cell {
	if (input === undefined) return { cell: name, input: "", value: null, type: "empty" };
	if (value instanceof ErrorValue) return { cell: name, input, value: value.code, type: "error" };
	if (value === null || value === undefined) return { cell: name, input, value: null, type: "empty" };
	// The output holds finite numbers only. The engine makes no other number, and this keeps a sheet
	// readable if it ever does.
	if (typeof value === "number" && !Number.isFinite(value)) return { cell: name, input, value: "#NUM!", type: "error" };
	return {
		cell: name,
		input,
		value,
		type: typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "text",
	};
}

function byPosition(a: string, b: string): number {
	const first = positionOf(a);
	const second = positionOf(b);
	return first.row - second.row || first.col - second.col;
}

/**
 * The cells of a tab for the output, row by row: each cell with an input or a format. `range` keeps
 * only the cells in it.
 */
export function toCells(
	tab: SheetTab,
	values: ReadonlyMap<string, Value>,
	range?: { from: CellPosition; to: CellPosition },
): Cell[] {
	const names = [...new Set([...tab.inputs.keys(), ...tab.formats.keys()])].filter((name) => {
		if (!range) return true;
		const { col, row } = positionOf(name);
		return col >= range.from.col && col <= range.to.col && row >= range.from.row && row <= range.to.row;
	});
	return names
		.sort(byPosition)
		.map((name) => toCell(name, tab.inputs.get(name), values.get(name), tab.formats.get(name)));
}

/**
 * The cells whose input, result or format is different after a change, also the cells that the
 * change cleared.
 */
export function changedCells(
	before: { tab: SheetTab; values: ReadonlyMap<string, Value> },
	after: { tab: SheetTab; values: ReadonlyMap<string, Value> },
): Cell[] {
	const names = new Set([
		...before.tab.inputs.keys(),
		...after.tab.inputs.keys(),
		...before.tab.formats.keys(),
		...after.tab.formats.keys(),
	]);
	const cells: Cell[] = [];
	for (const name of [...names].sort(byPosition)) {
		const old = toCell(name, before.tab.inputs.get(name), before.values.get(name), before.tab.formats.get(name));
		const next = toCell(name, after.tab.inputs.get(name), after.values.get(name), after.tab.formats.get(name));
		const same =
			old.input === next.input &&
			old.value === next.value &&
			old.type === next.type &&
			JSON.stringify(old.format) === JSON.stringify(next.format);
		if (!same) cells.push(next);
	}
	return cells;
}

/** The last row and the last column that have a cell with an input. 0 for an empty sheet. */
export function extent(inputs: ReadonlyMap<string, string>): { rows: number; columns: number } {
	let rows = 0;
	let columns = 0;
	for (const name of inputs.keys()) {
		const { col, row } = positionOf(name);
		rows = Math.max(rows, row);
		columns = Math.max(columns, col);
	}
	return { rows, columns };
}

const MAX_TEXT_CHARS = 100_000;

/** The texts of each tab of a sheet, for the search index of Drive. */
export function sheetText(values: ReadonlyMap<string, ReadonlyMap<string, Value>>): string {
	let text = "";
	for (const tab of values.values()) {
		for (const value of tab.values()) {
			if (typeof value !== "string" || value.trim() === "") continue;
			text += `${value}\n`;
			if (text.length > MAX_TEXT_CHARS) return text.slice(0, MAX_TEXT_CHARS);
		}
	}
	return text;
}
