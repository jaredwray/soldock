import { DRIVE_LIMITS, type DriveItem, operations } from "@soldock/contracts";
import { describe, expect, it } from "vitest";
import {
	backPath,
	breadcrumbs,
	bulkActions,
	copyInput,
	createTarget,
	dropZone,
	idBatches,
	itemActions,
	linkPath,
	listInput,
	memberRoles,
	moveAcrossRefusal,
	moveConfirmText,
	moveItemsInput,
	moveSummary,
	moveTargets,
	moveToDriveInput,
	previewKind,
	spaceBatches,
	uploadMimeType,
	uploadRefusal,
} from "../src/features/drive/model.ts";
import type { DriveView } from "../src/routes.ts";

const ME = "prn_01JD00000000000000000000ME";
const BOB = "prn_01JD0000000000000000000B0B";
const DESIGN = "drv_01JD0000000000000000000DES";
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
		// The root, the trash and the search of a shared drive send the id of the drive.
		[
			{ kind: "folder", spaceId: DESIGN, folderId: null },
			{ view: "folder", space_id: DESIGN, order: "name" },
		],
		[
			{ kind: "trash", spaceId: DESIGN },
			{ view: "trash", space_id: DESIGN },
		],
		[
			{ kind: "search", query: "tile", spaceId: DESIGN },
			{ view: "search", space_id: DESIGN, query: "tile" },
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
		// The list of the shared drives is not a list of items.
		expect(listInput({ kind: "shared-drives" }, "name", ME)).toBeNull();
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

	// A shared drive has a root that the person can open. A viewer of the drive adds no items.
	it("needs the editor role in a shared drive, at its root and in its folders", () => {
		const root: DriveView = { kind: "folder", spaceId: DESIGN, folderId: null };
		const inFolder: DriveView = { kind: "folder", spaceId: DESIGN, folderId: FOLDER };
		expect(createTarget(root, "manager", ME)).toEqual({ space_id: DESIGN });
		expect(createTarget(inFolder, "editor", ME)).toEqual({ space_id: DESIGN, parent_id: FOLDER });
		expect(createTarget(root, "viewer", ME)).toBeNull();
		expect(createTarget(root, null, ME)).toBeNull();
		for (const target of [createTarget(root, "editor", ME), createTarget(inFolder, "editor", ME)]) {
			const input = { ...target, name: "Plans", idempotency_key: "k" };
			expect(operations["drive.create_folder"].input.safeParse(input).success).toBe(true);
		}
	});
});

describe("dropZone", () => {
	const myDrive: DriveView = { kind: "folder", spaceId: null, folderId: null };
	const folder = (change: Partial<DriveItem>) => item({ id: FOLDER, kind: "folder", name: "Plans", ...change });

	it("uploads into a folder row of the owner or of an editor", () => {
		expect(dropZone(myDrive, {}, "My Drive", folder({}), ME)).toEqual({
			target: { parent_id: FOLDER },
			name: "Plans",
			rowId: FOLDER,
		});
		expect(dropZone({ kind: "shared" }, {}, "Shared with me", folder({ space_id: BOB, role: "editor" }), ME)).toEqual({
			target: { space_id: BOB, parent_id: FOLDER },
			name: "Plans",
			rowId: FOLDER,
		});
	});

	// The server refuses an upload to a folder that the person can only view.
	it("sends the files of each other row to the folder of New", () => {
		const view: DriveView = { kind: "folder", spaceId: null, folderId: ITEM };
		for (const row of [folder({ space_id: BOB, role: "viewer" }), folder({ trashed: true }), item(), null]) {
			expect(dropZone(view, { parent_id: ITEM }, "Site", row, ME)).toEqual({
				target: { parent_id: ITEM },
				name: "Site",
				rowId: null,
			});
		}
		expect(dropZone({ kind: "recent" }, {}, "Recent", null, ME)).toEqual({ target: {}, name: "My Drive", rowId: null });
	});

	it("takes no files in the trash, or in a folder of somebody else without the editor role", () => {
		expect(dropZone({ kind: "trash" }, {}, "Trash", null, ME)).toBeNull();
		expect(dropZone({ kind: "folder", spaceId: BOB, folderId: FOLDER }, null, "Plans", item(), ME)).toBeNull();
	});
});

