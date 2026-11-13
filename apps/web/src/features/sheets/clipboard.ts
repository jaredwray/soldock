// The clipboard text of a block of cells: tab-separated values, one line for each row. This is the
// text that the usual spreadsheets write and read.

function needsQuotes(field: string): boolean {
	return /[\t\r\n]/.test(field) || field.startsWith('"');
}

/** A block of cells as tab-separated text. A field with a tab or a line break goes in double quotes. */
export function formatTsv(rows: readonly (readonly string[])[]): string {
	return rows
		.map((row) => row.map((field) => (needsQuotes(field) ? `"${field.replaceAll('"', '""')}"` : field)).join("\t"))
		.join("\n");
}

/**
 * The end of a quoted field that starts at `start`, or -1 when the text there is not a quoted field.
 * A quoted field ends with a double quote before a tab, a line break or the end of the text.
 */
function quotedEnd(text: string, start: number): number {
	for (let index = start + 1; index < text.length; index++) {
		if (text[index] !== '"') continue;
		if (text[index + 1] === '"') {
			index++;
			continue;
		}
		const next = text[index + 1];
		return next === undefined || next === "\t" || next === "\n" ? index : -1;
	}
	return -1;
}

/**
 * Tab-separated text as a block of cells. One line break at the end of the text does not make a
 * row. A field in double quotes can hold tabs and line breaks. A quote that does not close stays text.
 */
export function parseTsv(text: string): string[][] {
	const source = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
	if (source === "") return [];
	const rows: string[][] = [];
	let row: string[] = [];
	let index = 0;
	for (;;) {
		let field: string;
		const end = source[index] === '"' ? quotedEnd(source, index) : -1;
		if (end >= 0) {
			field = source.slice(index + 1, end).replaceAll('""', '"');
			index = end + 1;
		} else {
			let stop = index;
			while (stop < source.length && source[stop] !== "\t" && source[stop] !== "\n") stop++;
			field = source.slice(index, stop);
			index = stop;
		}
		row.push(field);
		const separator = source[index];
		if (separator === "\t") {
			index++;
			continue;
		}
		rows.push(row);
		row = [];
		if (separator === undefined) return rows;
		index++;
	}
}
