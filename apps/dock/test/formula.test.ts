import { SHEET_LIMITS } from "@soldock/contracts";
import { describe, expect, it } from "vitest";
import { cellName, ErrorValue, evaluateSheet, parseCellName, WORK_BUDGET } from "../src/sheets/formula.ts";

/** The results of a sheet, with each error as its code. */
function run(cells: Record<string, string>, budget?: number): Record<string, unknown> {
	const values = evaluateSheet(new Map(Object.entries(cells)), budget);
	return Object.fromEntries(
		[...values].map(([name, value]) => [name, value instanceof ErrorValue ? value.code : value]),
	);
}

/** The result of one formula, in a sheet with some values to read. */
function calc(formula: string, cells: Record<string, string> = {}): unknown {
	return run({ ...cells, Z99: formula }).Z99;
}

const DATA = { A1: "10", A2: "20", A3: "30", B1: "apple", B2: "TRUE", B3: "", C1: "2.5", C2: "-4", C3: "50%" };

describe("the formula engine", () => {
	it("reads the input of a cell as a number, a boolean, a text or a formula", () => {
		expect(
			run({ A1: "42", A2: " 3.5 ", A3: "1e3", A4: "50%", A5: "true", A6: "hello", A7: "'42", A8: "=", A9: "12abc" }),
		).toEqual({
			A1: 42,
			A2: 3.5,
			A3: 1000,
			A4: 0.5,
			A5: true,
			A6: "hello",
			A7: "42",
			A8: "=",
			A9: "12abc",
		});
	});

	it("calculates with the usual order of the operators", () => {
		const table: [string, unknown][] = [
			["=1+2*3", 7],
			["=(1+2)*3", 9],
			["=2^3^2", 64],
			["=-2^2", 4],
			["=10/4", 2.5],
			["=7-2-1", 4],
			["=50%*200", 100],
			["=0.1+0.2", 0.3],
			['="a"&"b"&1', "ab1"],
			["=1+1=2", true],
			['="b">"A"', true],
			["=3<>3", false],
			["=2>=2", true],
			['="say ""hi"""', 'say "hi"'],
			["= 1 +  2 ", 3],
			["=A1+A2*C1", 60],
			["=$A$1+a2", 30],
			["=B3+1", 1],
			["=C3", 0.5],
			["=B3", 0],
		];
		for (const [formula, expected] of table) expect(calc(formula, DATA), formula).toBe(expected);
	});

	it("has the functions that the contract names", () => {
		const table: [string, unknown][] = [
			["=SUM(A1:A3)", 60],
			["=SUM(A1:A3, 5, C1)", 67.5],
			["=sum(A1:C3)", 59],
			["=AVERAGE(A1:A3)", 20],
			["=MIN(A1:A3,C2)", -4],
			["=MAX(A1:C3)", 30],
			["=COUNT(A1:C3)", 6],
			["=COUNTA(A1:C3)", 8],
			['=IF(A1>5,"big","small")', "big"],
			["=IF(A1>50,1)", false],
			["=IF(TRUE,1,1/0)", 1],
			['=IFERROR(1/0,"none")', "none"],
			["=IFERROR(A1,0)", 10],
			["=AND(A1>5,B2)", true],
			["=OR(A1>50,FALSE)", false],
			["=NOT(B2)", false],
			["=ROUND(2.567,2)", 2.57],
			["=ROUND(-2.5)", -3],
			["=ROUND(1234,-2)", 1200],
			["=ABS(C2)", 4],
			["=INT(-2.5)", -3],
			["=MOD(-7,3)", 2],
			["=POWER(2,10)", 1024],
			["=SQRT(16)", 4],
			['=CONCAT(B1," ",A1)', "apple 10"],
			['=CONCATENATE("a","b")', "ab"],
			["=LEN(B1)", 5],
			["=UPPER(B1)", "APPLE"],
			['=LOWER("ABC")', "abc"],
			['=TRIM("  a   b  ")', "a b"],
			["=LEFT(B1,3)", "app"],
			["=LEFT(B1)", "a"],
			["=RIGHT(B1,2)", "le"],
			["=MID(B1,2,3)", "ppl"],
			["=SUM(1;2;3)", 6],
		];
		for (const [formula, expected] of table) expect(calc(formula, DATA), formula).toBe(expected);
	});

	it("gives an error value for a formula that has no result", () => {
		const table: [string, string][] = [
			["=1/0", "#DIV/0!"],
			["=MOD(1,0)", "#DIV/0!"],
			["=AVERAGE(B1:B1)", "#DIV/0!"],
			['="a"+1', "#VALUE!"],
			["=B1*2", "#VALUE!"],
			["=A1:A3", "#VALUE!"],
			["=LEFT(B1,-1)", "#VALUE!"],
			["=NOPE(1)", "#NAME?"],
			["=apple", "#NAME?"],
			["=BA1", "#REF!"],
			[`=A${SHEET_LIMITS.rows + 1}`, "#REF!"],
			["=SUM(A1:ZZ9)", "#REF!"],
			["=SQRT(-1)", "#NUM!"],
			["=10^400", "#NUM!"],
			["=1e309", "#NUM!"],
			["=2*1e999", "#NUM!"],
			["=1+", "#ERROR!"],
			["=(1+2", "#ERROR!"],
			["=1 2", "#ERROR!"],
			["=SUM(1,)", "#ERROR!"],
			['="open', "#ERROR!"],
			["=1+#", "#ERROR!"],
			[`=${"(".repeat(200)}1${")".repeat(200)}`, "#ERROR!"],
			// An error in a cell that a formula reads comes through.
			["=SUM(A1:A3)+D1", "#DIV/0!"],
			["=SUM(D1:D2)", "#DIV/0!"],
		];
		for (const [formula, expected] of table) expect(calc(formula, { ...DATA, D1: "=1/0" }), formula).toBe(expected);
	});

	// Each cell joins the cell before with itself, so the text doubles at each step. Without a limit,
	// 30 steps make a text of a gigabyte.
	it("stops a text result that grows over the limit", () => {
		const cells: Record<string, string> = { A1: "x" };
		for (let row = 2; row <= 40; row++) cells[`A${row}`] = `=A${row - 1}&A${row - 1}`;
		cells.B1 = "=CONCAT(A15,A15,A15)";
		cells.B2 = "=LEN(A15)";
		const result = run(cells);
		// A15 has 16,384 characters. A16 has 32,768: one more than the limit.
		expect(result.B2).toBe(16_384);
		expect(result.A16).toBe("#LIMIT!");
		expect(result.A40).toBe("#LIMIT!");
		expect(result.B1).toBe("#LIMIT!");
	});

	// Each text here is under the limit for one cell. Without a limit for the total, 2,000 such cells
	// make an answer of 64 million characters from a sheet of a few kilobytes.
	it("stops when the text results of one calculation are too long in total", () => {
		const cells: Record<string, string> = { A1: "x".repeat(2000) };
		const join = `=${Array.from({ length: 16 }, () => "A1").join("&")}`;
		for (let row = 2; row <= 1000; row++) cells[`A${row}`] = join;
		for (let row = 1; row <= 1000; row++) cells[`B${row}`] = join;
		const results = Object.values(run(cells));
		const characters = results.reduce<number>((sum, value) => sum + (typeof value === "string" ? value.length : 0), 0);
		expect(characters).toBeLessThan(2 * WORK_BUDGET);
		expect(results).toContain("#LIMIT!");
		expect(results.filter((value) => typeof value === "string" && value.length === 32_000).length).toBeGreaterThan(0);
	});

	it("calculates a cell after the cells that it reads, in each order of the inputs", () => {
		expect(run({ A1: "=B1*2", B1: "=C1+1", C1: "5", D1: "=SUM(A1:C1)" })).toEqual({ A1: 12, B1: 6, C1: 5, D1: 23 });
	});

	// A sheet with a running total has a chain as long as its rows. Recursion would use up the stack.
	it("calculates a chain of formulas as long as the grid", () => {
		const cells: Record<string, string> = { A1: "1" };
		for (let row = 2; row <= SHEET_LIMITS.rows; row++) cells[`A${row}`] = `=A${row - 1}+1`;
		expect(run(cells)[`A${SHEET_LIMITS.rows}`]).toBe(SHEET_LIMITS.rows);
	});

	it("marks the cells of a circle, and the cells that read them", () => {
		const result = run({
			A1: "=B1",
			B1: "=C1+1",
			C1: "=A1",
			D1: "=A1*2",
			E1: "=E1",
			F1: "=SUM(E1:G1)",
			G1: "7",
			H1: "=G1+1",
		});
		expect(result).toMatchObject({
			A1: "#CYCLE!",
			B1: "#CYCLE!",
			C1: "#CYCLE!",
			D1: "#CYCLE!",
			E1: "#CYCLE!",
			F1: "#CYCLE!",
		});
		// A cell outside the circle keeps its result.
		expect(result).toMatchObject({ G1: 7, H1: 8 });
	});

	// One request has a CPU limit. A sheet must not be able to use all of it.
	it("stops at the work budget, and marks the formulas that have no result then", () => {
		const cells: Record<string, string> = {};
		for (let row = 1; row <= 200; row++) cells[`A${row}`] = String(row);
		for (let row = 1; row <= 200; row++) cells[`B${row}`] = "=SUM(A1:A200)";
		expect(run(cells).B200).toBe(20100);
		const limited = run(cells, 5000);
		expect(limited.A1).toBe(1);
		expect(Object.values(limited)).toContain("#LIMIT!");
		expect(Object.values(limited).filter((value) => value === 20100).length).toBeGreaterThan(0);
	});
});

describe("cell names", () => {
	it("go from a name to a position and back, and stop at the limits of the grid", () => {
		expect(parseCellName("A1")).toEqual({ col: 1, row: 1 });
		expect(parseCellName("az1000")).toEqual({ col: 52, row: 1000 });
		expect(cellName({ col: 27, row: 3 })).toBe("AA3");
		for (let col = 1; col <= SHEET_LIMITS.columns; col++) {
			expect(parseCellName(cellName({ col, row: 7 }))).toEqual({ col, row: 7 });
		}
		for (const name of ["BA1", "A1001", "A0", "1A", "A", ""]) expect(parseCellName(name), name).toBeNull();
	});
});
