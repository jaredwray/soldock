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
	/** The tabs of one sheet. */
	tabs: 50,
	/** The characters of a tab name. Excel has the same limit, so an export to XLSX keeps each name. */
	tabNameChars: 31,
	/** The cells of one sheet that have a format, in all tabs. */
	formats: 20_000,
	/** The digits after the decimal point that a number format can show. */
	decimals: 10,
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

/** A cell or a range of cells in A1 form, for example B2 or A1:D20. */
const RangeRef = z
	.string()
	.trim()
	.toUpperCase()
	.regex(/^[A-Z]{1,2}[1-9][0-9]{0,3}(?::[A-Z]{1,2}[1-9][0-9]{0,3})?$/, "must be a cell or a range such as A1:D20");

const CellInput = z.strictObject({
	cell: CellRef,
	/**
	 * What a person types in the cell. A text that starts with = is a formula. A number, TRUE and FALSE
	 * are values. Each other text is text. An empty string clears the cell.
	 */
	input: z.string().max(SHEET_LIMITS.inputChars),
});

/** The id of a tab in its sheet, for example tab_2. The id stays the same when the tab gets a new name. */
export const TabId = z
	.string()
	.regex(/^tab_[1-9][0-9]{0,8}$/, "must be the id of a tab, such as tab_2")
	.describe("The id of a tab, as the tabs of sheets.get return it.");

/**
 * The characters that a tab name cannot have: the characters that Excel refuses, and control and
 * format characters, so that two names that look the same are not two different names.
 */
const TAB_NAME_FORBIDDEN = /[\p{Cc}\p{Cf}[\]:*?/\\]/u;

/** The name of a tab. A formula refers to a tab with its name, for example ='Q1 costs'!B4. */
export const TabName = z
	.string()
	.trim()
	.min(1)
	.max(SHEET_LIMITS.tabNameChars)
	.refine((name) => !TAB_NAME_FORBIDDEN.test(name), "must not contain control or format characters, or [ ] : * ? / \\")
	.refine((name) => !name.startsWith("'") && !name.endsWith("'"), "must not start or end with '");

/** One grid of a sheet. */
export const Tab = z.object({
	id: z.string(),
	name: z.string(),
	/** The last row and the last column of the tab that have a cell with an input. 0 for an empty tab. */
	rows: z.number().int(),
	columns: z.number().int(),
});
export type Tab = z.infer<typeof Tab>;

/** The number formats of a cell. Without one, a number shows with at most 10 significant digits. */
export const NUMBER_FORMATS = ["currency", "percent"] as const;
/** The horizontal alignments of a cell. Without one, a number goes right, text left, and TRUE and FALSE in the center. */
export const CELL_ALIGNS = ["left", "center", "right"] as const;

/** The format of a cell. Each field is optional: a cell without a field has the default for it. */
export const CellFormat = z.object({
	/** currency shows $1,234.50. percent shows 0.125 as 12.50%. */
	number_format: z.enum(NUMBER_FORMATS).optional(),
	/** The digits after the decimal point. The default is 2 with a number format. */
	decimals: z.number().int().optional(),
	bold: z.boolean().optional(),
	italic: z.boolean().optional(),
	/** The color of the text, as #rrggbb. */
	color: z.string().optional(),
	/** The fill color of the cell, as #rrggbb. */
	fill: z.string().optional(),
	align: z.enum(CELL_ALIGNS).optional(),
});
export type CellFormat = z.infer<typeof CellFormat>;

