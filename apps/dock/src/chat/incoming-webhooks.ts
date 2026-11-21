import { CHAT_LIMITS, type ChatCard, type ChatIncomingWebhook, chatIncomingWebhookPath } from "@asterra/contracts";
import type { Hono } from "hono";
import type { ApiEnv } from "../api/index.ts";
import type { CallContext } from "../identity/index.ts";
import {
	audit,
	hmacSha256,
	log,
	newId,
	OperationError,
	randomToken,
	readBodyText,
	sameSecret,
} from "../platform/index.ts";

// Incoming webhooks for Chat rooms. External systems POST Slack-compatible JSON payloads to
// `POST /hooks/chat/:webhook_id` signed with HMAC-SHA256 (`X-Slack-Request-Timestamp` and
// `X-Slack-Signature: v0=<hex>`). No secret ever appears in the URL. Every message posted
// through an incoming webhook is stored with `untrusted: true`.

const REPLAY_WINDOW_SECONDS = 300;
const MAX_HOOK_BYTES = 64 * 1024;

interface WebhookRow {
	id: string;
	room_id: string;
	name: string;
	signing_secret: string;
	created_by: string;
	created_at: number;
}

function toIncomingWebhook(row: WebhookRow): ChatIncomingWebhook {
	return {
		id: row.id,
		room_id: row.room_id,
		name: row.name,
		url_path: chatIncomingWebhookPath(row.id),
		created_by: row.created_by,
		created_at: new Date(row.created_at).toISOString(),
	};
}

function bytesToHex(bytes: Uint8Array): string {
	let hex = "";
	for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
	return hex;
}

/** Computes a Slack-compatible v0 HMAC-SHA256 signature for `v0:${timestamp}:${rawBody}`. */
export async function slackSignature(secret: string, timestamp: string, rawBody: string): Promise<string> {
	const digest = await hmacSha256(new TextEncoder().encode(secret), `v0:${timestamp}:${rawBody}`);
	return `v0=${bytesToHex(digest)}`;
}

export async function createIncomingWebhook(
	call: CallContext,
	input: { room_id: string; name: string },
): Promise<{ webhook: ChatIncomingWebhook; signing_secret: string }> {
	const countRow = await call.env.DIRECTORY.prepare(
		"SELECT COUNT(*) AS n FROM chat_incoming_webhooks WHERE room_id = ?",
	)
		.bind(input.room_id)
		.first<{ n: number }>();
	if ((countRow?.n ?? 0) >= CHAT_LIMITS.incomingWebhooksPerRoom) {
		throw new OperationError(
			"conflict",
			`A room can have ${CHAT_LIMITS.incomingWebhooksPerRoom} incoming webhooks at most.`,
		);
	}
	const id = newId("iwh");
	const signingSecret = `whsec_${randomToken(32)}`;
	const now = Date.now();
	await call.env.DIRECTORY.prepare(
		`INSERT INTO chat_incoming_webhooks (id, room_id, name, signing_secret, created_by, created_at)
		VALUES (?, ?, ?, ?, ?, ?)`,
	)
		.bind(id, input.room_id, input.name, signingSecret, call.caller.id, now)
		.run();
	audit({
		op: "chat.create_incoming_webhook",
		actor: call.caller.id,
		actorKind: call.caller.kind,
		credential: call.caller.credential,
		target: `${input.room_id}:${id}`,
		result: "ok",
		requestId: call.requestId,
	});
	return {
		webhook: {
			id,
			room_id: input.room_id,
			name: input.name,
			url_path: chatIncomingWebhookPath(id),
			created_by: call.caller.id,
			created_at: new Date(now).toISOString(),
		},
		signing_secret: signingSecret,
	};
}

export async function listIncomingWebhooks(db: D1Database, roomId: string): Promise<ChatIncomingWebhook[]> {
	const { results } = await db
		.prepare(
			"SELECT id, room_id, name, signing_secret, created_by, created_at FROM chat_incoming_webhooks WHERE room_id = ? ORDER BY created_at DESC, id DESC",
		)
		.bind(roomId)
		.all<WebhookRow>();
	return results.map(toIncomingWebhook);
}

export async function getIncomingWebhookRoom(db: D1Database, webhookId: string): Promise<string | null> {
	const row = await db
		.prepare("SELECT room_id FROM chat_incoming_webhooks WHERE id = ?")
		.bind(webhookId)
		.first<{ room_id: string }>();
	return row?.room_id ?? null;
}

