import { SHEET_LIMITS } from "@soldock/contracts";

// Cells in A1 form. A position has a row and a column that start at 0: A1 is row 0, column 0.

export interface CellPos {
	row: number;
	col: number;
}

/** The letters of a column: 0 is A, 25 is Z, and 26 is AA. */
export function columnName(col: number): string {
	let name = "";
	for (let rest = col + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) {
		name = String.fromCharCode(65 + ((rest - 1) % 26)) + name;
	}
	return name;
}

/** The names of the first `count` columns. */
export function columnNames(count: number): string[] {
	return Array.from({ length: count }, (_, col) => columnName(col));
}

/** The name of a cell, for example B2 for row 1 and column 1. */
export function cellName(pos: CellPos): string {
	return `${columnName(pos.col)}${pos.row + 1}`;
}

const CELL = /^([A-Z]{1,2})([1-9][0-9]{0,3})$/;

/**
 * The position of a cell name, in upper or lower case. The result is null for text that is not a
 * cell, and for a cell after the last column or the last row of a sheet.
 */
export function parseCell(name: string): CellPos | null {
	const match = CELL.exec(name.trim().toUpperCase());
	if (!match) return null;
	const [, letters = "", digits = ""] = match;
	let col = 0;
	for (const letter of letters) col = col * 26 + (letter.charCodeAt(0) - 64);
	const pos = { row: Number(digits) - 1, col: col - 1 };
	return pos.row < SHEET_LIMITS.rows && pos.col < SHEET_LIMITS.columns ? pos : null;
}