const Color = z
	.string()
	.regex(/^#[0-9a-fA-F]{6}$/, "must be a color such as #1d4ed8")
	.transform((color) => color.toLowerCase());

/** A change to the formats of a range. A field that is not given stays. null, or false, removes a field. */
const FormatPatch = z.strictObject({
	number_format: z.enum(NUMBER_FORMATS).nullable().optional(),
	decimals: z.number().int().min(0).max(SHEET_LIMITS.decimals).nullable().optional(),
	bold: z.boolean().optional(),
	italic: z.boolean().optional(),
	color: Color.nullable().optional(),
	fill: Color.nullable().optional(),
	align: z.enum(CELL_ALIGNS).nullable().optional(),
});
export type FormatPatch = z.output<typeof FormatPatch>;

/** The fields of a format, in the order that the stored form and the output have them. */
export const FORMAT_KEYS = ["number_format", "decimals", "bold", "italic", "color", "fill", "align"] as const;

/**
 * The format after a patch. A field that the patch does not give stays. null and false remove a
 * field. The result is undefined when no field is left. The server and the web app use it, so both
 * give a cell the same format.
 */
export function patchFormat(format: CellFormat | undefined, patch: FormatPatch): CellFormat | undefined {
	const next: Record<string, unknown> = {};
	for (const key of FORMAT_KEYS) {
		const value = patch[key] === undefined ? format?.[key] : patch[key];
		if (value !== null && value !== undefined && value !== false) next[key] = value;
	}
	return Object.keys(next).length > 0 ? (next as CellFormat) : undefined;
}

const numberFormats = new Map<number, Intl.NumberFormat>();

/**
 * The text of a number with the number format of a cell, for example $1,234.50 or 12.50%. Null when
 * the format has no number format and no decimals: the number then shows as it is.
 */
export function formatCellNumber(value: number, format: CellFormat | undefined): string | null {
	if (format?.number_format === undefined && format?.decimals === undefined) return null;
	const digits = format.decimals ?? 2;
	let style = numberFormats.get(digits);
	if (!style) {
		style = new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
		numberFormats.set(digits, style);
	}
	const scaled = format.number_format === "percent" ? value * 100 : value;
	let text = style.format(scaled);
	// A small negative number that rounds to zero shows as zero, without a minus.
	if (/^-[0.,]+$/.test(text)) text = text.slice(1);
	if (format.number_format === "percent") return `${text}%`;
	if (format.number_format === "currency") return text.startsWith("-") ? `-$${text.slice(1)}` : `$${text}`;
	return text;
}

export const Cell = z.object({
	cell: z.string(),
	/** The input of the cell, for example =SUM(A1:A3). Empty for a cell that the change cleared, or for a cell with only a format. */
	input: z.string(),
	/** The result: a number, a text, true or false, an error such as #DIV/0!, or null for an empty cell. */
	value: z.union([z.number(), z.string(), z.boolean(), z.null()]),
	type: z.enum(["number", "text", "boolean", "error", "empty"]),
	/** The format of the cell. Only a cell that has a format has it. */
	format: CellFormat.optional(),
	/** The number as the grid shows it with the number format, for example $1,234.50. Only a number cell with a number format or decimals has it. */
	text: z.string().optional(),
});
export type Cell = z.infer<typeof Cell>;

const FORMULA_NOTE =
	"A formula starts with =. It can use numbers, texts in double quotes, TRUE and FALSE, cells (B2), ranges (A1:C3), cells and ranges of a different tab (Costs!B2, 'Q1 costs'!A1:C3), the operators + - * / ^ & = <> < > <= >= and %, and these functions: SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, IF, IFERROR, AND, OR, NOT, ROUND, ABS, INT, MOD, POWER, SQRT, CONCAT, CONCATENATE, LEN, UPPER, LOWER, TRIM, LEFT, RIGHT and MID.";

const TAB_PARAM = TabId.optional().describe("The tab. The default is the first tab.");

const TAB_NOTE =
	"A sheet has one or more tabs. Each tab is a grid. tabs lists them in order, with the id and the name.";

/** The output of an operation that changes the tabs. */
const TabsOutput = z.object({ item: DriveItem, revision: z.number().int(), tabs: z.array(Tab) });

const BASE_REVISION = z
	.number()
	.int()
	.min(0)
	.optional()
	.describe("The revision that you read. When the sheet changed after it, the call fails with conflict.");

export const createSheet = defineOperation({
	name: "sheets.create",
	summary: "Create a sheet",
	description: [
		"Creates a spreadsheet with one tab, Sheet1, in the folder parent_id, or at the root of the drive without parent_id.",
		`A tab is a grid with the columns A to AZ and the rows 1 to ${SHEET_LIMITS.rows}. Set cells to fill the first tab. Add more tabs with sheets.add_tab.`,
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
	description: `Returns each cell of one tab that has an input or a format, with the input, the result of its formula and the format. rows and columns give the last row and the last column of the tab that have a cell with an input. Set range (for example A1:D20) to get only the cells in that range. ${TAB_NOTE} Set tab_id to read a different tab than the first. ${IN_SPACE}`,
	http: { method: "GET", path: "/api/v1/sheets/{item_id}" },
	scopes: ["drive.read"],
	callers: ["human", "agent"],
	annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
	input: z.strictObject({
		space_id: SpaceParam,
		item_id: ItemId,
		tab_id: TAB_PARAM,
		range: RangeRef.optional(),
	}),
	output: z.object({
		item: DriveItem,
		revision: z.number().int(),
		tabs: z.array(Tab),
		/** The tab of `cells`. */
		tab_id: z.string(),
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
		"Sets the input of each given cell of one tab. An empty input clears the cell. The server calculates each formula again. You need the editor role.",
		"Set tab_id to change a different tab than the first.",
		FORMULA_NOTE,
		"The result has each cell of the tab whose input or result changed, also the cells of the tab that depend on a changed cell. Formulas of other tabs that read a changed cell also get new results: read them with sheets.get.",
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
		tab_id: TAB_PARAM,
		cells: z.array(CellInput).min(1).max(SHEET_LIMITS.cellsPerUpdate),
		base_revision: z.number().int().min(0).optional(),
	}),
	output: z.object({
		item: DriveItem,
		revision: z.number().int(),
		tabs: z.array(Tab),
		/** The tab of `cells`. */
		tab_id: z.string(),
		rows: z.number().int(),
		columns: z.number().int(),
		cells: z.array(Cell),
	}),
	errors: ["not_found", "invalid", "conflict", "payload_too_large"],
});

export const formatCells = defineOperation({
	name: "sheets.format_cells",
	summary: "Change the format of cells of a sheet",
	description: [
		"Changes the format of each cell in the given ranges of one tab: the number format, the decimals, bold, italic, the text color, the fill color and the alignment. You need the editor role.",
		"Each change has a range (B2 or A1:D20) and the fields to change. A field that is not given stays. null, or false for bold and italic, removes the field. The changes apply in order.",
		"number_format currency shows $1,234.50, and percent shows 0.125 as 12.50%. decimals is the count of digits after the decimal point: the default is 2 with a number format. Colors are #rrggbb.",
		`A cell keeps its format when its input changes or is cleared. A sheet can have at most ${SHEET_LIMITS.formats} cells with a format, and one call can change at most ${SHEET_LIMITS.rows * SHEET_LIMITS.columns} cells.`,
		"The result has each cell of the tab whose format changed, with its format, and with text when a number format changes how its number shows.",
		"Set tab_id to change a different tab than the first. Set base_revision to the revision that you read.",
		IN_SPACE,
	].join(" "),
	http: { method: "POST", path: "/api/v1/sheets/{item_id}/formats" },
	scopes: ["drive.write"],
	callers: ["human", "agent"],
	annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
	input: z.strictObject({
		space_id: SpaceParam,
		item_id: ItemId,
		tab_id: TAB_PARAM,
		formats: z
			.array(z.strictObject({ range: RangeRef, format: FormatPatch }))
			.min(1)
			.max(SHEET_LIMITS.cellsPerUpdate),
		base_revision: BASE_REVISION,
	}),
	output: z.object({
		item: DriveItem,
		revision: z.number().int(),
		tabs: z.array(Tab),
		/** The tab of `cells`. */
		tab_id: z.string(),
		rows: z.number().int(),
		columns: z.number().int(),
		cells: z.array(Cell),
	}),
	errors: ["not_found", "invalid", "conflict", "payload_too_large"],
});

const TAB_RULES = `A tab name has 1 to ${SHEET_LIMITS.tabNameChars} characters, without [ ] : * ? / \\, and does not start or end with '. Two tabs of a sheet cannot have the same name, in upper or lower case. A retry with the same name gets invalid, so a call with a name is safe to send again.`;

export const addTab = defineOperation({
	name: "sheets.add_tab",
	summary: "Add a tab to a sheet",
	description: [
		"Adds an empty tab to a sheet. Without name, the tab gets the first free name of Sheet1, Sheet2 and so on. Without index, the tab goes after the last tab.",
		"index is the position of the new tab: 0 is the first.",
		TAB_RULES,
		`A sheet has at most ${SHEET_LIMITS.tabs} tabs. A formula that refers to the name of the new tab gets its cells. You need the editor role.`,
		IN_SPACE,
	].join(" "),
	http: { method: "POST", path: "/api/v1/sheets/{item_id}/tabs" },
	scopes: ["drive.write"],
	callers: ["human", "agent"],
	annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: false },
	input: z.strictObject({
		space_id: SpaceParam,
		item_id: ItemId,
		name: TabName.optional(),
		index: z.number().int().min(0).optional(),
		base_revision: BASE_REVISION,
	}),
	output: TabsOutput.extend({ tab_id: z.string().describe("The id of the new tab.") }),
	errors: ["not_found", "invalid", "conflict"],
});

export const renameTab = defineOperation({
	name: "sheets.rename_tab",
	summary: "Give a tab of a sheet a new name",
	description: [
		"Gives a tab a new name. Each formula of the sheet that refers to the old name gets the new name, so its result stays the same.",
		TAB_RULES,
		"You need the editor role.",
		IN_SPACE,
	].join(" "),
	http: { method: "POST", path: "/api/v1/sheets/{item_id}/tabs/{tab_id}/rename" },
	scopes: ["drive.write"],
	callers: ["human", "agent"],
	annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
	input: z.strictObject({
		space_id: SpaceParam,
		item_id: ItemId,
		tab_id: TabId,
		name: TabName,
		base_revision: BASE_REVISION,
	}),
	output: TabsOutput,
	errors: ["not_found", "invalid", "conflict", "payload_too_large"],
});

export const moveTab = defineOperation({
	name: "sheets.move_tab",
	summary: "Move a tab of a sheet to a different position",
	description: `Moves a tab to the position index: 0 is the first. An index after the last tab moves the tab to the end. You need the editor role. ${IN_SPACE}`,
	http: { method: "POST", path: "/api/v1/sheets/{item_id}/tabs/{tab_id}/move" },
	scopes: ["drive.write"],
	callers: ["human", "agent"],
	annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
	input: z.strictObject({
		space_id: SpaceParam,
		item_id: ItemId,
		tab_id: TabId,
		index: z.number().int().min(0),
		base_revision: BASE_REVISION,
	}),
	output: TabsOutput,
	errors: ["not_found", "invalid", "conflict"],
});

export const duplicateTab = defineOperation({
	name: "sheets.duplicate_tab",
	summary: "Make a copy of a tab of a sheet",
	description: [
		'Makes a copy of a tab with each of its cells, directly after the tab. Without name, the copy gets the name "Copy of" and the name of the tab.',
		TAB_RULES,
		`A sheet has at most ${SHEET_LIMITS.tabs} tabs and ${SHEET_LIMITS.cells} cells with an input. You need the editor role.`,
		IN_SPACE,
	].join(" "),
	http: { method: "POST", path: "/api/v1/sheets/{item_id}/tabs/{tab_id}/duplicate" },
	scopes: ["drive.write"],
	callers: ["human", "agent"],
	annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: false },
	input: z.strictObject({
		space_id: SpaceParam,
		item_id: ItemId,
		tab_id: TabId,
		name: TabName.optional(),
		base_revision: BASE_REVISION,
	}),
	output: TabsOutput.extend({ tab_id: z.string().describe("The id of the copy.") }),
	errors: ["not_found", "invalid", "conflict", "payload_too_large"],
});

