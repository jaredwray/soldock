import { type Cell, type CellFormat, type FormatPatch, patchFormat, SHEET_LIMITS } from "@soldock/contracts";
import { cellName, parseRange } from "./a1.ts";

// The formats of cells on the page: the formats from the server with the changes that wait on top,
// the changes that Undo sends, and the helpers of the format buttons. The server stores each format
// and gives the text of each number with a number format. The page uses the same rules from the
// contracts, so a change shows at once.

/** One change of `sheets.format_cells`: the fields to change in each cell of a range. */
export interface FormatChange {
	range: string;
	format: FormatPatch;
}

/** A patch that removes each field of a format. */
export const CLEAR_FORMAT: FormatPatch = {
	number_format: null,
	decimals: null,
	bold: false,
	italic: false,
	color: null,
	fill: null,
	align: null,
};

/** The format of each cell from the server that has one. */
export function formatsOf(cells: ReadonlyMap<string, Cell>): Map<string, CellFormat> {
	const formats = new Map<string, CellFormat>();
	for (const [name, cell] of cells) if (cell.format) formats.set(name, cell.format);
	return formats;
}

/** The count of cells of a range such as B2 or A1:D20. 0 for a range that is not valid. */
export function cellCount(range: string): number {
	const area = parseRange(range);
	return area ? (area.bottom - area.top + 1) * (area.right - area.left + 1) : 0;
}

/** Each cell name of a range such as B2 or A1:D20. Nothing for a range that is not valid. */
function* cellsIn(range: string): Generator<string> {
	const area = parseRange(range);
	if (!area) return;
	for (let row = area.top; row <= area.bottom; row++) {
		for (let col = area.left; col <= area.right; col++) yield cellName({ row, col });
	}
}

/** The formats after the changes, in order. */
export function applyFormatChanges(
	formats: ReadonlyMap<string, CellFormat>,
	changes: readonly FormatChange[],
): Map<string, CellFormat> {
	const next = new Map(formats);
	for (const change of changes) {
		for (const name of cellsIn(change.range)) {
			const format = patchFormat(next.get(name), change.format);
			if (format) next.set(name, format);
			else next.delete(name);
		}
	}
	return next;
}

/** True when the changes give at least one cell a different format. */
export function changesFormats(formats: ReadonlyMap<string, CellFormat>, changes: readonly FormatChange[]): boolean {
	const after = applyFormatChanges(formats, changes);
	for (const change of changes) {
		for (const name of cellsIn(change.range)) {
			if (JSON.stringify(formats.get(name)) !== JSON.stringify(after.get(name))) return true;
		}
	}
	return false;
}

/**
 * The changes that give the cells of `changes` their formats of now again: Undo sends them. Each
 * range is cleared first, and then each cell in it that has a format gets that format back.
 */
export function restoreFormats(
	formats: ReadonlyMap<string, CellFormat>,
	changes: readonly FormatChange[],
): FormatChange[] {
	const restore: FormatChange[] = [];
	const done = new Set<string>();
	for (const change of changes) restore.push({ range: change.range, format: CLEAR_FORMAT });
	for (const change of changes) {
		for (const name of cellsIn(change.range)) {
			const format = formats.get(name);
			if (!format || done.has(name)) continue;
			done.add(name);
			restore.push({ range: name, format: { ...CLEAR_FORMAT, ...format } });
		}
	}
	return restore;
}

/**
 * The digits after the decimal point that a number shows now, as the start of a change with the
 * decimal buttons. A format with decimals or a number format gives them. Else the text of the number
 * gives them: 0.25 has 2.
 */
export function decimalsShown(text: string, format: CellFormat | undefined): number {
	if (format?.decimals !== undefined) return format.decimals;
	if (format?.number_format !== undefined) return 2;
	const match = /\.(\d+)/.exec(text);
	return Math.min(SHEET_LIMITS.decimals, match?.[1]?.length ?? 0);
}

/** A text color that is easy to read on a fill: near black on a light fill, white on a dark fill. */
export function textColorOn(fill: string): string {
	const channel = (start: number) => {
		const value = Number.parseInt(fill.slice(start, start + 2), 16) / 255;
		return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	};
	const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
	return luminance > 0.4 ? "#111827" : "#ffffff";
}
