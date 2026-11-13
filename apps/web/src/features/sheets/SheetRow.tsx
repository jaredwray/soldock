import { memo } from "react";
import type { ViewCell } from "./cells.ts";

// The rows of the grid. The grid is a table with the role `grid`, so each `tr` is a row, each `th`
// is a column or row header and each `td` is a gridcell. Each row is a memo component, so a move of
// the selection draws only the rows that the selection touches.

/** The element id of a cell. The grid names the active cell with it in `aria-activedescendant`. */
export function cellId(gridId: string, name: string): string {
	return `${gridId}-${name}`;
}

interface ColumnHeadsProps {
	names: readonly string[];
	/** The first and the last selected column. */
	left: number;
	right: number;
}

/** The row of column letters. It stays at the top while the grid scrolls. */
export const ColumnHeads = memo(function ColumnHeads({ names, left, right }: ColumnHeadsProps) {
	return (
		<tr aria-rowindex={1} className="sheet-heads">
			<th scope="col" aria-colindex={1} className="sheet-corner" data-corner="">
				<span className="visually-hidden">Select all cells</span>
			</th>
			{names.map((name, col) => (
				<th
					key={name}
					scope="col"
					aria-colindex={col + 2}
					className={col >= left && col <= right ? "sheet-col-head sheet-head-selected" : "sheet-col-head"}
					data-col-head={col}
				>
					{name}
				</th>
			))}
		</tr>
	);
});

interface SheetRowProps {
	gridId: string;
	row: number;
	names: readonly string[];
	cells: ReadonlyMap<string, ViewCell>;
	/** The first and the last selected column of this row, or -1 when the row has no selected cell. */
	left: number;
	right: number;
	/** The column of the active cell, or -1 when the active cell is in a different row. */
	activeCol: number;
}

function cellClass(cell: ViewCell | undefined, selected: boolean, active: boolean): string {
	let name = "sheet-cell";
	if (cell) name += ` sheet-cell-${cell.type}`;
	if (cell?.pending) name += " sheet-cell-pending";
	if (selected) name += " sheet-cell-selected";
	if (active) name += " sheet-cell-active";
	return name;
}

export const SheetRow = memo(function SheetRow({ gridId, row, names, cells, left, right, activeCol }: SheetRowProps) {
	const number = row + 1;
	return (
		<tr aria-rowindex={row + 2} className="sheet-row">
			<th
				scope="row"
				aria-colindex={1}
				className={left >= 0 ? "sheet-row-head sheet-head-selected" : "sheet-row-head"}
				data-row-head={row}
			>
				{number}
			</th>
			{names.map((column, col) => {
				const name = `${column}${number}`;
				const cell = cells.get(name);
				const selected = col >= left && col <= right;
				return (
					// biome-ignore lint/a11y/useAriaPropsSupportedByRole: a td in a table with the role grid is a gridcell, which has aria-selected.
					<td
						key={column}
						id={cellId(gridId, name)}
						aria-colindex={col + 2}
						aria-selected={selected}
						className={cellClass(cell, selected, col === activeCol)}
						// The full input of an error cell, so a person can read the formula that failed.
						title={cell?.type === "error" ? `${cell.text}: ${cell.input}` : undefined}
						data-row={row}
						data-col={col}
					>
						{cell?.text}
					</td>
				);
			})}
		</tr>
	);
});
