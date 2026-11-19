import { env } from "cloudflare:workers";
import { SHEET_LIMITS, TabName } from "@asterra/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { type Actor, api, codeOf, seedOrg } from "./helpers.ts";

let owner: Actor;
let ada: Actor;
let bot: Actor;

beforeEach(async () => {
	({ owner, ada, bot } = await seedOrg());
});

const BUDGET = [
	{ cell: "A1", input: "Item" },
	{ cell: "B1", input: "Cost" },
	{ cell: "A2", input: "Hosting" },
	{ cell: "B2", input: "120" },
	{ cell: "A3", input: "Domains" },
	{ cell: "B3", input: "30.5" },
	{ cell: "A4", input: "Total" },
	{ cell: "B4", input: "=SUM(B2:B3)" },
];

describe("sheets.create and sheets.get", () => {
	it("creates a sheet as an item of the drive, and calculates its formulas", async () => {
		const created = await ada.call("sheets.create", { name: "Budget", cells: BUDGET });
		expect(created).toMatchObject({ revision: 1, item: { kind: "sheet", name: "Budget", mime_type: null } });
		const sheet = await ada.call("sheets.get", { item_id: created.item.id });
		expect(sheet).toMatchObject({
			revision: 1,
			rows: 4,
			columns: 2,
			tab_id: "tab_1",
			tabs: [{ id: "tab_1", name: "Sheet1", rows: 4, columns: 2 }],
		});
		expect(sheet.cells).toEqual([
			{ cell: "A1", input: "Item", value: "Item", type: "text" },
			{ cell: "B1", input: "Cost", value: "Cost", type: "text" },
			{ cell: "A2", input: "Hosting", value: "Hosting", type: "text" },
			{ cell: "B2", input: "120", value: 120, type: "number" },
			{ cell: "A3", input: "Domains", value: "Domains", type: "text" },
			{ cell: "B3", input: "30.5", value: 30.5, type: "number" },
			{ cell: "A4", input: "Total", value: "Total", type: "text" },
			{ cell: "B4", input: "=SUM(B2:B3)", value: 150.5, type: "number" },
		]);
	});

	it("returns only the cells of a range", async () => {
		const { item } = await ada.call("sheets.create", { name: "Budget", cells: BUDGET });
		const part = await ada.call("sheets.get", { item_id: item.id, range: "b3:B4" });
		expect(part.cells.map((cell) => [cell.cell, cell.value])).toEqual([
			["B3", 30.5],
			["B4", 150.5],
		]);
		// The extent is that of the whole sheet.
		expect(part).toMatchObject({ rows: 4, columns: 2 });
		expect((await ada.call("sheets.get", { item_id: item.id, range: "A2" })).cells).toHaveLength(1);
		expect(await codeOf(ada.call("sheets.get", { item_id: item.id, range: "A1:BA5" }))).toBe("invalid");
	});

	it("returns an empty sheet for a new item", async () => {
		const { item, revision } = await ada.call("sheets.create", { name: "Empty" });
		expect(revision).toBe(0);
		expect(await ada.call("sheets.get", { item_id: item.id })).toMatchObject({
			revision: 0,
			rows: 0,
			columns: 0,
			cells: [],
		});
	});

	it("refuses a cell outside the grid, and creates no item then", async () => {
		expect(await codeOf(ada.call("sheets.create", { name: "Bad", cells: [{ cell: "BA1", input: "x" }] }))).toBe(
			"invalid",
		);
		expect(
			await codeOf(
				ada.call("sheets.create", { name: "Bad", cells: [{ cell: `A${SHEET_LIMITS.rows + 1}`, input: "x" }] }),
			),
		).toBe("invalid");
		expect((await ada.call("drive.list_items")).items).toEqual([]);
	});
});

