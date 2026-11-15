import { type OperationName, SHEET_LIMITS } from "@soldock/contracts";
import {
	accept,
	auditOk,
	idempotencyOf,
	type OpenSpace,
	openSpace,
	readDocument,
	toOneItem,
	writeDocument,
} from "../drive/index.ts";
import type { CallContext } from "../identity/index.ts";
import { type HandlerMap, newId, OperationError } from "../platform/index.ts";
import { evaluateWorkbook, refersToTab, renameTabInInput, tabKey, type Value } from "./formula.ts";
import {
	applyChanges,
	applyFormats,
	changedCells,
	extent,
	parseRange,
	readWorkbook,
	type SheetTab,
	sheetText,
	storeWorkbook,
	toCells,
	toTabs,
	type Workbook,
} from "./grid.ts";

type SheetsOperation = Extract<OperationName, `sheets.${string}`>;

/** The stored form of a sheet. Refuses a sheet over its limits. */
function checked(book: Workbook): string {
	let cells = 0;
	let formats = 0;
	for (const tab of book.tabs) {
		cells += tab.inputs.size;
		formats += tab.formats.size;
	}
	if (cells > SHEET_LIMITS.cells) {
		throw new OperationError(
			"payload_too_large",
			`A sheet can have at most ${SHEET_LIMITS.cells} cells with an input.`,
		);
	}
	if (formats > SHEET_LIMITS.formats) {
		throw new OperationError(
			"payload_too_large",
			`A sheet can have at most ${SHEET_LIMITS.formats} cells with a format.`,
		);
	}
	const content = storeWorkbook(book);
	if (new TextEncoder().encode(content).byteLength > SHEET_LIMITS.contentBytes) {
		throw new OperationError(
			"payload_too_large",
			`The inputs and formats of a sheet can be at most ${SHEET_LIMITS.contentBytes} bytes.`,
		);
	}
	return content;
}

/** The result of `run`. A RangeError, for a cell outside the grid, becomes an invalid call. */
function inGrid<T>(run: () => T): T {
	try {
		return run();
	} catch (error) {
		if (error instanceof RangeError) throw new OperationError("invalid", error.message);
		throw error;
	}
}

/** The inputs of a tab after the changes of a call. Refuses a cell outside the grid. */
function changedInputs(inputs: ReadonlyMap<string, string>, changes: readonly { cell: string; input: string }[]) {
	return inGrid(() => applyChanges(inputs, changes));
}

/** The tab with the id, or the first tab without an id. */
function tabOf(book: Workbook, tabId: string | undefined): SheetTab {
	const tab = tabId === undefined ? book.tabs[0] : book.tabs.find((entry) => entry.id === tabId);
	if (!tab) throw new OperationError("not_found", `The sheet has no tab ${tabId}. Read the tabs with sheets.get.`);
	return tab;
}

/**
 * The name to store, in NFC. Refuses a name that a different tab of the sheet has. The case and the
 * Unicode form of a name do not count.
 */
function freeNameOf(book: Workbook, name: string, except?: string): string {
	const key = tabKey(name);
	if (book.tabs.some((tab) => tab.id !== except && tabKey(tab.name) === key)) {
		throw new OperationError("invalid", `The sheet has a tab with the name ${name}. Use a different name.`);
	}
	return name.normalize("NFC");
}

function checkTabCount(book: Workbook) {
	if (book.tabs.length >= SHEET_LIMITS.tabs) {
		throw new OperationError("invalid", `A sheet can have at most ${SHEET_LIMITS.tabs} tabs.`);
	}
}

/**
 * A name for a new tab that is not too long, and that does not end with a space or a quote. It cuts
 * between characters, never in a surrogate pair. The start of each candidate is fixed text.
 */
