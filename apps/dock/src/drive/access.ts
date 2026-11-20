import type { DriveItem } from "@asterra/contracts";
import { documentStub } from "../collab/index.ts";
import { type CallContext, driveLimitNames, driveLimitOf, isAdmin, unknownPrincipalIds } from "../identity/index.ts";
import { audit, OperationError, sha256Hex } from "../platform/index.ts";
import { unknownSharedDriveIds } from "./shared-index.ts";
import {
	type ActorRecord,
	blobKeyFor,
	type ItemRecord,
	type ItemRef,
	isSharedDriveId,
	type Refusal,
	type SpaceCall,
} from "./space.ts";

const NOT_FOUND = "No item has that id, or you have no access to it.";

/** R2 holds the bytes of a file with a neutral type. Only `/dl/` serves them to a browser, as an attachment. */
export const STORED_TYPE = { httpMetadata: { contentType: "application/octet-stream" } };

export function spaceStub(env: Pick<Env, "DRIVE_SPACE">, spaceId: string) {
	return env.DRIVE_SPACE.get(env.DRIVE_SPACE.idFromName(spaceId));
}

export { blobKeyFor };

export function actorOf(call: CallContext): ActorRecord {
	const { principal } = call.caller;
	return { principal_id: principal.id, kind: principal.kind, display_name: principal.display_name };
}

/** A drive that an operation uses, with the caller for its object. */
export interface OpenSpace {
	spaceId: string;
	/** True for the own drive of the caller. */
	own: boolean;
	space: ReturnType<typeof spaceStub>;
	ctx: SpaceCall;
}

/**
 * The ids from the list that are not a drive that an operation can open: the id of a principal that
 * the directory does not have, or the id of a shared drive that is not live in the index.
 */
export async function unknownSpaceIds(db: D1Database, ids: readonly string[]): Promise<string[]> {
	const [principals, drives] = await Promise.all([
		unknownPrincipalIds(
			db,
			ids.filter((id) => !isSharedDriveId(id)),
		),
		unknownSharedDriveIds(db, ids.filter(isSharedDriveId)),
	]);
	return [...principals, ...drives];
}

/**
 * The caller for the object of a drive. `admin` is true for a person with the owner or the admin role
 * of the organization. The object uses it for the members and the name of a shared drive only.
 *
 * `limit` holds the Drive limit of an API key for this drive. Each call to the object of a drive gets
 * its caller from here, so the object applies the limit to each item. A drive that the limit does not
 * name gets an empty limit, which allows no item.
 */
export function spaceCall(call: CallContext, spaceId: string): SpaceCall {
	const allowed = driveLimitOf(call.caller, spaceId);
	return {
		spaceId,
		actor: actorOf(call),
		admin: call.caller.kind === "human" && isAdmin(call.caller),
		...(allowed === "all" ? {} : { limit: { roots: allowed } }),
	};
}

/** A drive by its id, without a check that the id is a drive. Use `openSpace` for an id from a caller. */
export function spaceOf(call: CallContext, spaceId: string): OpenSpace {
	return {
		spaceId,
		own: spaceId === call.caller.id,
		space: spaceStub(call.env, spaceId),
		ctx: spaceCall(call, spaceId),
	};
}

/**
 * The drive of a call: the own drive of the caller by default, the drive of a different principal, or
 * a shared drive. The object of that drive decides what the caller can do with each item. The scopes
 * of the credential decide which operations the caller can call at all.
 */
export async function openSpace(call: CallContext, spaceId: string | undefined): Promise<OpenSpace> {
	const id = spaceId ?? call.caller.id;
	// A drive object exists for each name that somebody asks for. Only the id of a principal, or of a
	// live shared drive in the index, gets one.
	if (id !== call.caller.id && (await unknownSpaceIds(call.env.DIRECTORY, [id])).length > 0) {
		throw new OperationError("not_found", NOT_FOUND);
	}
	// A drive that the Drive limit of the key does not name gets the answer of an id that is no drive.
	if (id !== call.caller.id && !driveLimitNames(call.caller, id)) throw new OperationError("not_found", NOT_FOUND);
	return spaceOf(call, id);
}