describe("sheets.update_cells", () => {
	it("returns each cell whose input or result changed, also the cells that read a changed cell", async () => {
		const { item } = await ada.call("sheets.create", { name: "Budget", cells: BUDGET });
		const updated = await ada.call("sheets.update_cells", {
			item_id: item.id,
			cells: [
				{ cell: "b2", input: "200" },
				{ cell: "C4", input: "=B4*2" },
			],
		});
		expect(updated).toMatchObject({ revision: 2, rows: 4, columns: 3 });
		expect(updated.cells).toEqual([
			{ cell: "B2", input: "200", value: 200, type: "number" },
			{ cell: "B4", input: "=SUM(B2:B3)", value: 230.5, type: "number" },
			{ cell: "C4", input: "=B4*2", value: 461, type: "number" },
		]);
	});

	it("clears a cell with an empty input, and reports it as empty", async () => {
		const { item } = await ada.call("sheets.create", { name: "Budget", cells: BUDGET });
		const updated = await ada.call("sheets.update_cells", { item_id: item.id, cells: [{ cell: "B3", input: "" }] });
		expect(updated.cells).toEqual([
			{ cell: "B3", input: "", value: null, type: "empty" },
			{ cell: "B4", input: "=SUM(B2:B3)", value: 120, type: "number" },
		]);
		expect((await ada.call("sheets.get", { item_id: item.id })).cells.map((cell) => cell.cell)).not.toContain("B3");
	});

	it("shows an error value as the result of a cell", async () => {
		const { item } = await ada.call("sheets.create", { name: "Budget", cells: BUDGET });
		const updated = await ada.call("sheets.update_cells", {
			item_id: item.id,
			cells: [
				{ cell: "C1", input: "=B2/0" },
				{ cell: "C2", input: "=C2+1" },
			],
		});
		expect(updated.cells).toEqual([
			{ cell: "C1", input: "=B2/0", value: "#DIV/0!", type: "error" },
			{ cell: "C2", input: "=C2+1", value: "#CYCLE!", type: "error" },
		]);
	});

	// A result must always be a value that the output can hold, or the sheet cannot be read again.
	it("stores a formula whose number is not finite, and returns an error value for it", async () => {
		const { item } = await ada.call("sheets.create", { name: "Large", cells: [{ cell: "A1", input: "=1e309" }] });
		const sheet = await ada.call("sheets.get", { item_id: item.id });
		expect(sheet.cells).toEqual([{ cell: "A1", input: "=1e309", value: "#NUM!", type: "error" }]);
	});

	it("makes no revision when the inputs are the same", async () => {
		const { item } = await ada.call("sheets.create", { name: "Budget", cells: BUDGET });
		const again = await ada.call("sheets.update_cells", { item_id: item.id, cells: [{ cell: "B2", input: "120" }] });
		expect(again).toMatchObject({ revision: 1, cells: [] });
	});

	it("refuses a change from an old revision, and changes nothing", async () => {
		const { item } = await ada.call("sheets.create", { name: "Budget", cells: BUDGET });
		await ada.call("sheets.update_cells", { item_id: item.id, cells: [{ cell: "B2", input: "1" }], base_revision: 1 });
		expect(
			await codeOf(
				ada.call("sheets.update_cells", { item_id: item.id, cells: [{ cell: "B2", input: "2" }], base_revision: 1 }),
			),
		).toBe("conflict");
		const sheet = await ada.call("sheets.get", { item_id: item.id, range: "B2" });
		expect(sheet).toMatchObject({ revision: 2, cells: [{ value: 1 }] });
	});

	// Without base_revision, each call changes its own cells. No call loses the cells of a different call.
	it("keeps the cells of calls that run at the same time", async () => {
		const { item } = await ada.call("sheets.create", { name: "Budget" });
		await Promise.all(
			["A1", "B1", "C1"].map((cell) =>
				ada.call("sheets.update_cells", { item_id: item.id, cells: [{ cell, input: cell }] }),
			),
		);
		const sheet = await ada.call("sheets.get", { item_id: item.id });
		expect(sheet.cells.map((cell) => cell.input)).toEqual(["A1", "B1", "C1"]);
		expect(sheet.revision).toBe(3);
	});

	it("refuses a sheet with more cells than the limit, and a cell outside the grid", async () => {
		const { item } = await ada.call("sheets.create", { name: "Large" });
		const column = (letter: string) =>
			Array.from({ length: SHEET_LIMITS.rows }, (_, row) => ({ cell: `${letter}${row + 1}`, input: "1" }));
		for (const letters of ["ABCDE", "FGHIJ", "KLMNO", "PQRST"]) {
			await ada.call("sheets.update_cells", { item_id: item.id, cells: [...letters].flatMap(column) });
		}
		expect(
			await codeOf(ada.call("sheets.update_cells", { item_id: item.id, cells: [{ cell: "U1", input: "1" }] })),
		).toBe("payload_too_large");
		expect(
			await codeOf(ada.call("sheets.update_cells", { item_id: item.id, cells: [{ cell: "BA1", input: "1" }] })),
		).toBe("invalid");
		expect((await ada.call("sheets.get", { item_id: item.id, range: "A1:A2" })).cells).toHaveLength(2);
	});
});

