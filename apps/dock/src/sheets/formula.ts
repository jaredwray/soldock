import { SHEET_ERRORS, SHEET_LIMITS, type SheetError } from "@soldock/contracts";

// The formula engine of Sheets. It has no access to the network, the clock or random numbers, so a
// sheet always gives the same results. One evaluation has a work budget, so a sheet with very large
// ranges cannot use all the CPU time of a request.

/** The result of a cell: a number, a text, true or false, an error, or null for an empty cell. */
export type Value = number | string | boolean | null | ErrorValue;

export class ErrorValue {
	readonly code: SheetError;
	constructor(code: SheetError) {
		this.code = code;
	}
}

const ERRORS = Object.fromEntries(SHEET_ERRORS.map((code) => [code, new ErrorValue(code)])) as Record<
	SheetError,
	ErrorValue
>;

export interface CellPosition {
	/** 1 for column A. */
	col: number;
	/** 1 for row 1. */
	row: number;
}

/** The column letters of a column number: 1 is A, 27 is AA. */
export function columnName(col: number): string {
	let name = "";
	for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
	return name;
}

export function cellName(position: CellPosition): string {
	return `${columnName(position.col)}${position.row}`;
}

/** The position of a cell name such as B2, or null when the name is not a cell of the grid. */
export function parseCellName(name: string): CellPosition | null {
	const match = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})$/.exec(name);
	if (!match) return null;
	let col = 0;
	for (const letter of (match[1] as string).toUpperCase()) col = col * 26 + (letter.charCodeAt(0) - 64);
	const row = Number(match[2]);
	return col <= SHEET_LIMITS.columns && row <= SHEET_LIMITS.rows ? { col, row } : null;
}

type Node =
	| { t: "value"; value: number | string | boolean }
	| { t: "error"; code: SheetError }
	| { t: "ref"; col: number; row: number }
	| { t: "range"; col1: number; row1: number; col2: number; row2: number }
	| { t: "unary"; op: "-" | "+" | "%"; arg: Node }
	| { t: "binary"; op: string; left: Node; right: Node }
	| { t: "call"; name: string; args: Node[] };

type Tok =
	| { t: "num"; value: number }
	| { t: "str"; value: string }
	| { t: "name"; value: string }
	| { t: "op"; value: string };

const TOKEN =
	/\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|"((?:[^"]|"")*)"|(\$?[A-Za-z]+\$?\d+|[A-Za-z_][A-Za-z0-9_.]*)|(<=|>=|<>|[-+*/^&=<>%(),;:]))/y;

class FormulaError extends Error {}

function tokenizeFormula(source: string): Tok[] {
	const tokens: Tok[] = [];
	TOKEN.lastIndex = 0;
	let position = 0;
	while (position < source.length) {
		if (/^\s*$/.test(source.slice(position))) break;
		TOKEN.lastIndex = position;
		const match = TOKEN.exec(source);
		if (!match) throw new FormulaError();
		position = TOKEN.lastIndex;
		if (match[1] !== undefined) tokens.push({ t: "num", value: Number(match[1]) });
		else if (match[2] !== undefined) tokens.push({ t: "str", value: match[2].replaceAll('""', '"') });
		else if (match[3] !== undefined) tokens.push({ t: "name", value: match[3] });
		else tokens.push({ t: "op", value: match[4] as string });
	}
	return tokens;
}

const MAX_FORMULA_DEPTH = 64;

/** A parser for one formula. The grammar has the usual order: comparison, &, + -, * /, ^, sign, %. */
class Parser {
	private position = 0;
	private depth = 0;
	private readonly tokens: Tok[];

	constructor(tokens: Tok[]) {
		this.tokens = tokens;
	}

	parse(): Node {
		const node = this.comparison();
		if (this.position < this.tokens.length) throw new FormulaError();
		return node;
	}

