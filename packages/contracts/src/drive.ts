import { prefixedId, RoomId, Timestamp } from "./common.ts";
import { defineOperation } from "./operation.ts";
import type { Scope } from "./scopes.ts";
import { DRIVE_WEBHOOK_EVENTS, DriveWebhookSubscription } from "./webhooks.ts";
import { z } from "./zod.ts";

export const DRIVE_LIMITS = {
	/** The bytes of the small picture of a file (`drive.set_preview`). */
	previewBytes: 256 * 1024,
	/** The pixels of each side of the small picture of a file. */
	previewSide: 640,
	/**
	 * The content of one JSON call: `drive.upload_file`, `drive.upload_version` and one answer of
	 * `drive.download_file`. The content is base64 in JSON, and a call holds several copies of it at
	 * once. A Worker isolate has 128 MB of memory, so this is the same limit as a composed mail message.
	 * A larger file uploads in parts (`drive.create_upload`).
	 */
	fileBytes: 10 * 1024 * 1024,
	/** One file that uploads in parts. */
	uploadBytes: 1024 * 1024 * 1024,
	/**
	 * One part of an upload. Each part has this size, and the last part has the bytes that are left.
	 * R2 needs parts of the same size, of 5 MiB or more. The base64 of a part fits in one JSON call.
	 */
	uploadPartBytes: 8 * 1024 * 1024,
	/** The time from the start of an upload to its end. After it, the upload and its parts go away. */
	uploadTtlMs: 24 * 60 * 60 * 1000,
	/** The uploads that one principal can have open in one drive at one time. */
	openUploads: 20,
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

/** The kinds of an item. `doc` and `sheet` are the native documents of Asterra. */
export const ITEM_KINDS = ["folder", "file", "doc", "sheet"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/**
 * What a principal can do with an item, from the most to the least. `owner` is for an item of a personal
 * drive. `manager` is for an item of a shared drive.
 */
export const DRIVE_ROLES = ["owner", "manager", "editor", "viewer"] as const;
export type DriveRole = (typeof DRIVE_ROLES)[number];

/** The roles of the members of a shared drive, from the most to the least. */
export const SHARED_DRIVE_ROLES = ["manager", "editor", "viewer"] as const;
export type SharedDriveRole = (typeof SHARED_DRIVE_ROLES)[number];

/**
 * The scopes that a member of a shared drive needs for its role. An agent or a service account gets them on
 * its account when a person who manages it makes it a member.
 */
export const SHARED_DRIVE_ROLE_SCOPES = {
	manager: ["drive.read", "drive.write", "drive.share"],
	editor: ["drive.read", "drive.write"],
	viewer: ["drive.read"],
} as const satisfies Record<SharedDriveRole, readonly Scope[]>;

export const SHARED_DRIVE_LIMITS = {
	/** The members of one shared drive. */
	members: 100,
	nameChars: 100,
	/** The items of one move between drives. Each item under a selected folder counts. */
	moveItems: 1000,
} as const;

export const ItemId = prefixedId("itm");
const VersionId = prefixedId("ver");
/** The id of an upload in parts. */
export const UploadId = prefixedId("upl");
const PrincipalId = prefixedId("prn");

/** The id of a shared drive. */
export const SharedDriveId = prefixedId("drv");

/** The id of a drive: the id of the principal that owns it (`prn_…`), or the id of a shared drive (`drv_…`). */
export const SpaceId = z
	.string()
	.regex(/^(prn|drv)_[0-9A-HJKMNP-TV-Z]{26}$/, "must be an id that starts with prn_ or drv_");

/** The input field that selects the drive of an operation. */
export const SpaceParam = SpaceId.optional().describe(
	"The drive that holds the item: the id of the person or agent that owns it, or the id of a shared drive. It is the space_id of the item, as drive.list_items returns it. The default is your own drive.",
);

/** One sentence for the description of each operation that takes `space_id`. */
export const IN_SPACE =
	"For an item that somebody shared with you, or an item of a shared drive, set space_id to the space_id of the item.";

/** The name of a shared drive. */
export const SharedDriveName = z
	.string()
	.trim()
	.min(1)
	.max(SHARED_DRIVE_LIMITS.nameChars)
	.refine((name) => !/\p{Cc}/u.test(name), "must not contain control characters");

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

export const ContentBase64 = z
	.string()
	// The base64 of the largest file, so a request cannot make the Worker decode more than that.
	.max(Math.ceil(DRIVE_LIMITS.fileBytes / 3) * 4, "must be at most 10 MiB")
	.regex(/^[A-Za-z0-9+/]*={0,2}$/, "must be base64");

/** The input field that puts a new file in the folder of a room of Chat. */
const ChatRoomParam = RoomId.optional().describe(
	"Puts the file in the folder Chat/<room name> of your own drive, for a message of that room. For a direct message, the folder has the name of the other person. The server makes the folders when they are not there. You must be a member of the room, and the credential needs chat.read too. Not with parent_id or space_id.",
);

/** One sentence for the description of each upload that takes `room_id`. */
const IN_ROOM =
	"For a file of a message of Chat, set room_id: the file goes into the folder Chat/<room name> of your own drive.";

/** A file goes into a folder of the call, or into the folder of a room: not both. */
function oneFolder(input: {
	room_id?: string | undefined;
	parent_id?: string | undefined;
	space_id?: string | undefined;
}) {
	return input.room_id === undefined || (input.parent_id === undefined && input.space_id === undefined);
}

const ONE_FOLDER = "set room_id without parent_id and space_id: the folder of a room is in your own drive";

/** The base64 of one part of an upload. */
const PartBase64 = z
	.string()
	.max(Math.ceil(DRIVE_LIMITS.uploadPartBytes / 3) * 4, "must be at most 8 MiB")
	.regex(/^[A-Za-z0-9+/]*={0,2}$/, "must be base64");

/** The number of parts of a file of `size` bytes. */
export function uploadPartCount(size: number): number {
	return Math.max(1, Math.ceil(size / DRIVE_LIMITS.uploadPartBytes));
}

/** The bytes of part `partNumber` (from 1) of a file of `size` bytes. */
export function uploadPartSize(size: number, partNumber: number): number {
	const start = (partNumber - 1) * DRIVE_LIMITS.uploadPartBytes;
	return Math.max(0, Math.min(DRIVE_LIMITS.uploadPartBytes, size - start));
}

/**
 * The path that takes the raw bytes of one part of an upload: `PUT`, with the bytes as the body. It is
 * the same as `drive.upload_part`, without base64.
 */
export function driveUploadPartPath(spaceId: string, uploadId: string, partNumber: number): string {
	return `/blob/drive/${encodeURIComponent(spaceId)}/uploads/${encodeURIComponent(uploadId)}/parts/${partNumber}`;
}

/**
 * The path that downloads a file: `GET`, with the session cookie or a bearer token. The answer is
 * always an attachment. Set `versionId` for an older version.
 */
export function driveDownloadPath(spaceId: string, itemId: string, versionId?: string): string {
	const path = `/dl/drive/${encodeURIComponent(spaceId)}/${encodeURIComponent(itemId)}`;
	return versionId === undefined ? path : `${path}?version_id=${encodeURIComponent(versionId)}`;
}

/** Which bytes a download returns: the content of the file, or its small picture. */
export const DownloadVariant = z
	.enum(["content", "preview"])
	.default("content")
	.describe(
		"content: the bytes of the file. preview: the small picture of a picture or a video, when it has one (see drive.set_preview).",
	);

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
	/** The drive that holds the item: the id of the person or agent that owns it, or the id of a shared drive. */
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
	/** What you can do with the item: `owner`, `manager`, `editor` or `viewer`. */
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

/**
 * A room of Chat whose members can read a file, because a message of the room holds the file. The room
 * adds the grant when a message gets the file, and removes it when no message of the room that stays
 * holds the file. A member that leaves the room loses the access at once.
 */
export const RoomGrant = z.object({
	room_id: z.string(),
	/** The author of the message that holds the file. */
	granted_by: Actor.nullable(),
	created_at: Timestamp,
});
export type RoomGrant = z.infer<typeof RoomGrant>;

/** A shared drive: a drive that its members own together. */
export const SharedDrive = z.object({
	id: z.string(),
	name: z.string(),
	/** Your role as a member. Null for an owner or an admin of the organization who is not a member. */
	role: z.enum(SHARED_DRIVE_ROLES).nullable(),
	member_count: z.number().int(),
	created_at: Timestamp,
});
export type SharedDrive = z.infer<typeof SharedDrive>;

export const SharedDriveMember = z.object({
	principal_id: z.string(),
	role: z.enum(SHARED_DRIVE_ROLES),
	added_by: Actor.nullable(),
	created_at: Timestamp,
});
export type SharedDriveMember = z.infer<typeof SharedDriveMember>;

/**
 * The small picture of a version of a picture or a video. The browser of the uploader made it, and the
 * server checked it: a PNG, JPEG or WebP picture of at most 640 pixels on each side, with the shape of the
 * picture. Get its bytes with drive.download_file and variant: preview.
 */
export const FilePreview = z.object({
	type: z.string(),
	width: z.number().int(),
	height: z.number().int(),
	size: z.number().int(),
	/** The pixels of the picture itself, when the server can read them from the file. Null for a video. */
	media_width: z.number().int().nullable(),
	media_height: z.number().int().nullable(),
});
export type FilePreview = z.infer<typeof FilePreview>;

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
	/**
	 * The type that the server found from the first bytes of the content, or null when it found no known
	 * type. A page shows a file inline only for a picture or a video of this type. A reader that gets no
	 * value takes null.
	 */
	detected_type: z.string().nullable().default(null),
	/** The small picture of a picture or a video, or null. A reader that gets no value takes null. */
	preview: FilePreview.nullable().default(null),
});
export type FileVersion = z.infer<typeof FileVersion>;