export async function deleteIncomingWebhook(call: CallContext, roomId: string, webhookId: string): Promise<boolean> {
	const res = await call.env.DIRECTORY.prepare("DELETE FROM chat_incoming_webhooks WHERE id = ? AND room_id = ?")
		.bind(webhookId, roomId)
		.run();
	const deleted = (res.meta.changes ?? 0) > 0;
	if (deleted) {
		audit({
			op: "chat.delete_incoming_webhook",
			actor: call.caller.id,
			actorKind: call.caller.kind,
			credential: call.caller.credential,
			target: `${roomId}:${webhookId}`,
			result: "ok",
			requestId: call.requestId,
		});
	}
	return deleted;
}

/** Extracts text and optional Asterra cards from a Slack-compatible incoming webhook JSON body. */
function parseSlackPayload(raw: unknown): { text: string; username: string | undefined; cards: ChatCard[] } | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const obj = raw as Record<string, unknown>;
	const parts: string[] = [];
	if (typeof obj.text === "string" && obj.text.trim().length > 0) parts.push(obj.text.trim());
	const cards: ChatCard[] = [];

	// Slack `blocks` (section / header)
	if (Array.isArray(obj.blocks)) {
		for (let i = 0; i < obj.blocks.length; i++) {
			const block = obj.blocks[i];
			if (typeof block !== "object" || block === null) continue;
			const b = block as Record<string, unknown>;
			if (b.type === "header" || b.type === "section") {
				const textObj = b.text as Record<string, unknown> | undefined;
				if (textObj && typeof textObj.text === "string" && textObj.text.trim().length > 0) {
					parts.push(textObj.text.trim());
				}
			}
		}
	}

	// Slack `attachments` mapped to structured cards
	if (Array.isArray(obj.attachments)) {
		for (let i = 0; i < obj.attachments.length && cards.length < CHAT_LIMITS.cardsPerMessage; i++) {
			const att = obj.attachments[i];
			if (typeof att !== "object" || att === null) continue;
			const a = att as Record<string, unknown>;
			const title = typeof a.title === "string" ? a.title.trim().slice(0, 200) : "";
			const body =
				typeof a.text === "string"
					? a.text.trim().slice(0, 2000)
					: typeof a.fallback === "string"
						? a.fallback.trim().slice(0, 2000)
						: "";
			const fields: NonNullable<ChatCard["fields"]> = [];
			if (Array.isArray(a.fields)) {
				for (const field of a.fields.slice(0, 10)) {
					if (typeof field === "object" && field !== null) {
						const f = field as Record<string, unknown>;
						if (typeof f.title === "string" && typeof f.value === "string") {
							fields.push({ label: f.title.slice(0, 80), value: f.value.slice(0, 300) });
						}
					}
				}
			}
			const actions: NonNullable<ChatCard["actions"]> = [];
			if (Array.isArray(a.actions)) {
				for (let j = 0; j < a.actions.length && actions.length < CHAT_LIMITS.cardActionsPerCard; j++) {
					const act = a.actions[j];
					if (typeof act === "object" && act !== null) {
						const ac = act as Record<string, unknown>;
						const label = typeof ac.text === "string" ? ac.text.trim().slice(0, 60) : "";
						if (label) {
							actions.push({
								action_id: typeof ac.name === "string" && ac.name.trim() ? ac.name.trim().slice(0, 64) : `act_${j + 1}`,
								label,
								style: ac.style === "primary" ? "primary" : ac.style === "danger" ? "danger" : "default",
								value: typeof ac.value === "string" ? ac.value.slice(0, 200) : "",
							});
						}
					}
				}
			}
			if (title || body || fields.length > 0 || actions.length > 0) {
				cards.push({
					id: `card_${i + 1}`,
					title: title || "Attachment",
					...(body ? { text: body } : {}),
					...(fields.length > 0 ? { fields } : {}),
					...(actions.length > 0 ? { actions } : {}),
				});
			}
		}
	}

	// Native `cards` array if caller passes Asterra format
	if (Array.isArray(obj.cards) && cards.length === 0) {
		for (let i = 0; i < obj.cards.length && cards.length < CHAT_LIMITS.cardsPerMessage; i++) {
			const c = obj.cards[i];
			if (typeof c === "object" && c !== null) {
				const card = c as Record<string, unknown>;
				const id = typeof card.id === "string" && card.id.trim() ? card.id.trim().slice(0, 64) : `card_${i + 1}`;
				const title = typeof card.title === "string" && card.title.trim() ? card.title.trim().slice(0, 200) : "Card";
				const body = typeof card.text === "string" ? card.text.slice(0, 2000) : undefined;
				const actions: NonNullable<ChatCard["actions"]> = Array.isArray(card.actions)
					? card.actions
							.slice(0, CHAT_LIMITS.cardActionsPerCard)
							.filter(
								(a): a is Record<string, unknown> =>
									typeof a === "object" && a !== null && typeof (a as Record<string, unknown>).label === "string",
							)
							.map((a, idx) => ({
								action_id:
									typeof a.action_id === "string" && a.action_id.trim()
										? a.action_id.trim().slice(0, 64)
										: `act_${idx + 1}`,
								label: String(a.label).slice(0, 60),
								style: a.style === "primary" ? "primary" : a.style === "danger" ? "danger" : "default",
								value: typeof a.value === "string" ? a.value.slice(0, 200) : "",
							}))
					: [];
				cards.push({
					id,
					title,
					...(body ? { text: body } : {}),
					...(actions.length > 0 ? { actions } : {}),
				});
			}
		}
	}

	const text = parts.join("\n").slice(0, CHAT_LIMITS.messageChars);
	if (text.length === 0 && cards.length === 0) return null;
	const username =
		typeof obj.username === "string" && obj.username.trim() ? obj.username.trim().slice(0, 80) : undefined;
	return { text, username, cards };
}

