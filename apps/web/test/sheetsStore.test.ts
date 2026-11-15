import { ApiError, type Cell, type DriveItem, SHEET_LIMITS, type Tab } from "@soldock/contracts";
import { describe, expect, it } from "vitest";
import type { CellChange } from "../src/features/sheets/cells.ts";
import { type SheetApi, type SheetData, SheetStore, type TabAction } from "../src/features/sheets/store.ts";

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

function notFound(): ApiError {
	return new ApiError(404, { code: "not_found", detail: "The sheet has no tab tab_2." });
}

interface Call {
	cells: CellChange[];
	baseRevision: number;
	tabId: string;
	resolve: (data: SheetData) => void;
	reject: (error: unknown) => void;
}

interface FakeSheet {
	item: DriveItem;
	revision: number;
	tabs: Tab[];
	/** The cells of each tab, by tab id. */
	cells: Record<string, Cell[]>;
}

/**
 * A server with one sheet. Each `update` call waits until the test answers it, so a test can make
 * changes while a request is in progress. `get` and `changeTab` answer at once. `log` has the order
 * of the calls that change the sheet.
 */
function fakeServer(role: DriveItem["role"] = "owner") {
	const sheet: FakeSheet = {
		item: item(role),
		revision: 1,
		tabs: [{ id: "tab_1", name: "Sheet1", rows: 0, columns: 0 }],
		cells: { tab_1: [] },
	};
	const calls: Call[] = [];
	const log: string[] = [];
	const read = (tabId: string): SheetData =>
		structuredClone({ ...sheet, tab_id: tabId, cells: sheet.cells[tabId] ?? [] });
	const api: SheetApi = {
		get: async (tabId = sheet.tabs[0]?.id ?? "") => {
			if (!sheet.tabs.some((tab) => tab.id === tabId)) throw notFound();
			return read(tabId);
		},
		update: (cells, baseRevision, tabId) => {
			log.push(`update ${tabId}`);
			return new Promise<SheetData>((resolve, reject) => {
				calls.push({ cells, baseRevision, tabId, resolve, reject });
			});
		},
		changeTab: async (action: TabAction) => {
			log.push(action.kind);
			sheet.revision++;
			if (action.kind === "add") {
				const id = `tab_${sheet.tabs.length + 1}`;
				sheet.tabs.push({ id, name: `Sheet${sheet.tabs.length + 1}`, rows: 0, columns: 0 });
				sheet.cells[id] = [];
				return { item: sheet.item, revision: sheet.revision, tabs: structuredClone(sheet.tabs), tab_id: id };
			}
			if (action.kind === "rename") {
				sheet.tabs = sheet.tabs.map((tab) => (tab.id === action.tabId ? { ...tab, name: action.name } : tab));
			}
			if (action.kind === "delete") sheet.tabs = sheet.tabs.filter((tab) => tab.id !== action.tabId);
			return { item: sheet.item, revision: sheet.revision, tabs: structuredClone(sheet.tabs) };
		},
	};
	/** Answers the oldest open call as the server does: it stores the inputs and returns the changed cells. */
	function accept() {
		const call = calls.shift();
		if (!call) throw new Error("no update call is open");
		const changed = call.cells.map(({ cell, input }) =>
			input === "" ? { cell, input, value: null, type: "empty" as const } : text(cell, input),
		);
		const before = sheet.cells[call.tabId] ?? [];
		sheet.cells[call.tabId] = [
			...before.filter((c) => !call.cells.some((change) => change.cell === c.cell)),
			...changed,
		];
		sheet.revision++;
		call.resolve({ ...read(call.tabId), cells: changed });
	}
	return { sheet, calls, log, api, accept };
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
		sheet.cells.tab_1 = [text("C3", "theirs")];
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
		sheet.cells.tab_1 = [text("A1", "theirs")];
		sheet.revision = 2;
		await store.refresh();
		expect(store.getSnapshot()).toMatchObject({ revision: 2 });
		expect(store.getSnapshot().cells.get("A1")).toMatchObject({ input: "theirs" });

		// A refresh that started before a change must not put the old sheet over the change.
		const refresh = store.refresh();
		store.commit([{ cell: "A1", input: "mine" }]);
		await refresh;
		expect(store.getSnapshot().cells.get("A1")).toMatchObject({ input: "mine", pending: true });
		sheet.cells.tab_1 = [text("B1", "later")];
		await store.refresh();
		expect(store.getSnapshot().cells.has("B1")).toBe(false);
		await settle();
		expect(calls).toHaveLength(1);
		accept();
		await settle();
		expect(store.getSnapshot().cells.get("A1")).toMatchObject({ input: "mine", pending: false });
	});
});

