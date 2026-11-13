import { SHEET_LIMITS } from "@soldock/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { type Actor, codeOf, seedOrg } from "./helpers.ts";

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
		expect(sheet).toMatchObject({ revision: 1, rows: 4, columns: 2 });
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
