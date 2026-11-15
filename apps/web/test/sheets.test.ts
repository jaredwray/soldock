import { type Cell, SHEET_LIMITS } from "@soldock/contracts";
import { describe, expect, it } from "vitest";
import { cellName, columnName, parseCell } from "../src/features/sheets/a1.ts";
import { autoSum } from "../src/features/sheets/autosum.ts";
import {
	applyCells,
	clearChanges,
	formatNumber,
	pasteChanges,
	toCellMap,
	usedSize,
	viewCells,
} from "../src/features/sheets/cells.ts";
import { formatTsv, parseTsv } from "../src/features/sheets/clipboard.ts";
import { gridSize, moveSelection, rangeOf, selectCell } from "../src/features/sheets/selection.ts";

function cell(name: string, input: string, value: Cell["value"], type: Cell["type"]): Cell {
	return { cell: name, input, value, type };
}

describe("cell names", () => {
	// The server reads the same A1 names. The step from Z to AA is where a column count goes wrong.
	it("names each column of a sheet and reads each name back", () => {
		expect([0, 25, 26, 51].map(columnName)).toEqual(["A", "Z", "AA", "AZ"]);
		for (let col = 0; col < SHEET_LIMITS.columns; col++) {
			for (const row of [0, 8, 9, SHEET_LIMITS.rows - 1]) {
				expect(parseCell(cellName({ row, col })), cellName({ row, col })).toEqual({ row, col });
			}
		}
		expect(parseCell(" b2 ")).toEqual({ row: 1, col: 1 });
	});

	it("refuses text that is not a cell of a sheet", () => {
		for (const text of ["", "A", "7", "A0", "A01", "BA1", "A1001", "AAA1", "A1:B2", "A-1", "=A1"]) {
			expect(parseCell(text), text).toBeNull();
		}
	});
});

describe("the selection", () => {
	it("stops a move at the edges of a sheet, and Shift keeps the active cell", () => {
		const corner = selectCell({ row: 0, col: 0 });
		expect(moveSelection(corner, -1, -1, false)).toEqual(corner);
		const last = { row: SHEET_LIMITS.rows - 1, col: SHEET_LIMITS.columns - 1 };
		expect(moveSelection(selectCell(last), 5, 5, false)).toEqual(selectCell(last));
		const grown = moveSelection(moveSelection(selectCell({ row: 4, col: 4 }), -2, 0, true), 0, 1, true);
		expect(grown).toEqual({ anchor: { row: 4, col: 4 }, focus: { row: 2, col: 5 } });
		expect(rangeOf(grown)).toEqual({ top: 2, left: 4, bottom: 4, right: 5 });
		// A move without Shift starts again from the active cell, not from the far corner.
		expect(moveSelection(grown, 1, 0, false)).toEqual(selectCell({ row: 5, col: 4 }));
	});

	it("shows A to Z and 50 rows at least, room after the last input, and never more than a sheet has", () => {
		const first = selectCell({ row: 0, col: 0 });
		expect(gridSize({ rows: 0, columns: 0 }, first)).toEqual({ rows: 50, columns: 26 });
		expect(gridSize({ rows: 40, columns: 24 }, first)).toEqual({ rows: 60, columns: 29 });
		// The grid holds the selection, so the arrow keys can go past the last drawn row.
		expect(gridSize({ rows: 0, columns: 0 }, selectCell({ row: 70, col: 30 }))).toEqual({ rows: 71, columns: 31 });
		expect(gridSize({ rows: 995, columns: 50 }, first)).toEqual({
			rows: SHEET_LIMITS.rows,
			columns: SHEET_LIMITS.columns,
		});
	});
});

describe("clipboard text", () => {
	it("writes a block that it reads back, also with tabs, line breaks and quotes in a cell", () => {
		const block = [
			["=SUM(A1:A3)", "", "plain"],
			['=IF(A1="x",1,2)', "two\nlines", "a\tb"],
			['"quoted"', 'say "hi"', ""],
		];
		expect(parseTsv(formatTsv(block))).toEqual(block);
		// A formula with quotes stays as it is, so a paste into a different app keeps the formula.
		expect(formatTsv([['=IF(A1="x",1,2)', "b"]])).toBe('=IF(A1="x",1,2)\tb');
	});

	it("reads the text of other spreadsheets: CRLF lines, a line break at the end, and quoted cells", () => {
		expect(parseTsv("1\t2\r\n3\t4\r\n")).toEqual([
			["1", "2"],
			["3", "4"],
		]);
		expect(parseTsv('"a\nb"\t"say ""hi"""\nx')).toEqual([["a\nb", 'say "hi"'], ["x"]]);
		expect(parseTsv("a\t\n\nb")).toEqual([["a", ""], [""], ["b"]]);
		expect(parseTsv("")).toEqual([]);
		// A quote that does not close is text, and the tab after it still starts a new cell.
		expect(parseTsv('"5 inch\tb')).toEqual([['"5 inch', "b"]]);
	});
});