// The member role of the person in each shared drive. Without a role, the person is not a member.
const NO_ROLES = memberRoles([]);
const rolesIn = (role: "manager" | "editor" | "viewer") => memberRoles([{ id: DESIGN, role }]);

describe("itemActions", () => {
	it("offers each action to the owner, by the kind of the item", () => {
		const all = ["open", "download", "rename", "move", "copy", "share", "versions", "trash"];
		expect(itemActions(item(), NO_ROLES)).toEqual(all);
		expect(itemActions(item({ kind: "folder" }), NO_ROLES)).toEqual(["open", "rename", "move", "share", "trash"]);
		expect(itemActions(item({ kind: "doc" }), NO_ROLES)).toEqual(["open", "rename", "move", "copy", "share", "trash"]);
	});

	// In the drive of a different person, only the owner can move, share and trash an item.
	it("keeps the owner actions from an editor and a viewer", () => {
		const editor = itemActions(item({ space_id: BOB, role: "editor" }), NO_ROLES);
		expect(editor).toEqual(["open", "download", "rename", "copy", "access", "versions"]);
		const viewer = itemActions(item({ space_id: BOB, role: "viewer" }), NO_ROLES, { sharedView: true });
		expect(viewer).toEqual(["open", "download", "copy", "access", "versions", "leave"]);
	});

	it("offers only restore and delete in the trash, to the owner", () => {
		expect(itemActions(item({ trashed: true }), NO_ROLES)).toEqual(["restore", "delete"]);
		expect(itemActions(item({ trashed: true, role: "editor" }), NO_ROLES)).toEqual([]);
	});

	// The server refuses a share and a permanent deletion by an editor, and each change by a viewer.
	it("follows the role of the member in a shared drive", () => {
		const inDesign = (role: "manager" | "editor" | "viewer", change: Partial<DriveItem> = {}) =>
			itemActions(item({ space_id: DESIGN, role, ...change }), rolesIn(role));
		const all = ["open", "download", "rename", "move", "copy", "share", "versions", "trash"];
		expect(inDesign("manager")).toEqual(all);
		expect(inDesign("editor")).toEqual(all.map((action) => (action === "share" ? "access" : action)));
		expect(inDesign("viewer")).toEqual(["open", "download", "copy", "access", "versions"]);
		expect(inDesign("manager", { trashed: true })).toEqual(["restore", "delete"]);
		expect(inDesign("editor", { trashed: true })).toEqual(["restore"]);
	});

	// The server accepts a move, the trash and a restore in a shared drive only from the member role.
	// The role of the item is the highest of the member role and the grants on the item.
	it("does not take an editor grant on an item of a shared drive for the editor role of the drive", () => {
		const granted = item({ space_id: DESIGN, role: "editor" });
		// A person who is not a member: the item shows in Shared with me.
		expect(itemActions(granted, NO_ROLES, { sharedView: true })).toEqual([
			"open",
			"download",
			"rename",
			"copy",
			"access",
			"versions",
			"leave",
		]);
		// A member with the viewer role and an editor grant on this item.
		expect(itemActions(granted, rolesIn("viewer"))).toEqual([
			"open",
			"download",
			"rename",
			"copy",
			"access",
			"versions",
		]);
		expect(itemActions({ ...granted, trashed: true }, rolesIn("viewer"))).toEqual([]);
		expect(itemActions({ ...granted, trashed: true }, NO_ROLES)).toEqual([]);
		// Only a member can have the manager role, so that role needs no list of the shared drives.
		expect(itemActions({ ...granted, role: "manager" }, NO_ROLES)).toContain("move");
	});
});

