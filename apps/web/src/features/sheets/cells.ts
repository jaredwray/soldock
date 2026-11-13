import type { Cell } from "@soldock/contracts";
import { cellName, parseCell } from "./a1.ts";
import { type GridSize, inRange, isOneCell, type Range } from "./selection.ts";

// The cells that the grid shows: the cells from the server, with the changes that the server does
// not have yet on top. The server calculates each formula. This module never calculates.

/** The new input of one cell. An empty input clears the cell. */
export interface CellChange {
	cell: string;
	input: string;
}

/** One cell as the grid shows it. */
export interface ViewCell {
	input: string;
	/** The text in the cell: the result from the server, or the input while the result is not known. */
	text: string;
	type: Exclude<Cell["type"], "empty">;
	/** True while the server does not have this input. */
	pending: boolean;
}

/**
 * The text of a number: at most 10 significant digits, so 0.1 + 0.2 shows as 0.3. Very large and
 * very small numbers use an exponent.
 */
export function formatNumber(value: number): string {
	if (!Number.isFinite(value)) return String(value);
	const rounded = Number(value.toPrecision(10));
	const size = Math.abs(rounded);
	if (size !== 0 && (size >= 1e15 || size < 1e-7)) return rounded.toExponential().toUpperCase();
	return String(rounded);
}

function serverCell(cell: Cell): ViewCell | null {
	if (cell.type === "empty" || cell.value === null) return null;
	const text =
		typeof cell.value === "number"
			? formatNumber(cell.value)
			: typeof cell.value === "boolean"
				? cell.value
					? "TRUE"
					: "FALSE"
				: cell.value;
	return { input: cell.input, text, type: cell.type, pending: false };
}

const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;

/**
 * A cell whose result the server did not send yet. It shows its input. An input of digits goes to
 * the right as a number does, so the text does not move when the result arrives.
 */
function pendingCell(input: string): ViewCell {
	return { input, text: input, type: PLAIN_NUMBER.test(input.trim()) ? "number" : "text", pending: true };
}

/** The cells of a sheet by name. A cell without an input is not in the map. */
export function toCellMap(cells: readonly Cell[]): Map<string, Cell> {
	return applyCells(new Map(), cells);
}

/** Puts the cells of a server answer into the map. An answer has a cleared cell as `empty`: it leaves the map. */
export function applyCells(map: Map<string, Cell>, cells: readonly Cell[]): Map<string, Cell> {
	for (const cell of cells) {
		if (cell.type === "empty") map.delete(cell.cell);
		else map.set(cell.cell, cell);
	}
	return map;
}

/**
 * The cells for the grid. Each list of changes goes on top of the server cells, in the given order,
 * so the last list wins. A change with an empty input removes the cell.
 */
export function viewCells(
	server: ReadonlyMap<string, Cell>,
	...changes: ReadonlyMap<string, string>[]
): Map<string, ViewCell> {
	const view = new Map<string, ViewCell>();
	for (const [name, cell] of server) {
		const shown = serverCell(cell);
		if (shown) view.set(name, shown);
	}
	for (const list of changes) {
		for (const [name, input] of list) {
			if (input === "") view.delete(name);
			else view.set(name, pendingCell(input));
		}
	}
	return view;
}

/** The count of rows and columns up to the last cell that has an input. */
export function usedSize(names: Iterable<string>): GridSize {
	let rows = 0;
	let columns = 0;
	for (const name of names) {
		const pos = parseCell(name);
		if (!pos) continue;
		rows = Math.max(rows, pos.row + 1);
		columns = Math.max(columns, pos.col + 1);
	}
	return { rows, columns };
}

/** The changes that clear each cell of the range that has an input. */
export function clearChanges(names: Iterable<string>, range: Range): CellChange[] {
	const changes: CellChange[] = [];
	for (const name of names) {
		const pos = parseCell(name);
		if (pos && inRange(range, pos)) changes.push({ cell: name, input: "" });
	}
	return changes;
}

/** The inputs of a range as rows, for the clipboard. A cell without an input is an empty string. */
export function rangeInputs(range: Range, inputOf: (name: string) => string): string[][] {
	const rows: string[][] = [];
	for (let row = range.top; row <= range.bottom; row++) {
		const line: string[] = [];
		for (let col = range.left; col <= range.right; col++) line.push(inputOf(cellName({ row, col })));
		rows.push(line);
	}
	return rows;
}

/**
 * The changes of a paste, and the range that they fill. A block goes down and to the right from the
 * first cell of the selected range, and stops at the last row and the last column of `limit`. One
 * value on a range of more than one cell fills each cell of the range.
 */
export function pasteChanges(
	block: readonly (readonly string[])[],
	target: Range,
	limit: GridSize,
): { changes: CellChange[]; range: Range } | null {
	const height = block.length;
	const width = Math.max(0, ...block.map((line) => line.length));
	if (height === 0 || width === 0) return null;
	const fill = height === 1 && width === 1 && !isOneCell(target);
	const range: Range = fill
		? target
		: {
				top: target.top,
				left: target.left,
				bottom: Math.min(limit.rows - 1, target.top + height - 1),
				right: Math.min(limit.columns - 1, target.left + width - 1),
			};
	const changes: CellChange[] = [];
	for (let row = range.top; row <= range.bottom; row++) {
		for (let col = range.left; col <= range.right; col++) {
			const input = fill ? block[0]?.[0] : block[row - range.top]?.[col - range.left];
			changes.push({ cell: cellName({ row, col }), input: input ?? "" });
		}
	}
	return { changes, range };
}

/** The first cell of a change whose input is longer than `maxChars`, or null. */
export function tooLong(changes: readonly CellChange[], maxChars: number): CellChange | null {
	return changes.find((change) => change.input.length > maxChars) ?? null;
}
