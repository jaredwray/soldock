import {
	DRIVE_LIMITS,
	type DriveItem,
	type InputOf,
	type OutputOf,
	type PathEntry,
	type SharedDrive,
	type SharedDriveRole,
} from "@soldock/contracts";
import type { IconName } from "../../lib/icons.tsx";
import { DRIVE_PATH, type DriveView, drivePath, isSharedDriveId, itemPath, sharedDrivePath } from "../../routes.ts";

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

/** The icon of a shared drive, and of the list of the shared drives. */
export const SHARED_DRIVE_ICON: IconName = "allMail";

/** The shared drive that a view is in: its root, a folder, its trash or its search. Null for each other view. */
export function sharedDriveOf(view: DriveView): string | null {
	return "spaceId" in view && isSharedDriveId(view.spaceId) ? view.spaceId : null;
}

/**
 * The input of `drive.list_items` for a view. Null for a view that makes no call: a search without
 * words, and the list of the shared drives.
 */
export function listInput(view: DriveView, order: ItemOrder, ownSpaceId: string): ListInput | null {
	const shared = sharedDriveOf(view);
	const space = shared !== null ? { space_id: shared } : {};
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
			return query ? { view: "search", ...space, query } : null;
		}
		case "trash":
			return { view: "trash", ...space };
		case "shared-drives":
			return null;
		default:
			return { view: view.kind };
	}
}

/** True for a folder view in the drive of a different person or agent. A shared drive is not such a drive. */
export function isForeignFolder(view: DriveView, ownSpaceId: string): boolean {
	return (
		view.kind === "folder" && view.spaceId !== null && view.spaceId !== ownSpaceId && !isSharedDriveId(view.spaceId)
	);
}

type Role = DriveItem["role"];

/** True for a role that can add items, change names and change content. */
export function canEdit(role: Role | null): boolean {
	return role === "owner" || role === "manager" || role === "editor";
}

export interface CreateTarget {
	space_id?: string;
	parent_id?: string;
}

/**
 * Where a new item goes. In a folder view, it is that folder. In each other view, it is the root of
 * the own drive. The result is null when the person cannot add items to the place on screen: a
 * folder of somebody else and each place of a shared drive need the editor role. `role` is the role
 * of the person for the folder, or for the shared drive at its root. It is null until it loads.
 */
export function createTarget(view: DriveView, role: Role | null, ownSpaceId: string): CreateTarget | null {
	if (view.kind !== "folder") return {};
	const parent = view.folderId ? { parent_id: view.folderId } : {};
	if (isSharedDriveId(view.spaceId) || isForeignFolder(view, ownSpaceId)) {
		// The root of the drive of somebody else is not a place that the person can open.
		if (!canEdit(role) || (view.folderId === null && !isSharedDriveId(view.spaceId))) return null;
		return { space_id: view.spaceId as string, ...parent };
	}
	return parent;
}

/** The place that gets the files of a drop. */
export interface DropZone {
	target: CreateTarget;
	/** The name of the folder that gets the files, for the drop hint and the toast. */
	name: string;
	/** The folder row that gets the files. Null when the view gets them. */
	rowId: string | null;
}

/**
 * Where a drop of files goes. A folder row gets the files when the person can add items to it: the
 * owner or an editor. Each other part of the list sends them to the target of New, but the trash
 * takes no files. `row` is the item under the pointer. Null when no part of the page takes files.
 */
export function dropZone(
	view: DriveView,
	viewTarget: CreateTarget | null,
	viewName: string,
	row: DriveItem | null,
	ownSpaceId: string,
): DropZone | null {
	if (row && row.kind === "folder" && !row.trashed && canEdit(row.role)) {
		return { target: { ...spaceInput(row.space_id, ownSpaceId), parent_id: row.id }, name: row.name, rowId: row.id };
	}
	if (view.kind === "trash" || viewTarget === null) return null;
	return { target: viewTarget, name: view.kind === "folder" ? viewName : "My Drive", rowId: null };
}

/**
 * The title of a view. `driveName` is the name of the shared drive that the view is in. It is null
 * for each other view, and while the name loads.
 */