/** An upload in parts. It becomes a file when each part is there and `drive.complete_upload` runs. */
export const DriveUpload = z.object({
	id: z.string(),
	/** The drive that gets the file. */
	space_id: z.string(),
	/** The folder that gets the file. Null for the root of the drive. */
	parent_id: z.string().nullable(),
	name: z.string(),
	mime_type: z.string(),
	/** The bytes of the whole file. */
	size: z.number().int(),
	/** The bytes of each part. The last part has the bytes that are left. */
	part_size: z.number().int(),
	part_count: z.number().int(),
	/** The numbers of the parts that the server has, in order. Send the other parts. */
	parts_received: z.array(z.number().int()),
	/** `open` until `drive.complete_upload` makes the file, then `done`. */
	state: z.enum(["open", "done"]),
	/** The new file, when the state is `done`. */
	item_id: z.string().nullable(),
	created_at: Timestamp,
	/** After this time the upload and its parts go away. */
	expires_at: Timestamp,
});
export type DriveUpload = z.infer<typeof DriveUpload>;

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
	summary: "Get the totals of a drive",
	description:
		"Returns the id of your drive, the bytes that it uses (each version of each file counts), its item totals, the limits, and a version number. The version grows with each change in the drive, so compare it to find out if anything changed. Set space_id to the id of a shared drive that you are a member of to get its totals, its name and your role in it. The personal drive of a different person or agent is refused.",
	http: { method: "GET", path: "/api/v1/drive/about" },
	scopes: ["drive.read"],
	callers: ["human", "agent", "service"],
	annotations: READ,
	input: z.strictObject({ space_id: SpaceParam }),
	output: z.object({
		space_id: z.string(),
		kind: z.enum(["personal", "shared"]),
		/** The name of a shared drive. Null for a personal drive. */
		name: z.string().nullable(),
		/** Your role for the drive: `owner` for your own drive, your member role for a shared drive. */
		role: z.enum(DRIVE_ROLES),
		used_bytes: z.number().int(),
		items_total: z.number().int(),
		trash_total: z.number().int(),
		version: z.number().int(),
		limits: z.object({
			/** The content of one JSON call. */
			file_bytes: z.number().int(),
			/** One file that uploads in parts. */
			upload_bytes: z.number().int(),
			/** One part of an upload. */
			upload_part_bytes: z.number().int(),
			versions_per_file: z.number().int(),
		}),
	}),
	errors: ["not_found"],
});

