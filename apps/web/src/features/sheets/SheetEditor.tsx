import { SHEET_LIMITS } from "@soldock/contracts";
import {
	type ClipboardEvent,
	type CSSProperties,
	type KeyboardEvent,
	type MouseEvent,
	type PointerEvent,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useToast } from "../../lib/toast.tsx";
import { type CellPos, cellName, columnNames, parseCell } from "./a1.ts";
import { type CellChange, clearChanges, pasteChanges, rangeInputs, tooLong, usedSize, type ViewCell } from "./cells.ts";
import { formatTsv, parseTsv } from "./clipboard.ts";
import { ColumnHeads, cellId, SheetRow } from "./SheetRow.tsx";
import {
	FIRST_CELL,
	gridSize,
	moveSelection,
	type Range,
	rangeOf,
	type Selection,
	selectCell,
	step,
} from "./selection.ts";

// The sizes of the grid, in pixels. The style sheet gets them as custom properties, so the two agree.
const COLUMN_WIDTH = 104;
const ROW_HEIGHT = 28;
const HEAD_WIDTH = 48;
/** The rows that the grid draws above and below the rows on screen. */
const SPARE_ROWS = 8;
const UNDO_STEPS = 100;

const GRID_STYLE = {
	"--sheet-column-width": `${COLUMN_WIDTH}px`,
	"--sheet-row-height": `${ROW_HEIGHT}px`,
	"--sheet-head-width": `${HEAD_WIDTH}px`,
} as CSSProperties;

interface Edit {
	/** The cell that the edit changes. */
	cell: CellPos;
	value: string;
	/** `replace`: the edit started with a typed character, and the arrow keys end it. `keep`: it started with the input of the cell. */
	mode: "replace" | "keep";
	/** Where the person types: the editor over the cell, or the formula bar. */
	source: "cell" | "bar";
}

/** One change of the person, for Undo and Redo. */
interface Step {
	before: CellChange[];
	after: CellChange[];
}

type Hit = { kind: "cell"; pos: CellPos } | { kind: "column"; col: number } | { kind: "row"; row: number } | "corner";

/** The part of the grid under a pointer event. */
function hitOf(target: EventTarget): Hit | null {
	if (!(target instanceof Element)) return null;
	const cell = target.closest<HTMLElement>("[data-row]");
	if (cell) return { kind: "cell", pos: { row: Number(cell.dataset.row), col: Number(cell.dataset.col) } };
	const column = target.closest<HTMLElement>("[data-col-head]");
	if (column) return { kind: "column", col: Number(column.dataset.colHead) };
	const row = target.closest<HTMLElement>("[data-row-head]");
	if (row) return { kind: "row", row: Number(row.dataset.rowHead) };
	return target.closest("[data-corner]") ? "corner" : null;
}

function samePos(a: CellPos, b: CellPos): boolean {
	return a.row === b.row && a.col === b.col;
}

/** The space of the rows that the grid does not draw, above or below the rows on screen. */
function SpacerRow({ columns, height }: { columns: number; height: number }) {
	return (
		<tr className="sheet-spacer">
			<td colSpan={columns + 1} style={{ height }} />
		</tr>
	);
}

interface SheetEditorProps {
	/** The name of the sheet, for the accessible name of the grid. */
	name: string;
	cells: ReadonlyMap<string, ViewCell>;
	/** True for a viewer: selection and copy work, and no edit. */
	readOnly: boolean;
	/**
	 * The current input of a cell. It comes from the store, not from `cells`, so it is correct in the
	 * same event as a commit, before the grid draws again.
	 */
	inputOf: (cell: string) => string;
	onCommit: (changes: CellChange[]) => void;
}

/**
 * The formula bar and the grid. The grid is one tab stop: the arrow keys move the selection in it.
 * It draws only the rows near the rows on screen, so a sheet with 1000 rows stays fast.
 */
