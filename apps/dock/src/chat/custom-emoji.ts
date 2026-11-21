import { CUSTOM_EMOJI_LIMITS, type OutputOf, operations } from "@asterra/contracts";
import type { Hono } from "hono";
import { type ApiEnv, callOf, unauthenticatedResponse } from "../api/index.ts";
import { type CallContext, isAdmin } from "../identity/index.ts";
import { base64ToBytes, type HandlerMap, invokeOperation, OperationError, readImageInfo } from "../platform/index.ts";

import { auditOk } from "./room-call.ts";

function requireAdmin(call: CallContext) {
	if (!isAdmin(call.caller)) throw new OperationError("forbidden", "Only an owner or admin can change custom emoji.");
}

export const chatEmojiHandlers = {
	async "chat.list_emoji"(call) {
		const rows = await call.env.DIRECTORY.prepare("SELECT name FROM chat_emoji ORDER BY name").all<{ name: string }>();
		return { names: rows.results.map((row) => row.name) };
	},
	async "chat.get_emoji"(call, { name }) {
		const row = await call.env.DIRECTORY.prepare("SELECT content_base64 FROM chat_emoji WHERE name = ?")
			.bind(name)
			.first<{ content_base64: string }>();
		if (!row) throw new OperationError("not_found", "No emoji has this name.");
		return row;
	},
	async "chat.create_emoji"(call, { name, content_base64 }) {
		requireAdmin(call);
		const bytes = base64ToBytes(content_base64);
		const info = readImageInfo(bytes);
		if (
			bytes.byteLength > CUSTOM_EMOJI_LIMITS.bytes ||
			info?.type !== "image/png" ||
			info.width < 1 ||
			info.height < 1 ||
			Math.max(info.width, info.height) > CUSTOM_EMOJI_LIMITS.side
		) {
			throw new OperationError("invalid", "Use a PNG image up to 32 KiB and 128 pixels per side.");
		}
		const result = await call.env.DIRECTORY.prepare(
			"INSERT INTO chat_emoji (name, content_base64) SELECT ?, ? WHERE (SELECT COUNT(*) FROM chat_emoji) < ? ON CONFLICT(name) DO NOTHING",
		)
			.bind(name, content_base64, CUSTOM_EMOJI_LIMITS.count)
			.run();
		if (result.meta.changes === 0)
			throw new OperationError("conflict", "The name is in use or the emoji catalog is full.");
		auditOk(call, "chat.create_emoji", name);
		return { name };
	},
	async "chat.delete_emoji"(call, { name }) {
		requireAdmin(call);
		const result = await call.env.DIRECTORY.prepare("DELETE FROM chat_emoji WHERE name = ?").bind(name).run();
		if (result.meta.changes > 0) auditOk(call, "chat.delete_emoji", name);
		return { removed: result.meta.changes > 0 };
	},
} satisfies Pick<
	HandlerMap<CallContext>,
	"chat.list_emoji" | "chat.get_emoji" | "chat.create_emoji" | "chat.delete_emoji"
>;

export function mountCustomEmoji(app: Hono<ApiEnv>) {
	app.get("/dl/chat-emoji/:name", async (c) => {
		const call = await callOf(c, { change: false, ownSiteRead: true });
		if (!call) return unauthenticatedResponse(c.var.requestId, new URL(c.req.url).pathname);
		const { content_base64 } = (await invokeOperation(
			operations["chat.get_emoji"],
			chatEmojiHandlers["chat.get_emoji"],
			call,
			{ name: c.req.param("name") },
		)) as OutputOf<"chat.get_emoji">;
		return new Response(new Uint8Array(base64ToBytes(content_base64)), {
			headers: {
				"content-type": "image/png",
				"cache-control": "private, no-cache",
				"x-content-type-options": "nosniff",
				"content-security-policy": "default-src 'none'; sandbox",
				"cross-origin-resource-policy": "same-origin",
			},
		});
	});
}
