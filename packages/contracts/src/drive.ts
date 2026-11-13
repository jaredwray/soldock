import { prefixedId, Timestamp } from "./common.ts";
import { defineOperation } from "./operation.ts";
import { z } from "./zod.ts";

export const DRIVE_LIMITS = {
	/**
	 * One uploaded file. The content is base64 in JSON, and an upload holds several copies of it at once.
	 * A Worker isolate has 128 MB of memory, so this is the same limit as a composed mail message.
	 */
	fileBytes: 10 * 1024 * 1024,
	nameChars: 255,
	/** The folders from the root of a drive to an item. */
	depth: 30,
	/** The items of one call that changes more than one item. */
	itemsPerCall: 100,
	pageSize: 100,
	/** The stored versions of one file. An upload over this limit deletes the oldest version. */
	versionsPerFile: 50,
	queryChars: 500,
} as const;

/** The kinds of an item. `doc` and `sheet` are the native documents of Soldock. */
export const ITEM_KINDS = ["folder", "file", "doc", "sheet"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** What a principal can do with an item, from the most to the least. */
export const DRIVE_ROLES = ["owner", "editor", "viewer"] as const;
export type DriveRole = (typeof DRIVE_ROLES)[number];

export const ItemId = prefixedId("itm");
const VersionId = prefixedId("ver");
const PrincipalId = prefixedId("prn");

/** The id of a drive: the id of the principal that owns it. */
export const SpaceId = prefixedId("prn");

/** The input field that selects the drive of an operation. */
export const SpaceParam = SpaceId.optional().describe(
	"The drive that holds the item: the space_id of the item, as drive.list_items returns it. The default is your own drive.",
);

/** One sentence for the description of each operation that takes `space_id`. */
export const IN_SPACE = "For an item that somebody shared with you, set space_id to the space_id of the item.";

/** The name of an item. It is safe as a file name: no control characters, slashes or backslashes. */
export const ItemName = z
	.string()
	.trim()
	.min(1)
	.max(DRIVE_LIMITS.nameChars)
	.refine((name) => !/[\p{Cc}\\/]/u.test(name), "must not contain control characters, slashes or backslashes")
	.refine((name) => name !== "." && name !== "..", "must not be . or ..");

const MimeType = z
	.string()
	.max(127)
	.regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i, "must be a MIME type such as application/pdf");

const ContentBase64 = z
	.string()
	// The base64 of the largest file, so a request cannot make the Worker decode more than that.
	.max(Math.ceil(DRIVE_LIMITS.fileBytes / 3) * 4, "must be at most 10 MiB")
	.regex(/^[A-Za-z0-9+/]*={0,2}$/, "must be base64");

const IdempotencyKey = z
	.string()
	.min(1)
	.max(255)
	.optional()
	.describe(
		"Makes a retry safe: a second call with the same key and the same input returns the first item and creates nothing.",
	);

/** The person or agent of a change, with the name at that time. */
export const Actor = z.object({
	principal_id: z.string(),
	kind: z.enum(["human", "agent"]),
	display_name: z.string(),
});
export type Actor = z.infer<typeof Actor>;

export const DriveItem = z.object({
	id: z.string(),
	/** The drive that holds the item. It is the id of the principal that owns the item. */
	space_id: z.string(),
	/** The folder that holds the item. Null for an item at the root of the drive. */
	parent_id: z.string().nullable(),
	kind: z.enum(ITEM_KINDS),
	name: z.string(),
	/** The type of the content of a file. Null for a folder, a doc and a sheet. */
	mime_type: z.string().nullable(),
	/** The bytes of the current content. 0 for a folder. */
	size: z.number().int(),
	created_at: Timestamp,
	modified_at: Timestamp,
	/** Who made the last change to the content or the name. */
	modified_by: Actor.nullable(),
	/** What you can do with the item: `owner`, `editor` or `viewer`. */
	role: z.enum(DRIVE_ROLES),
	/** True when you put a star on the item. Each principal has their own stars. */
	starred: z.boolean(),
	/** True when the item, or a folder above it, is in the trash. */
	trashed: z.boolean(),
	trashed_at: Timestamp.nullable(),
	/** True when the owner gave access to the item itself. Access to a folder above it does not count. */
	shared: z.boolean(),
});
export type DriveItem = z.infer<typeof DriveItem>;

/** One entry of the path from the root of a drive to an item. */
export const PathEntry = z.object({ id: z.string(), name: z.string() });
export type PathEntry = z.infer<typeof PathEntry>;