export function SheetEditor({ name, cells, readOnly, inputOf: inputAt, onCommit }: SheetEditorProps) {
	const toast = useToast();
	const gridId = useId();
	const hintId = useId();
	const [selection, setSelection] = useState<Selection>(() => selectCell(FIRST_CELL));
	const [edit, setEditState] = useState<Edit | null>(null);
	const [rowWindow, setRowWindow] = useState({ first: 0, last: 60 });
	const [nameDraft, setNameDraft] = useState<string | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const gridRef = useRef<HTMLTableElement>(null);
	const editorRef = useRef<HTMLInputElement>(null);
	const editRef = useRef<Edit | null>(null);
	const draggingRef = useRef(false);
	const pointerTypeRef = useRef("mouse");
	/** True after Escape: the next Tab leaves the grid. */
	const leaveRef = useRef(false);
	/** True when the next selection must not scroll the grid, for example a whole column. */
	const keepScrollRef = useRef(false);
	const historyRef = useRef<{ undo: Step[]; redo: Step[] }>({ undo: [], redo: [] });

	const used = useMemo(() => usedSize(cells.keys()), [cells]);
	const size = gridSize(used, selection);
	const names = useMemo(() => columnNames(size.columns), [size.columns]);
	const range = rangeOf(selection);
	const active = selection.anchor;
	const activeName = cellName(active);

	function setEdit(next: Edit | null) {
		editRef.current = next;
		setEditState(next);
	}

	function select(next: Selection, options: { keepScroll?: boolean } = {}) {
		keepScrollRef.current = options.keepScroll === true;
		setSelection((current) =>
			samePos(current.anchor, next.anchor) && samePos(current.focus, next.focus) ? current : next,
		);
	}

	function move(rows: number, cols: number, extend: boolean) {
		select(moveSelection(selection, rows, cols, extend));
	}

	function selectRange(next: Range, options?: { keepScroll?: boolean }) {
		select({ anchor: { row: next.top, col: next.left }, focus: { row: next.bottom, col: next.right } }, options);
	}

	/** Sends changes to the store. Returns false, with a message, when an input is too long. */
	function apply(changes: CellChange[]): boolean {
		const long = tooLong(changes, SHEET_LIMITS.inputChars);
		if (long) {
			toast({
				message: `The input of ${long.cell} is too long. A cell holds at most ${SHEET_LIMITS.inputChars} characters.`,
				tone: "error",
			});
			return false;
		}
		const after = changes.filter((change) => inputAt(change.cell) !== change.input);
		if (after.length === 0) return true;
		const history = historyRef.current;
		history.undo.push({ before: after.map((change) => ({ cell: change.cell, input: inputAt(change.cell) })), after });
		if (history.undo.length > UNDO_STEPS) history.undo.shift();
		history.redo = [];
		onCommit(after);
		return true;
	}

	/** Undo sends the inputs from before a step. Redo sends the inputs of the step again. */
	function replay(from: "undo" | "redo") {
		if (readOnly) return;
		const history = historyRef.current;
		const entry = history[from].pop();
		if (!entry) return;
		history[from === "undo" ? "redo" : "undo"].push(entry);
		const changes = from === "undo" ? entry.before : entry.after;
		onCommit(changes);
		const first = parseCell(changes[0]?.cell ?? "");
		if (first) select(selectCell(first));
	}

	function startEdit(mode: Edit["mode"], source: Edit["source"], first?: string) {
		if (readOnly) return;
		setEdit({ cell: active, value: first ?? inputAt(activeName), mode, source });
	}

	/**
	 * Ends the edit and keeps the input. With `rows` or `cols`, the selection then moves, and the
	 * focus goes back to the grid. A second call does nothing, so a blur after a key is safe.
	 */
	function commitEdit(moveBy?: { rows: number; cols: number }) {
		const current = editRef.current;
		if (!current) return;
		setEdit(null);
		const saved = apply([{ cell: cellName(current.cell), input: current.value }]);
		if (!moveBy) return;
		if (saved) select(selectCell(step(current.cell, moveBy.rows, moveBy.cols)));
		gridRef.current?.focus();
	}

	function cancelEdit() {
		setEdit(null);
		gridRef.current?.focus();
	}

	// The editor over the cell gets the focus when an edit starts, with the cursor after the text.
	const cellEditing = edit?.source === "cell";
	useLayoutEffect(() => {
		const editor = editorRef.current;
		if (!cellEditing || !editor) return;
		editor.focus();
		editor.setSelectionRange(editor.value.length, editor.value.length);
	}, [cellEditing]);

	const updateWindow = useCallback(() => {
		const scroll = scrollRef.current;
		if (!scroll) return;
		const first = Math.max(0, Math.floor(scroll.scrollTop / ROW_HEIGHT) - SPARE_ROWS);
		const last = Math.floor((scroll.scrollTop + scroll.clientHeight) / ROW_HEIGHT) + SPARE_ROWS;
		setRowWindow((current) => (current.first === first && current.last === last ? current : { first, last }));
	}, []);

	useEffect(() => {
		const scroll = scrollRef.current;
		if (!scroll) return;
		updateWindow();
		const observer = new ResizeObserver(updateWindow);
		observer.observe(scroll);
		return () => observer.disconnect();
	}, [updateWindow]);

	// After a move, the cell at the moving corner of the selection scrolls into view, clear of the headers.
	useEffect(() => {
		const scroll = scrollRef.current;
		if (!scroll) return;
		if (keepScrollRef.current) {
			keepScrollRef.current = false;
			return;
		}
		const left = selection.focus.col * COLUMN_WIDTH;
		const top = selection.focus.row * ROW_HEIGHT;
		const width = scroll.clientWidth - HEAD_WIDTH;
		const height = scroll.clientHeight - ROW_HEIGHT;
		if (left < scroll.scrollLeft) scroll.scrollLeft = left;
		else if (left + COLUMN_WIDTH > scroll.scrollLeft + width) scroll.scrollLeft = left + COLUMN_WIDTH - width;
		if (top < scroll.scrollTop) scroll.scrollTop = top;
		else if (top + ROW_HEIGHT > scroll.scrollTop + height) scroll.scrollTop = top + ROW_HEIGHT - height;
	}, [selection]);

	useEffect(() => {
		const stop = () => {
			draggingRef.current = false;
		};
		window.addEventListener("pointerup", stop);
		window.addEventListener("pointercancel", stop);
		return () => {
			window.removeEventListener("pointerup", stop);
			window.removeEventListener("pointercancel", stop);
		};
	}, []);

	function selectHit(hit: Hit, extend: boolean) {
		commitEdit();
		if (hit === "corner") {
			select({ anchor: FIRST_CELL, focus: { row: size.rows - 1, col: size.columns - 1 } }, { keepScroll: true });
		} else if (hit.kind === "column") {
			const from = extend ? selection.anchor.col : hit.col;
			select({ anchor: { row: 0, col: from }, focus: { row: size.rows - 1, col: hit.col } }, { keepScroll: true });
		} else if (hit.kind === "row") {
			const from = extend ? selection.anchor.row : hit.row;
			select({ anchor: { row: from, col: 0 }, focus: { row: hit.row, col: size.columns - 1 } }, { keepScroll: true });
		} else {
			select(extend ? { anchor: selection.anchor, focus: hit.pos } : selectCell(hit.pos));
		}
	}

	// A mouse selects when the button goes down, and a drag then grows the range. A finger selects
	// with a tap, so a touch that scrolls the grid does not move the selection.
	function onPointerDown(event: PointerEvent<HTMLTableElement>) {
		pointerTypeRef.current = event.pointerType;
		if (event.pointerType !== "mouse" || event.button !== 0) return;
		const hit = hitOf(event.target);
		if (!hit) return;
		selectHit(hit, event.shiftKey);
		draggingRef.current = hit !== "corner" && hit.kind === "cell";
	}

	function onPointerMove(event: PointerEvent<HTMLTableElement>) {
		if (!draggingRef.current || (event.buttons & 1) === 0) return;
		const hit = hitOf(event.target);
		if (hit && hit !== "corner" && hit.kind === "cell") select({ anchor: selection.anchor, focus: hit.pos });
	}

	function onClick(event: MouseEvent<HTMLTableElement>) {
		if (pointerTypeRef.current === "mouse") return;
		const hit = hitOf(event.target);
		if (hit) selectHit(hit, event.shiftKey);
	}

	function onDoubleClick(event: MouseEvent<HTMLTableElement>) {
		const hit = hitOf(event.target);
		if (hit && hit !== "corner" && hit.kind === "cell") startEdit("keep", "cell");
	}

	function onGridKeyDown(event: KeyboardEvent<HTMLTableElement>) {
		if (event.nativeEvent.isComposing) return;
		const command = event.ctrlKey || event.metaKey;
		const leave = leaveRef.current;
		leaveRef.current = false;
		const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 0) / ROW_HEIGHT) - 2);
		switch (event.key) {
			case "ArrowUp":
				move(-1, 0, event.shiftKey);
				break;
			case "ArrowDown":
				move(1, 0, event.shiftKey);
				break;
			case "ArrowLeft":
				move(0, -1, event.shiftKey);
				break;
			case "ArrowRight":
				move(0, 1, event.shiftKey);
				break;
			case "PageUp":
				move(-page, 0, event.shiftKey);
				break;
			case "PageDown":
				move(page, 0, event.shiftKey);
				break;
			case "Tab":
				// After Escape, Tab goes to the next control of the page, so the grid is not a keyboard trap.
				if (leave) return;
				move(0, event.shiftKey ? -1 : 1, false);
				break;
			case "Enter":
				if (event.shiftKey) move(-1, 0, false);
				else if (readOnly) move(1, 0, false);
				else startEdit("keep", "cell");
				break;
			case "F2":
				startEdit("keep", "cell");
				break;
			case "Home": {
				const target = command ? FIRST_CELL : { row: selection.focus.row, col: 0 };
				select(event.shiftKey ? { anchor: selection.anchor, focus: target } : selectCell(target));
				break;
			}
			case "Delete":
			case "Backspace":
				if (!readOnly) apply(clearChanges(cells.keys(), range));
				break;
			case "Escape":
				leaveRef.current = true;
				return;
			default: {
				const key = event.key.toLowerCase();
				if (command && key === "a") {
					select({ anchor: FIRST_CELL, focus: { row: size.rows - 1, col: size.columns - 1 } }, { keepScroll: true });
				} else if (command && key === "z") {
					replay(event.shiftKey ? "redo" : "undo");
				} else if (command && key === "y") {
					replay("redo");
				} else if (!command && !event.altKey && event.key.length === 1 && !readOnly) {
					// A typed character starts an edit that replaces the input of the cell.
					startEdit("replace", "cell", event.key);
				} else {
					return;
				}
			}
		}
		event.preventDefault();
	}

	function onEditorKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		if (event.nativeEvent.isComposing) return;
		const arrows: Record<string, { rows: number; cols: number }> = {
			ArrowUp: { rows: -1, cols: 0 },
			ArrowDown: { rows: 1, cols: 0 },
			ArrowLeft: { rows: 0, cols: -1 },
			ArrowRight: { rows: 0, cols: 1 },
		};
		const arrow = editRef.current?.mode === "replace" ? arrows[event.key] : undefined;
		if (event.key === "Enter") commitEdit({ rows: event.shiftKey ? -1 : 1, cols: 0 });
		else if (event.key === "Tab") commitEdit({ rows: 0, cols: event.shiftKey ? -1 : 1 });
		else if (event.key === "Escape") cancelEdit();
		else if (arrow) commitEdit(arrow);
		else return;
		event.preventDefault();
	}

	function onBarKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		if (event.nativeEvent.isComposing) return;
		if (event.key === "Enter") commitEdit({ rows: event.shiftKey ? -1 : 1, cols: 0 });
		else if (event.key === "Escape") cancelEdit();
		else return;
		event.preventDefault();
	}

	function changeEdit(value: string) {
		const current = editRef.current;
		if (current) setEdit({ ...current, value });
	}

	// The clipboard has the inputs of the range, so a paste keeps each formula.
	function onCopy(event: ClipboardEvent<HTMLTableElement>) {
		event.clipboardData.setData("text/plain", formatTsv(rangeInputs(range, inputAt)));
		event.preventDefault();
	}

	function onCut(event: ClipboardEvent<HTMLTableElement>) {
		onCopy(event);
		if (!readOnly) apply(clearChanges(cells.keys(), range));
	}

	function onPaste(event: ClipboardEvent<HTMLTableElement>) {
		event.preventDefault();
		if (readOnly) return;
		const block = parseTsv(event.clipboardData.getData("text/plain"));
		const paste = pasteChanges(block, range, SHEET_LIMITS);
		if (paste && apply(paste.changes)) selectRange(paste.range, { keepScroll: true });
	}

	function goToName() {
		const pos = parseCell(nameDraft ?? "");
		setNameDraft(null);
		if (!pos) return;
		select(selectCell(pos));
		gridRef.current?.focus();
	}

	const first = Math.min(rowWindow.first, size.rows - 1);
	const last = Math.min(rowWindow.last, size.rows - 1);
	const rows: number[] = [];
	for (let row = first; row <= last; row++) rows.push(row);
	const activeDrawn = active.row >= first && active.row <= last;
	const barValue = edit ? edit.value : inputAt(activeName);

	return (
		<div className="sheet-editor">
			<div className="sheet-bar">
				<input
					className="sheet-name-box"
					aria-label="Active cell. Type a cell, then press Enter to go to it"
					spellCheck={false}
					autoComplete="off"
					value={nameDraft ?? activeName}
					onChange={(event) => setNameDraft(event.target.value)}
					onFocus={(event) => event.currentTarget.select()}
					onBlur={() => setNameDraft(null)}
					onKeyDown={(event) => {
						if (event.key === "Enter") goToName();
						else if (event.key === "Escape") {
							setNameDraft(null);
							gridRef.current?.focus();
						}
					}}
				/>
				<span className="sheet-fx" aria-hidden="true">
					fx
				</span>
				<input
					className="sheet-formula"
					aria-label={`Input of cell ${activeName}`}
					spellCheck={false}
					autoComplete="off"
					readOnly={readOnly}
					value={barValue}
					onFocus={() => {
						if (!editRef.current) startEdit("keep", "bar");
					}}
					onChange={(event) => changeEdit(event.target.value)}
					onKeyDown={onBarKeyDown}
					onBlur={() => commitEdit()}
				/>
				{readOnly && <span className="sheet-view-only">View only</span>}
			</div>
			<div ref={scrollRef} className="sheet-scroll" onScroll={updateWindow}>
				<div className="sheet-canvas" style={{ ...GRID_STYLE, width: HEAD_WIDTH + size.columns * COLUMN_WIDTH }}>
					<table
						ref={gridRef}
						// biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: a table is the element for a grid. The grid has the focus, and aria-activedescendant names the active cell.
						role="grid"
						tabIndex={0}
						className="sheet-grid"
						aria-label={`Cells of ${name}`}
						aria-describedby={hintId}
						aria-rowcount={size.rows + 1}
						aria-colcount={size.columns + 1}
						aria-multiselectable="true"
						aria-readonly={readOnly}
						aria-activedescendant={activeDrawn ? cellId(gridId, activeName) : undefined}
						onKeyDown={onGridKeyDown}
						onPointerDown={onPointerDown}
						onPointerMove={onPointerMove}
						onClick={onClick}
						onDoubleClick={onDoubleClick}
						onCopy={onCopy}
						onCut={onCut}
						onPaste={onPaste}
					>
						<colgroup>
							<col className="sheet-col-first" />
							{names.map((column) => (
								<col key={column} className="sheet-col" />
							))}
						</colgroup>
						<thead>
							<ColumnHeads names={names} left={range.left} right={range.right} />
						</thead>
						<tbody>
							{first > 0 && <SpacerRow columns={size.columns} height={first * ROW_HEIGHT} />}
							{rows.map((row) => {
								const selected = row >= range.top && row <= range.bottom;
								return (
									<SheetRow
										key={row}
										gridId={gridId}
										row={row}
										names={names}
										cells={cells}
										left={selected ? range.left : -1}
										right={selected ? range.right : -1}
										activeCol={row === active.row ? active.col : -1}
									/>
								);
							})}
							{last < size.rows - 1 && (
								<SpacerRow columns={size.columns} height={(size.rows - 1 - last) * ROW_HEIGHT} />
							)}
						</tbody>
					</table>
					{edit?.source === "cell" && (
						<input
							ref={editorRef}
							className="sheet-cell-editor"
							aria-label={`Input of cell ${cellName(edit.cell)}`}
							spellCheck={false}
							autoComplete="off"
							value={edit.value}
							style={{
								left: HEAD_WIDTH + edit.cell.col * COLUMN_WIDTH,
								top: (edit.cell.row + 1) * ROW_HEIGHT,
								width: Math.max(COLUMN_WIDTH, Math.min(480, edit.value.length * 8 + 24)),
							}}
							onChange={(event) => changeEdit(event.target.value)}
							onKeyDown={onEditorKeyDown}
							onBlur={() => commitEdit()}
						/>
					)}
				</div>
			</div>
			<p id={hintId} className="visually-hidden">
				{readOnly
					? "Use the arrow keys to move. Press Escape, then Tab, to leave the grid."
					: "Use the arrow keys to move. Press Enter to change a cell. Press Escape, then Tab, to leave the grid."}
			</p>
		</div>
	);
}