describe("sheets and the drive", () => {
	it("finds a sheet by the text of its cells, and shows the author of the last change", async () => {
		const { item } = await bot.call("sheets.create", { name: "Untitled", cells: BUDGET });
		expect(item).toMatchObject({ modified_by: { principal_id: bot.id, kind: "agent" } });
		expect(
			(await bot.call("drive.list_items", { view: "search", query: "hosting" })).items.map((entry) => entry.id),
		).toEqual([item.id]);
	});

	it("lets a viewer read and an editor write, and no other person", async () => {
		const { item } = await ada.call("sheets.create", { name: "Budget", cells: BUDGET });
		const space = { space_id: ada.id, item_id: item.id };
		const change = { ...space, cells: [{ cell: "B2", input: "1" }] };
		expect(await codeOf(owner.call("sheets.get", space))).toBe("not_found");
		expect(await codeOf(owner.call("sheets.update_cells", change))).toBe("not_found");
		await ada.call("drive.share_item", { item_id: item.id, principal_id: owner.id, role: "viewer" });
		await ada.call("drive.share_item", { item_id: item.id, principal_id: bot.id, role: "editor" });
		expect((await owner.call("sheets.get", space)).item.role).toBe("viewer");
		expect(await codeOf(owner.call("sheets.update_cells", change))).toBe("forbidden");
		expect((await bot.call("sheets.update_cells", change)).item.modified_by).toMatchObject({ principal_id: bot.id });
		expect((await ada.call("sheets.get", { item_id: item.id, range: "B4" })).cells[0]?.value).toBe(31.5);
	});

	it("copies a sheet with its cells", async () => {
		const { item } = await ada.call("sheets.create", { name: "Budget", cells: BUDGET });
		const { item: copy } = await ada.call("drive.copy_item", { item_id: item.id, name: "Budget 2027" });
		expect(copy).toMatchObject({ kind: "sheet", name: "Budget 2027" });
		await ada.call("sheets.update_cells", { item_id: copy.id, cells: [{ cell: "B2", input: "0" }] });
		expect((await ada.call("sheets.get", { item_id: item.id, range: "B4" })).cells[0]?.value).toBe(150.5);
		expect((await ada.call("sheets.get", { item_id: copy.id, range: "B4" })).cells[0]?.value).toBe(30.5);
	});
});

