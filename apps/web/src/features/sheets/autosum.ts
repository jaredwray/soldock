import { type CellPos, cellName, rangeName } from "./a1.ts";
import type { CellChange, ViewCell } from "./cells.ts";
import { type GridSize, isOneCell, type Range } from "./selection.ts";

// The functions of the Σ menu, and the cells that get their formula. This module writes only the
// formula. The server calculates it.

/** The functions of the Σ menu, in the order of the menu. */
export const SUM_FUNCTIONS = ["SUM", "AVERAGE", "COUNT", "MAX", "MIN"] as const;
export type SumFunction = (typeof SUM_FUNCTIONS)[number];

export type AutoSum =
	/**
	 * One selected cell: an edit of the active cell starts with `input`. The edit selects the part
	 * `select` of the input (the range), so the person can type a different range.
	 */
	| { kind: "edit"; input: string; select: readonly [number, number] }
	/** More than one selected cell: the formulas go into the cells after the range. `range` holds those cells. */
	| { kind: "write"; changes: CellChange[]; range: Range }
	/** No formula. `message` tells the person why. */
	| { kind: "refused"; message: string };

/**
 * The numbers next to a cell: the cells with a number directly above it, up to the first cell
 * without a number. When the cell above has no number, the cells directly to the left. Null when
 * neither has a number.
 */
function numbersNextTo(pos: CellPos, cellAt: (name: string) => ViewCell | undefined): Range | null {
	const isNumber = (row: number, col: number) => cellAt(cellName({ row, col }))?.type === "number";
	let top = pos.row;
	while (top > 0 && isNumber(top - 1, pos.col)) top--;
	if (top < pos.row) return { top, left: pos.col, bottom: pos.row - 1, right: pos.col };
	let left = pos.col;
	while (left > 0 && isNumber(pos.row, left - 1)) left--;
	if (left < pos.col) return { top: pos.row, left, bottom: pos.row, right: pos.col - 1 };
	return null;
}

/**
 * Where the formula of `fn` goes for the selected range, and what it reads.
 *
 * - One cell: an edit of that cell starts with the function of the numbers above it, or else of
 *   the numbers to its left. The person can change the range, and Enter saves it.
 * - A range with more than one row: one formula below each column of the range.
 * - A range with one row: one formula to the right of the range.
 *
 * For a range, a formula never replaces an input: when a cell for a result is not empty, or is
 * outside the sheet, nothing changes. For one cell, the edit replaces the input only when the
 * person saves it, as a typed input does.
 */
export function autoSum(
	fn: SumFunction,
	range: Range,
	cellAt: (name: string) => ViewCell | undefined,
	limit: GridSize,
): AutoSum {
	if (isOneCell(range)) {
		const numbers = numbersNextTo({ row: range.top, col: range.left }, cellAt);
		const head = `=${fn}(`;
		const text = numbers ? rangeName(numbers) : "";
		return { kind: "edit", input: `${head}${text})`, select: [head.length, head.length + text.length] };
	}
	const below = range.bottom > range.top;
	const target: Range = below
		? { top: range.bottom + 1, left: range.left, bottom: range.bottom + 1, right: range.right }
		: { top: range.top, left: range.right + 1, bottom: range.top, right: range.right + 1 };
	if (target.bottom >= limit.rows || target.right >= limit.columns) {
		return {
			kind: "refused",
			message: below
				? "The results go below the selection, but the selection ends at the last row."
				: "The result goes to the right of the selection, but the selection ends at the last column.",
		};
	}
	const changes: CellChange[] = [];
	for (let col = target.left; col <= target.right; col++) {
		const cell = cellName({ row: target.top, col });
		if (cellAt(cell)) {
			return {
				kind: "refused",
				message: below
					? "The results go below the selection, but a cell there is not empty."
					: "The result goes to the right of the selection, but that cell is not empty.",
			};
		}
		const source = below ? { top: range.top, left: col, bottom: range.bottom, right: col } : range;
		changes.push({ cell, input: `=${fn}(${rangeName(source)})` });
	}
	return { kind: "write", changes, range: target };
}