export function viewTitle(view: DriveView, folderName: string | null, driveName: string | null = null): string {
	const shared = sharedDriveOf(view) !== null;
	switch (view.kind) {
		case "folder":
			if (view.folderId !== null) return folderName ?? "Folder";
			return shared ? (driveName ?? "Shared drive") : "My Drive";
		case "shared":
			return "Shared with me";
		case "shared-drives":
			return "Shared drives";
		case "recent":
			return "Recent";
		case "starred":
			return "Starred";
		case "trash":
			return shared ? `Trash of ${driveName ?? "the shared drive"}` : "Trash";
		case "search": {
			const prefix = shared ? `Search in ${driveName ?? "the shared drive"}` : "Search";
			return view.query.trim() ? `${prefix}: ${view.query.trim()}` : prefix;
		}
	}
}

export function emptyText(view: DriveView): string {
	const shared = sharedDriveOf(view) !== null;
	switch (view.kind) {
		case "folder":
			if (view.folderId !== null) return "This folder is empty.";
			return shared
				? "This shared drive is empty."
				: "Your drive is empty. Use New to add a folder, a file, a doc or a sheet.";
		case "shared-drives":
			return "You are not a member of a shared drive.";
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
 * The breadcrumbs of a view. A view with no path gets none.
 * - In a folder view, the first crumb is "My Drive" in the own drive, and the name of the drive in a
 *   shared drive. In the drive of somebody else it is "Shared with me": there, the path starts at the
 *   highest folder that the person can read.
 * - The trash and the search of a shared drive start with the name of the drive.
 *
 * `folder` is null for the root, and while the folder loads. `driveName` is the name of the shared
 * drive, or null while it loads.
 */
export function breadcrumbs(
	view: DriveView,
	folder: { item: Pick<DriveItem, "id" | "name" | "space_id">; path: readonly PathEntry[] } | null,
	ownSpaceId: string,
	driveName: string | null = null,
): Crumb[] {
	const shared = sharedDriveOf(view);
	if (view.kind !== "folder") {
		if (shared === null) return [];
		return [
			{ label: driveName ?? "Shared drive", to: sharedDrivePath(shared) },
			{ label: view.kind === "search" ? viewTitle({ kind: "search", query: view.query }, null) : "Trash", to: null },
		];
	}
	const atRoot = view.folderId === null;
	const root: Crumb =
		shared !== null
			? { label: driveName ?? "Shared drive", to: atRoot ? null : sharedDrivePath(shared) }
			: isForeignFolder(view, ownSpaceId)
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

/** The place of a file among the files of a list, for Previous and Next in the preview dialog. */
export interface PreviewNeighbors<T> {
	previous: T | null;
	next: T | null;
	/** The position of the file, from 1. 0 when the list does not have the file. */
	position: number;
	/** The number of files in the list. */
	total: number;
}

/**
 * The files before and after a file in a list, in the order of the list. A folder, a doc and a sheet
 * open in their own pages, so the preview skips them. The first file has no previous file, and the
 * last file has no next file.
 */
export function previewNeighbors<T extends Pick<DriveItem, "id" | "kind">>(
	items: readonly T[],
	itemId: string,
): PreviewNeighbors<T> {
	const files = items.filter((item) => item.kind === "file");
	const index = files.findIndex((item) => item.id === itemId);
	if (index === -1) return { previous: null, next: null, position: 0, total: files.length };
	return {
		previous: files[index - 1] ?? null,
		next: files[index + 1] ?? null,
		position: index + 1,
		total: files.length,
	};
}

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

/** The message for the folders of a drop. Drive uploads only files. */
export function folderRefusal(names: readonly string[]): string {
	const first = names[0];
	return names.length === 1 && first
		? `“${first}” is a folder, and Drive uploads only files. Drop the files that are in it.`
		: `${names.length} folders did not upload. Drive uploads only files. Drop the files that are in them.`;
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
 * The member role of the person in each shared drive, by the id of the drive. A drive that is not
 * in the map has no member role for the person: the person is not a member, or the list of the
 * shared drives did not load yet.
 */
export type MemberRoles = ReadonlyMap<string, SharedDriveRole>;

/** The member roles from the shared drives of the person. `role` is null where the person is not a member. */
export function memberRoles(drives: readonly Pick<SharedDrive, "id" | "role">[]): MemberRoles {
	return new Map(drives.flatMap((drive) => (drive.role ? [[drive.id, drive.role] as const] : [])));
}

/**
 * The member role of the person in the shared drive of an item. Null for an item of each other
 * drive, and for a person who is not a member.
 *
 * `item.role` is not the member role: it is the highest of the member role and the grants on the
 * item. The server uses only the member role for a move, the trash, a restore and a copy into the
 * drive. A grant gives at most the editor role, so the manager role always comes from the members.
 */
export function memberRole(item: Pick<DriveItem, "role" | "space_id">, roles: MemberRoles): SharedDriveRole | null {
	if (!isSharedDriveId(item.space_id)) return null;
	return roles.get(item.space_id) ?? (item.role === "manager" ? "manager" : null);
}

/**
 * True when the person can move the item, put it in the trash and restore it. In the own drive, the
 * owner can. In a shared drive, a member with the manager or the editor role can. A grant on the
 * item is not sufficient.
 */
export function canMove(item: Pick<DriveItem, "role" | "space_id">, roles: MemberRoles): boolean {
	return item.role === "owner" || canEdit(memberRole(item, roles));
}

/** True when the person can share the item and remove each grant: the owner, or a manager of a shared drive. */
export function canShare(item: Pick<DriveItem, "role">): boolean {
	return item.role === "owner" || item.role === "manager";
}

/**
 * The actions that the More menu of an item offers. The role decides.
 * - The owner can do all. In a shared drive, a manager can do all.
 * - An editor can change the name and the content. In a shared drive, a member with the editor role
 *   can also move the item in the drive and put it in the trash.
 * - A viewer can read and copy.
 *
 * An item in the trash has Restore, and Delete forever for the owner or a manager. `sharedView` adds
 * "Remove from my list" for an item that the person cannot put in the trash: there, each item has a
 * grant of its own for the person. `roles` has the member role of the person in each shared drive.
 */
export function itemActions(item: DriveItem, roles: MemberRoles, options: { sharedView?: boolean } = {}): ItemAction[] {
	if (item.trashed) {
		if (!canMove(item, roles)) return [];
		return canShare(item) ? ["restore", "delete"] : ["restore"];
	}
	const actions: ItemAction[] = ["open"];
	if (item.kind === "file") actions.push("download");
	if (canEdit(item.role)) actions.push("rename");
	const movable = canMove(item, roles);
	if (movable) actions.push("move");
	if (item.kind !== "folder") actions.push("copy");
	actions.push(canShare(item) ? "share" : "access");
	if (item.kind === "file") actions.push("versions");
	if (movable) actions.push("trash");
	else if (options.sharedView) actions.push("leave");
	return actions;
}

/**
 * The ids of a bulk action, in parts that one call can take. A person can select more items than
 * `DRIVE_LIMITS.itemsPerCall`, for example after "More" loaded three pages.
 */
export function idBatches(ids: readonly string[], size: number = DRIVE_LIMITS.itemsPerCall): string[][] {
	const batches: string[][] = [];
	for (let start = 0; start < ids.length; start += size) batches.push(ids.slice(start, start + size));
	return batches;
}

/**
 * The ids of a bulk action, for each drive and in parts that one call can take. The items of a list
 * can be in more than one drive, for example in Starred. Each part has the `space_id` field of its drive.
 */
export function spaceBatches(
	items: readonly Pick<DriveItem, "id" | "space_id">[],
	ownSpaceId: string,
): { space: { space_id?: string }; ids: string[] }[] {
	const bySpace = new Map<string, string[]>();
	for (const item of items) bySpace.set(item.space_id, [...(bySpace.get(item.space_id) ?? []), item.id]);
	return [...bySpace].flatMap(([spaceId, ids]) =>
		idBatches(ids).map((batch) => ({ space: spaceInput(spaceId, ownSpaceId), ids: batch })),
	);
}

export type BulkAction = "move" | "trash" | "restore" | "delete";

/**
 * The actions that apply to each item of a selection. The rules are those of `itemActions`. A move
 * needs items of one drive, because the items go to one place.
 */
export function bulkActions(items: readonly DriveItem[], roles: MemberRoles): BulkAction[] {
	if (items.length === 0 || items.some((item) => !canMove(item, roles))) return [];
	if (items.every((item) => item.trashed)) return items.every(canShare) ? ["restore", "delete"] : ["restore"];
	if (items.some((item) => item.trashed)) return [];
	return items.every((item) => item.space_id === items[0]?.space_id) ? ["move", "trash"] : ["trash"];
}

/**
 * The input of `drive.copy_item`. A copy goes next to the item when the person can add items there:
 * in the own drive, and in a shared drive for a member with the editor or the manager role. Each
 * other copy goes to the root of the own drive, also for a person with only a grant on the item.
 */
export function copyInput(
	item: Pick<DriveItem, "id" | "space_id" | "parent_id" | "role">,
	ownSpaceId: string,
	idempotencyKey: string,
	roles: MemberRoles,
): InputOf<"drive.copy_item"> {
	const inSharedDrive = canEdit(memberRole(item, roles));
	const nextToItem = item.space_id === ownSpaceId || inSharedDrive;
	return {
		...spaceInput(item.space_id, ownSpaceId),
		item_id: item.id,
		...(inSharedDrive ? { target_space_id: item.space_id } : {}),
		...(nextToItem && item.parent_id ? { parent_id: item.parent_id } : {}),
		idempotency_key: idempotencyKey,
	};
}

/** A drive that can get the items of a move. */
export interface MoveTarget {
	/** The id of the drive: the own id of the person for My Drive. */
	spaceId: string;
	name: string;
	shared: boolean;
}

/**
 * The drives that the items can move to, with the drive that holds them now. Empty when the person
 * cannot move the items, or when the items are in more than one drive.
 * - From the own drive: My Drive, and each shared drive where the person is an editor or a manager.
 * - From a shared drive, a manager has the same choice. An editor moves items only in that drive.
 *
 * `drives` has the shared drives of the person, with the member role in each one. A grant on an
 * item of a shared drive does not let the person move it.
 */
export function moveTargets(
	items: readonly Pick<DriveItem, "space_id" | "role">[],
	ownSpaceId: string,
	drives: readonly Pick<SharedDrive, "id" | "name" | "role">[],
): MoveTarget[] {
	const roles = memberRoles(drives);
	const sourceId = items[0]?.space_id;
	if (sourceId === undefined || items.some((item) => item.space_id !== sourceId || !canMove(item, roles))) return [];
	const shared = drives
		.filter((drive) => drive.role === "manager" || drive.role === "editor")
		.map((drive) => ({ spaceId: drive.id, name: drive.name, shared: true }));
	const canMoveOut = sourceId === ownSpaceId || items.every((item) => memberRole(item, roles) === "manager");
	if (canMoveOut) return [{ spaceId: ownSpaceId, name: "My Drive", shared: false }, ...shared];
	// The list of the shared drives can be behind. The drive of the items is always a target.
	return shared.some((drive) => drive.spaceId === sourceId)
		? shared.filter((drive) => drive.spaceId === sourceId)
		: [{ spaceId: sourceId, name: "Shared drive", shared: true }];
}

/** The input of `drive.move_items`: a move in one drive. A null `parentId` is the root of the drive. */
export function moveItemsInput(
	sourceSpaceId: string,
	ownSpaceId: string,
	itemIds: string[],
	parentId: string | null,
): InputOf<"drive.move_items"> {
	return { ...spaceInput(sourceSpaceId, ownSpaceId), item_ids: itemIds, ...(parentId ? { parent_id: parentId } : {}) };
}

/** The input of `drive.move_to_drive`: a move to a different drive. A null `parentId` is the root of the target. */
export function moveToDriveInput(
	sourceSpaceId: string,
	ownSpaceId: string,
	itemIds: string[],
	target: { spaceId: string; parentId: string | null },
	dryRun: boolean,
): InputOf<"drive.move_to_drive"> {
	return {
		...spaceInput(sourceSpaceId, ownSpaceId),
		item_ids: itemIds,
		target_space_id: target.spaceId,
		...(target.parentId ? { parent_id: target.parentId } : {}),
		dry_run: dryRun,
	};
}

/**
 * The reason why a selection cannot move to a different drive, or null. Such a move is one call of
 * `drive.move_to_drive`, so that it moves each item or no item. One call takes at most
 * `DRIVE_LIMITS.itemsPerCall` ids. In one call, the server also counts an item only once when the
 * selection has the item and a folder above it.
 */
export function moveAcrossRefusal(selected: number): string | null {
	return selected > DRIVE_LIMITS.itemsPerCall
		? `Select at most ${DRIVE_LIMITS.itemsPerCall} items to move to a different drive.`
		: null;
}

/** The totals of a move to a different drive, from its dry run. */
export interface MoveSummary {
	/** The selected items and all that their folders hold. */
	itemsTotal: number;
	/** The ids of the people and agents that keep a direct share. */
	keptShares: readonly string[];
}

/** The summary of the dry run of a move. */
export function moveSummary(run: Pick<OutputOf<"drive.move_to_drive">, "items_total" | "kept_shares">): MoveSummary {
	return { itemsTotal: run.items_total, keptShares: run.kept_shares };
}

/**
 * The text of the confirmation of a move to a different drive: who owns the items after the move,
 * who gets or loses access, and who keeps a direct share.
 * @param selected The number of the selected items.
 * @param source The drive that holds the items now.
 */
export function moveConfirmText(
	selected: number,
	source: Pick<MoveTarget, "name" | "shared">,
	target: Pick<MoveTarget, "name" | "shared">,
	summary: MoveSummary,
): string[] {
	const them = selected === 1 ? "it" : "them";
	const lines = target.shared
		? [`${target.name} will own ${them}.`, "Its members get access."]
		: [`You will own ${them}.`];
	if (source.shared) lines.push(`The members of ${source.name} lose the access that their role gives.`);
	if (summary.itemsTotal > selected) {
		lines.push(`The move takes ${summary.itemsTotal} items, with all that the folders hold.`);
	}
	const kept = summary.keptShares.length;
	// A direct share can be for a person or for an agent. The ids do not tell which.
	if (kept === 1) lines.push("1 person or agent keeps a direct share.");
	else if (kept > 1) lines.push(`${kept} people or agents keep their direct shares.`);
	return lines;
}

/** The path that shows a drive, or a folder of it. */
export function spacePath(spaceId: string, ownSpaceId: string, folderId: string | null = null): string {
	if (folderId) return drivePath({ kind: "folder", spaceId, folderId });
	return spaceId === ownSpaceId ? DRIVE_PATH : drivePath({ kind: "folder", spaceId, folderId: null });
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

/**
 * The page to go back to from an editor.
 * - The owner goes to the folder of the item.
 * - A member of a shared drive goes to the folder of the item in that drive, or to its root.
 * - Each other person goes to the shared list. A person with only a grant on an item cannot open
 *   the folder of the item, or the root of its shared drive.
 *
 * `member` is the member role of the person in the shared drive of the item (`memberRole`). It is
 * null for a person who is not a member, and while the role loads.
 */
export function backPath(
	item: Pick<DriveItem, "role" | "space_id" | "parent_id">,
	member: SharedDriveRole | null,
): string {
	if (isSharedDriveId(item.space_id)) {
		return member !== null ? spacePath(item.space_id, "", item.parent_id) : drivePath({ kind: "shared" });
	}
	if (item.role !== "owner") return drivePath({ kind: "shared" });
	if (!item.parent_id) return DRIVE_PATH;
	return itemPath({ kind: "folder", space_id: item.space_id, id: item.parent_id }) ?? DRIVE_PATH;
}

/**
 * The name of the owner of a drive for a list: "me" for the own drive. `names` has the name of each
 * principal and of each shared drive of the person, by id.
 */
export function ownerName(spaceId: string, ownSpaceId: string, names: ReadonlyMap<string, string>): string {
	if (spaceId === ownSpaceId) return "me";
	return names.get(spaceId) ?? (isSharedDriveId(spaceId) ? "Shared drive" : "Unknown");
}