/** Mounts Slack-compatible signed incoming webhooks at `POST /hooks/chat/:webhook_id`. */
export function mountChatIncomingWebhooks(app: Hono<ApiEnv>): void {
	app.post("/hooks/chat/:webhook_id", async (c) => {
		const webhookId = c.req.param("webhook_id");
		const instance = new URL(c.req.url).pathname;
		const requestId = c.var.requestId;

		const tsHeader = c.req.header("x-slack-request-timestamp") ?? "";
		const sigHeader = c.req.header("x-slack-signature") ?? "";
		const ts = Number(tsHeader);
		if (!/^\d+$/.test(tsHeader) || !Number.isFinite(ts)) {
			return new OperationError("unauthenticated", "Missing or invalid X-Slack-Request-Timestamp header.").toResponse({
				instance,
				requestId,
			});
		}
		const nowSec = Math.floor(Date.now() / 1000);
		if (Math.abs(nowSec - ts) > REPLAY_WINDOW_SECONDS) {
			return new OperationError(
				"unauthenticated",
				"Webhook request timestamp is outside the allowed replay window.",
			).toResponse({ instance, requestId });
		}
		if (!sigHeader.startsWith("v0=")) {
			return new OperationError("unauthenticated", "Missing or invalid X-Slack-Signature header.").toResponse({
				instance,
				requestId,
			});
		}

		let rawBody: string;
		try {
			rawBody = await readBodyText(c.req.raw, MAX_HOOK_BYTES);
		} catch (error) {
			if (error instanceof OperationError) return error.toResponse({ instance, requestId });
			throw error;
		}

		const hook = await c.env.DIRECTORY.prepare(
			"SELECT id, room_id, name, signing_secret, created_by, created_at FROM chat_incoming_webhooks WHERE id = ?",
		)
			.bind(webhookId)
			.first<WebhookRow>();
		if (!hook) {
			return new OperationError("unauthenticated", "Invalid webhook or signature.").toResponse({ instance, requestId });
		}

		const expected = await slackSignature(hook.signing_secret, tsHeader, rawBody);
		if (!sameSecret(sigHeader, expected)) {
			return new OperationError("unauthenticated", "Invalid webhook or signature.").toResponse({ instance, requestId });
		}

		let parsedJson: unknown;
		try {
			parsedJson = JSON.parse(rawBody);
		} catch {
			return new OperationError("invalid", "Incoming webhook payload must be valid JSON.").toResponse({
				instance,
				requestId,
			});
		}
		const payload = parseSlackPayload(parsedJson);
		if (!payload) {
			return new OperationError(
				"invalid",
				"Incoming webhook payload needs text, blocks, attachments, or cards.",
			).toResponse({ instance, requestId });
		}

		const messageId = newId("cmsg");
		const displayName = payload.username ? `${hook.name} (${payload.username})`.slice(0, 120) : hook.name;
		const res = await c.env.CHAT_ROOM.get(c.env.CHAT_ROOM.idFromName(hook.room_id)).postIncomingWebhook({
			roomId: hook.room_id,
			messageId,
			author: { principal_id: hook.id, kind: "agent", display_name: displayName },
			text: payload.text,
			cards: payload.cards,
		});
		if ("error" in res) {
			return new OperationError(res.error.code, res.error.message).toResponse({ instance, requestId });
		}
		log("info", "chat incoming webhook delivered", { webhookId: hook.id, roomId: hook.room_id, messageId });
		return c.json({ ok: true, message_id: res.message.id, room_id: hook.room_id, untrusted: true }, 200);
	});
}