export const Permission = z.object({
	principal_id: z.string(),
	role: z.enum(["editor", "viewer"]),
	/** The item that holds the grant: the item itself, or a folder above it. */
	item_id: z.string(),
	/** True when the grant comes from a folder above the item. */
	inherited: z.boolean(),
	granted_by: Actor.nullable(),
	created_at: Timestamp,
});
export type Permission = z.infer<typeof Permission>;

export const FileVersion = z.object({
	id: z.string(),
	size: z.number().int(),
	mime_type: z.string(),
	/** The SHA-256 of the content, as lowercase hex. */
	sha256: z.string(),
	created_at: Timestamp,
	created_by: Actor.nullable(),
	/** True for the version that drive.download_file returns by default. */
	current: z.boolean(),
});
export type FileVersion = z.infer<typeof FileVersion>;

const READ = { readOnly: true, destructive: false, idempotent: true, openWorld: false } as const;
const CREATE = { readOnly: false, destructive: false, idempotent: false, openWorld: false } as const;
const CHANGE = { readOnly: false, destructive: false, idempotent: true, openWorld: false } as const;
const REMOVE = { readOnly: false, destructive: true, idempotent: true, openWorld: false } as const;

const ItemIds = z.array(ItemId).min(1).max(DRIVE_LIMITS.itemsPerCall);

const ChangeResult = z.object({
	/** The items that the call changed. An item that was already in the wanted state does not count. */
	items_changed: z.number().int(),
	dry_run: z.boolean(),
});

export const getAbout = defineOperation({
	name: "drive.get_about",
	summary: "Get the totals of your drive",
	description:
		"Returns the id of your drive, the bytes that it uses (each version of each file counts), its item totals, the limits, and a version number. The version grows with each change in your drive, so compare it to find out if anything changed.",
	http: { method: "GET", path: "/api/v1/drive/about" },
	scopes: ["drive.read"],
	callers: ["human", "agent"],
	annotations: READ,
	input: z.strictObject({}),
	output: z.object({
		space_id: z.string(),
		used_bytes: z.number().int(),
		items_total: z.number().int(),
		trash_total: z.number().int(),
		version: z.number().int(),
		limits: z.object({ file_bytes: z.number().int(), versions_per_file: z.number().int() }),
	}),
	errors: [],
});

export const listItems = defineOperation({
	name: "drive.list_items",
	summary: "List or search the items of a drive",
	description: [
		"Returns the items of one view. The default view is folder: the items of the folder parent_id, or of the root of the drive without parent_id.",
		"The other views are for your own drive and what others shared with you. starred: the items with your star. recent: your files, docs and sheets, by the time of the last change.",
		"shared: the items that others shared with you, newest first. trash: the items that you put in the trash. search: the items of your own drive whose name or text has each word of query.",
		"The folder view has folders first, then names in order. Set order to modified for the newest change first.",
		"Set kind to get one kind of item only. Pass next_cursor as cursor to get the next page.",
		`${IN_SPACE} Each item has its space_id and your role for it.`,
	].join(" "),
	http: { method: "GET", path: "/api/v1/drive/items" },
	scopes: ["drive.read"],
	callers: ["human", "agent"],
	annotations: READ,
	input: z
		.strictObject({
			space_id: SpaceParam,
			view: z.enum(["folder", "starred", "recent", "shared", "trash", "search"]).default("folder"),
			parent_id: ItemId.optional(),
			query: z.string().trim().min(1).max(DRIVE_LIMITS.queryChars).optional(),
			kind: z.enum(ITEM_KINDS).optional(),
			order: z.enum(["name", "modified"]).default("name"),
			cursor: z.string().max(600).optional(),
			limit: z.coerce.number().int().min(1).max(DRIVE_LIMITS.pageSize).optional(),
		})
		.refine((input) => (input.view === "search") === (input.query !== undefined), "set query with the search view only")
		.refine(
			(input) => input.view === "folder" || input.parent_id === undefined,
			"set parent_id with the folder view only",
		)
		.refine(
			(input) => input.view === "folder" || input.space_id === undefined,
			"set space_id with the folder view only: the other views are for your own drive",
		),
	output: z.object({
		items: z.array(DriveItem),
		next_cursor: z.string().nullable(),
	}),
	errors: ["not_found"],
});