describe("bulkActions", () => {
	it("offers move and trash only when the person owns each item", () => {
		expect(bulkActions([item(), item({ id: FOLDER, kind: "folder" })], NO_ROLES)).toEqual(["move", "trash"]);
		expect(bulkActions([item(), item({ space_id: BOB, role: "editor" })], NO_ROLES)).toEqual([]);
		expect(bulkActions([], NO_ROLES)).toEqual([]);
	});

	it("offers restore and delete only when each item is in the trash", () => {
		expect(bulkActions([item({ trashed: true })], NO_ROLES)).toEqual(["restore", "delete"]);
		expect(bulkActions([item({ trashed: true }), item()], NO_ROLES)).toEqual([]);
	});

	it("follows the role of the member in a shared drive, and moves only items of one drive", () => {
		const editor = item({ space_id: DESIGN, role: "editor" });
		expect(bulkActions([editor, { ...editor, id: FOLDER }], rolesIn("editor"))).toEqual(["move", "trash"]);
		expect(bulkActions([{ ...editor, trashed: true }], rolesIn("editor"))).toEqual(["restore"]);
		expect(bulkActions([{ ...editor, role: "manager", trashed: true }], rolesIn("manager"))).toEqual([
			"restore",
			"delete",
		]);
		expect(bulkActions([{ ...editor, role: "viewer" }], rolesIn("viewer"))).toEqual([]);
		// A selection in Starred can have items of two drives. The items of a move go to one place.
		expect(bulkActions([item(), editor], rolesIn("editor"))).toEqual(["trash"]);
		// An editor grant on an item is not the editor role of the drive.
		expect(bulkActions([editor], NO_ROLES)).toEqual([]);
		expect(bulkActions([editor, { ...editor, id: FOLDER, trashed: true }], rolesIn("viewer"))).toEqual([]);
	});

	// Without the space_id of its drive, the server does not find an item of a shared drive.
	it("sends the ids of each drive in a call of their own, with the space_id of that drive", () => {
		const items = [item(), item({ id: FOLDER, space_id: DESIGN }), item({ id: "itm_3", space_id: DESIGN })];
		expect(spaceBatches(items, ME)).toEqual([
			{ space: {}, ids: [ITEM] },
			{ space: { space_id: DESIGN }, ids: [FOLDER, "itm_3"] },
		]);
	});
});

describe("copyInput", () => {
	it("puts a copy next to the item where the person can add items, and in the own drive in each other case", () => {
		const copy = (change: Partial<DriveItem>, roles = NO_ROLES) =>
			copyInput(item({ parent_id: FOLDER, ...change }), ME, "k", roles);
		const toOwnDrive = { space_id: DESIGN, item_id: ITEM, idempotency_key: "k" };
		const cases = [
			[copy({}), { item_id: ITEM, parent_id: FOLDER, idempotency_key: "k" }],
			[copy({ space_id: BOB, role: "editor" }), { space_id: BOB, item_id: ITEM, idempotency_key: "k" }],
			[
				copy({ space_id: DESIGN, role: "editor" }, rolesIn("editor")),
				{ space_id: DESIGN, item_id: ITEM, target_space_id: DESIGN, parent_id: FOLDER, idempotency_key: "k" },
			],
			// A viewer of a shared drive cannot add items to it.
			[copy({ space_id: DESIGN, role: "viewer" }, rolesIn("viewer")), toOwnDrive],
			// The server refuses a copy into a shared drive from a person with only an editor grant on the item.
			[copy({ space_id: DESIGN, role: "editor" }), toOwnDrive],
			[copy({ space_id: DESIGN, role: "editor" }, rolesIn("viewer")), toOwnDrive],
		] as const;
		for (const [input, expected] of cases) {
			expect(input).toEqual(expected);
			expect(operations["drive.copy_item"].input.safeParse(input).success).toBe(true);
		}
	});
});

