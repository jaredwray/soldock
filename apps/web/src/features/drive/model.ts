import { DRIVE_LIMITS, type DriveItem, type InputOf, type PathEntry } from "@soldock/contracts";
import type { IconName } from "../../lib/icons.tsx";
import { DRIVE_PATH, type DriveView, drivePath, itemPath } from "../../routes.ts";

// The rules of the Drive pages that need no DOM: which call a view makes, which actions an item
// offers, and what a file can show. The components and the Node tests use them.

export type ListInput = InputOf<"drive.list_items">;
export type ItemOrder = "name" | "modified";

/** The root of the own drive of the person. */
export const MY_DRIVE: DriveView = { kind: "folder", spaceId: null, folderId: null };

/**
 * The `space_id` field of a drive operation. The own drive needs none. An item of somebody else
 * needs the drive that holds it.
 */
export function spaceInput(spaceId: string | null, ownSpaceId: string): { space_id?: string } {
	return spaceId !== null && spaceId !== ownSpaceId ? { space_id: spaceId } : {};
}

/** The input of `drive.list_items` for a view. Null for a search without words: that view makes no call. */
export function listInput(view: DriveView, order: ItemOrder, ownSpaceId: string): ListInput | null {
	switch (view.kind) {
		case "folder":
			return {
				view: "folder",
				...spaceInput(view.spaceId, ownSpaceId),
				...(view.folderId ? { parent_id: view.folderId } : {}),
				order,
			};
		case "search": {
			const query = view.query.trim().slice(0, DRIVE_LIMITS.queryChars);
			return query ? { view: "search", query } : null;
		}
		default:
			return { view: view.kind };
	}
}

/** True for a folder view in the drive of somebody else. */
export function isForeignFolder(view: DriveView, ownSpaceId: string): boolean {
	return view.kind === "folder" && view.spaceId !== null && view.spaceId !== ownSpaceId;
}

export interface CreateTarget {
	space_id?: string;
	parent_id?: string;
}

/**
 * Where a new item goes. In a folder view, it is that folder. In each other view, it is the root of
 * the own drive. The result is null when the person cannot add items to the folder: a folder of
 * somebody else needs the editor role, and `folderRole` is null until the folder loads.
 */
export function createTarget(
	view: DriveView,
	folderRole: DriveItem["role"] | null,
	ownSpaceId: string,
): CreateTarget | null {
	if (view.kind !== "folder" || view.folderId === null) return {};
	if (isForeignFolder(view, ownSpaceId)) {
		if (folderRole !== "editor" && folderRole !== "owner") return null;
		return { space_id: view.spaceId as string, parent_id: view.folderId };
	}
	return { parent_id: view.folderId };
}

export function viewTitle(view: DriveView, folderName: string | null): string {
	switch (view.kind) {
		case "folder":
			return view.folderId === null ? "My Drive" : (folderName ?? "Folder");
		case "shared":
			return "Shared with me";
		case "recent":
			return "Recent";
		case "starred":
			return "Starred";
		case "trash":
			return "Trash";
		case "search":
			return view.query.trim() ? `Search: ${view.query.trim()}` : "Search";
	}
}

export function emptyText(view: DriveView): string {
	switch (view.kind) {
		case "folder":
			return view.folderId === null
				? "Your drive is empty. Use New to add a folder, a file, a doc or a sheet."
				: "This folder is empty.";
		case "shared":
			return "Nobody shared an item with you.";
		case "recent":
			return "You have no files, docs or sheets yet.";
		case "starred":
			return "You have no items with a star.";
		case "trash":
			return "The trash is empty.";
		case "search":
			return view.query.trim() ? `No items match “${view.query.trim()}”.` : "Enter words in the search box.";
	}
}

export interface Crumb {
	label: string;
	/** The path of the crumb. Null for the last crumb, which is the current folder. */
	to: string | null;
}

/**
 * The breadcrumbs of a folder view. The first crumb is "My Drive" in the own drive, and "Shared with
 * me" in the drive of somebody else: there, the path starts at the highest folder that the person
 * can read. `folder` is null for the root, and while the folder loads.
 */
export function breadcrumbs(
	view: Extract<DriveView, { kind: "folder" }>,
	folder: { item: Pick<DriveItem, "id" | "name" | "space_id">; path: readonly PathEntry[] } | null,
	ownSpaceId: string,
): Crumb[] {
	const foreign = isForeignFolder(view, ownSpaceId);
	const atRoot = view.folderId === null;
	const root: Crumb = foreign
		? { label: "Shared with me", to: drivePath({ kind: "shared" }) }
		: { label: "My Drive", to: atRoot ? null : DRIVE_PATH };
	if (atRoot || !folder) return [root];
	const spaceId = folder.item.space_id;
	const above = folder.path
		.filter((entry) => entry.id !== folder.item.id)
		.map((entry) => ({ label: entry.name, to: itemPath({ kind: "folder", space_id: spaceId, id: entry.id }) }));
	return [root, ...above, { label: folder.item.name, to: null }];
}