export const getItem = defineOperation({
	name: "drive.get_item",
	summary: "Get one item and its path",
	description: `Returns the item and the folders from the root of the drive to it. For an item that somebody shared with you, the path starts at the highest folder that you can read. ${IN_SPACE}`,
	http: { method: "GET", path: "/api/v1/drive/items/{item_id}" },
	scopes: ["drive.read"],
	callers: ["human", "agent"],
	annotations: READ,
	input: z.strictObject({ space_id: SpaceParam, item_id: ItemId }),
	output: z.object({ item: DriveItem, path: z.array(PathEntry) }),
	errors: ["not_found"],
});

export const createFolder = defineOperation({
	name: "drive.create_folder",
	summary: "Create a folder",
	description: `Creates a folder in the folder parent_id, or at the root of the drive without parent_id. Two items in one folder can have the same name. In a folder of somebody else, you need the editor role, and the owner of that drive owns the new folder. ${IN_SPACE}`,
	http: { method: "POST", path: "/api/v1/drive/folders" },
	scopes: ["drive.write"],
	callers: ["human", "agent"],
	annotations: CREATE,
	input: z.strictObject({
		space_id: SpaceParam,
		parent_id: ItemId.optional(),
		name: ItemName,
		idempotency_key: IdempotencyKey,
	}),
	output: z.object({ item: DriveItem }),
	errors: ["not_found", "conflict"],
});

export const uploadFile = defineOperation({
	name: "drive.upload_file",
	summary: "Upload a file",
	description: [
		"Stores a new file in the folder parent_id, or at the root of the drive without parent_id. The content is base64, at most 10 MiB.",
		"To replace the content of a file that exists, use drive.upload_version.",
		"In a folder of somebody else, you need the editor role, and the owner of that drive owns the new file.",
		IN_SPACE,
	].join(" "),
	http: { method: "POST", path: "/api/v1/drive/files" },
	scopes: ["drive.write"],
	callers: ["human", "agent"],
	annotations: CREATE,
	input: z.strictObject({
		space_id: SpaceParam,
		parent_id: ItemId.optional(),
		name: ItemName,
		mime_type: MimeType.default("application/octet-stream"),
		content_base64: ContentBase64,
		idempotency_key: IdempotencyKey,
	}),
	output: z.object({ item: DriveItem }),
	errors: ["not_found", "payload_too_large", "conflict"],
});

export const uploadVersion = defineOperation({
	name: "drive.upload_version",
	summary: "Upload a new version of a file",
	description: `Replaces the content of a file. The file keeps its id, name and place. The old content stays as a version: see drive.list_versions. A file keeps at most ${DRIVE_LIMITS.versionsPerFile} versions, and the oldest is then deleted. You need the editor role. ${IN_SPACE}`,
	http: { method: "POST", path: "/api/v1/drive/items/{item_id}/versions" },
	scopes: ["drive.write"],
	callers: ["human", "agent"],
	annotations: CREATE,
	input: z.strictObject({
		space_id: SpaceParam,
		item_id: ItemId,
		mime_type: MimeType.optional(),
		content_base64: ContentBase64,
	}),
	output: z.object({ item: DriveItem, version: FileVersion }),
	errors: ["not_found", "payload_too_large", "invalid"],
});

export const downloadFile = defineOperation({
	name: "drive.download_file",
	summary: "Get the content of a file",
	description: `Returns the content of a file as base64, with its name and type. Set version_id to get an older version. A doc or a sheet has no file content: read it with docs.get or sheets.get. ${IN_SPACE}`,
	http: { method: "GET", path: "/api/v1/drive/items/{item_id}/content" },
	scopes: ["drive.read"],
	callers: ["human", "agent"],
	annotations: READ,
	input: z.strictObject({ space_id: SpaceParam, item_id: ItemId, version_id: VersionId.optional() }),
	output: z.object({
		name: z.string(),
		mime_type: z.string(),
		size: z.number().int(),
		version_id: z.string(),
		content_base64: z.string(),
	}),
	errors: ["not_found", "invalid"],
});

export const listVersions = defineOperation({
	name: "drive.list_versions",
	summary: "List the versions of a file",
	description: `Returns the stored versions of a file, newest first. Get the content of one with drive.download_file and version_id. ${IN_SPACE}`,
	http: { method: "GET", path: "/api/v1/drive/items/{item_id}/versions" },
	scopes: ["drive.read"],
	callers: ["human", "agent"],
	annotations: READ,
	input: z.strictObject({ space_id: SpaceParam, item_id: ItemId }),
	output: z.object({ versions: z.array(FileVersion) }),
	errors: ["not_found", "invalid"],
});