export const listItems = defineOperation({
	name: "drive.list_items",
	summary: "List or search the items of a drive",
	description: [
		"Returns the items of one view. The default view is folder: the items of the folder parent_id, or of the root of the drive without parent_id.",
		"The other views are for your own drive and what others shared with you. starred: the items with your star. recent: your files, docs and sheets, by the time of the last change.",
		"shared: the items that others shared with you, newest first. trash: the items that you put in the trash. search: the items of your own drive whose name or text has each word of query.",
		"The folder, search and trash views also take the space_id of a shared drive that you are a member of. The trash view of a shared drive needs the editor role.",
		"The folder view has folders first, then names in order. Set order to modified for the newest change first.",
		"Set kind to get one kind of item only. Pass next_cursor as cursor to get the next page.",
		`${IN_SPACE} Each item has its space_id and your role for it.`,
	].join(" "),
	http: { method: "GET", path: "/api/v1/drive/items" },
	scopes: ["drive.read"],
	callers: ["human", "agent", "service"],
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
			(input) => ["folder", "search", "trash"].includes(input.view) || input.space_id === undefined,
			"set space_id with the folder, search and trash views only: the other views are for your own drive",
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
	callers: ["human", "agent", "service"],
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
	callers: ["human", "agent", "service"],
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
		"For a larger file, use drive.create_upload. To replace the content of a file that exists, use drive.upload_version.",
		"In a folder of somebody else, you need the editor role, and the owner of that drive owns the new file.",
		IN_ROOM,
		IN_SPACE,
	].join(" "),
	http: { method: "POST", path: "/api/v1/drive/files" },
	scopes: ["drive.write"],
	callers: ["human", "agent", "service"],
	annotations: CREATE,
	input: z
		.strictObject({
			space_id: SpaceParam,
			parent_id: ItemId.optional(),
			room_id: ChatRoomParam,
			name: ItemName,
			mime_type: MimeType.default("application/octet-stream"),
			content_base64: ContentBase64,
			idempotency_key: IdempotencyKey,
		})
		.refine(oneFolder, ONE_FOLDER),
	output: z.object({ item: DriveItem }),
	errors: ["not_found", "payload_too_large", "conflict"],
});

export const uploadVersion = defineOperation({
	name: "drive.upload_version",
	summary: "Upload a new version of a file",
	description: `Replaces the content of a file. The file keeps its id, name and place. The old content stays as a version: see drive.list_versions. A file keeps at most ${DRIVE_LIMITS.versionsPerFile} versions. An upload over that deletes the oldest version, but never the version that was current before the upload. You need the editor role. ${IN_SPACE}`,
	http: { method: "POST", path: "/api/v1/drive/items/{item_id}/versions" },
	scopes: ["drive.write"],
	callers: ["human", "agent", "service"],
	// At the limit of versions, the call deletes the oldest version.
	annotations: { readOnly: false, destructive: true, idempotent: false, openWorld: false },
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
	description: [
		"Returns the content of a file as base64, with its name and type. Set version_id to get an older version.",
		"One answer has at most 10 MiB. For a larger file, set offset and length to get one range of bytes at a time, or GET /dl/drive/{space_id}/{item_id} with your bearer token to get all of it as a stream.",
		"A doc or a sheet has no file content: read it with docs.get or sheets.get.",
		IN_SPACE,
	].join(" "),
	http: { method: "GET", path: "/api/v1/drive/items/{item_id}/content" },
	scopes: ["drive.read"],
	callers: ["human", "agent", "service"],
	annotations: READ,
	input: z.strictObject({
		space_id: SpaceParam,
		item_id: ItemId,
		version_id: VersionId.optional(),
		offset: z.coerce
			.number()
			.int()
			.min(0)
			.optional()
			.describe("The first byte to return, from 0. Without it, the answer starts at the first byte."),
		length: z.coerce
			.number()
			.int()
			.min(1)
			.max(DRIVE_LIMITS.fileBytes)
			.optional()
			.describe(
				"The most bytes to return, at most 10 MiB. Without it, the answer has the bytes from offset to the end, and a file over 10 MiB needs it.",
			),
		variant: DownloadVariant,
	}),
	output: z.object({
		name: z.string(),
		/** The type that the client gave for the file, or the type of the small picture for variant: preview. */
		mime_type: z.string(),
		/** The bytes of the whole version. */
		size: z.number().int(),
		version_id: z.string(),
		/** The first byte of the content in this answer. */
		offset: z.number().int(),
		/** The bytes of the content in this answer. */
		length: z.number().int(),
		content_base64: z.string(),
	}),
	errors: ["not_found", "invalid", "payload_too_large"],
});

