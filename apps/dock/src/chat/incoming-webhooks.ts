import {
	CardsInput,
	CHAT_LIMITS,
	type ChatCard,
	type ChatIncomingWebhook,
	chatIncomingWebhookPath,
} from "@asterra/contracts";
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
	sha256Hex,
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

function stripCtrl(raw: string): string {
	return raw.replace(/\p{Cc}/gu, "").trim();
}

function sanitizeCardId(raw: unknown, fallback: string, used: Set<string>): string {
	const cleaned =
		typeof raw === "string"
			? raw
					.trim()
					.replace(/[^a-zA-Z0-9._-]+/g, "_")
					.replace(/^_+|_+$/g, "")
					.slice(0, 60)
			: "";
	const base = cleaned || fallback;
	let candidate = base;
	let suffix = 2;
	while (used.has(candidate)) {
		candidate = `${base.slice(0, 56)}_${suffix++}`;
	}
	used.add(candidate);
	return candidate;
}

/** Extracts text and validated Asterra cards from a Slack-compatible incoming webhook JSON body. */
function parseSlackPayload(
	raw: unknown,
): { text: string; username: string | undefined; cards: ChatCard[] } | { invalid: string } | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const obj = raw as Record<string, unknown>;
	const parts: string[] = [];
	if (typeof obj.text === "string" && obj.text.trim().length > 0) parts.push(obj.text.trim());
	const cards: ChatCard[] = [];
	const usedCardIds = new Set<string>();

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

	// Slack `attachments` mapped to structured cards (sanitized to satisfy `ChatCard`)
	if (Array.isArray(obj.attachments)) {
		for (let i = 0; i < obj.attachments.length && cards.length < CHAT_LIMITS.cardsPerMessage; i++) {
			const att = obj.attachments[i];
			if (typeof att !== "object" || att === null) continue;
			const a = att as Record<string, unknown>;
			const title = typeof a.title === "string" ? stripCtrl(a.title).slice(0, 200) : "";
			const body =
				typeof a.text === "string"
					? a.text.trim().slice(0, 2000)
					: typeof a.fallback === "string"
						? a.fallback.trim().slice(0, 2000)
						: "";
			const fields: NonNullable<ChatCard["fields"]> = [];
			if (Array.isArray(a.fields)) {
				for (const field of a.fields.slice(0, CHAT_LIMITS.cardFieldsPerCard)) {
					if (typeof field === "object" && field !== null) {
						const f = field as Record<string, unknown>;
						if (typeof f.title === "string" && typeof f.value === "string") {
							const label = stripCtrl(f.title).slice(0, 80);
							const value = stripCtrl(f.value).slice(0, 300);
							if (label && value) fields.push({ label, value });
						}
					}
				}
			}
			const actions: NonNullable<ChatCard["actions"]> = [];
			const usedActionIds = new Set<string>();
			if (Array.isArray(a.actions)) {
				for (let j = 0; j < a.actions.length && actions.length < CHAT_LIMITS.cardActionsPerCard; j++) {
					const act = a.actions[j];
					if (typeof act === "object" && act !== null) {
						const ac = act as Record<string, unknown>;
						const label = typeof ac.text === "string" ? stripCtrl(ac.text).slice(0, 60) : "";
						if (label) {
							const actionId = sanitizeCardId(ac.name, `act_${j + 1}`, usedActionIds);
							const val = typeof ac.value === "string" ? ac.value.slice(0, 200) : undefined;
							actions.push({
								action_id: actionId,
								label,
								style: ac.style === "primary" ? "primary" : ac.style === "danger" ? "danger" : "default",
								...(val !== undefined ? { value: val } : {}),
							});
						}
					}
				}
			}
			if (title || body || fields.length > 0 || actions.length > 0) {
				cards.push({
					id: sanitizeCardId(a.id, `card_${i + 1}`, usedCardIds),
					title: title || "Attachment",
					...(body ? { text: body } : {}),
					...(fields.length > 0 ? { fields } : {}),
					...(actions.length > 0 ? { actions } : {}),
				});
			}
		}
	}

	// Native `cards` array if caller passes Asterra format: validate strictly against `CardsInput`.
	if (obj.cards !== undefined && cards.length === 0) {
		const parsedCards = CardsInput.safeParse(obj.cards);
		if (!parsedCards.success) {
			return { invalid: `Invalid cards payload: ${parsedCards.error.issues[0]?.message ?? "schema mismatch"}` };
		}
		cards.push(...parsedCards.data);
	}

	// Final invariant check: never allow an unparseable card into room storage.
	if (cards.length > 0) {
		const checked = CardsInput.safeParse(cards);
		if (!checked.success) {
			return { invalid: `Invalid cards payload: ${checked.error.issues[0]?.message ?? "schema mismatch"}` };
		}
	}

	const text = parts.join("\n").slice(0, CHAT_LIMITS.messageChars);
	if (text.length === 0 && cards.length === 0) return null;
	const username =
		typeof obj.username === "string" && stripCtrl(obj.username) ? stripCtrl(obj.username).slice(0, 80) : undefined;
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
		if ("invalid" in payload) {
			return new OperationError("invalid", payload.invalid).toResponse({ instance, requestId });
		}

		const replayKey = await sha256Hex(`${tsHeader}.${rawBody}`);
		const messageId = newId("cmsg");
		const displayName = payload.username ? `${hook.name} (${payload.username})`.slice(0, 120) : hook.name;
		const res = await c.env.CHAT_ROOM.get(c.env.CHAT_ROOM.idFromName(hook.room_id)).postIncomingWebhook({
			roomId: hook.room_id,
			messageId,
			replayKey,
			author: { principal_id: hook.id, kind: "agent", display_name: displayName },
			text: payload.text,
			cards: payload.cards,
		});
		if ("error" in res) {
			// Hide whether a webhook's target room was deleted vs unknown webhook id.
			if (res.error.code === "not_found") {
				return new OperationError("unauthenticated", "Invalid webhook or signature.").toResponse({
					instance,
					requestId,
				});
			}
			return new OperationError(res.error.code, res.error.message).toResponse({ instance, requestId });
		}
		if (!res.duplicate) {
			audit({
				op: "chat.incoming_webhook.post",
				actor: hook.id,
				actorKind: "agent",
				credential: "webhook",
				target: `${hook.room_id}:${res.message.id}`,
				result: "ok",
				requestId,
			});
		}
		log("info", "chat incoming webhook delivered", {
			webhookId: hook.id,
			roomId: hook.room_id,
			messageId: res.message.id,
			duplicate: res.duplicate,
		});
		return c.json({ ok: true, message_id: res.message.id, room_id: hook.room_id, untrusted: true }, 200);
	});
}
