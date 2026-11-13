import { ApiError, type Cell, type DriveItem, SHEET_LIMITS } from "@soldock/contracts";
import { describe, expect, it } from "vitest";
import type { CellChange } from "../src/features/sheets/cells.ts";
import { type SheetApi, type SheetData, SheetStore } from "../src/features/sheets/store.ts";

function item(role: DriveItem["role"] = "owner"): DriveItem {
	return {
		id: "itm_01JD0000000000000000000000",
		space_id: "prn_01JD0000000000000000000000",
		parent_id: null,
		kind: "sheet",
		name: "Budget",
		mime_type: null,
		size: 0,
		created_at: "2026-11-13T00:00:00.000Z",
		modified_at: "2026-11-13T00:00:00.000Z",
		modified_by: null,
		role,
		starred: false,
		trashed: false,
		trashed_at: null,
		shared: false,
	};
}

function text(name: string, input: string): Cell {
	return { cell: name, input, value: input, type: "text" };
}

function conflict(): ApiError {
	return new ApiError(409, { code: "conflict", detail: "The sheet changed." });
}

interface Call {
	cells: CellChange[];
	baseRevision: number;
	resolve: (data: SheetData) => void;
	reject: (error: unknown) => void;
}

/**
 * A server with one sheet. Each `update` call waits until the test answers it, so a test can make
 * changes while a request is in progress. `get` answers at once with the sheet of the server.
 */
function fakeServer(role: DriveItem["role"] = "owner") {
	const sheet: SheetData = { item: item(role), revision: 1, cells: [] };
	const calls: Call[] = [];
	const api: SheetApi = {
		get: async () => structuredClone(sheet),
		update: (cells, baseRevision) =>
			new Promise<SheetData>((resolve, reject) => {
				calls.push({ cells, baseRevision, resolve, reject });
			}),
	};
	/** Answers the oldest open call as the server does: it stores the inputs and returns the changed cells. */
	function accept() {
		const call = calls.shift();
		if (!call) throw new Error("no update call is open");
		const changed = call.cells.map(({ cell, input }) =>
			input === "" ? { cell, input, value: null, type: "empty" as const } : text(cell, input),
		);
		sheet.cells = [...sheet.cells.filter((c) => !call.cells.some((change) => change.cell === c.cell)), ...changed];
		sheet.revision++;
		call.resolve({ item: sheet.item, revision: sheet.revision, cells: changed });
	}
	return { sheet, calls, api, accept };
}