function fitName(name: string): string {
	let fitted = "";
	for (const char of name.normalize("NFC")) {
		if (fitted.length + char.length > SHEET_LIMITS.tabNameChars) break;
		fitted += char;
	}
	return fitted.replace(/[\s']+$/u, "");
}

/** The first of the candidate names that no tab of the sheet has. */
function freeName(book: Workbook, candidate: (n: number) => string): string {
	const taken = new Set(book.tabs.map((tab) => tabKey(tab.name)));
	for (let n = 1; ; n++) {
		const name = fitName(candidate(n));
		if (!taken.has(tabKey(name))) return name;
	}
}

function withTabs(book: Workbook, tabs: SheetTab[]): Workbook {
	return { tabs, nextTab: book.nextTab };
}

/** A new tab with the next id of the sheet, at the position `index`. */
function insertTab(book: Workbook, tab: Omit<SheetTab, "id">, index: number): { book: Workbook; id: string } {
	const id = `tab_${book.nextTab}`;
	const tabs = [...book.tabs];
	tabs.splice(Math.min(index, tabs.length), 0, { id, ...tab });
	return { book: { tabs, nextTab: book.nextTab + 1 }, id };
}

async function itemOf(call: CallContext, opened: OpenSpace, itemId: string) {
	return toOneItem(call, accept(await opened.space.checkItem(opened.ctx, itemId, "viewer", ["sheet"])));
}

function rangeOf(range: string | undefined) {
	return range === undefined ? undefined : inGrid(() => parseRange(range));
}

/** The most times that one call calculates its change again, when other writers change the sheet at the same time. */
const WRITE_ATTEMPTS = 3;

interface SheetCall {
	space_id?: string | undefined;
	item_id: string;
	base_revision?: number | undefined;
}

/**
 * Reads a sheet, makes a change to it, and writes it. The change can refuse with an OperationError.
 * Each write names the revision that the call read. When a different writer changed the sheet
 * between the read and the write, the call reads and makes the change again, at most 3 times. Thus
 * calls at the same time never lose changes of each other. A change that changes nothing makes no
 * revision.
 */
async function changeSheet<T>(
	call: CallContext,
	input: SheetCall,
	operation: SheetsOperation,
	change: (book: Workbook) => { book: Workbook; result: T },
) {
	const opened = await openSpace(call, input.space_id);
	accept(await opened.space.checkItem(opened.ctx, input.item_id, "editor", ["sheet"]));
	for (let attempt = 1; ; attempt++) {
		const state = await readDocument(call, input.item_id);
		const revision = state?.revision ?? 0;
		if (input.base_revision !== undefined && input.base_revision !== revision) {
			throw new OperationError(
				"conflict",
				`The sheet changed: it is at revision ${revision}, not ${input.base_revision}. Read it again, then make the change again.`,
			);
		}
		const before = readWorkbook(state?.content ?? null);
		const { book: after, result } = change(before);
		const content = checked(after);
		const values = evaluateWorkbook(after.tabs);
		let written = { revision, changed: false };
		if (content !== storeWorkbook(before)) {
			try {
				written = await writeDocument(call, opened, input.item_id, {
					content,
					text: sheetText(values),
					baseRevision: revision,
				});
			} catch (error) {
				const retry = error instanceof OperationError && error.code === "conflict" && attempt < WRITE_ATTEMPTS;
				if (retry) continue;
				throw error;
			}
		}
		if (written.changed) auditOk(call, opened, operation, input.item_id);
		return {
			item: await itemOf(call, opened, input.item_id),
			revision: written.revision,
			before,
			after,
			values,
			result,
		};
	}
}

/** The output of an operation that changes the tabs. */
function tabsOutput(written: Awaited<ReturnType<typeof changeSheet>>) {
	return { item: written.item, revision: written.revision, tabs: toTabs(written.after) };
}

const NO_VALUES: ReadonlyMap<string, Value> = new Map();

/**
 * The output of an operation that changes the cells of one tab: each cell whose input, result or
 * format changed. A format cannot change a result, so a format change does not calculate the sheet
 * before it.
 */
function cellsOutput(written: Awaited<ReturnType<typeof changeSheet<string>>>, resultsSame = false) {
	const tabId = written.result;
	const after = tabOf(written.after, tabId);
	const values = written.values.get(tabId) ?? NO_VALUES;
	const old = resultsSame ? values : (evaluateWorkbook(written.before.tabs).get(tabId) ?? NO_VALUES);
	return {
		...tabsOutput(written),
		tab_id: tabId,
		...extent(after.inputs),
		cells: changedCells({ tab: tabOf(written.before, tabId), values: old }, { tab: after, values }),
	};
}

export const sheetsHandlers: Pick<HandlerMap<CallContext>, SheetsOperation> = {
	async "sheets.create"(call, input) {
		const opened = await openSpace(call, input.space_id);
		// Refuse cells that are not valid before the item exists.
		const empty = readWorkbook(null);
		const [firstTab] = empty.tabs as [SheetTab];
		const inputs = changedInputs(firstTab.inputs, input.cells);
		const first = withTabs(empty, [{ ...firstTab, inputs }]);
		const content = checked(first);
		const created = accept(
			await opened.space.createItem(opened.ctx, {
				id: newId("itm"),
				parentId: input.parent_id ?? null,
				kind: "sheet",
				name: input.name,
				idempotency: await idempotencyOf(call, "sheets.create", input),
			}),
		);
		const itemId = created.item.id;
		let revision = (await readDocument(call, itemId))?.revision ?? 0;
		// A retry with the same key finds the item. When the first call stopped before the cells, the retry writes them.
		if (inputs.size > 0 && revision === 0) {
			const text = sheetText(evaluateWorkbook(first.tabs));
			revision = (await writeDocument(call, opened, itemId, { content, text, baseRevision: 0 })).revision;
		}
		if (!created.duplicate) auditOk(call, opened, "sheets.create", itemId);
		return { item: await itemOf(call, opened, itemId), revision };
	},

	async "sheets.get"(call, input) {
		const opened = await openSpace(call, input.space_id);
		const item = accept(await opened.space.checkItem(opened.ctx, input.item_id, "viewer", ["sheet"]));
		const range = rangeOf(input.range);
		const state = await readDocument(call, input.item_id);
		const book = readWorkbook(state?.content ?? null);
		const tab = tabOf(book, input.tab_id);
		return {
			item: await toOneItem(call, item),
			revision: state?.revision ?? 0,
			tabs: toTabs(book),
			tab_id: tab.id,
			...extent(tab.inputs),
			cells: toCells(tab, evaluateWorkbook(book.tabs).get(tab.id) ?? NO_VALUES, range),
		};
	},

	async "sheets.update_cells"(call, input) {
		const written = await changeSheet(call, input, "sheets.update_cells", (book) => {
			const tab = tabOf(book, input.tab_id);
			const inputs = changedInputs(tab.inputs, input.cells);
			return {
				book: withTabs(
					book,
					book.tabs.map((entry) => (entry === tab ? { ...tab, inputs } : entry)),
				),
				result: tab.id,
			};
		});
		return cellsOutput(written);
	},

	async "sheets.format_cells"(call, input) {
		const written = await changeSheet(call, input, "sheets.format_cells", (book) => {
			const tab = tabOf(book, input.tab_id);
			const formats = inGrid(() => applyFormats(tab.formats, input.formats));
			return {
				book: withTabs(
					book,
					book.tabs.map((entry) => (entry === tab ? { ...tab, formats } : entry)),
				),
				result: tab.id,
			};
		});
		return cellsOutput(written, true);
	},

	async "sheets.add_tab"(call, input) {
		const written = await changeSheet(call, input, "sheets.add_tab", (book) => {
			checkTabCount(book);
			const name =
				input.name === undefined ? freeName(book, (n) => `Sheet${book.tabs.length + n}`) : freeNameOf(book, input.name);
			const added = insertTab(book, { name, inputs: new Map(), formats: new Map() }, input.index ?? book.tabs.length);
			return { book: added.book, result: added.id };
		});
		return { ...tabsOutput(written), tab_id: written.result };
	},

	async "sheets.rename_tab"(call, input) {
		const written = await changeSheet(call, input, "sheets.rename_tab", (book) => {
			const tab = tabOf(book, input.tab_id);
			const newName = freeNameOf(book, input.name, tab.id);
			// Each formula that refers to the old name gets the new name, so it still reads the same cells.
			const tabs = book.tabs.map((entry) => {
				const inputs = new Map<string, string>();
				for (const [cell, raw] of entry.inputs) {
					const next = renameTabInInput(raw, tab.name, newName);
					if (next.length > SHEET_LIMITS.inputChars) {
						throw new OperationError(
							"payload_too_large",
							`With the new name, the input of ${entry.name}!${cell} has more than ${SHEET_LIMITS.inputChars} characters. Use a shorter name.`,
						);
					}
					inputs.set(cell, next);
				}
				return { ...entry, name: entry === tab ? newName : entry.name, inputs };
			});
			return { book: withTabs(book, tabs), result: null };
		});
		return tabsOutput(written);
	},

	async "sheets.move_tab"(call, input) {
		const written = await changeSheet(call, input, "sheets.move_tab", (book) => {
			const tab = tabOf(book, input.tab_id);
			const tabs = book.tabs.filter((entry) => entry !== tab);
			tabs.splice(Math.min(input.index, tabs.length), 0, tab);
			return { book: withTabs(book, tabs), result: null };
		});
		return tabsOutput(written);
	},

	async "sheets.duplicate_tab"(call, input) {
		const written = await changeSheet(call, input, "sheets.duplicate_tab", (book) => {
			const tab = tabOf(book, input.tab_id);
			checkTabCount(book);
			const name =
				input.name === undefined
					? freeName(book, (n) => (n === 1 ? `Copy of ${tab.name}` : `Copy ${n} of ${tab.name}`))
					: freeNameOf(book, input.name);
			const added = insertTab(
				book,
				{ name, inputs: new Map(tab.inputs), formats: new Map(tab.formats) },
				book.tabs.indexOf(tab) + 1,
			);
			return { book: added.book, result: added.id };
		});
		return { ...tabsOutput(written), tab_id: written.result };
	},

	async "sheets.delete_tab"(call, input) {
		// A dry run checks the same things and makes the same counts, and returns the sheet as it is.
		const written = await changeSheet(call, input, "sheets.delete_tab", (book) => {
			const tab = tabOf(book, input.tab_id);
			if (book.tabs.length === 1) {
				throw new OperationError("invalid", "A sheet keeps at least one tab. Add a different tab first.");
			}
			let references = 0;
			for (const entry of book.tabs) {
				if (entry === tab) continue;
				for (const raw of entry.inputs.values()) if (refersToTab(raw, tab.name)) references++;
			}
			const next = input.dry_run
				? book
				: withTabs(
						book,
						book.tabs.filter((entry) => entry !== tab),
					);
			return { book: next, result: { cells: tab.inputs.size, references } };
		});
		return { ...tabsOutput(written), ...written.result, dry_run: input.dry_run };
	},
};