describe("the cells of the grid", () => {
	it("shows a number with at most 10 significant digits", () => {
		const table: [number, string][] = [
			[0.1 + 0.2, "0.3"],
			[1 / 3, "0.3333333333"],
			[1234567.5, "1234567.5"],
			[-42, "-42"],
			[0, "0"],
			[123456789012, "123456789000"],
			[1e21, "1E+21"],
			[0.00000001234, "1.234E-8"],
		];
		for (const [value, text] of table) expect(formatNumber(value), String(value)).toBe(text);
	});

	it("shows the results of the server, and on top the inputs that the server does not have yet", () => {
		const server = toCellMap([
			cell("A1", "2", 2, "number"),
			cell("A2", "=A1*2", 4, "number"),
			cell("A3", "=1/0", "#DIV/0!", "error"),
			cell("A4", "TRUE", true, "boolean"),
			cell("A5", "note", "note", "text"),
		]);
		const sending = new Map([
			["A1", "5"],
			["B1", "old"],
		]);
		const waiting = new Map([
			["B1", "=A1+1"],
			["A5", ""],
		]);
		const view = viewCells(server, sending, waiting);
		expect(view.get("A1")).toEqual({ input: "5", text: "5", type: "number", pending: true });
		// The result of A2 is the old one until the server answers. The page never calculates.
		expect(view.get("A2")).toEqual({ input: "=A1*2", text: "4", type: "number", pending: false });
		expect(view.get("A3")).toMatchObject({ text: "#DIV/0!", type: "error" });
		expect(view.get("A4")).toMatchObject({ text: "TRUE", type: "boolean" });
		// The newest change to a cell wins, and an empty input removes the cell.
		expect(view.get("B1")).toEqual({ input: "=A1+1", text: "=A1+1", type: "text", pending: true });
		expect(view.has("A5")).toBe(false);
	});

	it("puts the changed cells of an answer into the sheet, and removes a cleared cell", () => {
		const server = toCellMap([cell("A1", "1", 1, "number"), cell("B1", "=A1", 1, "number")]);
		applyCells(server, [cell("A1", "", null, "empty"), cell("B1", "=A1", 0, "number"), cell("C1", "x", "x", "text")]);
		expect([...server.keys()].sort()).toEqual(["B1", "C1"]);
		expect(server.get("B1")?.value).toBe(0);
		expect(usedSize(server.keys())).toEqual({ rows: 1, columns: 3 });
	});

	it("pastes a block from the first cell of the range, and stops at the edges of a sheet", () => {
		const block = [
			["1", "2", "3"],
			["4", "5"],
		];
		const paste = pasteChanges(block, { top: 1, left: 1, bottom: 1, right: 1 }, SHEET_LIMITS);
		expect(paste?.range).toEqual({ top: 1, left: 1, bottom: 2, right: 3 });
		expect(paste?.changes).toEqual([
			{ cell: "B2", input: "1" },
			{ cell: "C2", input: "2" },
			{ cell: "D2", input: "3" },
			{ cell: "B3", input: "4" },
			{ cell: "C3", input: "5" },
			// A short row clears the cell, as the block on the clipboard has no value there.
			{ cell: "D3", input: "" },
		]);
		const corner = { top: SHEET_LIMITS.rows - 1, left: SHEET_LIMITS.columns - 1 };
		const cut = pasteChanges(block, { ...corner, bottom: corner.top, right: corner.left }, SHEET_LIMITS);
		expect(cut?.changes).toEqual([{ cell: `AZ${SHEET_LIMITS.rows}`, input: "1" }]);
		expect(pasteChanges([], { top: 0, left: 0, bottom: 0, right: 0 }, SHEET_LIMITS)).toBeNull();
	});

	it("fills a range of more than one cell with one pasted value", () => {
		const paste = pasteChanges([["=A1"]], { top: 0, left: 1, bottom: 1, right: 2 }, SHEET_LIMITS);
		expect(paste?.range).toEqual({ top: 0, left: 1, bottom: 1, right: 2 });
		expect(paste?.changes.map((change) => change.cell)).toEqual(["B1", "C1", "B2", "C2"]);
		expect(new Set(paste?.changes.map((change) => change.input))).toEqual(new Set(["=A1"]));
	});

	// Delete on a whole column must not send 1000 cells: only the cells with an input change.
	it("clears only the cells of the range that have an input", () => {
		const names = ["A1", "B2", "C3", "B900"];
		expect(clearChanges(names, { top: 0, left: 1, bottom: SHEET_LIMITS.rows - 1, right: 1 })).toEqual([
			{ cell: "B2", input: "" },
			{ cell: "B900", input: "" },
		]);
	});
});