	private peekOp(...ops: string[]): string | null {
		const token = this.tokens[this.position];
		return token?.t === "op" && ops.includes(token.value) ? token.value : null;
	}

	private takeOp(...ops: string[]): string | null {
		const op = this.peekOp(...ops);
		if (op !== null) this.position++;
		return op;
	}

	private binary(next: () => Node, ...ops: string[]): Node {
		let left = next();
		for (let op = this.takeOp(...ops); op !== null; op = this.takeOp(...ops)) {
			left = { t: "binary", op, left, right: next() };
		}
		return left;
	}

	private comparison = (): Node => this.binary(this.concat, "=", "<>", "<", ">", "<=", ">=");
	private concat = (): Node => this.binary(this.sum, "&");
	private sum = (): Node => this.binary(this.product, "+", "-");
	private product = (): Node => this.binary(this.power, "*", "/");
	private power = (): Node => this.binary(this.unary, "^");

	private unary = (): Node => {
		const op = this.takeOp("-", "+");
		if (op !== null) {
			if (++this.depth > MAX_FORMULA_DEPTH) throw new FormulaError();
			const arg = this.unary();
			this.depth--;
			return { t: "unary", op: op as "-" | "+", arg };
		}
		let node = this.primary();
		while (this.takeOp("%") !== null) node = { t: "unary", op: "%", arg: node };
		return node;
	};

	private primary(): Node {
		const token = this.tokens[this.position++];
		if (!token) throw new FormulaError();
		// A literal such as 1e309 is not a finite number.
		if (token.t === "num" && !Number.isFinite(token.value)) return { t: "error", code: "#NUM!" };
		if (token.t === "num" || token.t === "str") return { t: "value", value: token.value };
		if (token.t === "op") {
			if (token.value !== "(") throw new FormulaError();
			if (++this.depth > MAX_FORMULA_DEPTH) throw new FormulaError();
			const node = this.comparison();
			this.depth--;
			if (this.takeOp(")") === null) throw new FormulaError();
			return node;
		}
		const name = token.value.toUpperCase();
		if (this.takeOp("(") !== null) {
			if (++this.depth > MAX_FORMULA_DEPTH) throw new FormulaError();
			const args: Node[] = [];
			if (this.takeOp(")") === null) {
				do args.push(this.comparison());
				while (this.takeOp(",", ";") !== null);
				if (this.takeOp(")") === null) throw new FormulaError();
			}
			this.depth--;
			return { t: "call", name, args };
		}
		if (name === "TRUE" || name === "FALSE") return { t: "value", value: name === "TRUE" };
		if (!/^\$?[A-Z]+\$?\d+$/.test(name)) return { t: "error", code: "#NAME?" };
		const start = parseCellName(name);
		if (this.takeOp(":") === null) return start ? { t: "ref", ...start } : { t: "error", code: "#REF!" };
		const endToken = this.tokens[this.position++];
		if (endToken?.t !== "name") throw new FormulaError();
		const end = parseCellName(endToken.value);
		if (!start || !end) return { t: "error", code: "#REF!" };
		return {
			t: "range",
			col1: Math.min(start.col, end.col),
			row1: Math.min(start.row, end.row),
			col2: Math.max(start.col, end.col),
			row2: Math.max(start.row, end.row),
		};
	}
}

/** What a person typed in a cell: a formula, a value, or nothing. */
type Input = { formula: Node } | { value: Value };

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Reads the input of a cell. A text that starts with = is a formula. A text that starts with ' is text. */
export function parseInput(raw: string): Input {
	if (raw.startsWith("=") && raw.length > 1) {
		try {
			return { formula: new Parser(tokenizeFormula(raw.slice(1))).parse() };
		} catch (error) {
			if (error instanceof FormulaError) return { value: ERRORS["#ERROR!"] };
			throw error;
		}
	}
	if (raw.startsWith("'")) return { value: raw.slice(1) };
	const text = raw.trim();
	if (text === "") return { value: raw === "" ? null : raw };
	if (NUMBER.test(text)) return { value: finite(Number(text)) };
	if (text.endsWith("%") && NUMBER.test(text.slice(0, -1))) return { value: finite(Number(text.slice(0, -1)) / 100) };
	if (/^true$/i.test(text)) return { value: true };
	if (/^false$/i.test(text)) return { value: false };
	return { value: raw };
}

