import {
	DRIVE_LIMITS,
	driveDownloadPath,
	type OperationName,
	type SharedDrive,
	type SharedDriveMember,
} from "@asterra/contracts";
import { type AttachmentRecord, attachmentKey, documentStub } from "../collab/index.ts";
import {
	type CallContext,
	getPrincipals,
	isAdmin,
	recordServiceMemberships,
	unknownPrincipalIds,
} from "../identity/index.ts";
import {
	base64ToBytes,
	bytesToBase64,
	type HandlerMap,
	newId,
	OperationError,
	SNIFF_BYTES,
	sha256Hex,
	sniffType,
} from "../platform/index.ts";
import { loseDriveAccess } from "../webhooks/store.ts";
import {
	accept,
	actorOf,
	auditOk,
	blobKeyFor,
	idempotencyOf,
	type OpenSpace,
	openSpace,
	readDocument,
	STORED_TYPE,
	spaceOf,
	toItems,
	toOneItem,
	unknownSpaceIds,
	writeDocument,
} from "./access.ts";
import { setPreview, toVersion } from "./preview.ts";
import { chatFolderFor } from "./rooms.ts";
import { listSharedDriveRows, serviceMembersOfDrive, sharedDriveState } from "./shared-index.ts";
import { sharedDriveRolesOf } from "./shared-items.ts";
import {
	type ItemRecord,
	type ItemRef,
	isSharedDriveId,
	type MemberInput,
	memberRefusal,
	type SharedDriveRecord,
	type VersionRecord,
} from "./space.ts";
import { abortUpload, completeUpload, createUpload, getUpload, receivePart } from "./upload.ts";
import { driveWebhookHandlers } from "./webhooks.ts";

type DriveOperation = Extract<OperationName, `drive.${string}`>;

const DEFAULT_PAGE = 50;

function decode(content: string): Uint8Array {
	try {
		return base64ToBytes(content);
	} catch {
		throw new OperationError("invalid", "content_base64 is not valid base64.");
	}
}

/**
 * The bytes that a download of a version returns: its content, or its small picture. A version without a
 * small picture has no preview: `not_found`.
 */
export function contentOf(
	found: { blobKey: string; version: VersionRecord },
	variant: "content" | "preview",
): { key: string; size: number; mimeType: string } {
	if (variant === "content") {
		return { key: found.blobKey, size: found.version.size, mimeType: found.version.mime_type };
	}
	const { preview } = found.version;
	if (!preview) throw new OperationError("not_found", "The file has no preview. Set one with drive.set_preview.");
	return { key: preview.key, size: preview.size, mimeType: preview.type };
}

/**
 * The items of a list of pointers, in the order of the pointers. Each drive checks the access of the
 * caller again, so a pointer to an item that the caller cannot read now gives no item.
 */
