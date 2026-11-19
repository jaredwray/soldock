import { DRIVE_LIMITS, type DriveUpload } from "@asterra/contracts";
import type { CallContext } from "../identity/index.ts";
import { log, newId, OperationError, SNIFF_BYTES, sha256StreamHex, sniffType } from "../platform/index.ts";
import { accept, auditOk, blobKeyFor, idempotencyOf, openSpace, STORED_TYPE, toOneItem } from "./access.ts";
import { chatFolderFor } from "./rooms.ts";
import type { UploadRecord } from "./space.ts";

// An upload in parts. The parts go to an R2 multipart upload, to the key of the version that the upload
// makes. The `DriveSpaceDO` of the drive holds the state of the upload and each part, so a part that
// failed can go again, and a client can ask which parts the server has. Each step checks the access.

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

export function toUpload(record: UploadRecord): DriveUpload {
	return { ...record, created_at: iso(record.created_at), expires_at: iso(record.expires_at) };
}

/** Stops an R2 multipart upload that no row of a drive names. A failure is logged: R2 stops it after 7 days. */
async function abandon(call: CallContext, multipart: R2MultipartUpload): Promise<void> {
	try {
		await multipart.abort();
	} catch (error) {
		log("warn", "drive upload abort failed", {
			requestId: call.requestId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export async function createUpload(
	call: CallContext,
	input: {
		space_id?: string | undefined;
		parent_id?: string | undefined;
		room_id?: string | undefined;
		name: string;
		mime_type: string;
		size: number;
		sha256?: string | undefined;
		idempotency_key?: string | undefined;
	},
): Promise<{ upload: DriveUpload }> {
	const opened = await openSpace(call, input.space_id);
	const idempotency = await idempotencyOf(call, "drive.create_upload", input);
	if (idempotency) {
		const earlier = await opened.space.uploadForKey(opened.ctx, idempotency.key, idempotency.requestHash);
		if (earlier !== null) return { upload: toUpload(accept(earlier)) };
	}
	// A file of a message of Chat goes into Chat/<room name> of the own drive of the caller.
	const parentId = input.room_id === undefined ? (input.parent_id ?? null) : await chatFolderFor(call, input.room_id);
	// Refuse before R2 starts a multipart upload, so a caller without access starts nothing.
	accept(await opened.space.checkCreate(opened.ctx, parentId));
	const itemId = newId("itm");
	const versionId = newId("ver");
	const blobKey = blobKeyFor(opened.spaceId, itemId, versionId);
	const multipart = await call.env.BLOBS.createMultipartUpload(blobKey, STORED_TYPE);
	// After an error the drive can have stored the row. Its alarm then stops the multipart upload after its time.
	const answer = await opened.space.openUpload(opened.ctx, {
		id: newId("upl"),
		r2UploadId: multipart.uploadId,
		itemId,
		versionId,
		blobKey,
		parentId,
		name: input.name,
		mimeType: input.mime_type,
		size: input.size,
		partSize: DRIVE_LIMITS.uploadPartBytes,
		sha256: input.sha256 ?? null,
		idempotency,
	});
	// No row names the multipart upload of a refused call, or of a call whose key gave an earlier upload.
	if ("error" in answer || answer.duplicate) await abandon(call, multipart);
	const opened2 = accept(answer);
	if (!opened2.duplicate) auditOk(call, opened, "drive.create_upload", opened2.upload.id);
	return { upload: toUpload(opened2.upload) };
}

export async function getUpload(
	call: CallContext,
	input: { space_id?: string | undefined; upload_id: string },
): Promise<{ upload: DriveUpload }> {
	const opened = await openSpace(call, input.space_id);
	return { upload: toUpload(accept(await opened.space.uploadState(opened.ctx, input.upload_id))) };
}

/**
 * Stores one part. The body is the decoded base64 of `drive.upload_part`, or the stream of the request
 * of the raw path, with a known length. The drive checks the number and the exact size before R2 gets
 * a byte.
 */
export async function receivePart(
	call: CallContext,
	input: {
		spaceId: string | undefined;
		uploadId: string;
		partNumber: number;
		size: number;
		body: ReadableStream<Uint8Array> | Uint8Array;
	},
): Promise<{ upload: DriveUpload }> {
	const opened = await openSpace(call, input.spaceId);
	const target = accept(await opened.space.partTarget(opened.ctx, input.uploadId, input.partNumber, input.size));
	let etag: string;
	try {
		const multipart = call.env.BLOBS.resumeMultipartUpload(target.blobKey, target.r2UploadId);
		etag = (await multipart.uploadPart(input.partNumber, input.body)).etag;
	} catch (error) {
		log("warn", "drive upload part failed", {
			requestId: call.requestId,
			part: input.partNumber,
			error: error instanceof Error ? error.message : String(error),
		});
		throw new OperationError("unavailable", `Part ${input.partNumber} did not store. Send it again.`);
	}
	return {
		upload: toUpload(
			accept(await opened.space.recordPart(opened.ctx, input.uploadId, input.partNumber, etag, input.size)),
		),
	};
}

/**
 * Joins the parts into the object of the version, then makes the file. The SHA-256 of the version comes
 * from the joined object, read one time as a stream. When the drive refuses the file, or the hash is not
 * the hash of the start, the upload goes away with its object.
 */
export async function completeUpload(call: CallContext, input: { space_id?: string | undefined; upload_id: string }) {
	const opened = await openSpace(call, input.space_id);
	const state = accept(await opened.space.uploadParts(opened.ctx, input.upload_id));
	if ("item" in state) return { item: await toOneItem(call, state.item) };
	const multipart = call.env.BLOBS.resumeMultipartUpload(state.blobKey, state.r2UploadId);
	try {
		await multipart.complete(state.parts);
	} catch (error) {
		// An earlier call can have joined the parts, and stopped before the drive made the file.
		const head = await call.env.BLOBS.head(state.blobKey);
		if (head?.size !== state.size) {
			log("warn", "drive upload complete failed", {
				requestId: call.requestId,
				error: error instanceof Error ? error.message : String(error),
			});
			throw new OperationError(
				"unavailable",
				"The parts did not join into one file. Call drive.complete_upload again. If it fails again, send each part again.",
			);
		}
	}
	const object = await call.env.BLOBS.get(state.blobKey);
	if (!object) throw new Error("the joined upload is missing from R2");
	const sha256 = await sha256StreamHex(object.body);
	// The drive removes an open upload, and its outbox deletes the joined object. A done upload keeps its
	// file: a second completion that fails here must never delete the bytes of the version of the first.
	const drop = () => opened.space.dropUpload(opened.ctx, input.upload_id);
	if (object.size !== state.size) {
		await drop();
		throw new OperationError("invalid", "The joined parts do not have the size of the file. Start a new upload.");
	}
	if (state.sha256 !== null && state.sha256 !== sha256) {
		await drop();
		throw new OperationError(
			"conflict",
			`The SHA-256 of the joined parts is ${sha256}, not the sha256 of drive.create_upload. The upload is removed. Start a new upload.`,
		);
	}
	const head = await call.env.BLOBS.get(state.blobKey, {
		range: { offset: 0, length: Math.min(SNIFF_BYTES, state.size) },
	});
	const detectedType = head ? sniffType(new Uint8Array(await head.arrayBuffer())) : null;
	const answer = await opened.space.finishUpload(opened.ctx, input.upload_id, sha256, detectedType);
	if ("error" in answer) await drop();
	const finished = accept(answer);
	if (!finished.duplicate) auditOk(call, opened, "drive.complete_upload", finished.item.id);
	return { item: await toOneItem(call, finished.item) };
}

export async function abortUpload(
	call: CallContext,
	input: { space_id?: string | undefined; upload_id: string },
): Promise<{ aborted: boolean }> {
	const opened = await openSpace(call, input.space_id);
	const { aborted } = await opened.space.dropUpload(opened.ctx, input.upload_id);
	if (aborted) auditOk(call, opened, "drive.abort_upload", input.upload_id);
	return { aborted };
}
