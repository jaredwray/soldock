import { DRIVE_LIMITS, type OperationName } from "@soldock/contracts";
import { type CallContext, unknownPrincipalIds } from "../identity/index.ts";
import { base64ToBytes, bytesToBase64, type HandlerMap, newId, OperationError, sha256Hex } from "../platform/index.ts";
import {
	accept,
	auditOk,
	blobKeyFor,
	idempotencyOf,
	type OpenSpace,
	openSpace,
	readDocument,
	spaceStub,
	toItem,
	toItems,
	toOneItem,
	writeDocument,
} from "./access.ts";
import type { ItemRecord, ItemRef, VersionRecord } from "./space.ts";

type DriveOperation = Extract<OperationName, `drive.${string}`>;

const DEFAULT_PAGE = 50;

/** R2 holds the bytes of a file with a neutral type. Nothing serves them from R2 to a browser. */
const STORED_TYPE = { httpMetadata: { contentType: "application/octet-stream" } };

function toVersion(version: VersionRecord) {
	return { ...version, created_at: new Date(version.created_at).toISOString() };
}

function decode(content: string): Uint8Array {
	try {
		return base64ToBytes(content);
	} catch {
		throw new OperationError("invalid", "content_base64 is not valid base64.");
	}
}

/**
 * The items of a list of pointers, in the order of the pointers. Each drive checks the access of the
 * caller again, so a pointer to an item that the caller cannot read now gives no item.
 */
async function hydrate(call: CallContext, refs: ItemRef[]): Promise<ItemRecord[]> {
	const bySpace = new Map<string, string[]>();
	for (const ref of refs) bySpace.set(ref.spaceId, [...(bySpace.get(ref.spaceId) ?? []), ref.itemId]);
	const actor = (await openSpace(call, undefined)).ctx.actor;
	const found = new Map<string, ItemRecord>();
	await Promise.all(
		[...bySpace].map(async ([spaceId, itemIds]) => {
			const records = await spaceStub(call.env, spaceId).getItems({ spaceId, actor }, itemIds, {
				includeTrashed: false,
			});
			for (const record of records) found.set(`${spaceId}/${record.id}`, record);
		}),
	);
	return refs.flatMap((ref) => found.get(`${ref.spaceId}/${ref.itemId}`) ?? []);
}

/** Copies the bytes of one version to a new R2 object, for a new item. */
async function copyBlob(call: CallContext, from: string, to: string): Promise<void> {
	const object = await call.env.BLOBS.get(from);
	if (!object) throw new Error("the file content is missing from R2");
	await call.env.BLOBS.put(to, object.body, STORED_TYPE);
}

/**
 * Writes the content of a doc or a sheet into its copy, when the copy has no content yet. A copy with
 * content stays as it is, so a second call never replaces what a person wrote in the copy.
 */
async function fillCopy(call: CallContext, own: OpenSpace, sourceId: string, copyId: string): Promise<void> {
	if ((await readDocument(call, copyId)) !== null) return;
	const state = await readDocument(call, sourceId);
	if (state) await writeDocument(call, own, copyId, { content: state.content, text: state.text, baseRevision: 0 });
}

/** The default name of a copy, at most as long as a name can be. The cut is never in the middle of a character. */
function copyName(name: string): string {
	const characters = [...`Copy of ${name}`];
	while (characters.join("").length > DRIVE_LIMITS.nameChars) characters.pop();
	return characters.join("").trimEnd();
}

/** The own drive of the caller. */
async function ownSpace(call: CallContext): Promise<OpenSpace> {
	return openSpace(call, undefined);
}

