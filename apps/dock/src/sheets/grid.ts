import { type Cell, SHEET_LIMITS } from "@soldock/contracts";
import { type CellPosition, ErrorValue, parseCellName, type Value } from "./formula.ts";

// The stored form of a sheet and its output form. A sheet stores the input of each cell that is not
// empty, by cell name. The results are never stored: each read calculates them.

/** The inputs of a sheet from the stored JSON. A sheet that nobody wrote has no cells. */
export function readInputs(content: string | null): Map<string, string> {
	if (content === null) return new Map();
	return new Map(Object.entries((JSON.parse(content) as { cells: Record<string, string> }).cells));
}

export function storeInputs(inputs: ReadonlyMap<string, string>): string {
	return JSON.stringify({ cells: Object.fromEntries(inputs) });
}

/** The position of a cell name from a call. Throws the message for a name outside the grid. */
export function positionOf(name: string): CellPosition {
	const position = parseCellName(name);
	if (!position) throw new RangeError(`${name} is outside the grid. The last cell is AZ${SHEET_LIMITS.rows}.`);
	return position;
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

export function toCell(name: string, input: string | undefined, value: Value | undefined): Cell {
	if (input === undefined) return { cell: name, input: "", value: null, type: "empty" };
	if (value instanceof ErrorValue) return { cell: name, input, value: value.code, type: "error" };
	if (value === null || value === undefined) return { cell: name, input, value: null, type: "empty" };
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

/** The cells of a sheet for the output, row by row. `range` keeps only the cells in it. */
export function toCells(
	inputs: ReadonlyMap<string, string>,
	values: ReadonlyMap<string, Value>,
	range?: { from: CellPosition; to: CellPosition },
): Cell[] {
	const names = [...inputs.keys()].filter((name) => {
		if (!range) return true;
		const { col, row } = positionOf(name);
		return col >= range.from.col && col <= range.to.col && row >= range.from.row && row <= range.to.row;
	});
	return names.sort(byPosition).map((name) => toCell(name, inputs.get(name), values.get(name)));
}

/** The cells whose input or result is different after a change, also the cells that the change cleared. */
export function changedCells(
	before: { inputs: ReadonlyMap<string, string>; values: ReadonlyMap<string, Value> },
	after: { inputs: ReadonlyMap<string, string>; values: ReadonlyMap<string, Value> },
): Cell[] {
	const names = new Set([...before.inputs.keys(), ...after.inputs.keys()]);
	const cells: Cell[] = [];
	for (const name of [...names].sort(byPosition)) {
		const old = toCell(name, before.inputs.get(name), before.values.get(name));
		const next = toCell(name, after.inputs.get(name), after.values.get(name));
		if (old.input !== next.input || old.value !== next.value || old.type !== next.type) cells.push(next);
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

/** The texts of a sheet, for the search index of Drive. */
export function sheetText(values: ReadonlyMap<string, Value>): string {
	let text = "";
	for (const value of values.values()) {
		if (typeof value !== "string" || value.trim() === "") continue;
		text += `${value}\n`;
		if (text.length > MAX_TEXT_CHARS) break;
	}
	return text.slice(0, MAX_TEXT_CHARS);
}