const IMAGE_PREVIEW_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** A text file larger than this shows no preview. */
export const TEXT_PREVIEW_BYTES = 1024 * 1024;

export type PreviewKind = "image" | "text" | "none";

/**
 * What the preview dialog can show for a file. Only raster images go into an `<img>`: an SVG image
 * can hold a script. Text shows as plain text. Each other type gets a download only.
 */
export function previewKind(mimeType: string | null, size: number): PreviewKind {
	const type = (mimeType ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
	if (IMAGE_PREVIEW_TYPES.has(type)) return "image";
	if ((type.startsWith("text/") || type === "application/json") && size <= TEXT_PREVIEW_BYTES) return "text";
	return "none";
}

export function itemIcon(item: Pick<DriveItem, "kind" | "mime_type">): IconName {
	switch (item.kind) {
		case "folder":
			return "folder";
		case "doc":
			return "doc";
		case "sheet":
			return "sheet";
		case "file":
			return (item.mime_type ?? "").toLowerCase().startsWith("image/") ? "image" : "file";
	}
}

const KIND_NAMES = { folder: "Folder", file: "File", doc: "Doc", sheet: "Sheet" } as const;

export function kindName(item: Pick<DriveItem, "kind">): string {
	return KIND_NAMES[item.kind];
}

const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

/**
 * The MIME type to send with an upload: the type that the browser gave, when the server accepts its
 * form. Without it, the server uses its default.
 */
export function uploadMimeType(browserType: string): string | undefined {
	// The server takes the type without parameters such as charset.
	const type = browserType.split(";")[0]?.trim() ?? "";
	return type.length <= 127 && MIME_TYPE.test(type) ? type : undefined;
}

/** The reason why a file cannot be uploaded, or null. The check runs before the file is read. */
export function uploadRefusal(file: { name: string; size: number }): string | null {
	if (file.size > DRIVE_LIMITS.fileBytes) {
		return `“${file.name}” is larger than ${DRIVE_LIMITS.fileBytes / (1024 * 1024)} MB, the limit for one file.`;
	}
	return null;
}

export type ItemAction =
	| "open"
	| "download"
	| "rename"
	| "move"
	| "copy"
	| "share"
	| "access"
	| "versions"
	| "trash"
	| "leave"
	| "restore"
	| "delete";

/**
 * The actions that the More menu of an item offers. The role decides: the owner can do all, an
 * editor can also change the name and the content, and a viewer can read and copy. An item in the
 * trash has only Restore and Delete forever. `sharedView` adds "Remove from my list": there, each
 * item has a grant of its own for the person.
 */
export function itemActions(item: DriveItem, options: { sharedView?: boolean } = {}): ItemAction[] {
	if (item.trashed) return item.role === "owner" ? ["restore", "delete"] : [];
	const owner = item.role === "owner";
	const canEdit = owner || item.role === "editor";
	const actions: ItemAction[] = ["open"];
	if (item.kind === "file") actions.push("download");
	if (canEdit) actions.push("rename");
	if (owner) actions.push("move");
	if (item.kind !== "folder") actions.push("copy");
	actions.push(owner ? "share" : "access");
	if (item.kind === "file") actions.push("versions");
	if (owner) actions.push("trash");
	else if (options.sharedView) actions.push("leave");
	return actions;
}

export type BulkAction = "move" | "trash" | "restore" | "delete";

/** The actions that apply to each item of a selection. Only the owner can move, trash, restore and delete. */
export function bulkActions(items: readonly DriveItem[]): BulkAction[] {
	if (items.length === 0 || items.some((item) => item.role !== "owner")) return [];
	if (items.every((item) => item.trashed)) return ["restore", "delete"];
	if (items.some((item) => item.trashed)) return [];
	return ["move", "trash"];
}

/**
 * The path to share for an item. A folder, a doc and a sheet have their own page. A file has none,
 * so the path is its folder. A file at the root of a drive has no path that works for other people.
 */
export function linkPath(item: Pick<DriveItem, "kind" | "space_id" | "id" | "parent_id">): string | null {
	const own = itemPath(item);
	if (own !== null) return own;
	return item.parent_id ? itemPath({ kind: "folder", space_id: item.space_id, id: item.parent_id }) : null;
}

/** The page to go back to from an editor: the folder of the item for its owner, the shared list for others. */
export function backPath(item: Pick<DriveItem, "role" | "space_id" | "parent_id">): string {
	if (item.role !== "owner") return drivePath({ kind: "shared" });
	if (!item.parent_id) return DRIVE_PATH;
	return itemPath({ kind: "folder", space_id: item.space_id, id: item.parent_id }) ?? DRIVE_PATH;
}

/** The name of the owner of a drive for a list: "me" for the own drive. */
export function ownerName(spaceId: string, ownSpaceId: string, names: ReadonlyMap<string, string>): string {
	if (spaceId === ownSpaceId) return "me";
	return names.get(spaceId) ?? "Unknown";
}
