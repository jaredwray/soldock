import { DRIVE_LIMITS, operations } from "@asterra/contracts";
import type { Hono } from "hono";
import { z } from "zod";
import { type ApiEnv, callOf, unauthenticatedResponse } from "../api/index.ts";
import type { CallContext } from "../identity/index.ts";
import { downloadResponse, INLINE_TYPES, invokeOperation, log, OperationError } from "../platform/index.ts";
import { accept, openSpace } from "./access.ts";
import { contentOf } from "./handlers.ts";
import type { VersionRecord } from "./space.ts";
import { receivePart } from "./upload.ts";

// The two paths of Drive outside the registry. Each one is a second transport of one operation, without
// base64: `PUT /blob/…/parts/{n}` is `drive.upload_part`, and `GET /dl/drive/…` is `drive.download_file`.
// Each runs through the shared invoker with the callers, the scopes and the audit of its operation.

const PART_OPERATION = operations["drive.upload_part"];
const DOWNLOAD_OPERATION = operations["drive.download_file"];

/** `drive.upload_part` without the content: the bytes are the body of the request. */
const rawPart = {
	...PART_OPERATION,
	input: PART_OPERATION.input.omit({ content_base64: true }),
};

/** `drive.download_file` without the range fields, with a stream as the answer. */
const rawDownload = {
	...DOWNLOAD_OPERATION,
	input: DOWNLOAD_OPERATION.input.omit({ offset: true, length: true }),
	output: z.custom<Response>((value) => value instanceof Response),
};

/** The length of a part from `Content-Length`. A part without it, or over the part size, is refused. */
function partLength(header: string | undefined): number {
	if (header === undefined || !/^\d+$/.test(header)) {
		throw new OperationError("invalid", "Send the part with a Content-Length header.");
	}
	const length = Number(header);
	if (length > DRIVE_LIMITS.uploadPartBytes) {
		throw new OperationError("payload_too_large", `A part has at most ${DRIVE_LIMITS.uploadPartBytes} bytes.`);
	}
	return length;
}

/**
 * The answer of `/dl/` for one version of a file: its bytes, or its small picture. A page can show the
 * bytes inline only when the server found a picture or a video in them (`INLINE_TYPES`). Each other
 * file is an attachment.
 */
export function versionResponse(
	request: Request,
	env: Pick<Env, "BLOBS">,
	found: { name: string; blobKey: string; version: VersionRecord },
	variant: "content" | "preview",
): Promise<Response> {
	const source = contentOf(found, variant);
	const detected = found.version.detected_type;
	return downloadResponse(request, {
		name: found.name,
		size: source.size,
		etag: variant === "preview" ? `${found.version.id}.preview` : found.version.id,
		inlineType:
			variant === "preview" ? source.mimeType : detected !== null && INLINE_TYPES.has(detected) ? detected : null,
		read: async (range) => (await env.BLOBS.get(source.key, { range }))?.body ?? null,
	});
}

export function mountDriveTransfer(app: Hono<ApiEnv>): void {
	app.put("/blob/drive/:space_id/uploads/:upload_id/parts/:part_number", async (c) => {
		const call = await callOf(c, { change: true });
		if (!call) return unauthenticatedResponse(c.var.requestId, new URL(c.req.url).pathname);
		const size = partLength(c.req.header("content-length"));
		const number = c.req.param("part_number");
		const input = {
			space_id: c.req.param("space_id"),
			upload_id: c.req.param("upload_id"),
			part_number: /^\d{1,4}$/.test(number) ? Number(number) : number,
		};
		const body = c.req.raw.body ?? new Uint8Array();
		const output = await invokeOperation(
			rawPart,
			(call: CallContext, parsed: z.output<typeof rawPart.input>) =>
				receivePart(call, {
					spaceId: parsed.space_id,
					uploadId: parsed.upload_id,
					partNumber: parsed.part_number,
					size,
					body,
				}),
			call,
			input,
		);
		return c.json(output as object, 200, { "cache-control": "no-store" });
	});

	app.on(["GET", "HEAD"], "/dl/drive/:space_id/:item_id", async (c) => {
		const call = await callOf(c, { change: false, ownSiteRead: true });
		if (!call) return unauthenticatedResponse(c.var.requestId, new URL(c.req.url).pathname);
		const versionId = c.req.query("version_id");
		const variant = c.req.query("variant");
		const input = {
			space_id: c.req.param("space_id"),
			item_id: c.req.param("item_id"),
			...(versionId === undefined ? {} : { version_id: versionId }),
			...(variant === undefined ? {} : { variant }),
		};
		return (await invokeOperation(
			rawDownload,
			async (call: CallContext, parsed: z.output<typeof rawDownload.input>) => {
				const opened = await openSpace(call, parsed.space_id);
				const found = accept(await opened.space.fileContent(opened.ctx, parsed.item_id, parsed.version_id ?? null));
				log("info", "drive download", {
					requestId: call.requestId,
					principalId: call.caller.id,
					credential: call.caller.credential,
					spaceId: opened.spaceId,
					itemId: parsed.item_id,
					versionId: found.version.id,
					variant: parsed.variant,
				});
				return versionResponse(c.req.raw, call.env, found, parsed.variant);
			},
			call,
			input,
		)) as Response;
	});
}
