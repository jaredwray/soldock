import type { DriveItem } from "@soldock/contracts";
import { documentStub } from "../collab/index.ts";
import { type CallContext, unknownPrincipalIds } from "../identity/index.ts";
import { audit, OperationError, sha256Hex } from "../platform/index.ts";
import type { ActorRecord, ItemRecord, ItemRef, Refusal, SpaceCall } from "./space.ts";

const NOT_FOUND = "No item has that id, or you have no access to it.";

export function spaceStub(env: Pick<Env, "DRIVE_SPACE">, spaceId: string) {
	return env.DRIVE_SPACE.get(env.DRIVE_SPACE.idFromName(spaceId));
}

/** The R2 key of one version of a file. Each object has one owner: the version in its key. */
export function blobKeyFor(spaceId: string, itemId: string, versionId: string): string {
	return `drive/${spaceId}/${itemId}/${versionId}`;
}

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
 * The drive of a call: the own drive of the caller by default, or the drive of a different principal.
 * The object of that drive decides what the caller can do with each item. The scopes of the
 * credential decide which operations the caller can call at all.
 */
export async function openSpace(call: CallContext, spaceId: string | undefined): Promise<OpenSpace> {
	const own = spaceId === undefined || spaceId === call.caller.id;
	const id = own ? call.caller.id : spaceId;
	// A drive object exists for each name that somebody asks for. Only the id of a principal gets one.
	if (!own && (await unknownPrincipalIds(call.env.DIRECTORY, [id])).length > 0) {
		throw new OperationError("not_found", NOT_FOUND);
	}
	return { spaceId: id, own, space: spaceStub(call.env, id), ctx: { spaceId: id, actor: actorOf(call) } };
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
 * The items for the output of an operation. An item in the drive of somebody else has no star from
 * its drive: the stars of the caller are in the own drive of the caller.
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
	input: { content: string; text: string; baseRevision: number | null },
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