describe("moves", () => {
	const SITE = "drv_01JD00000000000000000000ST";
	const ARCHIVE = "drv_01JD0000000000000000000ARC";
	const drives = [
		{ id: ARCHIVE, name: "Archive", role: "viewer" },
		{ id: DESIGN, name: "Design", role: "editor" },
		{ id: SITE, name: "Site", role: "manager" },
	] as const;
	const myDrive = { spaceId: ME, name: "My Drive", shared: false };
	const design = { spaceId: DESIGN, name: "Design", shared: true };
	const site = { spaceId: SITE, name: "Site", shared: true };

	// The server refuses a move into a drive where the person is a viewer, and a move out of a shared
	// drive by an editor.
	it("offers the drives that the server accepts as the target of a move", () => {
		expect(moveTargets([item()], ME, drives)).toEqual([myDrive, design, site]);
		expect(moveTargets([item({ space_id: SITE, role: "manager" })], ME, drives)).toEqual([myDrive, design, site]);
		// An editor moves items only in the shared drive.
		expect(moveTargets([item({ space_id: DESIGN, role: "editor" })], ME, drives)).toEqual([design]);
		expect(moveTargets([item({ space_id: ARCHIVE, role: "viewer" })], ME, drives)).toEqual([]);
		expect(moveTargets([item({ space_id: BOB, role: "editor" })], ME, drives)).toEqual([]);
		expect(moveTargets([item(), item({ space_id: SITE, role: "manager" })], ME, drives)).toEqual([]);
		expect(moveTargets([], ME, drives)).toEqual([]);
		// An editor grant on an item does not move it: not for a viewer of the drive, and not for a
		// person who is not a member.
		expect(moveTargets([item({ space_id: ARCHIVE, role: "editor" })], ME, drives)).toEqual([]);
		expect(moveTargets([item({ space_id: DESIGN, role: "editor" })], ME, [])).toEqual([]);
	});

	it("makes inputs that drive.move_items and drive.move_to_drive accept", () => {
		const inDrive = [moveItemsInput(ME, ME, [ITEM], null), moveItemsInput(DESIGN, ME, [ITEM], FOLDER)];
		expect(inDrive).toEqual([{ item_ids: [ITEM] }, { space_id: DESIGN, item_ids: [ITEM], parent_id: FOLDER }]);
		for (const input of inDrive) expect(operations["drive.move_items"].input.safeParse(input).success).toBe(true);

		// The target of a move out of a shared drive is the own drive: the operation needs its id.
		const across = [
			moveToDriveInput(ME, ME, [ITEM], { spaceId: DESIGN, parentId: FOLDER }, true),
			moveToDriveInput(SITE, ME, [ITEM], { spaceId: ME, parentId: null }, false),
		];
		expect(across).toEqual([
			{ item_ids: [ITEM], target_space_id: DESIGN, parent_id: FOLDER, dry_run: true },
			{ space_id: SITE, item_ids: [ITEM], target_space_id: ME, dry_run: false },
		]);
		for (const input of across) expect(operations["drive.move_to_drive"].input.safeParse(input).success).toBe(true);
	});

	// A move to a different drive is one call: the server then moves each item or no item. A second
	// call for the same selection can fail after the first call moved a folder with the items of the
	// second call.
	it("does not start a move to a different drive that one call cannot take", () => {
		const ids = (count: number) =>
			Array.from({ length: count }, (_, index) => `itm_01JD${String(index).padStart(22, "0")}`);
		const input = (count: number) => moveToDriveInput(ME, ME, ids(count), { spaceId: DESIGN, parentId: null }, false);
		const { itemsPerCall } = DRIVE_LIMITS;
		expect(moveAcrossRefusal(itemsPerCall)).toBeNull();
		expect(operations["drive.move_to_drive"].input.safeParse(input(itemsPerCall)).success).toBe(true);
		expect(moveAcrossRefusal(itemsPerCall + 1)).toBe(
			`Select at most ${itemsPerCall} items to move to a different drive.`,
		);
		expect(operations["drive.move_to_drive"].input.safeParse(input(itemsPerCall + 1)).success).toBe(false);
	});

	// The person must know who owns the items after the move, and who can then read them.
	it("tells the person who owns the items after the move, and who keeps a direct share", () => {
		const summary = moveSummary({ items_total: 3, kept_shares: [BOB, "prn_2"] });
		expect(summary).toEqual({ itemsTotal: 3, keptShares: [BOB, "prn_2"] });
		// A direct share can be for an agent, so the text does not say "people" only.
		expect(moveConfirmText(3, myDrive, design, summary).join(" ")).toBe(
			"Design will own them. Its members get access. 2 people or agents keep their direct shares.",
		);
		expect(moveConfirmText(1, site, myDrive, { itemsTotal: 12, keptShares: [BOB] }).join(" ")).toBe(
			"You will own it. The members of Site lose the access that their role gives. " +
				"The move takes 12 items, with all that the folders hold. 1 person or agent keeps a direct share.",
		);
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

	// A shared drive has a root that each member can open. Its name comes from drive.get_about.
	it("starts at the name of the drive in a shared drive, also for its trash", () => {
		const view = { kind: "folder", spaceId: DESIGN, folderId: ITEM } as const;
		const inDrive = { item: { id: ITEM, name: "Bakery", space_id: DESIGN }, path: [] };
		expect(breadcrumbs(view, inDrive, ME, "Design")).toEqual([
			{ label: "Design", to: `/drive/shared-drives/${DESIGN}` },
			{ label: "Bakery", to: null },
		]);
		expect(breadcrumbs({ ...view, folderId: null }, null, ME, null)).toEqual([{ label: "Shared drive", to: null }]);
		expect(breadcrumbs({ kind: "trash", spaceId: DESIGN }, null, ME, "Design")).toEqual([
			{ label: "Design", to: `/drive/shared-drives/${DESIGN}` },
			{ label: "Trash", to: null },
		]);
		expect(breadcrumbs({ kind: "trash" }, null, ME)).toEqual([]);
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
		expect(backPath(item({ parent_id: FOLDER }), null)).toBe(`/drive/folders/${ME}/${FOLDER}`);
		expect(backPath(item(), null)).toBe("/drive");
		expect(backPath(item({ space_id: BOB, role: "editor", parent_id: FOLDER }), null)).toBe("/drive/shared");
	});

	// An item of a shared drive has no owner. Each member can open its folder. A person with only a
	// direct share cannot open the folder or the root of the drive: the server answers `not_found`.
	it("goes back to the folder or to the root of a shared drive for a member, and to the shared list for each other person", () => {
		const doc = { space_id: DESIGN, role: "viewer" } as const;
		expect(backPath(item({ ...doc, parent_id: FOLDER }), "viewer")).toBe(`/drive/folders/${DESIGN}/${FOLDER}`);
		expect(backPath(item(doc), "viewer")).toBe(`/drive/shared-drives/${DESIGN}`);
		expect(backPath(item({ ...doc, parent_id: FOLDER }), null)).toBe("/drive/shared");
		expect(backPath(item({ ...doc, role: "editor" }), null)).toBe("/drive/shared");
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

// A person can select more items than one call takes. The server refuses a call over the limit.
describe("bulk actions", () => {
	it("send the ids in parts that the contract of each bulk operation accepts", () => {
		const ids = Array.from(
			{ length: 2 * DRIVE_LIMITS.itemsPerCall + 50 },
			(_, n) => `itm_${String(n).padStart(26, "0")}`,
		);
		const batches = idBatches(ids);
		expect(batches.flat()).toEqual(ids);
		expect(batches.map((batch) => batch.length)).toEqual([100, 100, 50]);
		for (const batch of batches) {
			expect(operations["drive.trash_items"].input.safeParse({ item_ids: batch }).success).toBe(true);
		}
		expect(operations["drive.trash_items"].input.safeParse({ item_ids: ids }).success).toBe(false);
		expect(idBatches([])).toEqual([]);
	});
});