describe("tabs", () => {
	const names = (tabs: { name: string }[]) => tabs.map((tab) => tab.name);

	it("adds, renames, moves, copies and deletes tabs, and keeps the cells of each tab apart", async () => {
		const { item } = await ada.call("sheets.create", { name: "Year", cells: BUDGET });
		const added = await ada.call("sheets.add_tab", { item_id: item.id });
		expect(added).toMatchObject({ revision: 2, tab_id: "tab_2" });
		expect(names(added.tabs)).toEqual(["Sheet1", "Sheet2"]);
		await ada.call("sheets.update_cells", { item_id: item.id, tab_id: "tab_2", cells: [{ cell: "B2", input: "9" }] });
		const first = await ada.call("sheets.get", { item_id: item.id, range: "B2" });
		const second = await ada.call("sheets.get", { item_id: item.id, tab_id: "tab_2" });
		expect(first).toMatchObject({ tab_id: "tab_1", cells: [{ value: 120 }] });
		expect(second).toMatchObject({ tab_id: "tab_2", rows: 2, columns: 2, cells: [{ cell: "B2", value: 9 }] });

		const front = await ada.call("sheets.add_tab", { item_id: item.id, name: " Notes ", index: 0 });
		expect(names(front.tabs)).toEqual(["Notes", "Sheet1", "Sheet2"]);
		expect(names((await ada.call("sheets.move_tab", { item_id: item.id, tab_id: "tab_3", index: 9 })).tabs)).toEqual([
			"Sheet1",
			"Sheet2",
			"Notes",
		]);
		const copy = await ada.call("sheets.duplicate_tab", { item_id: item.id, tab_id: "tab_1" });
		expect(copy.tab_id).toBe("tab_4");
		expect(names(copy.tabs)).toEqual(["Sheet1", "Copy of Sheet1", "Sheet2", "Notes"]);
		// A copy goes directly after the tab that it came from.
		expect(names((await ada.call("sheets.duplicate_tab", { item_id: item.id, tab_id: "tab_1" })).tabs)).toEqual([
			"Sheet1",
			"Copy 2 of Sheet1",
			"Copy of Sheet1",
			"Sheet2",
			"Notes",
		]);
		// The copy has its own cells: a change to it does not change the tab that it came from.
		await ada.call("sheets.update_cells", { item_id: item.id, tab_id: "tab_4", cells: [{ cell: "B2", input: "0" }] });
		expect((await ada.call("sheets.get", { item_id: item.id, tab_id: "tab_4", range: "B4" })).cells[0]?.value).toBe(
			30.5,
		);
		expect((await ada.call("sheets.get", { item_id: item.id, range: "B4" })).cells[0]?.value).toBe(150.5);

		const renamed = await ada.call("sheets.rename_tab", { item_id: item.id, tab_id: "tab_1", name: "Costs" });
		expect(renamed.tabs[0]).toEqual({ id: "tab_1", name: "Costs", rows: 4, columns: 2 });
		// The same name again changes nothing and makes no revision.
		const again = await ada.call("sheets.rename_tab", { item_id: item.id, tab_id: "tab_1", name: "Costs" });
		expect(again.revision).toBe(renamed.revision);

		const deleted = await ada.call("sheets.delete_tab", { item_id: item.id, tab_id: "tab_1" });
		expect(deleted.tabs.map((tab) => tab.id)).not.toContain("tab_1");
		// Without tab_id, a call reads the first tab. A deleted tab id is never used again.
		expect((await ada.call("sheets.get", { item_id: item.id })).tab_id).toBe("tab_5");
		expect((await ada.call("sheets.add_tab", { item_id: item.id })).tab_id).toBe("tab_6");
		expect(await codeOf(ada.call("sheets.get", { item_id: item.id, tab_id: "tab_1" }))).toBe("not_found");
	});

	it("calculates formulas across tabs, keeps them on a rename, and gives #REF! after a delete", async () => {
		const { item } = await ada.call("sheets.create", { name: "Year", cells: BUDGET });
		await ada.call("sheets.add_tab", { item_id: item.id, name: "Summary" });
		const summary = await ada.call("sheets.update_cells", {
			item_id: item.id,
			tab_id: "tab_2",
			cells: [{ cell: "A1", input: "=SUM(Sheet1!B2:B3)" }],
		});
		expect(summary.cells).toEqual([{ cell: "A1", input: "=SUM(Sheet1!B2:B3)", value: 150.5, type: "number" }]);
		// A change in one tab gives new results in the formulas of the other tab.
		await ada.call("sheets.update_cells", { item_id: item.id, cells: [{ cell: "B3", input: "80" }] });
		const read = () => ada.call("sheets.get", { item_id: item.id, tab_id: "tab_2" });
		expect((await read()).cells[0]).toMatchObject({ value: 200 });

		await ada.call("sheets.rename_tab", { item_id: item.id, tab_id: "tab_1", name: "Q1 costs" });
		expect((await read()).cells[0]).toMatchObject({ input: "=SUM('Q1 costs'!B2:B3)", value: 200 });
		// The search index has the texts of each tab.
		expect(
			(await ada.call("drive.list_items", { view: "search", query: "hosting" })).items.map((entry) => entry.id),
		).toEqual([item.id]);

		await ada.call("sheets.delete_tab", { item_id: item.id, tab_id: "tab_1" });
		expect((await read()).cells[0]).toMatchObject({ input: "=SUM('Q1 costs'!B2:B3)", value: "#REF!" });
		// A new tab with the name gives the formula a result again.
		const back = await ada.call("sheets.add_tab", { item_id: item.id, name: "q1 COSTS" });
		await ada.call("sheets.update_cells", {
			item_id: item.id,
			tab_id: back.tab_id,
			cells: [{ cell: "B2", input: "5" }],
		});
		expect((await read()).cells[0]).toMatchObject({ value: 5 });
	});

	it("refuses a name that a tab has, a name with a forbidden character, the last tab and a tab that does not exist", async () => {
		const { item } = await ada.call("sheets.create", { name: "Year" });
		await ada.call("sheets.add_tab", { item_id: item.id, name: "Notes" });
		const tab = { item_id: item.id, tab_id: "tab_1" };
		expect(await codeOf(ada.call("sheets.add_tab", { item_id: item.id, name: "NOTES" }))).toBe("invalid");
		expect(await codeOf(ada.call("sheets.rename_tab", { ...tab, name: "notes" }))).toBe("invalid");
		expect(await codeOf(ada.call("sheets.duplicate_tab", { ...tab, name: "Notes" }))).toBe("invalid");
		for (const name of ["a:b", "a/b", "[x]", "'quoted'", "", "x".repeat(SHEET_LIMITS.tabNameChars + 1)]) {
			expect(await codeOf(ada.call("sheets.rename_tab", { ...tab, name })), name).toBe("invalid");
		}
		expect(await codeOf(ada.call("sheets.rename_tab", { item_id: item.id, tab_id: "tab_9", name: "x" }))).toBe(
			"not_found",
		);
		await ada.call("sheets.delete_tab", { item_id: item.id, tab_id: "tab_2" });
		expect(await codeOf(ada.call("sheets.delete_tab", tab))).toBe("invalid");
		expect(
			await codeOf(ada.call("sheets.update_cells", { ...tab, tab_id: "tab_2", cells: [{ cell: "A1", input: "1" }] })),
		).toBe("not_found");
	});

	// Each tab write goes through one write loop that checks the editor role. A write that leaves the
	// loop must not lose the check, for a person, for an agent, or for a key with fewer scopes.
	it("lets an editor change the tabs and the formats, also an agent, and refuses a stranger, a viewer and a read-only key", async () => {
		const { item } = await ada.call("sheets.create", { name: "Year" });
		await ada.call("sheets.add_tab", { item_id: item.id, name: "Two" });
		const space = { space_id: ada.id, item_id: item.id };
		const writes: [string, Record<string, unknown>][] = [
			["sheets.add_tab", { ...space, name: "Three" }],
			["sheets.rename_tab", { ...space, tab_id: "tab_2", name: "Second" }],
			["sheets.move_tab", { ...space, tab_id: "tab_2", index: 0 }],
			["sheets.duplicate_tab", { ...space, tab_id: "tab_2" }],
			["sheets.format_cells", { ...space, tab_id: "tab_2", formats: [{ range: "A1", format: { bold: true } }] }],
			["sheets.delete_tab", { ...space, tab_id: "tab_1" }],
		];
		const send = (call: Actor["call"], [name, input]: [string, Record<string, unknown>]) =>
			(call as (name: string, input: unknown) => Promise<unknown>)(name, input);
		const { api_key: reader } = await ada.call("account.create_api_key", { label: "read", scopes: ["drive.read"] });
		for (const write of writes) expect(await codeOf(send(owner.call, write)), write[0]).toBe("not_found");
		await ada.call("drive.share_item", { item_id: item.id, principal_id: owner.id, role: "viewer" });
		await ada.call("drive.share_item", { item_id: item.id, principal_id: bot.id, role: "editor" });
		for (const write of writes) {
			expect(await codeOf(send(owner.call, write)), write[0]).toBe("forbidden");
			expect(await codeOf(send(api(reader.secret), write)), write[0]).toBe("forbidden");
			await send(bot.call, write);
		}
		const { tabs } = await ada.call("sheets.get", { item_id: item.id });
		expect(names(tabs)).toEqual(["Second", "Copy of Second", "Three"]);
		expect((await ada.call("sheets.get", { item_id: item.id, tab_id: "tab_2" })).cells).toEqual([
			{ cell: "A1", input: "", value: null, type: "empty", format: { bold: true } },
		]);
	});

	it("counts the cells and the references of a tab in a dry run of a delete, and changes nothing", async () => {
		const { item } = await ada.call("sheets.create", { name: "Year", cells: BUDGET });
		await ada.call("sheets.add_tab", { item_id: item.id, name: "Summary" });
		await ada.call("sheets.update_cells", {
			item_id: item.id,
			tab_id: "tab_2",
			cells: [
				{ cell: "A1", input: "=sheet1!B4" },
				{ cell: "A2", input: "=SUM('Sheet1'!B2:B3)" },
				{ cell: "A3", input: '="Sheet1!B4"' },
			],
		});
		const tab = { item_id: item.id, tab_id: "tab_1" };
		const dry = await ada.call("sheets.delete_tab", { ...tab, dry_run: true });
		expect(dry).toMatchObject({ revision: 3, cells: BUDGET.length, references: 2, dry_run: true });
		expect(names(dry.tabs)).toEqual(["Sheet1", "Summary"]);
		const done = await ada.call("sheets.delete_tab", tab);
		expect(done).toMatchObject({ revision: 4, cells: BUDGET.length, references: 2, dry_run: false });
		expect(names(done.tabs)).toEqual(["Summary"]);
		// A dry run checks what the delete checks: the last tab stays.
		expect(await codeOf(ada.call("sheets.delete_tab", { item_id: item.id, tab_id: "tab_2", dry_run: true }))).toBe(
			"invalid",
		);
	});

	// A name over the limit gets cut. A cut in a surrogate pair stores text that strict JSON readers refuse.
	it("gives a copy a valid name, also when the name of the tab is long", async () => {
		const { item } = await ada.call("sheets.create", { name: "Year" });
		const tab = { item_id: item.id, tab_id: "tab_1" };
		for (const name of [`${"x".repeat(22)}😀abcdefg`, `${"x".repeat(21)} 'y`]) {
			await ada.call("sheets.rename_tab", { ...tab, name });
			const copy = await ada.call("sheets.duplicate_tab", tab);
			const copied = copy.tabs.find((entry) => entry.id === copy.tab_id)?.name ?? "";
			expect(TabName.safeParse(copied).success, copied).toBe(true);
			expect(copied.isWellFormed(), copied).toBe(true);
			await ada.call("sheets.delete_tab", { item_id: item.id, tab_id: copy.tab_id });
		}
	});

	// Two names that look the same must be one name, or a formula reads a tab that the person did not mean.
	it("compares tab names in one Unicode form, and refuses invisible characters", async () => {
		const { item } = await ada.call("sheets.create", { name: "Year" });
		const nfd = "cafe\u0301";
		const added = await ada.call("sheets.add_tab", { item_id: item.id, name: nfd });
		await ada.call("sheets.update_cells", {
			item_id: item.id,
			tab_id: added.tab_id,
			cells: [{ cell: "A1", input: "4" }],
		});
		expect(await codeOf(ada.call("sheets.add_tab", { item_id: item.id, name: "CAFÉ" }))).toBe("invalid");
		const read = await ada.call("sheets.update_cells", {
			item_id: item.id,
			cells: [{ cell: "A1", input: "='café'!A1" }],
		});
		expect(read.cells[0]?.value).toBe(4);
		for (const name of ["Costs\u200b", "\u202eCosts"]) {
			expect(await codeOf(ada.call("sheets.add_tab", { item_id: item.id, name })), name).toBe("invalid");
		}
	});

	it("refuses more tabs than the limit, and adds tabs of calls at the same time", async () => {
		const { item } = await ada.call("sheets.create", { name: "Year" });
		// Each call reads the tabs again before its write, so two new tabs never get the same id or name.
		const at = await Promise.all([1, 2, 3].map(() => ada.call("sheets.add_tab", { item_id: item.id })));
		expect(new Set(at.map((entry) => entry.tab_id)).size).toBe(3);
		const { tabs } = await ada.call("sheets.get", { item_id: item.id });
		expect(names(tabs).sort()).toEqual(["Sheet1", "Sheet2", "Sheet3", "Sheet4"]);
		for (let count = tabs.length; count < SHEET_LIMITS.tabs; count++) {
			await ada.call("sheets.add_tab", { item_id: item.id });
		}
		expect(await codeOf(ada.call("sheets.add_tab", { item_id: item.id }))).toBe("invalid");
		expect(await codeOf(ada.call("sheets.duplicate_tab", { item_id: item.id, tab_id: "tab_1" }))).toBe("invalid");
	});

	// Sheets of the first layer stored { cells } with one grid. They must open as one tab.
	it("reads a sheet that the first layer stored, as one tab Sheet1", async () => {
		const { item } = await ada.call("sheets.create", { name: "Old" });
		const author = { principal_id: ada.id, kind: "human" as const, display_name: "Ada" };
		await env.DOCUMENT.get(env.DOCUMENT.idFromName(item.id)).write({
			spaceId: ada.id,
			itemId: item.id,
			content: JSON.stringify({ cells: { A1: "2", A2: "=A1*3" } }),
			text: "",
			baseRevision: null,
			author,
		});
		expect(await ada.call("sheets.get", { item_id: item.id })).toMatchObject({
			revision: 1,
			tab_id: "tab_1",
			tabs: [{ id: "tab_1", name: "Sheet1", rows: 2, columns: 1 }],
			cells: [{ cell: "A1" }, { cell: "A2", value: 6 }],
		});
		// The same input again changes nothing, also when the stored form is the old one.
		expect(
			(await ada.call("sheets.update_cells", { item_id: item.id, cells: [{ cell: "A1", input: "2" }] })).revision,
		).toBe(1);
		const added = await ada.call("sheets.add_tab", { item_id: item.id });
		expect(added).toMatchObject({ tab_id: "tab_2", tabs: [{ id: "tab_1" }, { id: "tab_2", name: "Sheet2" }] });
		expect((await ada.call("sheets.get", { item_id: item.id, range: "A2" })).cells[0]?.value).toBe(6);
	});
});