export const setPreview = defineOperation({
	name: "drive.set_preview",
	summary: "Store the small picture of a picture or a video",
	description: [
		"Stores a small picture that shows a picture or a video file, for lists and messages. Make it in the client: for example, draw the picture or one frame of the video on a canvas.",
		`The content is base64 of a PNG, JPEG or WebP picture of at most ${DRIVE_LIMITS.previewSide} pixels on each side and ${DRIVE_LIMITS.previewBytes / 1024} KiB.`,
		"The server checks it. The first bytes of the file must show a picture or a video. For a picture, the small picture must have the same shape.",
		"The preview is for the current version, or for version_id. A second call replaces it. You need the editor role.",
		IN_SPACE,
	].join(" "),
	http: { method: "POST", path: "/api/v1/drive/items/{item_id}/preview" },
	scopes: ["drive.write"],
	callers: ["human", "agent", "service"],
	annotations: CHANGE,
	input: z.strictObject({
		space_id: SpaceParam,
		item_id: ItemId,
		version_id: VersionId.optional(),
		content_base64: z
			.string()
			.max(Math.ceil(DRIVE_LIMITS.previewBytes / 3) * 4, "must be at most 256 KiB")
			.regex(/^[A-Za-z0-9+/]*={0,2}$/, "must be base64"),
	}),
	output: z.object({ version: FileVersion }),
	errors: ["not_found", "invalid", "payload_too_large"],
});

const PART_ROUTE =
	"Or PUT the raw bytes of the part to /blob/drive/{space_id}/uploads/{upload_id}/parts/{part_number}, with your bearer token or the session cookie. That path returns the same answer.";

export const createUpload = defineOperation({
	name: "drive.create_upload",
	summary: "Start the upload of a large file in parts",
	description: [
		`Starts an upload of a file of at most 1 GiB in parts of 8 MiB (the part_size of the answer). The last part has the bytes that are left.`,
		"Send each part with drive.upload_part, in any order. A part that fails can go again. Then call drive.complete_upload, which makes the file in the folder parent_id, or at the root of the drive without parent_id.",
		"Set sha256 to the SHA-256 of the whole file, so that drive.complete_upload checks it.",
		`An upload that does not complete in 24 hours goes away with its parts. You can have ${DRIVE_LIMITS.openUploads} open uploads in one drive.`,
		"In a folder of somebody else, you need the editor role, and the owner of that drive owns the new file.",
		IN_ROOM,
		IN_SPACE,
	].join(" "),
	http: { method: "POST", path: "/api/v1/drive/uploads" },
	scopes: ["drive.write"],
	callers: ["human", "agent", "service"],
	annotations: CREATE,
	input: z
		.strictObject({
			space_id: SpaceParam,
			parent_id: ItemId.optional(),
			room_id: ChatRoomParam,
			name: ItemName,
			mime_type: MimeType.default("application/octet-stream"),
			size: z.number().int().min(1).max(DRIVE_LIMITS.uploadBytes).describe("The bytes of the whole file."),
			sha256: z
				.string()
				.regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex characters")
				.optional()
				.describe("The SHA-256 of the whole file, as lowercase hex."),
			idempotency_key: IdempotencyKey.describe(
				"Makes a retry safe: a second call with the same key and the same input returns the first upload.",
			),
		})
		.refine(oneFolder, ONE_FOLDER),
	output: z.object({ upload: DriveUpload }),
	errors: ["not_found", "conflict"],
});

const UploadInput = { space_id: SpaceParam, upload_id: UploadId };

export const uploadPart = defineOperation({
	name: "drive.upload_part",
	summary: "Send one part of an upload",
	description: [
		"Stores one part of an upload that drive.create_upload started. Parts count from 1. Each part has part_size bytes, and the last part has the bytes that are left.",
		"Send a part again when it failed: the new bytes replace the old bytes of that part. Only the principal that started the upload can send its parts.",
		PART_ROUTE,
		IN_SPACE,
	].join(" "),
	http: { method: "POST", path: "/api/v1/drive/uploads/{upload_id}/parts" },
	scopes: ["drive.write"],
	callers: ["human", "agent", "service"],
	annotations: CHANGE,
	input: z.strictObject({
		...UploadInput,
		part_number: z
			.number()
			.int()
			.min(1)
			.max(Math.ceil(DRIVE_LIMITS.uploadBytes / DRIVE_LIMITS.uploadPartBytes)),
		content_base64: PartBase64,
	}),
	output: z.object({ upload: DriveUpload }),
	errors: ["not_found", "invalid"],
});

export const getUpload = defineOperation({
	name: "drive.get_upload",
	summary: "Get the state of an upload",
	description: `Returns an upload that you started, with the numbers of the parts that the server has. After a failure, send only the parts that are not in parts_received. ${IN_SPACE}`,
	http: { method: "GET", path: "/api/v1/drive/uploads/{upload_id}" },
	scopes: ["drive.write"],
	callers: ["human", "agent", "service"],
	annotations: READ,
	input: z.strictObject(UploadInput),
	output: z.object({ upload: DriveUpload }),
	errors: ["not_found"],
});