/** A number without the noise of binary fractions (0.1 + 0.2 gives 0.3), or #NUM! when it is not finite. */
function finite(value: number): number | ErrorValue {
	return Number.isFinite(value) ? Number(value.toPrecision(15)) : ERRORS["#NUM!"];
}

function toNumber(value: Value): number | ErrorValue {
	if (value instanceof ErrorValue) return value;
	if (typeof value === "number") return value;
	if (typeof value === "boolean") return value ? 1 : 0;
	if (value === null) return 0;
	const text = value.trim();
	if (NUMBER.test(text)) return Number(text);
	return ERRORS["#VALUE!"];
}

function toText(value: Value): string | ErrorValue {
	if (value instanceof ErrorValue) return value;
	if (value === null) return "";
	if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
	return String(value);
}

function toBoolean(value: Value): boolean | ErrorValue {
	if (value instanceof ErrorValue) return value;
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	if (value === null) return false;
	if (/^true$/i.test(value.trim())) return true;
	if (/^false$/i.test(value.trim())) return false;
	return ERRORS["#VALUE!"];
}

/** The order of two values: numbers before texts before booleans, as in the usual spreadsheets. */
function compare(left: Value, right: Value): number {
	const rank = (value: Value) => (typeof value === "number" ? 0 : typeof value === "string" ? 1 : 2);
	const a = left === null ? (typeof right === "string" ? "" : typeof right === "boolean" ? false : 0) : left;
	const b = right === null ? (typeof left === "string" ? "" : typeof left === "boolean" ? false : 0) : right;
	if (rank(a) !== rank(b)) return rank(a) - rank(b);
	if (typeof a === "string") return a.toLowerCase().localeCompare((b as string).toLowerCase(), "en");
	return Number(a) - Number(b);
}

/** A value or a range, as an argument of a function. */
type Arg = { values: Value[]; range: boolean };

type Fn = (args: Arg[]) => Value;

function firstError(values: Value[]): ErrorValue | null {
	return values.find((value): value is ErrorValue => value instanceof ErrorValue) ?? null;
}

/**
 * The numbers of the arguments of SUM, AVERAGE, MIN, MAX and COUNT. In a range, a text, a boolean and
 * an empty cell do not count. A value that is not in a range must be a number.
 */
function numbers(args: Arg[], strict: boolean): number[] | ErrorValue {
	const out: number[] = [];
	for (const arg of args) {
		for (const value of arg.values) {
			if (value instanceof ErrorValue) {
				if (strict) return value;
			} else if (arg.range) {
				if (typeof value === "number") out.push(value);
			} else {
				const number = toNumber(value);
				if (number instanceof ErrorValue) {
					if (strict) return number;
				} else out.push(number);
			}
		}
	}
	return out;
}

function scalar(arg: Arg | undefined): Value {
	if (!arg) return null;
	return arg.range && arg.values.length !== 1 ? ERRORS["#VALUE!"] : (arg.values[0] ?? null);
}

/** A function of numbers. An argument that is an error gives that error. */
function numeric(count: [number, number], fn: (...values: number[]) => number | ErrorValue): Fn {
	return (args) => {
		if (args.length < count[0] || args.length > count[1]) return ERRORS["#VALUE!"];
		const values: number[] = [];
		for (const arg of args) {
			const value = toNumber(scalar(arg));
			if (value instanceof ErrorValue) return value;
			values.push(value);
		}
		const result = fn(...values);
		return result instanceof ErrorValue ? result : finite(result);
	};
}