describe("formats", () => {
	it("formats ranges, keeps a format through a change of the input, and returns the text of a number", async () => {
		const { item } = await ada.call("sheets.create", { name: "Budget", cells: BUDGET });
		const id = { item_id: item.id };
		const formatted = await ada.call("sheets.format_cells", {
			...id,
			formats: [
				{ range: "A1:B1", format: { bold: true, fill: "#FEF9C3" } },
				{ range: "B2:B4", format: { number_format: "currency" } },
				{ range: "B4", format: { decimals: 0, color: "#B91C1C", align: "center" } },
				{ range: "C9", format: { italic: true } },
			],
		});
		const header = { bold: true, fill: "#fef9c3" };
		const total = { number_format: "currency", decimals: 0, color: "#b91c1c", align: "center" };
		expect(formatted).toMatchObject({ revision: 2, tab_id: "tab_1", rows: 4, columns: 2 });
		expect(formatted.cells).toEqual([
			{ cell: "A1", input: "Item", value: "Item", type: "text", format: header },
			{ cell: "B1", input: "Cost", value: "Cost", type: "text", format: header },
			{ cell: "B2", input: "120", value: 120, type: "number", format: { number_format: "currency" }, text: "$120.00" },
			{ cell: "B3", input: "30.5", value: 30.5, type: "number", format: { number_format: "currency" }, text: "$30.50" },
			{ cell: "B4", input: "=SUM(B2:B3)", value: 150.5, type: "number", format: total, text: "$151" },
			// A cell without an input keeps its format, so a later input gets it.
			{ cell: "C9", input: "", value: null, type: "empty", format: { italic: true } },
		]);
		expect((await ada.call("sheets.get", { ...id, range: "C9" })).cells).toEqual([formatted.cells[5]]);

		// A new input keeps the format, and the cells that read it get their new text.
		const changed = await ada.call("sheets.update_cells", {
			...id,
			cells: [
				{ cell: "B2", input: "-1234.5" },
				{ cell: "B3", input: "" },
			],
		});
		expect(changed.cells).toEqual([
			{
				cell: "B2",
				input: "-1234.5",
				value: -1234.5,
				type: "number",
				format: { number_format: "currency" },
				text: "-$1,234.50",
			},
			{ cell: "B3", input: "", value: null, type: "empty", format: { number_format: "currency" } },
			{ cell: "B4", input: "=SUM(B2:B3)", value: -1234.5, type: "number", format: total, text: "-$1,235" },
		]);

		// Percent, a field that a later change removes, and the same change again, which makes no revision.
		const percent = await ada.call("sheets.format_cells", {
			...id,
			formats: [
				{ range: "B2", format: { number_format: "percent", decimals: 1 } },
				{ range: "A1:B1", format: { bold: false, fill: null } },
			],
		});
		expect(percent.revision).toBe(4);
		expect(percent.cells).toEqual([
			{ cell: "A1", input: "Item", value: "Item", type: "text" },
			{ cell: "B1", input: "Cost", value: "Cost", type: "text" },
			{
				cell: "B2",
				input: "-1234.5",
				value: -1234.5,
				type: "number",
				format: { number_format: "percent", decimals: 1 },
				text: "-123,450.0%",
			},
		]);
		const again = await ada.call("sheets.format_cells", {
			...id,
			formats: [{ range: "B2", format: { number_format: "percent", decimals: 1 } }],
		});
		expect(again).toMatchObject({ revision: 4, cells: [] });

		// A copy of the tab has the formats too.
		const copy = await ada.call("sheets.duplicate_tab", { ...id, tab_id: "tab_1" });
		expect((await ada.call("sheets.get", { ...id, tab_id: copy.tab_id, range: "B4" })).cells[0]).toMatchObject({
			format: total,
			text: "-$1,235",
		});
	});

	it("refuses a color that is not #rrggbb, a cell outside the grid, and more formats than the limit", async () => {
		const { item } = await ada.call("sheets.create", { name: "Budget", cells: BUDGET });
		// The input is not valid on purpose, so the call goes around the types of the client.
		const format = (formats: unknown) =>
			(ada.call as (name: string, input: unknown) => Promise<unknown>)("sheets.format_cells", {
				item_id: item.id,
				formats,
			});
		expect(await codeOf(format([{ range: "A1", format: { color: "red" } }]))).toBe("invalid");
		expect(await codeOf(format([{ range: "A1:BA1", format: { bold: true } }]))).toBe("invalid");
		// One call formats at most each cell of a tab once.
		expect(
			await codeOf(
				format([
					{ range: "A1:AZ1000", format: { bold: false } },
					{ range: "A1", format: { bold: false } },
				]),
			),
		).toBe("invalid");
		const over = Math.ceil(SHEET_LIMITS.formats / SHEET_LIMITS.columns) + 1;
		expect(await codeOf(format([{ range: `A1:AZ${over}`, format: { bold: true } }]))).toBe("payload_too_large");
		const { revision, cells } = await ada.call("sheets.get", { item_id: item.id });
		expect(revision).toBe(1);
		expect(cells.some((cell) => cell.format)).toBe(false);
	});

	// A sheet that nobody formatted must keep its stored form, and a format that goes away must leave
	// no trace, so the stored form after a removal is the same as before the format.
	it("stores formats only for a tab that has one", async () => {
		const { item } = await ada.call("sheets.create", { name: "Budget", cells: BUDGET });
		const stored = async () => {
			const state = await env.DOCUMENT.get(env.DOCUMENT.idFromName(item.id)).read();
			return state?.content ?? "";
		};
		const before = await stored();
		expect(before).not.toContain("formats");
		await ada.call("sheets.format_cells", { item_id: item.id, formats: [{ range: "A1", format: { bold: true } }] });
		expect(JSON.parse(await stored()).tabs[0].formats).toEqual({ A1: { bold: true } });
		await ada.call("sheets.format_cells", { item_id: item.id, formats: [{ range: "A1", format: { bold: false } }] });
		expect(await stored()).toBe(before);
	});

	it("refuses formats over the byte limit of a sheet", async () => {
		const { item } = await ada.call("sheets.create", { name: "Budget", cells: BUDGET });
		// About 120 bytes of JSON for each of 10,400 cells: under the count limit, over 1 MiB.
		const full = {
			number_format: "currency",
			decimals: 10,
			bold: true,
			italic: true,
			color: "#123456",
			fill: "#abcdef",
			align: "center",
		} as const;
		const format = ada.call("sheets.format_cells", {
			item_id: item.id,
			formats: [{ range: "A1:AZ200", format: full }],
		});
		expect(await codeOf(format)).toBe("payload_too_large");
		expect((await ada.call("sheets.get", { item_id: item.id })).revision).toBe(1);
	});
});
