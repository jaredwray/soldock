import { DRIVE_LIMITS, type DriveItem, operations } from "@soldock/contracts";
import { describe, expect, it } from "vitest";
import {
	backPath,
	breadcrumbs,
	bulkActions,
	createTarget,
	itemActions,
	linkPath,
	listInput,
	previewKind,
	uploadMimeType,
	uploadRefusal,
} from "../src/features/drive/model.ts";
import type { DriveView } from "../src/routes.ts";

const ME = "prn_01JD00000000000000000000ME";
const BOB = "prn_01JD0000000000000000000B0B";
const FOLDER = "itm_01JD0000000000000000000001";
const ITEM = "itm_01JD0000000000000000000002";

function item(change: Partial<DriveItem> = {}): DriveItem {
	return {
		id: ITEM,
		space_id: ME,
		parent_id: null,
		kind: "file",
		name: "report.pdf",
		mime_type: "application/pdf",
		size: 10,
		created_at: "2026-11-01T00:00:00.000Z",
		modified_at: "2026-11-01T00:00:00.000Z",
		modified_by: null,
		role: "owner",
		starred: false,
		trashed: false,
		trashed_at: null,
		shared: false,
		...change,
	};
}

describe("listInput", () => {
	const views: [DriveView, unknown][] = [
		[
			{ kind: "folder", spaceId: null, folderId: null },
			{ view: "folder", order: "name" },
		],
		// The own drive needs no space_id, also when the path has it.
		[
			{ kind: "folder", spaceId: ME, folderId: FOLDER },
			{ view: "folder", parent_id: FOLDER, order: "name" },
		],
		[
			{ kind: "folder", spaceId: BOB, folderId: FOLDER },
			{ view: "folder", space_id: BOB, parent_id: FOLDER, order: "name" },
		],
		[{ kind: "shared" }, { view: "shared" }],
		[{ kind: "recent" }, { view: "recent" }],
		[{ kind: "starred" }, { view: "starred" }],
		[{ kind: "trash" }, { view: "trash" }],
		[
			{ kind: "search", query: "  q3 report " },
			{ view: "search", query: "q3 report" },
		],
	];

	// The server refuses space_id, parent_id and query outside their views, so each input must pass the contract.
	it("gives each view an input that drive.list_items accepts", () => {
		for (const [view, expected] of views) {
			const input = listInput(view, "name", ME);
			expect(input, view.kind).toEqual(expected);
			expect(operations["drive.list_items"].input.safeParse(input).success, view.kind).toBe(true);
		}
	});

	it("makes no call for a search without words, and cuts a query at the limit of the server", () => {
		expect(listInput({ kind: "search", query: "   " }, "name", ME)).toBeNull();
		const long = listInput({ kind: "search", query: "a".repeat(DRIVE_LIMITS.queryChars + 50) }, "name", ME);
		expect(operations["drive.list_items"].input.safeParse(long).success).toBe(true);
	});
});

describe("createTarget", () => {
	const foreign: DriveView = { kind: "folder", spaceId: BOB, folderId: FOLDER };

	it("puts a new item in the folder on screen, and at the root of the own drive from each other view", () => {
		expect(createTarget({ kind: "folder", spaceId: null, folderId: null }, null, ME)).toEqual({});
		expect(createTarget({ kind: "folder", spaceId: ME, folderId: FOLDER }, null, ME)).toEqual({ parent_id: FOLDER });
		expect(createTarget({ kind: "shared" }, null, ME)).toEqual({});
		expect(createTarget({ kind: "trash" }, null, ME)).toEqual({});
	});

	// A viewer must not see New in a folder of somebody else: the server refuses the call.
	it("needs the editor role in a folder of somebody else", () => {
		expect(createTarget(foreign, "editor", ME)).toEqual({ space_id: BOB, parent_id: FOLDER });
		expect(createTarget(foreign, "viewer", ME)).toBeNull();
		expect(createTarget(foreign, null, ME)).toBeNull();
	});
});

describe("itemActions", () => {
	it("offers each action to the owner, by the kind of the item", () => {
		expect(itemActions(item())).toEqual(["open", "download", "rename", "move", "copy", "share", "versions", "trash"]);
		expect(itemActions(item({ kind: "folder" }))).toEqual(["open", "rename", "move", "share", "trash"]);
		expect(itemActions(item({ kind: "doc" }))).toEqual(["open", "rename", "move", "copy", "share", "trash"]);
	});

	// Move, share and trash are for the own drive only. The operations have no space_id.
	it("keeps the owner actions from an editor and a viewer", () => {
		const editor = itemActions(item({ space_id: BOB, role: "editor" }));
		expect(editor).toEqual(["open", "download", "rename", "copy", "access", "versions"]);
		const viewer = itemActions(item({ space_id: BOB, role: "viewer" }), { sharedView: true });
		expect(viewer).toEqual(["open", "download", "copy", "access", "versions", "leave"]);
	});

	it("offers only restore and delete in the trash, to the owner", () => {
		expect(itemActions(item({ trashed: true }))).toEqual(["restore", "delete"]);
		expect(itemActions(item({ trashed: true, role: "editor" }))).toEqual([]);
	});
});