async function hydrate(call: CallContext, refs: ItemRef[]): Promise<ItemRecord[]> {
	const bySpace = new Map<string, string[]>();
	for (const ref of refs) bySpace.set(ref.spaceId, [...(bySpace.get(ref.spaceId) ?? []), ref.itemId]);
	// The drive of a deleted principal, and a deleted shared drive, stay in storage, but openSpace refuses
	// them. Their items leave the lists too.
	for (const spaceId of await unknownSpaceIds(call.env.DIRECTORY, [...bySpace.keys()])) bySpace.delete(spaceId);
	const found = new Map<string, ItemRecord>();
	await Promise.all(
		[...bySpace].map(async ([spaceId, itemIds]) => {
			const opened = spaceOf(call, spaceId);
			const records = await opened.space.getItems(opened.ctx, itemIds, { includeTrashed: false });
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
 * Copies attachments of a document (the images of a doc) to its copy, with the same ids. An
 * attachment that the copy holds is not copied again, so a second call continues the work of the
 * first one.
 */
async function copyAttachments(call: CallContext, used: readonly AttachmentRecord[], copyId: string): Promise<void> {
	if (used.length === 0) return;
	const copy = documentStub(call.env, copyId);
	const held = new Set((await copy.attachments()).map((attachment) => attachment.id));
	for (const attachment of used) {
		if (held.has(attachment.id)) continue;
		const blobKey = attachmentKey(copyId, attachment.id);
		await copyBlob(call, attachment.blobKey, blobKey);
		const answer = await copy.addAttachment({
			id: attachment.id,
			blobKey,
			size: attachment.size,
			meta: attachment.meta,
			used: true,
			limit: used.length,
		});
		if ("error" in answer) throw new Error(`the copy refused an attachment: ${answer.error.message}`);
	}
}

/**
 * Writes the content of a doc or a sheet into its copy, when the copy has no content yet. A copy with
 * content stays as it is, so a second call never replaces what a person wrote in the copy.
 *
 * The content and the attachments that it uses come from the source in one call, so a change of the
 * source during the copy cannot give content that names an attachment which the copy does not get.
 * The attachments go first, because the content names them. The source keeps an attachment for 24
 * hours after its last use, so its bytes are there for the copy.
 */
async function fillCopy(call: CallContext, own: OpenSpace, sourceId: string, copyId: string): Promise<void> {
	if ((await readDocument(call, copyId)) !== null) return;
	const { state, attachments } = await documentStub(call.env, sourceId).snapshot();
	if (!state) return;
	await copyAttachments(
		call,
		attachments.filter((attachment) => attachment.unusedSince === null),
		copyId,
	);
	try {
		await writeDocument(call, own, copyId, { content: state.content, text: state.text, baseRevision: 0 });
	} catch (error) {
		// Two calls with one key can run at the same time. The other call then wrote the content first,
		// and this call has nothing more to do.
		const filled = error instanceof OperationError && error.code === "conflict";
		if (!filled || (await readDocument(call, copyId)) === null) throw error;
	}
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

/** A cursor of the list of shared drives: base64url of the UTF-8 bytes of JSON, with the name key and the id. */
function encodeDriveCursor(nameKey: string, id: string): string {
	const bytes = new TextEncoder().encode(JSON.stringify([nameKey, id]));
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

function decodeDriveCursor(cursor: string): [string, string] {
	try {
		const binary = atob(cursor.replaceAll("-", "+").replaceAll("_", "/"));
		const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
		const values: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
		if (Array.isArray(values) && values.length === 2 && values.every((value) => typeof value === "string")) {
			return values as [string, string];
		}
	} catch {
		// The text is not a cursor.
	}
	throw new OperationError("invalid", "The cursor is not valid. Use next_cursor from the last page of the same list.");
}

/**
 * A shared drive and its members for the output. The members that the directory deleted are left out,
 * and they do not count.
 */
async function toSharedDrive(
	call: CallContext,
	record: SharedDriveRecord,
): Promise<{ shared_drive: SharedDrive; members: SharedDriveMember[] }> {
	const gone = new Set(
		await unknownPrincipalIds(
			call.env.DIRECTORY,
			record.members.map((member) => member.principal_id),
		),
	);
	const members = record.members
		.filter((member) => !gone.has(member.principal_id))
		.map((member) => ({ ...member, created_at: new Date(member.created_at).toISOString() }));
	return {
		shared_drive: {
			id: record.id,
			name: record.name,
			role: record.role,
			member_count: members.length,
			created_at: new Date(record.created_at).toISOString(),
		},
		members,
	};
}

/** A member of an input: the principal and its role. */
type MemberRole = { principal_id: string; role: MemberInput["role"] };

/**
 * The members of an input, with the kind of each principal from the directory. The object of the drive
 * needs the kind, because an agent cannot be a manager. The call refuses a list that the rules do not allow,
 * before the write of the drive. `driveId` is undefined for the members of a new drive.
 */
async function memberInputs(
	call: CallContext,
	members: MemberRole[],
	driveId: string | undefined,
): Promise<MemberInput[]> {
	const ids = members.map((member) => member.principal_id);
	if ((await unknownPrincipalIds(call.env.DIRECTORY, ids)).length > 0) {
		throw new OperationError("not_found", "No person or agent has one of the ids in members.");
	}
	const principals = await getPrincipals(call.env.DIRECTORY, ids);
	const kinds = new Map(principals.map((principal) => [principal.id, principal.kind]));
	const inputs = members.map((member) => ({
		principalId: member.principal_id,
		kind: kinds.get(member.principal_id) ?? "agent",
		role: member.role,
	}));
	const bad = memberRefusal(inputs, driveId === undefined);
	if (bad) accept(bad);
	return inputs;
}

/**
 * The rows of the list that each drive confirms, for an agent or a service account without drive.read on its
 * account. Such an account could not read a shared drive before the memberships decided the access of agents,
 * and a drive that did not wake since then still has its membership from before in the index. Each drive
 * narrows that membership when it wakes (`narrowAgentAccess`), so the list asks each drive and shows its
 * answer. Each other caller gets the rows of the index as they are.
 */
async function confirmedDrives<T extends { id: string; role: string | null }>(
	call: CallContext,
	rows: readonly T[],
): Promise<T[]> {
	if (call.caller.principal.kind !== "agent" || call.caller.scopes.has("drive.read")) return [...rows];
	const roles = await sharedDriveRolesOf(
		call.env,
		actorOf(call),
		rows.map((row) => row.id),
	);
	return rows.flatMap((row) => {
		const role = roles.get(row.id);
		return role === undefined ? [] : [{ ...row, role }];
	});
}

export const driveHandlers: Pick<HandlerMap<CallContext>, DriveOperation> = {
	...driveWebhookHandlers,
	async "drive.get_about"(call, input) {
		const own = await openSpace(call, input.space_id);
		const about = accept(await own.space.about(own.ctx));
		return {
			space_id: own.spaceId,
			...about,
			limits: {
				file_bytes: DRIVE_LIMITS.fileBytes,
				upload_bytes: DRIVE_LIMITS.uploadBytes,
				upload_part_bytes: DRIVE_LIMITS.uploadPartBytes,
				versions_per_file: DRIVE_LIMITS.versionsPerFile,
			},
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
		if (input.view === "starred" || input.view === "shared") {
			const own = await ownSpace(call);
			const page = accept(await own.space.listRefs(own.ctx, { list: input.view, cursor, limit }));
			const records = (await hydrate(call, page.items)).filter((record) => kind === null || record.kind === kind);
			return { items: await toItems(call, records), next_cursor: page.nextCursor };
		}
		// The search and the trash are for the own drive, or for a shared drive. The recent view has no space_id.
		const opened = await openSpace(call, input.space_id);
		const page = accept(
			await opened.space.listView(opened.ctx, { view: input.view, query: input.query ?? null, kind, cursor, limit }),
		);
		return { items: await toItems(call, page.items), next_cursor: page.nextCursor };
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
		// A file of a message of Chat goes into Chat/<room name> of the own drive of the caller.
		const parentId = input.room_id === undefined ? (input.parent_id ?? null) : await chatFolderFor(call, input.room_id);
		// Refuse before the bytes go to R2, so a caller without access stores nothing.
		accept(await opened.space.checkCreate(opened.ctx, parentId));
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
			parentId,
			kind: "file",
			name: input.name,
			version: {
				id: versionId,
				blobKey,
				size: bytes.byteLength,
				sha256: await sha256Hex(bytes),
				mimeType: input.mime_type,
				detectedType: sniffType(bytes.subarray(0, SNIFF_BYTES)),
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
			detectedType: sniffType(bytes.subarray(0, SNIFF_BYTES)),
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
		const source = contentOf(found, input.variant);
		const size = source.size;
		const offset = input.offset ?? 0;
		if (offset > 0 && offset >= size) {
			throw new OperationError("invalid", `offset must be less than the size of the file (${size} bytes).`);
		}
		const rest = size - offset;
		if (input.length === undefined && rest > DRIVE_LIMITS.fileBytes) {
			throw new OperationError(
				"payload_too_large",
				`The file has ${size} bytes, and one answer has at most ${DRIVE_LIMITS.fileBytes}. Set offset and length to get one range at a time, or GET ${driveDownloadPath(opened.spaceId, input.item_id)} to get all of it.`,
			);
		}
		const length = Math.min(input.length ?? rest, rest);
		let bytes = new Uint8Array();
		if (length > 0) {
			const object = await call.env.BLOBS.get(source.key, { range: { offset, length } });
			if (!object) throw new Error("the file content is missing from R2");
			bytes = new Uint8Array(await object.arrayBuffer());
		}
		return {
			name: found.name,
			mime_type: source.mimeType,
			size,
			version_id: found.version.id,
			offset,
			length,
			content_base64: bytesToBase64(bytes),
		};
	},

	"drive.set_preview": setPreview,
	"drive.create_upload": createUpload,
	"drive.get_upload": getUpload,
	"drive.complete_upload": completeUpload,
	"drive.abort_upload": abortUpload,

	async "drive.upload_part"(call, input) {
		const body = decode(input.content_base64);
		return receivePart(call, {
			spaceId: input.space_id,
			uploadId: input.upload_id,
			partNumber: input.part_number,
			size: body.byteLength,
			body,
		});
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
		const own = await openSpace(call, input.space_id);
		const items = accept(await own.space.move(own.ctx, input.item_ids, input.parent_id ?? null));
		auditOk(call, own, "drive.move_items", input.item_ids.join(","));
		return { items: await toItems(call, items) };
	},

	async "drive.move_to_drive"(call, input) {
		const source = await openSpace(call, input.space_id);
		if (input.target_space_id === source.spaceId) {
			throw new OperationError(
				"invalid",
				"target_space_id is the drive that holds the items. Use drive.move_items to move items in one drive.",
			);
		}
		if (!isSharedDriveId(input.target_space_id) && input.target_space_id !== call.caller.id) {
			throw new OperationError(
				"invalid",
				"target_space_id must be your own drive or a shared drive. Items cannot move into the drive of a different person.",
			);
		}
		const target = await openSpace(call, input.target_space_id);
		const parentId = input.parent_id ?? null;
		// The target drive checks the caller here, and again when it gets the items.
		const place = accept(await target.space.checkImport(target.ctx, parentId));
		const moved = accept(
			await source.space.moveOut(source.ctx, {
				itemIds: input.item_ids,
				targetId: target.spaceId,
				parentId,
				targetDepth: place.depth,
				dryRun: input.dry_run,
				// The source drive writes the audit line when it starts the move. The alarm can complete the
				// move after this call stops, so a line from here could be lost.
				credential: call.caller.credential,
				requestId: call.requestId,
			}),
		);
		const items =
			moved.status === "done" ? await target.space.getItems(target.ctx, moved.topIds, { includeTrashed: false }) : [];
		return {
			status: moved.status,
			items_total: moved.itemsTotal,
			bytes: moved.bytes,
			kept_shares: moved.keptShares,
			items: await toItems(call, items),
		};
	},

	async "drive.copy_item"(call, input) {
		const source = await openSpace(call, input.space_id);
		// The drive that gets the copy: the own drive of the caller, or a shared drive.
		if (
			input.target_space_id !== undefined &&
			!isSharedDriveId(input.target_space_id) &&
			input.target_space_id !== call.caller.id
		) {
			throw new OperationError(
				"invalid",
				"target_space_id must be your own drive or a shared drive. A copy cannot go into the drive of a different person.",
			);
		}
		const own = await openSpace(call, input.target_space_id);
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
				return {
					item: await toOneItem(call, accept(await own.space.checkItem(own.ctx, copy.id, "viewer", [copy.kind]))),
				};
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
					detectedType: content.version.detected_type,
				},
				idempotency,
			});
			if ("error" in answer || answer.duplicate) await call.env.BLOBS.delete(blobKey);
			const created = accept(answer);
			if (!created.duplicate) auditOk(call, own, "drive.copy_item", created.item.id);
			return { item: await toOneItem(call, created.item) };
		}
		const created = accept(
			await own.space.createItem(own.ctx, { id: itemId, parentId, kind: original.kind, name, idempotency }),
		);
		await fillCopy(call, own, input.item_id, created.item.id);
		if (!created.duplicate) auditOk(call, own, "drive.copy_item", created.item.id);
		return {
			item: await toOneItem(
				call,
				accept(await own.space.checkItem(own.ctx, created.item.id, "viewer", [original.kind])),
			),
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
		const own = await openSpace(call, input.space_id);
		const result = accept(await own.space.trash(own.ctx, input.item_ids, input.dry_run));
		if (!input.dry_run) auditOk(call, own, "drive.trash_items", input.item_ids.join(","));
		return { ...result, dry_run: input.dry_run };
	},

	async "drive.restore_items"(call, input) {
		const own = await openSpace(call, input.space_id);
		const result = accept(await own.space.restore(own.ctx, input.item_ids));
		auditOk(call, own, "drive.restore_items", input.item_ids.join(","));
		return result;
	},

	async "drive.delete_items"(call, input) {
		const own = await openSpace(call, input.space_id);
		const result = accept(await own.space.remove(own.ctx, input.item_ids, input.dry_run));
		if (!input.dry_run) auditOk(call, own, "drive.delete_items", input.item_ids.join(","));
		return { ...result, dry_run: input.dry_run };
	},

	async "drive.empty_trash"(call, input) {
		const own = await openSpace(call, input.space_id);
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
			room_grants: found.room_grants.map((grant) => ({
				...grant,
				created_at: new Date(grant.created_at).toISOString(),
			})),
		};
	},

	async "drive.share_item"(call, input) {
		const own = await openSpace(call, input.space_id);
		if ((await unknownPrincipalIds(call.env.DIRECTORY, [input.principal_id])).length > 0) {
			throw new OperationError("not_found", "No person or agent has the id in principal_id.");
		}
		const permission = accept(await own.space.share(own.ctx, input.item_id, input.principal_id, input.role));
		auditOk(call, own, "drive.share_item", `${input.item_id}:${input.principal_id}:${input.role}`);
		recordServiceMemberships(call, [input.principal_id], "drive.share_item", input.item_id);
		return { permission: { ...permission, created_at: new Date(permission.created_at).toISOString() } };
	},

	async "drive.unshare_item"(call, input) {
		const opened = await openSpace(call, input.space_id);
		const result = accept(await opened.space.unshare(opened.ctx, input.item_id, input.principal_id));
		if (result.removed) {
			auditOk(call, opened, "drive.unshare_item", `${input.item_id}:${input.principal_id}`);
			recordServiceMemberships(call, [input.principal_id], "drive.unshare_item", input.item_id);
		}
		return result;
	},

	async "drive.create_shared_drive"(call, input) {
		if (!isAdmin(call.caller)) {
			throw new OperationError("forbidden", "Only owners and admins of the organization can create a shared drive.");
		}
		// The key of a retry is in the own drive of the caller. It gives the id of the first call, and the
		// object of that id creates the drive one time only.
		const idempotency = await idempotencyOf(call, "drive.create_shared_drive", input);
		const own = idempotency ? await ownSpace(call) : null;
		if (own && idempotency) {
			// A retry gets the drive of the first call, also when a member of that call is deleted now. So
			// this comes before the check of the members.
			const earlier = await own.space.reservedId(own.ctx, idempotency.key, idempotency.requestHash);
			if (earlier !== null) {
				const first = spaceOf(call, accept(earlier).id);
				const drive = await first.space.createdSharedDrive(first.ctx);
				if (drive !== null) return toSharedDrive(call, accept(drive));
			}
		}
		// The check of the members comes before the id and the object of a new drive, so a refused call
		// leaves no object.
		const members = await memberInputs(call, input.members, undefined);
		let driveId = newId("drv");
		if (own && idempotency) {
			driveId = accept(await own.space.reserveId(own.ctx, idempotency.key, idempotency.requestHash, driveId)).id;
		}
		const opened = spaceOf(call, driveId);
		const created = accept(await opened.space.createSharedDrive(opened.ctx, { name: input.name, members }));
		if (!created.duplicate) {
			auditOk(call, opened, "drive.create_shared_drive", driveId);
			for (const member of members) {
				auditOk(call, opened, "drive.add_shared_drive_members", `${member.principalId}:${member.role}`);
			}
			recordServiceMemberships(
				call,
				members.map((member) => member.principalId),
				"drive.create_shared_drive",
				driveId,
			);
		}
		// A retry changes no agent. The members can be different now: a person who does not manage an agent
		// can be the one who made it a member again. `drive.add_shared_drive_members` completes an access.
		return toSharedDrive(call, created.drive);
	},

	async "drive.list_shared_drives"(call, input) {
		const all = input.all === "true";
		if (all && !isAdmin(call.caller)) {
			throw new OperationError("forbidden", "Only owners and admins of the organization can list each shared drive.");
		}
		const limit = input.limit ?? DEFAULT_PAGE;
		const rows = await listSharedDriveRows(call.env.DIRECTORY, call.caller.id, {
			all,
			after: input.cursor === undefined ? null : decodeDriveCursor(input.cursor),
			limit: limit + 1,
		});
		const page = rows.slice(0, limit);
		const last = page[page.length - 1];
		const shown = await confirmedDrives(call, page);
		return {
			shared_drives: shown.map((row) => ({
				id: row.id,
				name: row.name,
				role: row.role,
				member_count: row.member_count,
				created_at: new Date(row.created_at).toISOString(),
			})),
			next_cursor: rows.length > limit && last ? encodeDriveCursor(last.name_key, last.id) : null,
		};
	},

	async "drive.get_shared_drive"(call, input) {
		const opened = await openSpace(call, input.drive_id);
		return toSharedDrive(call, accept(await opened.space.sharedDrive(opened.ctx)));
	},

	async "drive.update_shared_drive"(call, input) {
		const opened = await openSpace(call, input.drive_id);
		const drive = accept(await opened.space.renameSharedDrive(opened.ctx, input.name));
		auditOk(call, opened, "drive.update_shared_drive", input.drive_id);
		return { shared_drive: (await toSharedDrive(call, drive)).shared_drive };
	},

	async "drive.add_shared_drive_members"(call, input) {
		const opened = await openSpace(call, input.drive_id);
		// The drive comes first. A caller that cannot change its members gets the same answer for each list.
		accept(await opened.space.checkSetMembers(opened.ctx));
		const members = await memberInputs(call, input.members, input.drive_id);
		const result = accept(await opened.space.setMembers(opened.ctx, members));
		// One line for each change, so the audit log shows an admin who adds themselves.
		for (const member of result.changed) {
			auditOk(call, opened, "drive.add_shared_drive_members", `${member.principalId}:${member.role}`);
		}
		recordServiceMemberships(
			call,
			result.changed.map((member) => member.principalId),
			"drive.add_shared_drive_members",
			input.drive_id,
		);
		// Each named agent that the caller manages gets the access of its membership, also a member from
		// before. So a second call completes a write that failed.
		return toSharedDrive(call, result.drive);
	},

	async "drive.remove_shared_drive_member"(call, input) {
		const opened = await openSpace(call, input.drive_id);
		const result = accept(await opened.space.removeMember(opened.ctx, input.principal_id));
		if (result.removed) {
			auditOk(call, opened, "drive.remove_shared_drive_member", input.principal_id);
			recordServiceMemberships(call, [input.principal_id], "drive.remove_shared_drive_member", input.drive_id);
			await loseDriveAccess(call.env.DIRECTORY, input.drive_id, input.principal_id);
		}
		return result;
	},

	async "drive.delete_shared_drive"(call, input) {
		if (!isAdmin(call.caller)) {
			throw new OperationError("forbidden", "Only owners and admins of the organization can delete a shared drive.");
		}
		const state = await sharedDriveState(call.env.DIRECTORY, input.drive_id);
		if (state === null) throw new OperationError("not_found", "No shared drive has that id.");
		// The index has the delete only after the object did it. A second call has nothing to do.
		if (state === "deleted") return { deleted: false };
		const opened = spaceOf(call, input.drive_id);
		// The service accounts of the drive lose it. The index names them before the delete, for their logs.
		const services = await serviceMembersOfDrive(call.env.DIRECTORY, input.drive_id);
		const result = accept(await opened.space.deleteSharedDrive(opened.ctx));
		if (result.deleted) {
			auditOk(call, opened, "drive.delete_shared_drive", input.drive_id);
			recordServiceMemberships(call, services, "drive.delete_shared_drive", input.drive_id);
		}
		return result;
	},
};
