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
import { evaluateSheet } from "./formula.ts";
import { applyChanges, changedCells, extent, positionOf, readInputs, sheetText, storeInputs, toCells } from "./grid.ts";

type SheetsOperation = Extract<OperationName, `sheets.${string}`>;

/** The inputs after the changes of a call. Refuses a cell outside the grid and a sheet over its limits. */
function changed(inputs: ReadonlyMap<string, string>, changes: readonly { cell: string; input: string }[]) {
	let next: Map<string, string>;
	try {
		next = applyChanges(inputs, changes);
	} catch (error) {
		if (error instanceof RangeError) throw new OperationError("invalid", error.message);
		throw error;
	}
	if (next.size > SHEET_LIMITS.cells) {
		throw new OperationError(
			"payload_too_large",
			`A sheet can have at most ${SHEET_LIMITS.cells} cells with an input.`,
		);
	}
	const content = storeInputs(next);
	if (new TextEncoder().encode(content).byteLength > SHEET_LIMITS.contentBytes) {
		throw new OperationError(
			"payload_too_large",
			`The inputs of a sheet can be at most ${SHEET_LIMITS.contentBytes} bytes.`,
		);
	}
	return { inputs: next, content };
}

async function itemOf(call: CallContext, opened: OpenSpace, itemId: string) {
	return toOneItem(call, accept(await opened.space.checkItem(opened.ctx, itemId, "viewer", ["sheet"])));
}

function rangeOf(range: string | undefined) {
	if (range === undefined) return undefined;
	try {
		const [first, last = first] = range.split(":") as [string, string?];
		const a = positionOf(first);
		const b = positionOf(last);
		return {
			from: { col: Math.min(a.col, b.col), row: Math.min(a.row, b.row) },
			to: { col: Math.max(a.col, b.col), row: Math.max(a.row, b.row) },
		};
	} catch (error) {
		if (error instanceof RangeError) throw new OperationError("invalid", error.message);
		throw error;
	}
}

/** The most times that one call calculates its change again, when other writers change the sheet at the same time. */
const WRITE_ATTEMPTS = 3;

export const sheetsHandlers: Pick<HandlerMap<CallContext>, SheetsOperation> = {
	async "sheets.create"(call, input) {
		const opened = await openSpace(call, input.space_id);
		// Refuse cells that are not valid before the item exists.
		const first = changed(new Map(), input.cells);
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
		if (first.inputs.size > 0 && revision === 0) {
			const text = sheetText(evaluateSheet(first.inputs));
			revision = (await writeDocument(call, opened, itemId, { content: first.content, text, baseRevision: 0 }))
				.revision;
		}
		if (!created.duplicate) auditOk(call, opened, "sheets.create", itemId);
		return { item: await itemOf(call, opened, itemId), revision };
	},

	async "sheets.get"(call, input) {
		const opened = await openSpace(call, input.space_id);
		const item = accept(await opened.space.checkItem(opened.ctx, input.item_id, "viewer", ["sheet"]));
		const range = rangeOf(input.range);
		const state = await readDocument(call, input.item_id);
		const inputs = readInputs(state?.content ?? null);
		return {
			item: await toOneItem(call, item),
			revision: state?.revision ?? 0,
			...extent(inputs),
			cells: toCells(inputs, evaluateSheet(inputs), range),
		};
	},

	async "sheets.update_cells"(call, input) {
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
			const before = readInputs(state?.content ?? null);
			const after = changed(before, input.cells);
			const values = evaluateSheet(after.inputs);
			let written: { revision: number; changed: boolean };
			try {
				// The write names the revision that this call read. Thus a change of a different writer between
				// the read and the write is never lost: the write is refused, and the call calculates again.
				written = await writeDocument(call, opened, input.item_id, {
					content: after.content,
					text: sheetText(values),
					baseRevision: revision,
				});
			} catch (error) {
				const retry = error instanceof OperationError && error.code === "conflict" && attempt < WRITE_ATTEMPTS;
				if (retry) continue;
				throw error;
			}
			if (written.changed) auditOk(call, opened, "sheets.update_cells", input.item_id);
			return {
				item: await itemOf(call, opened, input.item_id),
				revision: written.revision,
				...extent(after.inputs),
				cells: changedCells({ inputs: before, values: evaluateSheet(before) }, { inputs: after.inputs, values }),
			};
		}
	},
};