export const completeUpload = defineOperation({
	name: "drive.complete_upload",
	summary: "Make the file of an upload",
	description: [
		"Joins the parts of an upload into one file, and returns the new file. Each part must be there.",
		"When drive.create_upload had sha256, the call checks it, and a different hash gets conflict and removes the upload.",
		"A second call returns the same file.",
		IN_SPACE,
	].join(" "),
	http: { method: "POST", path: "/api/v1/drive/uploads/{upload_id}/complete" },
	scopes: ["drive.write"],
	callers: ["human", "agent", "service"],
	annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
	input: z.strictObject(UploadInput),
	output: z.object({ item: DriveItem }),
	errors: ["not_found", "invalid", "conflict"],
});

export const abortUpload = defineOperation({
	name: "drive.abort_upload",
	summary: "Stop an upload",
	description: `Stops an upload that you started, and removes its parts. A completed upload keeps its file. The answer is aborted: false when the upload is not there or is complete. ${IN_SPACE}`,
	http: { method: "DELETE", path: "/api/v1/drive/uploads/{upload_id}" },
	scopes: ["drive.write"],
	callers: ["human", "agent", "service"],
	annotations: REMOVE,
	input: z.strictObject(UploadInput),
	output: z.object({ aborted: z.boolean() }),
	errors: [],
});

export const listVersions = defineOperation({
	name: "drive.list_versions",
	summary: "List the versions of a file",
	description: `Returns the stored versions of a file, newest first. Get the content of one with drive.download_file and version_id. ${IN_SPACE}`,
	http: { method: "GET", path: "/api/v1/drive/items/{item_id}/versions" },
	scopes: ["drive.read"],
	callers: ["human", "agent", "service"],
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
	callers: ["human", "agent", "service"],
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
	callers: ["human", "agent", "service"],
	annotations: CHANGE,
	input: z.strictObject({ space_id: SpaceParam, item_id: ItemId, name: ItemName }),
	output: z.object({ item: DriveItem }),
	errors: ["not_found"],
});

export const moveItems = defineOperation({
	name: "drive.move_items",
	summary: "Move items to a different folder of the same drive",
	description:
		"Moves items of your own drive into the folder parent_id, or to the root of the drive without parent_id. A folder moves with all that it holds. A folder cannot move into itself or into a folder under it. The call moves each item or no item. Set space_id to the id of a shared drive to move items in that drive: you need the editor role there. To move items to a different drive, use drive.move_to_drive.",
	http: { method: "POST", path: "/api/v1/drive/items/move" },
	scopes: ["drive.write"],
	callers: ["human", "agent", "service"],
	annotations: CHANGE,
	input: z.strictObject({ space_id: SpaceParam, item_ids: ItemIds, parent_id: ItemId.optional() }),
	output: z.object({ items: z.array(DriveItem) }),
	errors: ["not_found", "invalid"],
});