export const driveHandlers: Pick<HandlerMap<CallContext>, DriveOperation> = {
	async "drive.get_about"(call) {
		const own = await ownSpace(call);
		const about = accept(await own.space.about(own.ctx));
		return {
			space_id: own.spaceId,
			...about,
			limits: { file_bytes: DRIVE_LIMITS.fileBytes, versions_per_file: DRIVE_LIMITS.versionsPerFile },
		};
	},

	async "drive.list_items"(call, input) {
		const limit = input.limit ?? DEFAULT_PAGE;
		const cursor = input.cursor ?? null;
		const kind = input.kind ?? null;
		if (input.view === "folder") {
			const opened = await openSpace(call, input.space_id);
			const page = accept(
				await opened.space.listFolder(opened.ctx, {
					parentId: input.parent_id ?? null,
					kind,
					order: input.order,
					cursor,
					limit,
				}),
			);
			return { items: await toItems(call, page.items), next_cursor: page.nextCursor };
		}
		const own = await ownSpace(call);
		if (input.view === "starred" || input.view === "shared") {
			const page = accept(await own.space.listRefs(own.ctx, { list: input.view, cursor, limit }));
			const records = (await hydrate(call, page.items)).filter((record) => kind === null || record.kind === kind);
			return { items: await toItems(call, records), next_cursor: page.nextCursor };
		}
		const page = accept(
			await own.space.listView(own.ctx, { view: input.view, query: input.query ?? null, kind, cursor, limit }),
		);
		return { items: page.items.map(toItem), next_cursor: page.nextCursor };
	},

	async "drive.get_item"(call, input) {
		const opened = await openSpace(call, input.space_id);
		const found = accept(await opened.space.getItem(opened.ctx, input.item_id));
		return { item: await toOneItem(call, found.item), path: found.path };
	},

	async "drive.create_folder"(call, input) {
		const opened = await openSpace(call, input.space_id);
		const created = accept(
			await opened.space.createItem(opened.ctx, {
				id: newId("itm"),
				parentId: input.parent_id ?? null,
				kind: "folder",
				name: input.name,
				idempotency: await idempotencyOf(call, "drive.create_folder", input),
			}),
		);
		if (!created.duplicate) auditOk(call, opened, "drive.create_folder", created.item.id);
		return { item: await toOneItem(call, created.item) };
	},

	async "drive.upload_file"(call, input) {
		const opened = await openSpace(call, input.space_id);
		const idempotency = await idempotencyOf(call, "drive.upload_file", input);
		if (idempotency) {
			const earlier = await opened.space.idempotentResult(opened.ctx, idempotency.key, idempotency.requestHash);
			if (earlier !== null) return { item: await toOneItem(call, accept(earlier)) };
		}
		// Refuse before the bytes go to R2, so a caller without access stores nothing.
		accept(await opened.space.checkCreate(opened.ctx, input.parent_id ?? null));
		const bytes = decode(input.content_base64);
		const itemId = newId("itm");
		const versionId = newId("ver");
		const blobKey = blobKeyFor(opened.spaceId, itemId, versionId);
		await call.env.BLOBS.put(blobKey, bytes, STORED_TYPE);
		// The object belongs to this attempt only. When the drive refuses, or answers that the key was
		// used, no version references the object, so delete it. After an error the drive can still have
		// committed, so the object stays: a version without its bytes would lose the file.
		const answer = await opened.space.createItem(opened.ctx, {
			id: itemId,
			parentId: input.parent_id ?? null,
			kind: "file",
			name: input.name,
			version: {
				id: versionId,
				blobKey,
				size: bytes.byteLength,
				sha256: await sha256Hex(bytes),
				mimeType: input.mime_type,
			},
			idempotency,
		});
		if ("error" in answer || answer.duplicate) await call.env.BLOBS.delete(blobKey);
		const created = accept(answer);
		if (!created.duplicate) auditOk(call, opened, "drive.upload_file", created.item.id);
		return { item: await toOneItem(call, created.item) };
	},

	async "drive.upload_version"(call, input) {
		const opened = await openSpace(call, input.space_id);
		accept(await opened.space.checkItem(opened.ctx, input.item_id, "editor", ["file"]));
		const bytes = decode(input.content_base64);
		const versionId = newId("ver");
		const blobKey = blobKeyFor(opened.spaceId, input.item_id, versionId);
		await call.env.BLOBS.put(blobKey, bytes, STORED_TYPE);
		const answer = await opened.space.addVersion(opened.ctx, input.item_id, {
			id: versionId,
			blobKey,
			size: bytes.byteLength,
			sha256: await sha256Hex(bytes),
			mimeType: input.mime_type ?? null,
		});
		// No version references the object of a refused attempt.
		if ("error" in answer) await call.env.BLOBS.delete(blobKey);
		const added = accept(answer);
		auditOk(call, opened, "drive.upload_version", input.item_id);
		return { item: await toOneItem(call, added.item), version: toVersion(added.version) };
	},

	async "drive.download_file"(call, input) {
		const opened = await openSpace(call, input.space_id);
		const found = accept(await opened.space.fileContent(opened.ctx, input.item_id, input.version_id ?? null));
		const object = await call.env.BLOBS.get(found.blobKey);
		if (!object) throw new Error("the file content is missing from R2");
		return {
			name: found.name,
			mime_type: found.version.mime_type,
			size: found.version.size,
			version_id: found.version.id,
			content_base64: bytesToBase64(new Uint8Array(await object.arrayBuffer())),
		};
	},

	async "drive.list_versions"(call, input) {
		const opened = await openSpace(call, input.space_id);
		return { versions: accept(await opened.space.versions(opened.ctx, input.item_id)).map(toVersion) };
	},

	async "drive.restore_version"(call, input) {
		const opened = await openSpace(call, input.space_id);
		const restored = accept(await opened.space.restoreVersion(opened.ctx, input.item_id, input.version_id));
		auditOk(call, opened, "drive.restore_version", input.item_id);
		return { item: await toOneItem(call, restored.item), version: toVersion(restored.version) };
	},

	async "drive.rename_item"(call, input) {
		const opened = await openSpace(call, input.space_id);
		const item = accept(await opened.space.rename(opened.ctx, input.item_id, input.name));
		auditOk(call, opened, "drive.rename_item", input.item_id);
		return { item: await toOneItem(call, item) };
	},

	async "drive.move_items"(call, input) {
		const own = await ownSpace(call);
		const items = accept(await own.space.move(own.ctx, input.item_ids, input.parent_id ?? null));
		auditOk(call, own, "drive.move_items", input.item_ids.join(","));
		return { items: items.map(toItem) };
	},

	async "drive.copy_item"(call, input) {
		const source = await openSpace(call, input.space_id);
		const own = await ownSpace(call);
		const idempotency = await idempotencyOf(call, "drive.copy_item", input);
		const original = accept(
			await source.space.checkItem(source.ctx, input.item_id, "viewer", ["file", "doc", "sheet"]),
		);
		if (idempotency) {
			const earlier = await own.space.idempotentResult(own.ctx, idempotency.key, idempotency.requestHash);
			if (earlier !== null) {
				const copy = accept(earlier);
				// The first call can stop after the item and before the content. The retry then writes the content.
				if (copy.kind !== "file") await fillCopy(call, own, input.item_id, copy.id);
				return { item: toItem(accept(await own.space.checkItem(own.ctx, copy.id, "viewer", [copy.kind]))) };
			}
		}
		accept(await own.space.checkCreate(own.ctx, input.parent_id ?? null));
		const name = input.name ?? copyName(original.name);
		const itemId = newId("itm");
		const parentId = input.parent_id ?? null;
		if (original.kind === "file") {
			const content = accept(await source.space.fileContent(source.ctx, input.item_id, null));
			const versionId = newId("ver");
			const blobKey = blobKeyFor(own.spaceId, itemId, versionId);
			await copyBlob(call, content.blobKey, blobKey);
			const answer = await own.space.createItem(own.ctx, {
				id: itemId,
				parentId,
				kind: "file",
				name,
				version: {
					id: versionId,
					blobKey,
					size: content.version.size,
					sha256: content.version.sha256,
					mimeType: content.version.mime_type,
				},
				idempotency,
			});
			if ("error" in answer || answer.duplicate) await call.env.BLOBS.delete(blobKey);
			const created = accept(answer);
			if (!created.duplicate) auditOk(call, own, "drive.copy_item", created.item.id);
			return { item: toItem(created.item) };
		}
		const created = accept(
			await own.space.createItem(own.ctx, { id: itemId, parentId, kind: original.kind, name, idempotency }),
		);
		await fillCopy(call, own, input.item_id, created.item.id);
		if (!created.duplicate) auditOk(call, own, "drive.copy_item", created.item.id);
		return {
			item: toItem(accept(await own.space.checkItem(own.ctx, created.item.id, "viewer", [original.kind]))),
		};
	},

	async "drive.star_items"(call, input) {
		const opened = await openSpace(call, input.space_id);
		const itemIds = [...new Set(input.item_ids)];
		// A new star needs an item that the caller can read. A star can always go away, also after the access ended.
		if (input.starred) {
			const found = await opened.space.getItems(opened.ctx, itemIds, { includeTrashed: opened.own });
			if (found.length !== itemIds.length) {
				throw new OperationError("not_found", "No item has one of these ids, or you have no access to it.");
			}
		}
		const own = await ownSpace(call);
		const refs = itemIds.map((itemId) => ({ spaceId: opened.spaceId, itemId }));
		const result = accept(await own.space.star(own.ctx, refs, input.starred));
		auditOk(call, opened, "drive.star_items", itemIds.join(","));
		return result;
	},

	async "drive.trash_items"(call, input) {
		const own = await ownSpace(call);
		const result = accept(await own.space.trash(own.ctx, input.item_ids, input.dry_run));
		if (!input.dry_run) auditOk(call, own, "drive.trash_items", input.item_ids.join(","));
		return { ...result, dry_run: input.dry_run };
	},

	async "drive.restore_items"(call, input) {
		const own = await ownSpace(call);
		const result = accept(await own.space.restore(own.ctx, input.item_ids));
		auditOk(call, own, "drive.restore_items", input.item_ids.join(","));
		return result;
	},

	async "drive.delete_items"(call, input) {
		const own = await ownSpace(call);
		const result = accept(await own.space.remove(own.ctx, input.item_ids, input.dry_run));
		if (!input.dry_run) auditOk(call, own, "drive.delete_items", input.item_ids.join(","));
		return { ...result, dry_run: input.dry_run };
	},

	async "drive.empty_trash"(call, input) {
		const own = await ownSpace(call);
		const result = accept(await own.space.emptyTrash(own.ctx, input.dry_run));
		if (!input.dry_run) auditOk(call, own, "drive.empty_trash", own.spaceId);
		return { ...result, dry_run: input.dry_run };
	},

	async "drive.list_permissions"(call, input) {
		const opened = await openSpace(call, input.space_id);
		const found = accept(await opened.space.permissions(opened.ctx, input.item_id));
		return {
			owner_id: found.owner_id,
			permissions: found.permissions.map((permission) => ({
				...permission,
				created_at: new Date(permission.created_at).toISOString(),
			})),
		};
	},

	async "drive.share_item"(call, input) {
		const own = await ownSpace(call);
		if ((await unknownPrincipalIds(call.env.DIRECTORY, [input.principal_id])).length > 0) {
			throw new OperationError("not_found", "No person or agent has the id in principal_id.");
		}
		const permission = accept(await own.space.share(own.ctx, input.item_id, input.principal_id, input.role));
		auditOk(call, own, "drive.share_item", `${input.item_id}:${input.principal_id}:${input.role}`);
		return { permission: { ...permission, created_at: new Date(permission.created_at).toISOString() } };
	},

	async "drive.unshare_item"(call, input) {
		const opened = await openSpace(call, input.space_id);
		const result = accept(await opened.space.unshare(opened.ctx, input.item_id, input.principal_id));
		if (result.removed) auditOk(call, opened, "drive.unshare_item", `${input.item_id}:${input.principal_id}`);
		return result;
	},
};