describe("the functions of the toolbar", () => {
	// A fee table: a header in B1, numbers in B2:B5, a text in C3, and numbers in A7:C7.
	const view = viewCells(
		toCellMap([
			cell("B1", "Fee", "Fee", "text"),
			cell("B2", "10", 10, "number"),
			cell("B3", "20", 20, "number"),
			cell("B4", "=B2+B3", 30, "number"),
			cell("B5", "40", 40, "number"),
			cell("C3", "note", "note", "text"),
			cell("A7", "1", 1, "number"),
			cell("B7", "2", 2, "number"),
			cell("C7", "3", 3, "number"),
		]),
	);
	const cellAt = (name: string) => view.get(name);
	const one = (name: string) => {
		const pos = parseCell(name);
		if (!pos) throw new Error(name);
		return { top: pos.row, left: pos.col, bottom: pos.row, right: pos.col };
	};

	it("starts an edit of one cell with the numbers above it, or else to its left, and selects the range", () => {
		const above = autoSum("SUM", one("B6"), cellAt, SHEET_LIMITS);
		// The header in B1 is text, so the range stops at B2. A formula with a number result counts.
		expect(above).toEqual({ kind: "edit", input: "=SUM(B2:B5)", select: [5, 10] });
		expect(autoSum("MAX", one("D7"), cellAt, SHEET_LIMITS)).toEqual({
			kind: "edit",
			input: "=MAX(A7:C7)",
			select: [5, 10],
		});
		// No number next to the cell: the cursor goes between the parentheses.
		expect(autoSum("AVERAGE", one("E1"), cellAt, SHEET_LIMITS)).toEqual({
			kind: "edit",
			input: "=AVERAGE()",
			select: [9, 9],
		});
		expect(autoSum("COUNT", one("C4"), cellAt, SHEET_LIMITS)).toMatchObject({ input: "=COUNT(B4)" });
	});

	it("writes one formula below each column of a range, or one to the right of a row", () => {
		expect(autoSum("SUM", { top: 6, left: 0, bottom: 7, right: 2 }, cellAt, SHEET_LIMITS)).toEqual({
			kind: "write",
			changes: [
				{ cell: "A9", input: "=SUM(A7:A8)" },
				{ cell: "B9", input: "=SUM(B7:B8)" },
				{ cell: "C9", input: "=SUM(C7:C8)" },
			],
			range: { top: 8, left: 0, bottom: 8, right: 2 },
		});
		expect(autoSum("MIN", { top: 6, left: 0, bottom: 6, right: 2 }, cellAt, SHEET_LIMITS)).toEqual({
			kind: "write",
			changes: [{ cell: "D7", input: "=MIN(A7:C7)" }],
			range: { top: 6, left: 3, bottom: 6, right: 3 },
		});
	});

	it("never replaces an input, and never writes outside the sheet", () => {
		// B5 below B2:B4 has an input, and so does C3 to the right of A3:B3.
		expect(autoSum("SUM", { top: 1, left: 1, bottom: 3, right: 1 }, cellAt, SHEET_LIMITS)).toMatchObject({
			kind: "refused",
		});
		expect(autoSum("SUM", { top: 2, left: 0, bottom: 2, right: 1 }, cellAt, SHEET_LIMITS)).toMatchObject({
			kind: "refused",
		});
		const lastRow = SHEET_LIMITS.rows - 1;
		const lastCol = SHEET_LIMITS.columns - 1;
		expect(autoSum("SUM", { top: 0, left: 4, bottom: lastRow, right: 4 }, cellAt, SHEET_LIMITS)).toMatchObject({
			kind: "refused",
		});
		expect(autoSum("SUM", { top: 0, left: 4, bottom: 0, right: lastCol }, cellAt, SHEET_LIMITS)).toMatchObject({
			kind: "refused",
		});
	});
});