export const deleteTab = defineOperation({
	name: "sheets.delete_tab",
	summary: "Delete a tab of a sheet",
	description: [
		"Deletes a tab and each of its cells. This cannot be undone. A sheet keeps at least one tab, so the last tab cannot be deleted.",
		"A formula of a different tab that refers to the deleted tab gets #REF!. It keeps its text, so a new tab with the same name gives it a result again.",
		"Set dry_run to true to get the count of cells that the delete removes and of formulas that get #REF!, without a change.",
		"You need the editor role.",
		IN_SPACE,
	].join(" "),
	http: { method: "DELETE", path: "/api/v1/sheets/{item_id}/tabs/{tab_id}" },
	scopes: ["drive.write"],
	callers: ["human", "agent"],
	annotations: { readOnly: false, destructive: true, idempotent: false, openWorld: false },
	input: z.strictObject({
		space_id: SpaceParam,
		item_id: ItemId,
		tab_id: TabId,
		base_revision: BASE_REVISION,
		dry_run: z.boolean().default(false),
	}),
	output: TabsOutput.extend({
		/** The cells of the tab that have an input. */
		cells: z.number().int(),
		/** The formulas of other tabs that refer to the tab, and get #REF! after the delete. */
		references: z.number().int(),
		dry_run: z.boolean(),
	}),
	errors: ["not_found", "invalid", "conflict"],
});

export const sheetsOperations = {
	"sheets.create": createSheet,
	"sheets.get": getSheet,
	"sheets.update_cells": updateCells,
	"sheets.format_cells": formatCells,
	"sheets.add_tab": addTab,
	"sheets.rename_tab": renameTab,
	"sheets.move_tab": moveTab,
	"sheets.duplicate_tab": duplicateTab,
	"sheets.delete_tab": deleteTab,
} as const;