export const copyItem = defineOperation({
	name: "drive.copy_item",
	summary: "Make a copy of a file, a doc or a sheet",
	description: `Creates a new item with the current content of the source. The copy goes into your own drive, or into the shared drive target_space_id, where you need the editor role. It goes into the folder parent_id of that drive, or to its root without parent_id. The default name is "Copy of" and the name of the source. A folder cannot be copied. You need the viewer role for the source. ${IN_SPACE}`,
	http: { method: "POST", path: "/api/v1/drive/items/{item_id}/copy" },
	scopes: ["drive.read", "drive.write"],
	callers: ["human", "agent", "service"],
	annotations: CREATE,
	input: z.strictObject({
		space_id: SpaceParam,
		item_id: ItemId,
		target_space_id: SpaceId.optional().describe(
			"The drive that gets the copy: your own drive by default, or a shared drive where you are an editor or a manager.",
		),
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
	callers: ["human", "agent", "service"],
	annotations: CHANGE,
	input: z.strictObject({ space_id: SpaceParam, item_ids: ItemIds, starred: z.boolean() }),
	output: z.object({ items_changed: z.number().int() }),
	errors: ["not_found"],
});

export const trashItems = defineOperation({
	name: "drive.trash_items",
	summary: "Move items of a drive to the trash",
	description:
		"Puts items of your own drive in the trash. A folder goes with all that it holds. The people that you shared an item with lose it until you restore it. Nothing is deleted: drive.restore_items brings an item back. Set dry_run to true to get the count without a change. Set space_id to the id of a shared drive to put items of that drive in its trash: you need the editor role there.",
	http: { method: "POST", path: "/api/v1/drive/items/trash" },
	scopes: ["drive.write"],
	callers: ["human", "agent", "service"],
	annotations: REMOVE,
	input: z.strictObject({ space_id: SpaceParam, item_ids: ItemIds, dry_run: z.boolean().default(false) }),
	output: ChangeResult,
	errors: ["not_found"],
});

export const restoreItems = defineOperation({
	name: "drive.restore_items",
	summary: "Restore items from the trash",
	description:
		"Takes items of your own drive out of the trash, back to their folder. When that folder is in the trash or does not exist, the item goes to the root of the drive. Set space_id to the id of a shared drive to restore items of that drive: you need the editor role there.",
	http: { method: "POST", path: "/api/v1/drive/items/restore" },
	scopes: ["drive.write"],
	callers: ["human", "agent", "service"],
	annotations: CHANGE,
	input: z.strictObject({ space_id: SpaceParam, item_ids: ItemIds }),
	output: z.object({ items_changed: z.number().int() }),
	errors: ["not_found"],
});

export const deleteItems = defineOperation({
	name: "drive.delete_items",
	summary: "Delete items in the trash permanently",
	description:
		"Deletes items of your own drive that are in the trash, with all that a folder holds and each version of each file. This cannot be undone. An item that is not in the trash is refused: use drive.trash_items first. Set dry_run to true to get the count without a change. Set space_id to the id of a shared drive to delete items of that drive: only a manager of the drive can do this.",
	http: { method: "POST", path: "/api/v1/drive/items/delete" },
	scopes: ["drive.write"],
	callers: ["human", "agent", "service"],
	annotations: REMOVE,
	input: z.strictObject({ space_id: SpaceParam, item_ids: ItemIds, dry_run: z.boolean().default(false) }),
	output: ChangeResult,
	errors: ["not_found", "invalid"],
});

export const emptyTrash = defineOperation({
	name: "drive.empty_trash",
	summary: "Delete all items in the trash permanently",
	description:
		"Deletes each item in the trash of your own drive. This cannot be undone. Set dry_run to true to get the count without a change. Set space_id to the id of a shared drive to empty the trash of that drive: only a manager of the drive can do this.",
	http: { method: "POST", path: "/api/v1/drive/trash/empty" },
	scopes: ["drive.write"],
	callers: ["human", "agent", "service"],
	annotations: REMOVE,
	input: z.strictObject({ space_id: SpaceParam, dry_run: z.boolean().default(false) }),
	output: ChangeResult,
	errors: ["not_found"],
});

export const listPermissions = defineOperation({
	name: "drive.list_permissions",
	summary: "List who can use an item",
	description: `Returns the owner of the item and each person or agent with a grant. A grant on a folder applies to all that the folder holds: such a grant has inherited: true. For an item of a shared drive, owner_id is the id of the drive, and the members of the drive are not in the list: get them with drive.get_shared_drive. For the owner, room_grants has each room of Chat whose members can read the file, because a message of the room holds it. ${IN_SPACE}`,
	http: { method: "GET", path: "/api/v1/drive/items/{item_id}/permissions" },
	scopes: ["drive.read"],
	callers: ["human", "agent", "service"],
	annotations: READ,
	input: z.strictObject({ space_id: SpaceParam, item_id: ItemId }),
	output: z.object({
		owner_id: z.string(),
		permissions: z.array(Permission),
		/**
		 * The rooms of Chat whose members can read the item, because a message of the room holds it. Only the
		 * owner of the drive, or a manager of a shared drive, gets this list. A reader that gets no value
		 * takes an empty list.
		 */
		room_grants: z.array(RoomGrant).default([]),
	}),
	errors: ["not_found"],
});

export const shareItem = defineOperation({
	name: "drive.share_item",
	summary: "Give a person or an agent access to an item",
	description: [
		"Gives a person or an agent of this organization the viewer or the editor role for an item of your own drive.",
		"A viewer can read and copy. An editor can also change the content and the name, and add items to a folder.",
		"A grant on a folder applies to all that the folder holds. A second call for the same principal changes the role.",
		"Only the owner of an item can share it. The item then shows in the shared view of that principal.",
		"Set space_id to the id of a shared drive to share an item of that drive with a principal that is not a member: only a manager of the drive can do this.",
	].join(" "),
	http: { method: "POST", path: "/api/v1/drive/items/{item_id}/permissions" },
	scopes: ["drive.share"],
	callers: ["human", "agent", "service"],
	annotations: CHANGE,
	input: z.strictObject({
		space_id: SpaceParam,
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
	description: `Removes a grant from the item. The owner can remove each grant. In a shared drive, a manager can remove each grant. You can also remove your own grant from an item that somebody shared with you: set space_id and your own id as principal_id. A grant that comes from a folder above the item stays: remove it from that folder. ${IN_SPACE}`,
	http: { method: "DELETE", path: "/api/v1/drive/items/{item_id}/permissions/{principal_id}" },
	scopes: ["drive.share"],
	callers: ["human", "agent", "service"],
	annotations: REMOVE,
	input: z.strictObject({ space_id: SpaceParam, item_id: ItemId, principal_id: PrincipalId }),
	output: z.object({ removed: z.boolean() }),
	errors: ["not_found"],
});

const MemberInput = z.strictObject({ principal_id: PrincipalId, role: z.enum(SHARED_DRIVE_ROLES) });

const SHARED_ROLES =
	"A viewer can read, download and copy. An editor can also add and change items, move them in the drive, put them in the trash and restore them. A manager can also change the members, rename the drive, share an item with a principal that is not a member, delete permanently and move items out of the drive. A manager is a person: an agent can be an editor or a viewer.";

/** What a membership gives to an agent or a service account. */
const AGENT_MEMBER =
	"The role alone decides what an agent or a service account can do in the drive. Its account and its API keys do not change. It can use the drive at once with each of its keys, and it loses the drive at once when it stops being a member.";

export const createSharedDrive = defineOperation({
	name: "drive.create_shared_drive",
	summary: "Create a shared drive",
	description: [
		"Only owners and admins of the organization can call this.",
		"Creates a drive that its members own together. The drive owns its items: they stay when a member leaves.",
		"members must have at least one person with the manager role. You are a member only when members names you.",
		SHARED_ROLES,
		AGENT_MEMBER,
	].join(" "),
	http: { method: "POST", path: "/api/v1/drive/shared-drives" },
	scopes: ["drive.write"],
	callers: ["human"],
	annotations: CREATE,
	input: z.strictObject({
		name: SharedDriveName,
		members: z.array(MemberInput).min(1).max(SHARED_DRIVE_LIMITS.members),
		idempotency_key: z
			.string()
			.min(1)
			.max(255)
			.optional()
			.describe(
				"Makes a retry safe: a second call with the same key and the same input returns the first shared drive and creates nothing.",
			),
	}),
	output: z.object({ shared_drive: SharedDrive, members: z.array(SharedDriveMember) }),
	errors: ["not_found", "conflict"],
});

export const listSharedDrives = defineOperation({
	name: "drive.list_shared_drives",
	summary: "List the shared drives that you are a member of",
	description: [
		"Returns the shared drives that you are a member of, with your role, in the order of their names.",
		"Use the id of a shared drive as space_id in the drive, docs and sheets operations.",
		'An owner or an admin of the organization can set all to "true" to get each shared drive. The role is null where you are not a member.',
		"Pass next_cursor as cursor to get the next page.",
	].join(" "),
	http: { method: "GET", path: "/api/v1/drive/shared-drives" },
	scopes: ["drive.read"],
	callers: ["human", "agent", "service"],
	annotations: READ,
	input: z.strictObject({
		// A GET input comes from the query string, so the flag is text.
		all: z.enum(["true", "false"]).default("false"),
		cursor: z.string().max(600).optional(),
		limit: z.coerce.number().int().min(1).max(DRIVE_LIMITS.pageSize).optional(),
	}),
	output: z.object({ shared_drives: z.array(SharedDrive), next_cursor: z.string().nullable() }),
	errors: [],
});

export const getSharedDrive = defineOperation({
	name: "drive.get_shared_drive",
	summary: "Get a shared drive and its members",
	description:
		"Returns the shared drive and each member with its role. The members of the drive, and the owners and admins of the organization, can call this.",
	http: { method: "GET", path: "/api/v1/drive/shared-drives/{drive_id}" },
	scopes: ["drive.read"],
	callers: ["human", "agent", "service"],
	annotations: READ,
	input: z.strictObject({ drive_id: SharedDriveId }),
	output: z.object({ shared_drive: SharedDrive, members: z.array(SharedDriveMember) }),
	errors: ["not_found"],
});

export const updateSharedDrive = defineOperation({
	name: "drive.update_shared_drive",
	summary: "Rename a shared drive",
	description:
		"Gives the shared drive a new name. The managers of the drive, and the owners and admins of the organization, can call this. The id, the items and the members do not change.",
	http: { method: "POST", path: "/api/v1/drive/shared-drives/{drive_id}" },
	scopes: ["drive.write"],
	callers: ["human"],
	annotations: CHANGE,
	input: z.strictObject({ drive_id: SharedDriveId, name: SharedDriveName }),
	output: z.object({ shared_drive: SharedDrive }),
	errors: ["not_found"],
});

export const addSharedDriveMembers = defineOperation({
	name: "drive.add_shared_drive_members",
	summary: "Add members to a shared drive, or change their roles",
	description: [
		"Gives each principal of members a role in the shared drive. A principal that is a member gets the new role.",
		"The managers of the drive, and the owners and admins of the organization, can call this.",
		SHARED_ROLES,
		`A drive always keeps one manager, and has at most ${SHARED_DRIVE_LIMITS.members} members. The call makes each change or no change.`,
		AGENT_MEMBER,
	].join(" "),
	http: { method: "POST", path: "/api/v1/drive/shared-drives/{drive_id}/members" },
	scopes: ["drive.share"],
	callers: ["human"],
	annotations: CHANGE,
	input: z.strictObject({
		drive_id: SharedDriveId,
		members: z.array(MemberInput).min(1).max(SHARED_DRIVE_LIMITS.members),
	}),
	output: z.object({ shared_drive: SharedDrive, members: z.array(SharedDriveMember) }),
	errors: ["not_found", "conflict"],
});

export const removeSharedDriveMember = defineOperation({
	name: "drive.remove_shared_drive_member",
	summary: "Remove a member from a shared drive",
	description:
		"The access of the member to the drive ends at once. A grant that a manager gave that principal for one item stays: remove it with drive.unshare_item. The managers of the drive, and the owners and admins of the organization, can call this. You can also remove yourself. The last manager cannot be removed: add a different manager first.",
	http: { method: "DELETE", path: "/api/v1/drive/shared-drives/{drive_id}/members/{principal_id}" },
	scopes: ["drive.share"],
	callers: ["human"],
	annotations: REMOVE,
	input: z.strictObject({ drive_id: SharedDriveId, principal_id: PrincipalId }),
	output: z.object({ removed: z.boolean() }),
	errors: ["not_found"],
});

export const deleteSharedDrive = defineOperation({
	name: "drive.delete_shared_drive",
	summary: "Delete an empty shared drive",
	description:
		"Only owners and admins of the organization can call this. Deletes a shared drive that holds no item. A drive with an item, also an item in its trash, is refused: move or delete the items first. This cannot be undone. A second call returns deleted: false.",
	http: { method: "DELETE", path: "/api/v1/drive/shared-drives/{drive_id}" },
	scopes: ["drive.write"],
	callers: ["human"],
	annotations: REMOVE,
	input: z.strictObject({ drive_id: SharedDriveId }),
	output: z.object({ deleted: z.boolean() }),
	errors: ["not_found"],
});

export const moveToDrive = defineOperation({
	name: "drive.move_to_drive",
	summary: "Move items to a different drive",
	description: [
		"Moves items from one drive to a different drive: from your own drive to a shared drive, from a shared drive to your own drive, or from one shared drive to a different one.",
		"A folder moves with all that it holds. The target drive then owns the items, and its members get access. The direct shares of the items stay. The ids of the items do not change: use them with the new space_id.",
		"The source is your own drive by default. To move items out of a shared drive, set space_id to its id: only a manager of that drive can do this.",
		"The target is your own drive, or a shared drive where you are an editor or a manager. A move to the drive of a different person is not possible.",
		"The items go into the folder parent_id of the target, or to its root without parent_id.",
		`One call moves at most ${SHARED_DRIVE_LIMITS.moveItems} items, with the items under each folder. An item in the trash is refused.`,
		"Set dry_run to true to get the totals and the principals that keep a direct share, without a change.",
		'The status is "done" when the move is complete. It is "moving" when the move continues after the answer: the items then show in the target a moment later. A second call with the same input is safe.',
	].join(" "),
	http: { method: "POST", path: "/api/v1/drive/items/move-to-drive" },
	scopes: ["drive.write"],
	callers: ["human", "agent", "service"],
	// The members of a source shared drive lose their access to the items.
	annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
	input: z.strictObject({
		space_id: SpaceParam,
		item_ids: ItemIds,
		target_space_id: SpaceId.describe(
			"The drive that gets the items: your own id, or the id of a shared drive. It must not be the source drive.",
		),
		parent_id: ItemId.optional(),
		dry_run: z.boolean().default(false),
	}),
	output: z.object({
		status: z.enum(["done", "moving", "dry_run"]),
		/** Each item of the move: the selected items and all that they hold. */
		items_total: z.number().int(),
		/** The bytes of each version of each file, and of each doc and sheet, of the move. */
		bytes: z.number().int(),
		/** The principals that keep a direct share of a moved item. */
		kept_shares: z.array(z.string()),
		/** The selected items, as they are in the target. Empty unless the status is `done`. */
		items: z.array(DriveItem),
	}),
	errors: ["not_found", "invalid", "conflict"],
});

const createDriveWebhookSubscription = defineOperation({
	name: "drive.create_webhook_subscription",
	summary: "Send drive events to an endpoint",
	description: [
		"Adds a subscription for your drive, a shared drive that you belong to, or the drive of an agent that you sponsor.",
		"Choose the event. A doc change and a sheet change use drive.item.updated.",
		"The POST has no file content. Read the item with your own credential.",
		"The endpoint must be yours and active.",
	].join(" "),
	http: { method: "POST", path: "/api/v1/drive/webhook-subscriptions" },
	scopes: ["drive.webhooks"],
	callers: ["human", "agent"],
	annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: true },
	input: z.strictObject({
		endpoint_id: prefixedId("whe"),
		event: z.enum(DRIVE_WEBHOOK_EVENTS),
		space_id: SpaceParam,
	}),
	output: z.object({ subscription: DriveWebhookSubscription }),
	errors: ["not_found", "policy_denied", "conflict", "forbidden"],
});

const listDriveWebhookSubscriptions = defineOperation({
	name: "drive.list_webhook_subscriptions",
	summary: "List drive webhook subscriptions",
	description:
		"Lists your drive subscriptions. With space_id, a sponsor, an owner or an admin can list the subscriptions of that agent's drive. A member sees only their own subscriptions of a shared drive.",
	http: { method: "GET", path: "/api/v1/drive/webhook-subscriptions" },
	scopes: ["drive.webhooks"],
	callers: ["human", "agent"],
	annotations: READ,
	input: z.strictObject({ space_id: SpaceParam }),
	output: z.object({ subscriptions: z.array(DriveWebhookSubscription) }),
	errors: ["not_found"],
});

const deleteDriveWebhookSubscription = defineOperation({
	name: "drive.delete_webhook_subscription",
	summary: "Delete a drive webhook subscription",
	description:
		"Deletes a subscription. The endpoint stays. Its creator can delete it. A manager of a shared drive, or the sponsor of an agent, can delete a subscription for that target.",
	http: { method: "DELETE", path: "/api/v1/drive/webhook-subscriptions/{subscription_id}" },
	scopes: ["drive.webhooks"],
	callers: ["human", "agent"],
	annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
	input: z.strictObject({ subscription_id: prefixedId("whk") }),
	output: z.object({ deleted: z.boolean() }),
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
	"drive.set_preview": setPreview,
	"drive.create_upload": createUpload,
	"drive.upload_part": uploadPart,
	"drive.get_upload": getUpload,
	"drive.complete_upload": completeUpload,
	"drive.abort_upload": abortUpload,
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
	"drive.create_shared_drive": createSharedDrive,
	"drive.list_shared_drives": listSharedDrives,
	"drive.get_shared_drive": getSharedDrive,
	"drive.update_shared_drive": updateSharedDrive,
	"drive.add_shared_drive_members": addSharedDriveMembers,
	"drive.remove_shared_drive_member": removeSharedDriveMember,
	"drive.delete_shared_drive": deleteSharedDrive,
	"drive.move_to_drive": moveToDrive,
	"drive.create_webhook_subscription": createDriveWebhookSubscription,
	"drive.list_webhook_subscriptions": listDriveWebhookSubscriptions,
	"drive.delete_webhook_subscription": deleteDriveWebhookSubscription,
} as const;
