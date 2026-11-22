import { CHAT_LIMITS, type ChatCustomEmoji, CustomEmojiName, chatCustomEmojiPath } from "@asterra/contracts";
import type { Hono } from "hono";
import { type ApiEnv, callOf, unauthenticatedResponse } from "../api/index.ts";
import type { CallContext } from "../identity/index.ts";
import { audit, base64ToBytes, downloadResponse, newId, OperationError, readImageInfo } from "../platform/index.ts";

// Custom emoji for the organization: raster images (PNG, JPEG, GIF, WebP) stored in R2 under
// `chat/emoji/<name>-<id>`, indexed in D1 `chat_custom_emoji`. Served on `/dl/chat/emoji/:name`
// with nosniff and sandbox CSP for authenticated callers.

interface EmojiRow {
	name: string;
	r2_key: string;
	mime_type: string;
	size: number;
	width: number;
	height: number;
	created_by: string;
	created_at: number;
}

function toCustomEmoji(row: EmojiRow): ChatCustomEmoji {
	return {
		name: row.name,
		mime_type: row.mime_type,
		size: row.size,
		width: row.width,
		height: row.height,
		url_path: chatCustomEmojiPath(row.name),
		created_by: row.created_by,
		created_at: new Date(row.created_at).toISOString(),
	};
}

/** True when a custom emoji with the given name (without colons) exists in the organization. */
export async function hasCustomEmoji(db: D1Database, name: string): Promise<boolean> {
	const row = await db.prepare("SELECT 1 AS found FROM chat_custom_emoji WHERE name = ?").bind(name).first();
	return row !== null;
}

export async function listCustomEmoji(db: D1Database): Promise<ChatCustomEmoji[]> {
	const { results } = await db
		.prepare(
			"SELECT name, r2_key, mime_type, size, width, height, created_by, created_at FROM chat_custom_emoji ORDER BY name",
		)
		.all<EmojiRow>();
	return results.map(toCustomEmoji);
}

export async function createCustomEmoji(
	call: CallContext,
	input: { name: string; content_base64: string },
): Promise<ChatCustomEmoji> {
	let bytes: Uint8Array;
	try {
		bytes = base64ToBytes(input.content_base64);
	} catch {
		throw new OperationError("invalid", "content_base64 is not valid base64.");
	}
	if (bytes.byteLength === 0 || bytes.byteLength > CHAT_LIMITS.customEmojiBytes) {
		throw new OperationError(
			"payload_too_large",
			`A custom emoji image must be between 1 and ${CHAT_LIMITS.customEmojiBytes} bytes.`,
		);
	}
	const info = readImageInfo(bytes);
	if (!info) {
		throw new OperationError("invalid", "A custom emoji must be a PNG, JPEG, GIF, or WebP image.");
	}
	if (info.width > CHAT_LIMITS.customEmojiPixels || info.height > CHAT_LIMITS.customEmojiPixels) {
		throw new OperationError(
			"invalid",
			`A custom emoji must be at most ${CHAT_LIMITS.customEmojiPixels}x${CHAT_LIMITS.customEmojiPixels} pixels.`,
		);
	}

	const countRow = await call.env.DIRECTORY.prepare("SELECT COUNT(*) AS n FROM chat_custom_emoji").first<{
		n: number;
	}>();
	if ((countRow?.n ?? 0) >= CHAT_LIMITS.customEmojiPerOrg) {
		throw new OperationError(
			"conflict",
			`An organization can have ${CHAT_LIMITS.customEmojiPerOrg} custom emoji at most.`,
		);
	}
	const existing = await call.env.DIRECTORY.prepare("SELECT 1 AS found FROM chat_custom_emoji WHERE name = ?")
		.bind(input.name)
		.first();
	if (existing) throw new OperationError("conflict", `Custom emoji :${input.name}: already exists.`);

	const r2Key = `chat/emoji/${input.name}-${newId("emj")}`;
	await call.env.BLOBS.put(r2Key, bytes, { httpMetadata: { contentType: info.type } });
	const now = Date.now();
	try {
		await call.env.DIRECTORY.prepare(
			`INSERT INTO chat_custom_emoji (name, r2_key, mime_type, size, width, height, created_by, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(input.name, r2Key, info.type, bytes.byteLength, info.width, info.height, call.caller.id, now)
			.run();
	} catch (error) {
		await call.env.BLOBS.delete(r2Key);
		const msg = error instanceof Error ? error.message : String(error);
		if (msg.includes("UNIQUE") || msg.includes("PRIMARY KEY")) {
			throw new OperationError("conflict", `Custom emoji :${input.name}: already exists.`);
		}
		throw error;
	}
	audit({
		op: "chat.create_custom_emoji",
		actor: call.caller.id,
		actorKind: call.caller.kind,
		credential: call.caller.credential,
		target: input.name,
		result: "ok",
		requestId: call.requestId,
	});
	return {
		name: input.name,
		mime_type: info.type,
		size: bytes.byteLength,
		width: info.width,
		height: info.height,
		url_path: chatCustomEmojiPath(input.name),
		created_by: call.caller.id,
		created_at: new Date(now).toISOString(),
	};
}

export async function deleteCustomEmoji(call: CallContext, name: string): Promise<boolean> {
	const row = await call.env.DIRECTORY.prepare("SELECT r2_key FROM chat_custom_emoji WHERE name = ?")
		.bind(name)
		.first<{ r2_key: string }>();
	if (!row) return false;
	await call.env.DIRECTORY.prepare("DELETE FROM chat_custom_emoji WHERE name = ?").bind(name).run();
	await call.env.BLOBS.delete(row.r2_key);
	audit({
		op: "chat.delete_custom_emoji",
		actor: call.caller.id,
		actorKind: call.caller.kind,
		credential: call.caller.credential,
		target: name,
		result: "ok",
		requestId: call.requestId,
	});
	return true;
}

/** Mounts authenticated safe raster download route `GET /dl/chat/emoji/:name`. */
export function mountChatCustomEmoji(app: Hono<ApiEnv>): void {
	app.on(["GET", "HEAD"], "/dl/chat/emoji/:name", async (c) => {
		const call = await callOf(c, { change: false, ownSiteRead: true });
		if (!call) return unauthenticatedResponse(c.var.requestId, new URL(c.req.url).pathname);
		if (!call.caller.scopes.has("chat.read")) {
			throw new OperationError("forbidden", "Your credential does not hold the chat.read scope.");
		}
		const parsed = CustomEmojiName.safeParse(c.req.param("name"));
		if (!parsed.success) throw new OperationError("not_found", "No custom emoji has that name.");
		const row = await call.env.DIRECTORY.prepare(
			"SELECT name, mime_type, size, r2_key FROM chat_custom_emoji WHERE name = ?",
		)
			.bind(parsed.data)
			.first<{ name: string; mime_type: string; size: number; r2_key: string }>();
		if (!row) throw new OperationError("not_found", "No custom emoji has that name.");
		return downloadResponse(c.req.raw, {
			name: row.name,
			size: row.size,
			etag: row.r2_key.slice(row.r2_key.lastIndexOf("/") + 1),
			inlineType: row.mime_type,
			read: async (range) => (await call.env.BLOBS.get(row.r2_key, { range }))?.body ?? null,
		});
	});
}
