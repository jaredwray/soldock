import { DRIVE_LIMITS, operations, RoomId } from "@asterra/contracts";
import type { Hono } from "hono";
import { z } from "zod";
import { type ApiEnv, callOf, unauthenticatedResponse } from "../api/index.ts";
import { contentOf, roomFile, versionResponse } from "../drive/index.ts";
import type { CallContext } from "../identity/index.ts";
import { bytesToBase64, downloadResponse, invokeOperation, log, OperationError } from "../platform/index.ts";
import { mountCustomEmoji } from "./custom-emoji.ts";
import type { Refusal } from "./room.ts";
import { openRoom } from "./room-call.ts";

// The files of a message. Each download makes two checks: the room checks that the caller is a member
// and that the message holds the file, and the drive of the file checks that it has a grant for the room
// and that the file is outside the trash. A member that leaves fails the first check at once.

const DOWNLOAD_OPERATION = operations["chat.download_file"];
const LINK_IMAGE_OPERATION = operations["chat.download_link_image"];

/** `chat.download_link_image` with a stream as the answer: `GET /dl/chat/…/links/image`. */
const rawLinkImage = {
	...LINK_IMAGE_OPERATION,
	output: z.custom<Response>((value) => value instanceof Response),
};

/** `chat.download_file` without the range fields, with a stream as the answer: `GET /dl/chat/…`. */
const rawDownload = {
	...DOWNLOAD_OPERATION,
	input: DOWNLOAD_OPERATION.input.omit({ offset: true, length: true }),
	output: z.custom<Response>((value) => value instanceof Response),
};

/** The current version of a file of a message, for a member of the room. */
async function messageFile(call: CallContext, roomId: string, messageId: string, itemId: string) {
	const { room, ctx } = openRoom(call, roomId);
	const ref = (await room.fileRef(ctx, messageId, itemId)) as { spaceId: string; itemId: string } | Refusal;
	if ("error" in ref) throw new OperationError(ref.error.code, ref.error.message);
	return roomFile(call.env, { spaceId: ref.spaceId, itemId: ref.itemId, roomId });
}

/** The picture of a link preview of a message, for a member of the room. */
async function linkImage(call: CallContext, roomId: string, messageId: string, url: string) {
	const { room, ctx } = openRoom(call, roomId);
	const found = (await room.linkImage(ctx, messageId, url)) as { key: string; type: string; size: number } | Refusal;
	if ("error" in found) throw new OperationError(found.error.code, found.error.message);
	return found;
}

export async function downloadLinkImage(
	call: CallContext,
	input: z.output<typeof LINK_IMAGE_OPERATION.input>,
): Promise<z.input<typeof LINK_IMAGE_OPERATION.output>> {
	const found = await linkImage(call, input.room_id, input.message_id, input.url);
	const object = await call.env.BLOBS.get(found.key);
	if (!object) throw new OperationError("not_found", "The link has no picture.");
	return {
		mime_type: found.type,
		size: found.size,
		content_base64: bytesToBase64(new Uint8Array(await object.arrayBuffer())),
		untrusted: true,
	};
}

export async function downloadChatFile(
	call: CallContext,
	input: z.output<typeof DOWNLOAD_OPERATION.input>,
): Promise<z.input<typeof DOWNLOAD_OPERATION.output>> {
	const found = await messageFile(call, input.room_id, input.message_id, input.item_id);
	const source = contentOf(found, input.variant);
	const offset = input.offset ?? 0;
	if (offset > 0 && offset >= source.size) {
		throw new OperationError("invalid", `offset must be less than the size of the file (${source.size} bytes).`);
	}
	const rest = source.size - offset;
	if (input.length === undefined && rest > DRIVE_LIMITS.fileBytes) {
		throw new OperationError(
			"payload_too_large",
			`The file has ${source.size} bytes, and one answer has at most ${DRIVE_LIMITS.fileBytes}. Set offset and length to get one range at a time.`,
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
		size: source.size,
		offset,
		length,
		content_base64: bytesToBase64(bytes),
	};
}

export function mountChatFiles(app: Hono<ApiEnv>): void {
	mountCustomEmoji(app);
	// The picture of a link preview. It comes before the route of a file: its path has one more part.
	app.on(["GET", "HEAD"], "/dl/chat/:room_id/:message_id/links/image", async (c) => {
		const call = await callOf(c, { change: false, ownSiteRead: true });
		if (!call) return unauthenticatedResponse(c.var.requestId, new URL(c.req.url).pathname);
		if (!RoomId.safeParse(c.req.param("room_id")).success) {
			throw new OperationError("not_found", "No room has that id, or you have no access to it.");
		}
		const input = { room_id: c.req.param("room_id"), message_id: c.req.param("message_id"), url: c.req.query("url") };
		return (await invokeOperation(
			rawLinkImage,
			async (call: CallContext, parsed: z.output<typeof rawLinkImage.input>) => {
				const found = await linkImage(call, parsed.room_id, parsed.message_id, parsed.url);
				return downloadResponse(c.req.raw, {
					name: "preview",
					size: found.size,
					etag: found.key.slice(found.key.lastIndexOf("/") + 1),
					inlineType: found.type,
					read: async (range) => (await call.env.BLOBS.get(found.key, { range }))?.body ?? null,
				});
			},
			call,
			input,
		)) as Response;
	});

	app.on(["GET", "HEAD"], "/dl/chat/:room_id/:message_id/:item_id", async (c) => {
		const call = await callOf(c, { change: false, ownSiteRead: true });
		if (!call) return unauthenticatedResponse(c.var.requestId, new URL(c.req.url).pathname);
		const variant = c.req.query("variant");
		// An id that is not a room id names no room. No object wakes for it.
		if (!RoomId.safeParse(c.req.param("room_id")).success) {
			throw new OperationError("not_found", "No room has that id, or you have no access to it.");
		}
		const input = {
			room_id: c.req.param("room_id"),
			message_id: c.req.param("message_id"),
			item_id: c.req.param("item_id"),
			...(variant === undefined ? {} : { variant }),
		};
		return (await invokeOperation(
			rawDownload,
			async (call: CallContext, parsed: z.output<typeof rawDownload.input>) => {
				const found = await messageFile(call, parsed.room_id, parsed.message_id, parsed.item_id);
				log("info", "chat file download", {
					requestId: call.requestId,
					principalId: call.caller.id,
					credential: call.caller.credential,
					roomId: parsed.room_id,
					messageId: parsed.message_id,
					itemId: parsed.item_id,
					variant: parsed.variant,
				});
				return versionResponse(c.req.raw, call.env, found, parsed.variant);
			},
			call,
			input,
		)) as Response;
	});
}
