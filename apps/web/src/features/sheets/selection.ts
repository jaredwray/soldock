import { SHEET_LIMITS } from "@soldock/contracts";
import type { CellPos } from "./a1.ts";

// The selection of the grid, and the size of the grid that the page shows.

/**
 * A selection. `anchor` is the active cell: the cell that an edit changes. `focus` is the opposite
 * corner of the range, which Shift with an arrow key moves.
 */
export interface Selection {
	anchor: CellPos;
	focus: CellPos;
}

/** A block of cells. Each edge is in the block. */
export interface Range {
	top: number;
	left: number;
	bottom: number;
	right: number;
}

export const FIRST_CELL: CellPos = { row: 0, col: 0 };

export function selectCell(pos: CellPos): Selection {
	return { anchor: pos, focus: pos };
}

export function rangeOf(selection: Selection): Range {
	const { anchor, focus } = selection;
	return {
		top: Math.min(anchor.row, focus.row),
		left: Math.min(anchor.col, focus.col),
		bottom: Math.max(anchor.row, focus.row),
		right: Math.max(anchor.col, focus.col),
	};
}

export function inRange(range: Range, pos: CellPos): boolean {
	return pos.row >= range.top && pos.row <= range.bottom && pos.col >= range.left && pos.col <= range.right;
}

export function isOneCell(range: Range): boolean {
	return range.top === range.bottom && range.left === range.right;
}

/** The cell that is `rows` and `cols` from `pos`. It stops at the edges of a sheet. */
export function step(pos: CellPos, rows: number, cols: number): CellPos {
	return {
		row: Math.min(SHEET_LIMITS.rows - 1, Math.max(0, pos.row + rows)),
		col: Math.min(SHEET_LIMITS.columns - 1, Math.max(0, pos.col + cols)),
	};
}

/**
 * The selection after a move. A plain move selects one cell, next to the active cell. A move with
 * Shift keeps the active cell and moves the opposite corner.
 */
export function moveSelection(selection: Selection, rows: number, cols: number, extend: boolean): Selection {
	if (extend) return { anchor: selection.anchor, focus: step(selection.focus, rows, cols) };
	return selectCell(step(selection.anchor, rows, cols));
}

export interface GridSize {
	rows: number;
	columns: number;
}

const MIN_ROWS = 50;
const MIN_COLUMNS = 26;
const SPARE_ROWS = 20;
const SPARE_COLUMNS = 5;

/**
 * The rows and columns that the grid shows: at least A to Z and 50 rows, and 5 columns and 20 rows
 * after the last cell that has an input. The grid also holds the selection, so the arrow keys can
 * go to each cell of a sheet. `used` is the count of rows and columns up to that last cell.
 */
export function gridSize(used: GridSize, selection: Selection): GridSize {
	const range = rangeOf(selection);
	return {
		rows: Math.min(SHEET_LIMITS.rows, Math.max(MIN_ROWS, used.rows + SPARE_ROWS, range.bottom + 1)),
		columns: Math.min(SHEET_LIMITS.columns, Math.max(MIN_COLUMNS, used.columns + SPARE_COLUMNS, range.right + 1)),
	};
}