/** A function of one text and optional numbers. */
function textual(count: [number, number], fn: (text: string, ...values: number[]) => Value): Fn {
	return (args) => {
		if (args.length < count[0] || args.length > count[1]) return ERRORS["#VALUE!"];
		const text = toText(scalar(args[0]));
		if (text instanceof ErrorValue) return text;
		const values: number[] = [];
		for (const arg of args.slice(1)) {
			const value = toNumber(scalar(arg));
			if (value instanceof ErrorValue) return value;
			if (value < 0) return ERRORS["#VALUE!"];
			values.push(Math.floor(value));
		}
		return fn(text, ...values);
	};
}

function logical(combine: (values: boolean[]) => boolean): Fn {
	return (args) => {
		const values: boolean[] = [];
		for (const arg of args) {
			for (const value of arg.values) {
				// In a range, a text and an empty cell do not count.
				if (arg.range && (value === null || typeof value === "string")) continue;
				const boolean = toBoolean(value);
				if (boolean instanceof ErrorValue) return boolean;
				values.push(boolean);
			}
		}
		return values.length === 0 ? ERRORS["#VALUE!"] : combine(values);
	};
}

function aggregate(fn: (values: number[]) => number | ErrorValue): Fn {
	return (args) => {
		const values = numbers(args, true);
		if (values instanceof ErrorValue) return values;
		const result = fn(values);
		return result instanceof ErrorValue ? result : finite(result);
	};
}

/** The most characters of a text result, as in the usual spreadsheets. */
export const MAX_TEXT_RESULT = 32_767;

/**
 * A text result, or #LIMIT! when it is too long. Without this limit, a chain of cells that each
 * join the cell before with itself makes a text that doubles at each step, and uses all the memory.
 */
function boundedText(text: string): string | ErrorValue {
	return text.length > MAX_TEXT_RESULT ? ERRORS["#LIMIT!"] : text;
}

function concatenate(args: Arg[]): Value {
	let out = "";
	for (const arg of args) {
		for (const value of arg.values) {
			const text = toText(value);
			if (text instanceof ErrorValue) return text;
			if (out.length + text.length > MAX_TEXT_RESULT) return ERRORS["#LIMIT!"];
			out += text;
		}
	}
	return out;
}

const FUNCTIONS: Record<string, Fn> = {
	SUM: aggregate((values) => values.reduce((sum, value) => sum + value, 0)),
	AVERAGE: aggregate((values) =>
		values.length === 0 ? ERRORS["#DIV/0!"] : values.reduce((sum, value) => sum + value, 0) / values.length,
	),
	MIN: aggregate((values) => values.reduce((min, value) => Math.min(min, value), values[0] ?? 0)),
	MAX: aggregate((values) => values.reduce((max, value) => Math.max(max, value), values[0] ?? 0)),
	COUNT: (args) => {
		const values = numbers(args, false);
		return values instanceof ErrorValue ? values : values.length;
	},
	COUNTA: (args) => args.reduce((count, arg) => count + arg.values.filter((value) => value !== null).length, 0),
	AND: logical((values) => values.every(Boolean)),
	OR: logical((values) => values.some(Boolean)),
	NOT: (args) => {
		if (args.length !== 1) return ERRORS["#VALUE!"];
		const value = toBoolean(scalar(args[0]));
		return value instanceof ErrorValue ? value : !value;
	},
	ROUND: numeric([1, 2], (value, digits = 0) => {
		const factor = 10 ** Math.trunc(digits);
		return (Math.sign(value) * Math.round(Math.abs(value) * factor)) / factor;
	}),
	ABS: numeric([1, 1], Math.abs),
	INT: numeric([1, 1], Math.floor),
	MOD: numeric([2, 2], (value, divisor) =>
		divisor === 0 ? ERRORS["#DIV/0!"] : value - divisor * Math.floor(value / (divisor as number)),
	),
	POWER: numeric([2, 2], (base, exponent) => (base as number) ** (exponent as number)),
	SQRT: numeric([1, 1], (value) => (value < 0 ? ERRORS["#NUM!"] : Math.sqrt(value))),
	CONCAT: concatenate,
	CONCATENATE: concatenate,
	LEN: textual([1, 1], (text) => text.length),
	UPPER: textual([1, 1], (text) => text.toUpperCase()),
	LOWER: textual([1, 1], (text) => text.toLowerCase()),
	TRIM: textual([1, 1], (text) => text.trim().replace(/ {2,}/g, " ")),
	LEFT: textual([1, 2], (text, count = 1) => text.slice(0, count)),
	RIGHT: textual([1, 2], (text, count = 1) => (count === 0 ? "" : text.slice(-count))),
	MID: textual([3, 3], (text, start, count) =>
		(start as number) < 1
			? ERRORS["#VALUE!"]
			: text.slice((start as number) - 1, (start as number) - 1 + (count as number)),
	),
};