/** Lets the promises of the store run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function openStore(role: DriveItem["role"] = "owner") {
	const server = fakeServer(role);
	const store = new SheetStore(server.api);
	await store.load();
	return { ...server, store };
}

describe("the save queue of a sheet", () => {
	// Two requests at the same time would use the same base_revision, and the second would get a conflict.
	it("sends one request at a time, and puts the changes of that time into the next request", async () => {
		const { store, calls, accept } = await openStore();
		store.commit([{ cell: "A1", input: "1" }]);
		store.commit([{ cell: "B1", input: "2" }]);
		store.commit([{ cell: "B1", input: "3" }]);
		await settle();
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ cells: [{ cell: "A1", input: "1" }], baseRevision: 1 });
		// The grid shows each input at once.
		expect(store.getSnapshot().cells.get("B1")).toMatchObject({ input: "3", pending: true });
		expect(store.getSnapshot().saveState).toBe("saving");
		accept();
		await settle();
		expect(calls).toHaveLength(1);
		// The newest input of B1 goes, with the revision of the first answer.
		expect(calls[0]).toMatchObject({ cells: [{ cell: "B1", input: "3" }], baseRevision: 2 });
		accept();
		await settle();
		expect(store.getSnapshot()).toMatchObject({ saveState: "saved", revision: 3 });
		expect(store.getSnapshot().cells.get("A1")).toMatchObject({ input: "1", pending: false });
		expect(store.hasUnsaved()).toBe(false);
	});

	it("sends no request for an input that the cell has, and none for a viewer", async () => {
		const { store, calls, accept } = await openStore();
		store.commit([{ cell: "A1", input: "x" }]);
		await settle();
		accept();
		await settle();
		store.commit([
			{ cell: "A1", input: "x" },
			{ cell: "Z9", input: "" },
		]);
		await settle();
		expect(calls).toHaveLength(0);
		expect(store.getSnapshot().saveState).toBe("saved");

		const viewer = await openStore("viewer");
		viewer.store.commit([{ cell: "A1", input: "x" }]);
		await settle();
		expect(viewer.calls).toHaveLength(0);
		expect(viewer.store.getSnapshot().cells.size).toBe(0);
	});

	it("after a conflict, gets the sheet again and sends the same changes one more time", async () => {
		const { store, sheet, calls, accept } = await openStore();
		store.commit([{ cell: "A1", input: "mine" }]);
		await settle();
		// Somebody else changes the sheet in that time.
		sheet.cells = [text("C3", "theirs")];
		sheet.revision = 7;
		calls.shift()?.reject(conflict());
		await settle();
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ cells: [{ cell: "A1", input: "mine" }], baseRevision: 7 });
		expect(store.getSnapshot().cells.get("C3")).toMatchObject({ input: "theirs", pending: false });
		accept();
		await settle();
		expect(store.getSnapshot()).toMatchObject({ saveState: "saved", revision: 8 });
		expect([...store.getSnapshot().cells.keys()].sort()).toEqual(["A1", "C3"]);
	});

	it("keeps the changes when a save fails, and sends them again on a retry", async () => {
		const { store, calls, accept } = await openStore();
		store.commit([
			{ cell: "A1", input: "1" },
			{ cell: "A2", input: "2" },
		]);
		await settle();
		store.commit([{ cell: "A2", input: "newer" }]);
		const failure = new TypeError("offline");
		calls.shift()?.reject(failure);
		await settle();
		expect(store.getSnapshot()).toMatchObject({ saveState: "error", saveError: failure });
		expect(store.getSnapshot().cells.get("A1")).toMatchObject({ input: "1", pending: true });
		expect(store.hasUnsaved()).toBe(true);
		expect(calls).toHaveLength(0);
		store.retry();
		await settle();
		// The change that came during the failed request wins over the older input of the same cell.
		expect(calls[0]?.cells).toEqual([
			{ cell: "A1", input: "1" },
			{ cell: "A2", input: "newer" },
		]);
		accept();
		await settle();
		expect(store.getSnapshot().saveState).toBe("saved");
	});

	it("reports a conflict when the second try also has one, and keeps the changes", async () => {
		const { store, calls } = await openStore();
		store.commit([{ cell: "A1", input: "mine" }]);
		await settle();
		calls.shift()?.reject(conflict());
		await settle();
		calls.shift()?.reject(conflict());
		await settle();
		expect(store.getSnapshot().saveState).toBe("conflict");
		expect(store.getSnapshot().cells.get("A1")).toMatchObject({ input: "mine", pending: true });
		expect(calls).toHaveLength(0);
	});

	// The server refuses a call with more cells than cellsPerUpdate.
	it("sends a large change in parts", async () => {
		const { store, calls, accept } = await openStore();
		const total = SHEET_LIMITS.cellsPerUpdate + 10;
		store.commit([{ cell: "A1", input: "first" }]);
		store.commit(Array.from({ length: total }, (_, index) => ({ cell: `B${index + 1}`, input: "x" })));
		await settle();
		accept();
		await settle();
		expect(calls[0]?.cells).toHaveLength(SHEET_LIMITS.cellsPerUpdate);
		accept();
		await settle();
		expect(calls[0]?.cells).toHaveLength(10);
		accept();
		await settle();
		expect(store.getSnapshot()).toMatchObject({ saveState: "saved" });
		expect(store.getSnapshot().cells.size).toBe(1 + total);
	});

	it("shows the changes of other people on a refresh, but not while a change of this page waits", async () => {
		const { store, sheet, calls, accept } = await openStore();
		sheet.cells = [text("A1", "theirs")];
		sheet.revision = 2;
		await store.refresh();
		expect(store.getSnapshot()).toMatchObject({ revision: 2 });
		expect(store.getSnapshot().cells.get("A1")).toMatchObject({ input: "theirs" });

		// A refresh that started before a change must not put the old sheet over the change.
		const refresh = store.refresh();
		store.commit([{ cell: "A1", input: "mine" }]);
		await refresh;
		expect(store.getSnapshot().cells.get("A1")).toMatchObject({ input: "mine", pending: true });
		sheet.cells = [text("B1", "later")];
		await store.refresh();
		expect(store.getSnapshot().cells.has("B1")).toBe(false);
		await settle();
		expect(calls).toHaveLength(1);
		accept();
		await settle();
		expect(store.getSnapshot().cells.get("A1")).toMatchObject({ input: "mine", pending: false });
	});
});