describe("the tabs of a sheet", () => {
	it("keeps the cells and the changes of each tab apart, and sends each change to its own tab", async () => {
		const { store, sheet, calls, accept } = await openStore();
		sheet.tabs.push({ id: "tab_2", name: "Sheet2", rows: 1, columns: 1 });
		sheet.cells.tab_2 = [text("A1", "second")];
		await store.refresh();
		store.commit([{ cell: "A1", input: "first" }]);
		store.selectTab("tab_2");
		await settle();
		expect(store.getSnapshot()).toMatchObject({ activeTab: "tab_2", tabLoading: false });
		expect(store.getSnapshot().cells.get("A1")).toMatchObject({ input: "second" });
		store.commit([{ cell: "B1", input: "also second" }]);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ tabId: "tab_1", cells: [{ cell: "A1", input: "first" }] });
		accept();
		await settle();
		// A write names the revision of the cells of its own tab. Thus the server refuses it when a write
		// to a different tab came after the read, and the store gets the tab again.
		expect(calls[0]).toMatchObject({ tabId: "tab_2", cells: [{ cell: "B1" }], baseRevision: 1 });
		accept();
		await settle();
		expect(store.getSnapshot().saveState).toBe("saved");
		// The grid shows the cells of the tab that the page has at once.
		store.selectTab("tab_1");
		expect(store.getSnapshot().cells.get("A1")).toMatchObject({ input: "first", pending: false });
		expect(store.inputOf("B1", "tab_2")).toBe("also second");
	});

	// A change of the tabs uses the newest revision. Cells that wait must not go to a deleted tab.
	it("saves the waiting changes before a change of the tabs, and then shows the new tab", async () => {
		const { store, log, accept } = await openStore();
		store.commit([{ cell: "A1", input: "1" }]);
		const adding = store.changeTab({ kind: "add" });
		await settle();
		expect(log).toEqual(["update tab_1"]);
		accept();
		await adding;
		expect(log).toEqual(["update tab_1", "add"]);
		expect(store.getSnapshot()).toMatchObject({ activeTab: "tab_2", tabLoading: false });
		expect(store.getSnapshot().tabs.map((tab) => tab.name)).toEqual(["Sheet1", "Sheet2"]);
	});

	// A rename writes the new name into the formulas of each tab, so the grid must not keep the old inputs.
	it("gets the active tab again after a change of the tabs", async () => {
		const { store, sheet, api } = await openStore();
		sheet.cells.tab_1 = [text("A1", "=Sheet1!B1")];
		await store.refresh();
		const rename = api.changeTab;
		api.changeTab = async (action) => {
			sheet.cells.tab_1 = [text("A1", "=Costs!B1")];
			return rename(action);
		};
		await store.changeTab({ kind: "rename", tabId: "tab_1", name: "Costs" });
		expect(store.getSnapshot().tabs[0]?.name).toBe("Costs");
		expect(store.inputOf("A1")).toBe("=Costs!B1");
	});

	// Without the cells of the tab, an edit starts from an empty input, and a save then deletes the real input.
	it("refuses a change to a tab whose cells did not arrive", async () => {
		const { store, sheet, calls } = await openStore();
		sheet.tabs.push({ id: "tab_2", name: "Sheet2", rows: 1, columns: 1 });
		sheet.cells.tab_2 = [text("A1", "=Sheet1!A9")];
		await store.refresh();
		store.selectTab("tab_2");
		expect(store.getSnapshot().tabLoading).toBe(true);
		store.commit([{ cell: "A1", input: "" }]);
		await settle();
		expect(calls).toHaveLength(0);
		expect(store.inputOf("A1")).toBe("=Sheet1!A9");
	});

	it("stops a change of the tabs while a save failed, but deletes the tab of the failed changes", async () => {
		const { store, sheet, calls, log } = await openStore();
		sheet.tabs.push({ id: "tab_2", name: "Sheet2", rows: 0, columns: 0 });
		sheet.cells.tab_2 = [];
		await store.refresh();
		store.selectTab("tab_2");
		await settle();
		store.commit([{ cell: "A1", input: "unsaved" }]);
		await settle();
		calls.shift()?.reject(new TypeError("offline"));
		await settle();
		// The change of the tabs tries the save again first. A copy without the unsaved cells would lose them.
		const duplicating = store.changeTab({ kind: "duplicate", tabId: "tab_2" });
		await settle();
		calls.shift()?.reject(new TypeError("offline"));
		await expect(duplicating).rejects.toThrow(/not saved/);
		expect(log.filter((entry) => entry === "duplicate")).toHaveLength(0);
		expect(store.inputOf("A1", "tab_2")).toBe("unsaved");
		const deleting = store.changeTab({ kind: "delete", tabId: "tab_2" });
		await settle();
		calls.shift()?.reject(new TypeError("offline"));
		await deleting;
		expect(log.at(-1)).toBe("delete");
		expect(store.getSnapshot()).toMatchObject({ activeTab: "tab_1", tabs: [{ id: "tab_1" }] });
		expect(store.hasUnsaved()).toBe(false);
	});

	it("shows the first tab, and drops the changes of a tab, when somebody deleted that tab", async () => {
		const { store, sheet, calls } = await openStore();
		sheet.tabs.push({ id: "tab_2", name: "Sheet2", rows: 0, columns: 0 });
		sheet.cells.tab_2 = [];
		await store.refresh();
		store.selectTab("tab_2");
		await settle();
		sheet.tabs.pop();
		await store.refresh();
		expect(store.getSnapshot()).toMatchObject({ activeTab: "tab_1", tabs: [{ id: "tab_1" }] });

		sheet.tabs.push({ id: "tab_2", name: "Sheet2", rows: 0, columns: 0 });
		await store.refresh();
		store.selectTab("tab_2");
		await settle();
		store.commit([{ cell: "A1", input: "lost" }]);
		await settle();
		sheet.tabs.pop();
		calls.shift()?.reject(notFound());
		await settle();
		expect(store.getSnapshot()).toMatchObject({ activeTab: "tab_1", saveState: "error" });
		expect(store.hasUnsaved()).toBe(false);
		store.retry();
		await settle();
		expect(store.getSnapshot().saveState).toBe("saved");
	});
});