describe("bulkActions", () => {
	it("offers move and trash only when the person owns each item", () => {
		expect(bulkActions([item(), item({ id: FOLDER, kind: "folder" })])).toEqual(["move", "trash"]);
		expect(bulkActions([item(), item({ space_id: BOB, role: "editor" })])).toEqual([]);
		expect(bulkActions([])).toEqual([]);
	});

	it("offers restore and delete only when each item is in the trash", () => {
		expect(bulkActions([item({ trashed: true })])).toEqual(["restore", "delete"]);
		expect(bulkActions([item({ trashed: true }), item()])).toEqual([]);
	});
});

describe("previewKind", () => {
	// An SVG image can hold a script, so it never goes into an <img> from a blob: URL.
	it("shows only raster images as images", () => {
		expect(previewKind("image/png", 10)).toBe("image");
		expect(previewKind("IMAGE/JPEG", 10)).toBe("image");
		expect(previewKind("image/svg+xml", 10)).toBe("none");
		expect(previewKind(null, 10)).toBe("none");
	});

	it("shows text and JSON as text, up to 1 MiB", () => {
		expect(previewKind("text/html; charset=utf-8", 10)).toBe("text");
		expect(previewKind("application/json", 10)).toBe("text");
		expect(previewKind("text/plain", 1024 * 1024 + 1)).toBe("none");
		expect(previewKind("application/pdf", 10)).toBe("none");
	});
});

describe("breadcrumbs", () => {
	const folder = { item: { id: ITEM, name: "Acme", space_id: ME }, path: [{ id: FOLDER, name: "Clients" }] };

	it("starts at My Drive in the own drive, with a link for each folder above", () => {
		const view = { kind: "folder", spaceId: ME, folderId: ITEM } as const;
		expect(breadcrumbs(view, folder, ME)).toEqual([
			{ label: "My Drive", to: "/drive" },
			{ label: "Clients", to: `/drive/folders/${ME}/${FOLDER}` },
			{ label: "Acme", to: null },
		]);
		// A path that also has the folder itself gives the same crumbs.
		const withSelf = { ...folder, path: [...folder.path, { id: ITEM, name: "Acme" }] };
		expect(breadcrumbs(view, withSelf, ME)).toEqual(breadcrumbs(view, folder, ME));
		expect(breadcrumbs({ kind: "folder", spaceId: null, folderId: null }, null, ME)).toEqual([
			{ label: "My Drive", to: null },
		]);
	});

	// The root of the drive of somebody else is not a page that the person can open.
	it("starts at Shared with me in the drive of somebody else", () => {
		const view = { kind: "folder", spaceId: BOB, folderId: ITEM } as const;
		const shared = { item: { id: ITEM, name: "Assets", space_id: BOB }, path: [] };
		expect(breadcrumbs(view, shared, ME)).toEqual([
			{ label: "Shared with me", to: "/drive/shared" },
			{ label: "Assets", to: null },
		]);
	});
});

describe("linkPath and backPath", () => {
	it("gives a file the path of its folder, and no path at the root of a drive", () => {
		expect(linkPath(item({ kind: "doc" }))).toBe(`/docs/${ME}/${ITEM}`);
		expect(linkPath(item({ parent_id: FOLDER }))).toBe(`/drive/folders/${ME}/${FOLDER}`);
		expect(linkPath(item())).toBeNull();
	});

	// A person without the owner role cannot open the folder of the item in the drive of the owner.
	it("goes back to the folder for the owner, and to the shared list for each other person", () => {
		expect(backPath(item({ parent_id: FOLDER }))).toBe(`/drive/folders/${ME}/${FOLDER}`);
		expect(backPath(item())).toBe("/drive");
		expect(backPath(item({ space_id: BOB, role: "editor", parent_id: FOLDER }))).toBe("/drive/shared");
	});
});

describe("uploads", () => {
	it("refuses a file over the limit, and accepts a file at the limit", () => {
		expect(uploadRefusal({ name: "a.bin", size: DRIVE_LIMITS.fileBytes })).toBeNull();
		expect(uploadRefusal({ name: "a.bin", size: DRIVE_LIMITS.fileBytes + 1 })).toMatch(/a\.bin.*10 MB/);
	});

	// A browser gives an empty type for an unknown extension. The server refuses such a mime_type.
	it("sends the type of the browser only when the server accepts its form", () => {
		expect(uploadMimeType("application/pdf")).toBe("application/pdf");
		expect(uploadMimeType("")).toBeUndefined();
		expect(uploadMimeType("text/plain; charset=utf-8")).toBe("text/plain");
		expect(uploadMimeType("not a type")).toBeUndefined();
	});
});