/** The most cell reads of one evaluation. A formula that needs more gets #LIMIT!. */
export const WORK_BUDGET = 2_000_000;

class BudgetError extends Error {}

/**
 * Calculates each cell of a sheet. `inputs` has the input of each cell that is not empty, by cell
 * name. A cell that depends on itself, directly or through other cells, gets #CYCLE!.
 */
export function evaluateSheet(inputs: ReadonlyMap<string, string>, budget: number = WORK_BUDGET): Map<string, Value> {
	const results = new Map<string, Value>();
	const formulas = new Map<string, Node>();
	for (const [name, raw] of inputs) {
		const input = parseInput(raw);
		if ("formula" in input) formulas.set(name, input.formula);
		else results.set(name, input.value);
	}
	let work = 0;
	const spend = (amount: number) => {
		work += amount;
		if (work > budget) throw new BudgetError();
	};

	/** The names of the cells in a range that have an input. It reads the smaller of the range and the sheet. */
	function* cellsIn(range: Extract<Node, { t: "range" }>): Generator<string> {
		const area = (range.col2 - range.col1 + 1) * (range.row2 - range.row1 + 1);
		if (area <= inputs.size) {
			spend(area);
			for (let row = range.row1; row <= range.row2; row++) {
				for (let col = range.col1; col <= range.col2; col++) {
					const name = cellName({ col, row });
					if (inputs.has(name)) yield name;
				}
			}
		} else {
			spend(inputs.size);
			for (const name of inputs.keys()) {
				const cell = parseCellName(name);
				if (
					cell &&
					cell.col >= range.col1 &&
					cell.col <= range.col2 &&
					cell.row >= range.row1 &&
					cell.row <= range.row2
				) {
					yield name;
				}
			}
		}
	}

	/** The formula cells that a formula reads. */
	function* dependencies(node: Node): Generator<string> {
		switch (node.t) {
			case "ref": {
				const name = cellName(node);
				if (formulas.has(name)) yield name;
				return;
			}
			case "range":
				for (const name of cellsIn(node)) if (formulas.has(name)) yield name;
				return;
			case "unary":
				yield* dependencies(node.arg);
				return;
			case "binary":
				yield* dependencies(node.left);
				yield* dependencies(node.right);
				return;
			case "call":
				for (const arg of node.args) yield* dependencies(arg);
				return;
		}
	}

	function argument(node: Node): Arg {
		if (node.t !== "range") return { values: [evaluate(node)], range: false };
		const values: Value[] = [];
		for (const name of cellsIn(node)) values.push(results.get(name) ?? null);
		return { values, range: true };
	}

	function evaluate(node: Node): Value {
		spend(1);
		switch (node.t) {
			case "value":
				return node.value;
			case "error":
				return ERRORS[node.code];
			case "ref":
				return results.get(cellName(node)) ?? null;
			case "range":
				// A range is a value only as an argument of a function.
				return ERRORS["#VALUE!"];
			case "unary": {
				const value = toNumber(evaluate(node.arg));
				if (value instanceof ErrorValue) return value;
				return finite(node.op === "-" ? -value : node.op === "%" ? value / 100 : value);
			}
			case "binary": {
				const left = evaluate(node.left);
				const right = evaluate(node.right);
				const error = firstError([left, right]);
				if (error) return error;
				if (node.op === "&") return boundedText(`${toText(left)}${toText(right)}`);
				if (["=", "<>", "<", ">", "<=", ">="].includes(node.op)) {
					const order = compare(left, right);
					return {
						"=": order === 0,
						"<>": order !== 0,
						"<": order < 0,
						">": order > 0,
						"<=": order <= 0,
						">=": order >= 0,
					}[node.op] as boolean;
				}
				const a = toNumber(left);
				const b = toNumber(right);
				if (a instanceof ErrorValue) return a;
				if (b instanceof ErrorValue) return b;
				if (node.op === "/" && b === 0) return ERRORS["#DIV/0!"];
				return finite(
					node.op === "+"
						? a + b
						: node.op === "-"
							? a - b
							: node.op === "*"
								? a * b
								: node.op === "/"
									? a / b
									: a ** b,
				);
			}
			case "call": {
				// IF and IFERROR calculate only the argument that they return.
				if (node.name === "IF") {
					if (node.args.length < 2 || node.args.length > 3) return ERRORS["#VALUE!"];
					const test = toBoolean(evaluate(node.args[0] as Node));
					if (test instanceof ErrorValue) return test;
					const branch = node.args[test ? 1 : 2];
					return branch ? evaluate(branch) : false;
				}
				if (node.name === "IFERROR") {
					if (node.args.length !== 2) return ERRORS["#VALUE!"];
					const value = evaluate(node.args[0] as Node);
					return value instanceof ErrorValue ? evaluate(node.args[1] as Node) : value;
				}
				const fn = FUNCTIONS[node.name];
				return fn ? fn(node.args.map(argument)) : ERRORS["#NAME?"];
			}
		}
	}

	/** The result of a formula as the value of its cell. A formula that reads an empty cell gives 0. */
	function cellValue(node: Node): Value {
		const value = evaluate(node);
		return value === null ? 0 : value;
	}

	// A walk through the formulas with a stack of our own, so a long chain of cells cannot use up the
	// call stack. A cell is done when each formula cell that it reads is done.
	const state = new Map<string, "open" | "done">();
	const cyclic = new Set<string>();
	try {
		for (const start of formulas.keys()) {
			if (state.has(start)) continue;
			const stack = [{ name: start, pending: dependencies(formulas.get(start) as Node) }];
			state.set(start, "open");
			while (stack.length > 0) {
				const frame = stack[stack.length - 1] as (typeof stack)[number];
				const next = frame.pending.next();
				if (!next.done) {
					const seen = state.get(next.value);
					if (seen === undefined) {
						state.set(next.value, "open");
						stack.push({ name: next.value, pending: dependencies(formulas.get(next.value) as Node) });
					} else if (seen === "open") {
						// The cells from that cell to the top of the stack read each other in a circle.
						for (let i = stack.length - 1; i >= 0; i--) {
							cyclic.add((stack[i] as (typeof stack)[number]).name);
							if ((stack[i] as (typeof stack)[number]).name === next.value) break;
						}
					}
					continue;
				}
				stack.pop();
				results.set(
					frame.name,
					cyclic.has(frame.name) ? ERRORS["#CYCLE!"] : cellValue(formulas.get(frame.name) as Node),
				);
				state.set(frame.name, "done");
			}
		}
	} catch (error) {
		if (!(error instanceof BudgetError)) throw error;
		for (const name of formulas.keys()) if (state.get(name) !== "done") results.set(name, ERRORS["#LIMIT!"]);
	}
	return results;
}