/** Turns a refusal from an object into an OperationError, and returns any other result. */
export function accept<T extends object>(value: T): Exclude<T, { error: unknown }> {
	if ("error" in value) {
		const { error } = value as unknown as Refusal;
		throw new OperationError(error.code, error.message);
	}
	return value as Exclude<T, { error: unknown }>;
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

export function toItem(record: ItemRecord): DriveItem {
	return {
		...record,
		created_at: iso(record.created_at),
		modified_at: iso(record.modified_at),
		trashed_at: record.trashed_at === null ? null : iso(record.trashed_at),
	};
}

/**
 * The items for the output of an operation. An item in the drive of somebody else, or in a shared
 * drive, has no star from its drive: the stars of the caller are in the own drive of the caller.
 */
export async function toItems(call: CallContext, records: ItemRecord[]): Promise<DriveItem[]> {
	const foreign: ItemRef[] = records
		.filter((record) => record.space_id !== call.caller.id)
		.map((record) => ({ spaceId: record.space_id, itemId: record.id }));
	if (foreign.length === 0) return records.map(toItem);
	const own = await openSpace(call, undefined);
	const starred = new Set(
		accept(await own.space.starredAmong(own.ctx, foreign)).map((ref) => `${ref.spaceId}/${ref.itemId}`),
	);
	return records.map((record) =>
		toItem({ ...record, starred: record.starred || starred.has(`${record.space_id}/${record.id}`) }),
	);
}

export async function toOneItem(call: CallContext, record: ItemRecord): Promise<DriveItem> {
	return (await toItems(call, [record]))[0] as DriveItem;
}

export function auditOk(call: CallContext, opened: OpenSpace | null, op: string, target: string): void {
	audit({
		op,
		actor: call.caller.id,
		actorKind: call.caller.kind,
		credential: call.caller.credential,
		target,
		...(opened && !opened.own ? { space: opened.spaceId } : {}),
		result: "ok",
		requestId: call.requestId,
	});
}

/**
 * The idempotency key of a call, for the object of a drive. Each key belongs to its caller, so the key
 * of one principal can never return or stop the item of a different principal. The hash binds the key
 * to the request, so a reused key with another request is a conflict.
 */
export async function idempotencyOf(
	call: CallContext,
	operation: string,
	input: { idempotency_key?: string | undefined },
): Promise<{ key: string; requestHash: string } | undefined> {
	if (input.idempotency_key === undefined) return undefined;
	const { idempotency_key: key, ...request } = input;
	return {
		key: `${call.caller.id}:${key}`,
		requestHash: await sha256Hex(JSON.stringify([operation, request])),
	};
}

/** The stored content of a doc or a sheet, or null when nobody wrote it. */
export async function readDocument(call: CallContext, itemId: string) {
	return documentStub(call.env, itemId).read();
}

/**
 * Writes the content of a doc or a sheet, then tells the drive of the item. The object of the content
 * also tells the drive, with retries, so the drive gets the change when this call stops between the
 * two steps. The drive drops the second message.
 */
export async function writeDocument(
	call: CallContext,
	opened: OpenSpace,
	itemId: string,
	input: { content: string; text: string; baseRevision: number | null; attachmentIds?: string[] },
): Promise<{ revision: number; changed: boolean }> {
	const author = actorOf(call);
	const result = accept(
		await documentStub(call.env, itemId).write({ spaceId: opened.spaceId, itemId, author, ...input }),
	);
	if (result.changed) {
		await opened.space.applyDocumentChange({
			itemId,
			revision: result.revision,
			modifiedAt: result.modifiedAt,
			modifiedBy: author,
			size: result.size,
			text: input.text,
		});
	}
	return { revision: result.revision, changed: result.changed };
}