export const restoreVersion = defineOperation({
	name: "drive.restore_version",
	summary: "Make an older version of a file the current version",
	description: `The file then has the content of that version. No version is deleted, so you can go back. You need the editor role. ${IN_SPACE}`,
	http: { method: "POST", path: "/api/v1/drive/items/{item_id}/versions/{version_id}/restore" },
	scopes: ["drive.write"],
	callers: ["human", "agent"],
	annotations: CHANGE,
	input: z.strictObject({ space_id: SpaceParam, item_id: ItemId, version_id: VersionId }),
	output: z.object({ item: DriveItem, version: FileVersion }),
	errors: ["not_found", "invalid"],
});

export const renameItem = defineOperation({
	name: "drive.rename_item",
	summary: "Rename an item",
	description: `Gives a folder, a file, a doc or a sheet a new name. You need the editor role. ${IN_SPACE}`,
	http: { method: "POST", path: "/api/v1/drive/items/{item_id}/rename" },
	scopes: ["drive.write"],
	callers: ["human", "agent"],
	annotations: CHANGE,
	input: z.strictObject({ space_id: SpaceParam, item_id: ItemId, name: ItemName }),
	output: z.object({ item: DriveItem }),
	errors: ["not_found"],
});

export const moveItems = defineOperation({
	name: "drive.move_items",
	summary: "Move items to a different folder of your drive",
	description:
		"Moves items of your own drive into the folder parent_id, or to the root of the drive without parent_id. A folder moves with all that it holds. A folder cannot move into itself or into a folder under it. The call moves each item or no item.",
	http: { method: "POST", path: "/api/v1/drive/items/move" },
	scopes: ["drive.write"],
	callers: ["human", "agent"],
	annotations: CHANGE,
	input: z.strictObject({ item_ids: ItemIds, parent_id: ItemId.optional() }),
	output: z.object({ items: z.array(DriveItem) }),
	errors: ["not_found", "invalid"],
});

export const copyItem = defineOperation({
	name: "drive.copy_item",
	summary: "Make a copy of a file, a doc or a sheet in your drive",
	description: `Creates a new item in your own drive with the current content of the source. The copy goes into the folder parent_id of your drive, or to its root without parent_id. The default name is "Copy of" and the name of the source. A folder cannot be copied. You need the viewer role for the source. ${IN_SPACE}`,
	http: { method: "POST", path: "/api/v1/drive/items/{item_id}/copy" },
	scopes: ["drive.read", "drive.write"],
	callers: ["human", "agent"],
	annotations: CREATE,
	input: z.strictObject({
		space_id: SpaceParam,
		item_id: ItemId,
		parent_id: ItemId.optional(),
		name: ItemName.optional(),
		idempotency_key: IdempotencyKey,
	}),
	output: z.object({ item: DriveItem }),
	errors: ["not_found", "invalid", "conflict"],
});

export const starItems = defineOperation({
	name: "drive.star_items",
	summary: "Add or remove your star on items",
	description: `Sets or removes your own star. A star is yours only: nobody else sees it, and you can put one on an item that somebody shared with you. ${IN_SPACE}`,
	http: { method: "POST", path: "/api/v1/drive/items/star" },
	scopes: ["drive.write"],
	callers: ["human", "agent"],
	annotations: CHANGE,
	input: z.strictObject({ space_id: SpaceParam, item_ids: ItemIds, starred: z.boolean() }),
	output: z.object({ items_changed: z.number().int() }),
	errors: ["not_found"],
});

export const trashItems = defineOperation({
	name: "drive.trash_items",
	summary: "Move items of your drive to the trash",
	description:
		"Puts items of your own drive in the trash. A folder goes with all that it holds. The people that you shared an item with lose it until you restore it. Nothing is deleted: drive.restore_items brings an item back. Set dry_run to true to get the count without a change.",
	http: { method: "POST", path: "/api/v1/drive/items/trash" },
	scopes: ["drive.write"],
	callers: ["human", "agent"],
	annotations: REMOVE,
	input: z.strictObject({ item_ids: ItemIds, dry_run: z.boolean().default(false) }),
	output: ChangeResult,
	errors: ["not_found"],
});

export const restoreItems = defineOperation({
	name: "drive.restore_items",
	summary: "Restore items from the trash",
	description:
		"Takes items of your own drive out of the trash, back to their folder. When that folder is in the trash or does not exist, the item goes to the root of the drive.",
	http: { method: "POST", path: "/api/v1/drive/items/restore" },
	scopes: ["drive.write"],
	callers: ["human", "agent"],
	annotations: CHANGE,
	input: z.strictObject({ item_ids: ItemIds }),
	output: z.object({ items_changed: z.number().int() }),
	errors: ["not_found"],
});

