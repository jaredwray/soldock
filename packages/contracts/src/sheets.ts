import { DriveItem, IN_SPACE, ItemId, ItemName, SpaceParam } from "./drive.ts";
import { defineOperation } from "./operation.ts";
import { z } from "./zod.ts";

export const SHEET_LIMITS = {
	rows: 1000,
	/** Columns A to AZ. */
	columns: 52,
	/** The cells of one sheet that hold an input. */
	cells: 20_000,
	inputChars: 2000,
	cellsPerUpdate: 5000,
	/** The JSON of the inputs of one sheet, in bytes of UTF-8. A Durable Object row holds at most 2 MB. */
	contentBytes: 1024 * 1024,
} as const;

/** The error values of a cell. A formula that uses an error cell gets the same error. */
export const SHEET_ERRORS = [
	"#DIV/0!",
	"#VALUE!",
	"#REF!",
	"#NAME?",
	"#NUM!",
	"#CYCLE!",
	"#ERROR!",
	"#LIMIT!",
] as const;
export type SheetError = (typeof SHEET_ERRORS)[number];

/** A cell in A1 form: the column letters, then the row number. */
const CellRef = z
	.string()
	.trim()
	.toUpperCase()
	.regex(/^[A-Z]{1,2}[1-9][0-9]{0,3}$/, "must be a cell such as B2, from A1 to AZ1000");

const CellInput = z.strictObject({
	cell: CellRef,
	/**
	 * What a person types in the cell. A text that starts with = is a formula. A number, TRUE and FALSE
	 * are values. Each other text is text. An empty string clears the cell.
	 */
	input: z.string().max(SHEET_LIMITS.inputChars),
});

export const Cell = z.object({
	cell: z.string(),
	/** The input of the cell, for example =SUM(A1:A3). Empty for a cell that the change cleared. */
	input: z.string(),
	/** The result: a number, a text, true or false, an error such as #DIV/0!, or null for an empty cell. */
	value: z.union([z.number(), z.string(), z.boolean(), z.null()]),
	type: z.enum(["number", "text", "boolean", "error", "empty"]),
});
export type Cell = z.infer<typeof Cell>;

const FORMULA_NOTE =
	"A formula starts with =. It can use numbers, texts in double quotes, TRUE and FALSE, cells (B2), ranges (A1:C3), the operators + - * / ^ & = <> < > <= >= and %, and these functions: SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, IF, IFERROR, AND, OR, NOT, ROUND, ABS, INT, MOD, POWER, SQRT, CONCAT, CONCATENATE, LEN, UPPER, LOWER, TRIM, LEFT, RIGHT and MID.";

export const createSheet = defineOperation({
	name: "sheets.create",
	summary: "Create a sheet",
	description: [
		"Creates a spreadsheet with one grid in the folder parent_id, or at the root of the drive without parent_id.",
		`The grid has the columns A to AZ and the rows 1 to ${SHEET_LIMITS.rows}. Set cells to fill it.`,
		FORMULA_NOTE,
		`In a folder of somebody else, you need the editor role, and the owner of that drive owns the new sheet. ${IN_SPACE}`,
	].join(" "),
	http: { method: "POST", path: "/api/v1/sheets" },
	scopes: ["drive.write"],
	callers: ["human", "agent"],
	annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: false },
	input: z.strictObject({
		space_id: SpaceParam,
		parent_id: ItemId.optional(),
		name: ItemName,
		cells: z.array(CellInput).max(SHEET_LIMITS.cellsPerUpdate).default([]),
		idempotency_key: z.string().min(1).max(255).optional(),
	}),
	output: z.object({ item: DriveItem, revision: z.number().int() }),
	errors: ["not_found", "invalid", "payload_too_large", "conflict"],
});

export const getSheet = defineOperation({
	name: "sheets.get",
	summary: "Get the cells of a sheet",
	description: `Returns each cell that has an input, with the input and the result of its formula. rows and columns give the last row and the last column that have a cell. Set range (for example A1:D20) to get only the cells in that range. ${IN_SPACE}`,
	http: { method: "GET", path: "/api/v1/sheets/{item_id}" },
	scopes: ["drive.read"],
	callers: ["human", "agent"],
	annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
	input: z.strictObject({
		space_id: SpaceParam,
		item_id: ItemId,
		range: z
			.string()
			.trim()
			.toUpperCase()
			.regex(/^[A-Z]{1,2}[1-9][0-9]{0,3}(?::[A-Z]{1,2}[1-9][0-9]{0,3})?$/, "must be a range such as A1:D20")
			.optional(),
	}),
	output: z.object({
		item: DriveItem,
		revision: z.number().int(),
		rows: z.number().int(),
		columns: z.number().int(),
		cells: z.array(Cell),
	}),
	errors: ["not_found", "invalid"],
});

export const updateCells = defineOperation({
	name: "sheets.update_cells",
	summary: "Change cells of a sheet",
	description: [
		"Sets the input of each given cell. An empty input clears the cell. The server calculates each formula again. You need the editor role.",
		FORMULA_NOTE,
		"The result has each cell whose input or result changed, also the cells that depend on a changed cell.",
		"Set base_revision to the revision that you read. When somebody changed the sheet after that, the call fails with conflict and changes nothing: read the sheet again.",
		IN_SPACE,
	].join(" "),
	http: { method: "POST", path: "/api/v1/sheets/{item_id}/cells" },
	scopes: ["drive.write"],
	callers: ["human", "agent"],
	annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
	input: z.strictObject({
		space_id: SpaceParam,
		item_id: ItemId,
		cells: z.array(CellInput).min(1).max(SHEET_LIMITS.cellsPerUpdate),
		base_revision: z.number().int().min(0).optional(),
	}),
	output: z.object({
		item: DriveItem,
		revision: z.number().int(),
		rows: z.number().int(),
		columns: z.number().int(),
		cells: z.array(Cell),
	}),
	errors: ["not_found", "invalid", "conflict", "payload_too_large"],
});

export const sheetsOperations = {
	"sheets.create": createSheet,
	"sheets.get": getSheet,
	"sheets.update_cells": updateCells,
} as const;
