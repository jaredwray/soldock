import { DRIVE_LIMITS, type FileVersion } from "@asterra/contracts";
import type { CallContext } from "../identity/index.ts";
import { base64ToBytes, type ImageInfo, OperationError, readImageInfo } from "../platform/index.ts";
import { accept, auditOk, openSpace, STORED_TYPE } from "./access.ts";
import { newPreviewKey, type VersionRecord } from "./space.ts";

// The small picture of a picture or a video. The browser of the uploader makes it, because a Worker
// cannot decode a picture or a video. The server checks what it can: the small picture is a small,
// inert raster picture, and for a picture file it has the shape of the picture. The server cannot check
// that the small picture shows the file.

/** The bytes of the start of a picture file that hold its size. A JPEG file has its EXIF data first. */
const HEADER_BYTES = 64 * 1024;

const PREVIEW_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp"]);

export function toVersion(version: VersionRecord): FileVersion {
	return { ...version, created_at: new Date(version.created_at).toISOString() };
}

/**
 * True when the small picture has the shape of the picture: a side of the small picture is at most one
 * pixel, or 2 %, from the side that the other side gives.
 */
function sameShape(preview: ImageInfo, original: ImageInfo): boolean {
	const expected = (original.height * preview.width) / original.width;
	return Math.abs(preview.height - expected) <= Math.max(1, expected * 0.02);
}

/** The reason that a small picture is refused, or null. */
function previewProblem(info: ImageInfo | null): string | null {
	if (info === null || !PREVIEW_TYPES.has(info.type)) return "The preview must be a PNG, JPEG or WebP picture.";
	if (info.width < 1 || info.height < 1) return "The preview has no pixels.";
	if (info.width > DRIVE_LIMITS.previewSide || info.height > DRIVE_LIMITS.previewSide) {
		return `The preview can have at most ${DRIVE_LIMITS.previewSide} pixels on each side.`;
	}
	return null;
}

export async function setPreview(
	call: CallContext,
	input: { space_id?: string | undefined; item_id: string; version_id?: string | undefined; content_base64: string },
): Promise<{ version: FileVersion }> {
	const opened = await openSpace(call, input.space_id);
	const target = accept(await opened.space.previewTarget(opened.ctx, input.item_id, input.version_id ?? null));
	let bytes: Uint8Array;
	try {
		bytes = base64ToBytes(input.content_base64);
	} catch {
		throw new OperationError("invalid", "content_base64 is not valid base64.");
	}
	if (bytes.byteLength > DRIVE_LIMITS.previewBytes) {
		throw new OperationError("payload_too_large", `A preview can have at most ${DRIVE_LIMITS.previewBytes} bytes.`);
	}
	const info = readImageInfo(bytes);
	const problem = previewProblem(info);
	if (problem || !info) throw new OperationError("invalid", problem ?? "The preview is not a picture.");
	let media: ImageInfo | null = null;
	if (target.detectedType.startsWith("image/") && target.size > 0) {
		const head = await call.env.BLOBS.get(target.blobKey, {
			range: { offset: 0, length: Math.min(HEADER_BYTES, target.size) },
		});
		media = head ? readImageInfo(new Uint8Array(await head.arrayBuffer())) : null;
		if (media && !sameShape(info, media)) {
			throw new OperationError(
				"invalid",
				`The preview must have the shape of the picture (${media.width} × ${media.height} pixels).`,
			);
		}
	}
	// After an error here, the bytes can stay without a record. Blob GC will collect them.
	const key = newPreviewKey(target.blobKey);
	await call.env.BLOBS.put(key, bytes, STORED_TYPE);
	const answer = await opened.space.setPreview(opened.ctx, input.item_id, target.versionId, {
		key,
		type: info.type,
		width: info.width,
		height: info.height,
		size: bytes.byteLength,
		media_width: media?.width ?? null,
		media_height: media?.height ?? null,
	});
	// No version names the bytes of a refused call.
	if ("error" in answer) await call.env.BLOBS.delete(key);
	const version = accept(answer);
	auditOk(call, opened, "drive.set_preview", input.item_id);
	return { version: toVersion(version) };
}