export const deleteItems = defineOperation({
	name: "drive.delete_items",
	summary: "Delete items in the trash permanently",
	description:
		"Deletes items of your own drive that are in the trash, with all that a folder holds and each version of each file. This cannot be undone. An item that is not in the trash is refused: use drive.trash_items first. Set dry_run to true to get the count without a change.",
	http: { method: "POST", path: "/api/v1/drive/items/delete" },
	scopes: ["drive.write"],
	callers: ["human", "agent"],
	annotations: REMOVE,
	input: z.strictObject({ item_ids: ItemIds, dry_run: z.boolean().default(false) }),
	output: ChangeResult,
	errors: ["not_found", "invalid"],
});

export const emptyTrash = defineOperation({
	name: "drive.empty_trash",
	summary: "Delete all items in the trash permanently",
	description:
		"Deletes each item in the trash of your own drive. This cannot be undone. Set dry_run to true to get the count without a change.",
	http: { method: "POST", path: "/api/v1/drive/trash/empty" },
	scopes: ["drive.write"],
	callers: ["human", "agent"],
	annotations: REMOVE,
	input: z.strictObject({ dry_run: z.boolean().default(false) }),
	output: ChangeResult,
	errors: [],
});

export const listPermissions = defineOperation({
	name: "drive.list_permissions",
	summary: "List who can use an item",
	description: `Returns the owner of the item and each person or agent with access. A grant on a folder applies to all that the folder holds: such a grant has inherited: true. ${IN_SPACE}`,
	http: { method: "GET", path: "/api/v1/drive/items/{item_id}/permissions" },
	scopes: ["drive.read"],
	callers: ["human", "agent"],
	annotations: READ,
	input: z.strictObject({ space_id: SpaceParam, item_id: ItemId }),
	output: z.object({ owner_id: z.string(), permissions: z.array(Permission) }),
	errors: ["not_found"],
});

export const shareItem = defineOperation({
	name: "drive.share_item",
	summary: "Give a person or an agent access to an item of your drive",
	description: [
		"Gives a person or an agent of this organization the viewer or the editor role for an item of your own drive.",
		"A viewer can read and copy. An editor can also change the content and the name, and add items to a folder.",
		"A grant on a folder applies to all that the folder holds. A second call for the same principal changes the role.",
		"Only the owner of an item can share it. The item then shows in the shared view of that principal.",
	].join(" "),
	http: { method: "POST", path: "/api/v1/drive/items/{item_id}/permissions" },
	scopes: ["drive.share"],
	callers: ["human", "agent"],
	annotations: CHANGE,
	input: z.strictObject({
		item_id: ItemId,
		principal_id: PrincipalId,
		role: z.enum(["editor", "viewer"]),
	}),
	output: z.object({ permission: Permission }),
	errors: ["not_found", "invalid"],
});

export const unshareItem = defineOperation({
	name: "drive.unshare_item",
	summary: "Remove the access of a person or an agent to an item",
	description: `Removes a grant from the item. The owner can remove each grant. You can also remove your own grant from an item that somebody shared with you: set space_id and your own id as principal_id. A grant that comes from a folder above the item stays: remove it from that folder. ${IN_SPACE}`,
	http: { method: "DELETE", path: "/api/v1/drive/items/{item_id}/permissions/{principal_id}" },
	scopes: ["drive.share"],
	callers: ["human", "agent"],
	annotations: REMOVE,
	input: z.strictObject({ space_id: SpaceParam, item_id: ItemId, principal_id: PrincipalId }),
	output: z.object({ removed: z.boolean() }),
	errors: ["not_found"],
});

export const driveOperations = {
	"drive.get_about": getAbout,
	"drive.list_items": listItems,
	"drive.get_item": getItem,
	"drive.create_folder": createFolder,
	"drive.upload_file": uploadFile,
	"drive.upload_version": uploadVersion,
	"drive.download_file": downloadFile,
	"drive.list_versions": listVersions,
	"drive.restore_version": restoreVersion,
	"drive.rename_item": renameItem,
	"drive.move_items": moveItems,
	"drive.copy_item": copyItem,
	"drive.star_items": starItems,
	"drive.trash_items": trashItems,
	"drive.restore_items": restoreItems,
	"drive.delete_items": deleteItems,
	"drive.empty_trash": emptyTrash,
	"drive.list_permissions": listPermissions,
	"drive.share_item": shareItem,
	"drive.unshare_item": unshareItem,
} as const;
