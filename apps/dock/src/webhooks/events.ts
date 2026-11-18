// MCP Events on the webhook store: the events that a client can subscribe to, and the subscriptions.
// A subscription of MCP Events is one endpoint and one subscription. The consumer of the webhook queue
// sends its events, with the checks and the retries of each webhook.
import {
	MCP_EVENT_LIMITS,
	type McpEventDefinition,
	mcpEventList,
	mcpEvents,
	WEBHOOK_LIMITS,
	type WebhookDomain,
	webhookScope,
} from "@soldock/contracts";
import { z } from "zod";
import { type CallContext, credentialBinding } from "../identity/index.ts";
import {
	audit,
	base64ToBytes,
	bytesToBase64,
	EventCallbackError,
	type EventDefinition,
	type EventSubscribeInput,
	type EventSubscriptionRef,
	type EventSubscriptions,
	newId,
	OperationError,
	randomToken,
	sameSecret,
	sha256Hex,
} from "../platform/index.ts";
import { webhookSignature } from "./delivery.ts";
import { getDelivery } from "./store.ts";
import { creatableTarget } from "./subscriptions.ts";
import { webhookHostAllowed, webhookUrlProblem } from "./url.ts";

/** The header of MCP Events that names the subscription of a POST. */
export const SUBSCRIPTION_ID_HEADER = "x-mcp-subscription-id";

/**
 * What a product does before its target gets a subscription. Mail and Drive record events only after
 * their object knows that a subscription exists.
 */
export type EventTargetHooks = Partial<Record<WebhookDomain, (call: CallContext, targetId: string) => Promise<void>>>;

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
	const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<
		string,
		unknown
	>;
	return rest;
}

// Built once for each isolate: the catalog does not change at run time.
const DEFINITIONS = new Map<string, EventDefinition>(
	mcpEventList.map((event) => [
		event.name,
		{
			name: event.name,
			description: event.description,
			delivery: ["webhook"],
			inputSchema: jsonSchema(event.input),
			payloadSchema: jsonSchema(event.payload),
		},
	]),
);

/** The event when the credential holds the webhook scope of its product. Else null, as for an unknown name. */
function usableEvent(call: CallContext, name: string): McpEventDefinition | null {
	const event = mcpEvents.get(name);
	return event && call.caller.scopes.has(webhookScope(event.domain)) ? event : null;
}

/** The target and the room filter that the arguments name. The default target is the caller. */
function parseArguments(
	call: CallContext,
	event: McpEventDefinition,
	value: Record<string, unknown>,
): { targetId: string | undefined; roomId: string | null } {
	const parsed = event.input.safeParse(value);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const path = issue?.path.join(".");
		throw new OperationError("invalid", `arguments${path ? `.${path}` : ""}: ${issue?.message ?? "not valid"}`);
	}
	const fields = parsed.data as { mailbox_id?: string; room_id?: string; space_id?: string };
	if (event.domain === "chat") return { targetId: call.caller.id, roomId: fields.room_id ?? null };
	return { targetId: event.domain === "mail" ? fields.mailbox_id : fields.space_id, roomId: null };
}

/**
 * The id of a subscription. The same principal, credential, URL, event and arguments give the same id,
 * so a second events/subscribe refreshes the subscription, and a different credential cannot stop it.
 */
async function subscriptionId(
	call: CallContext,
	url: string,
	name: string,
	targetId: string,
	roomId: string | null,
): Promise<string> {
	const binding = credentialBinding(call.caller);
	const identity = [binding.principalId, binding.kind, binding.id, url, name, targetId, roomId];
	return `sub_${await sha256Hex(JSON.stringify(identity))}`;
}

/** True for `whsec_` and the canonical base64 of a key of an accepted length. */
function validSecret(secret: string): boolean {
	const encoded = /^whsec_([A-Za-z0-9+/]+={0,2})$/.exec(secret)?.[1];
	if (encoded === undefined) return false;
	let bytes: Uint8Array;
	try {
		bytes = base64ToBytes(encoded);
	} catch {
		return false;
	}
	return (
		bytes.length >= MCP_EVENT_LIMITS.secretMinBytes &&
		bytes.length <= MCP_EVENT_LIMITS.secretMaxBytes &&
		bytesToBase64(bytes) === encoded
	);
}

/** The text of a response body, or null when the body has more than `limit` bytes. */
async function readLimited(response: Response, limit: number): Promise<string | null> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const bytes = new Uint8Array(limit);
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (size + value.byteLength > limit) {
			await reader.cancel();
			return null;
		}
		bytes.set(value, size);
		size += value.byteLength;
	}
	return new TextDecoder().decode(bytes.subarray(0, size));
}

/**
 * Proves that the receiver of the URL has the secret and wants the events: sends a signed POST with a
 * random challenge, and requires a 2xx answer that returns the challenge. The POST has no data of the
 * organization. It never follows a redirect.
 */
async function verifyCallback(id: string, url: string, secret: string): Promise<void> {
	const challenge = randomToken(32);
	const body = JSON.stringify({ type: "verification", challenge });
	const messageId = `msg_verification_${randomToken(16)}`;
	const timestamp = String(Math.floor(Date.now() / 1000));
	let status: number;
	let text: string | null;
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"user-agent": "Soldock-Webhooks/1",
				"webhook-id": messageId,
				"webhook-timestamp": timestamp,
				"webhook-signature": await webhookSignature(secret, messageId, timestamp, body),
				[SUBSCRIPTION_ID_HEADER]: id,
			},
			body,
			redirect: "manual",
			signal: AbortSignal.timeout(MCP_EVENT_LIMITS.verifyTimeoutMs),
		});
		status = response.status;
		if (status >= 200 && status < 300) {
			text = await readLimited(response, MCP_EVENT_LIMITS.verifyResponseBytes);
		} else {
			await response.body?.cancel();
			text = null;
		}
	} catch (error) {
		const name = error instanceof Error ? error.name : "";
		throw new EventCallbackError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "unreachable");
	}
	let echoed: unknown;
	try {
		echoed = text === null ? undefined : (JSON.parse(text) as { challenge?: unknown } | null)?.challenge;
	} catch {
		// An answer that is not JSON has no challenge.
	}
	if (typeof echoed !== "string" || !sameSecret(echoed, challenge)) throw new EventCallbackError("challenge_failed");
}

function auditEvents(call: CallContext, op: string, id: string, targetId: string): void {
	audit({
		op,
		actor: call.caller.id,
		actorKind: call.caller.kind,
		credential: call.caller.credential,
		target: id,
		...(targetId === call.caller.id ? {} : { mailbox: targetId }),
		result: "ok",
		requestId: call.requestId,
	});
}

/** The subscriptions of MCP Events. `prepare` has the step of each product before a target gets a subscription. */
export function createEventSubscriptions(prepare: EventTargetHooks = {}): EventSubscriptions<CallContext> {
	async function subscribe(
		call: CallContext,
		input: EventSubscribeInput,
	): Promise<{ id: string; refreshBefore: string }> {
		const event = usableEvent(call, input.name);
		if (!event) throw new OperationError("invalid", "Unknown event, or an event that this credential cannot use.");
		const args = parseArguments(call, event, input.arguments);
		if (!validSecret(input.secret)) {
			throw new OperationError(
				"invalid",
				`delivery.secret must be whsec_ and the base64 of ${MCP_EVENT_LIMITS.secretMinBytes} to ${MCP_EVENT_LIMITS.secretMaxBytes} bytes.`,
			);
		}
		if (webhookUrlProblem(input.url, call.origin)) throw new EventCallbackError("invalid_url");
		const url = new URL(input.url).href;
		const db = call.env.DIRECTORY;
		const { principal } = call.caller;
		const targetId = await creatableTarget(call, args.targetId, event.domain);
		if (args.roomId !== null) {
			// The index is a copy. The room object decides again before each POST.
			const member = await db
				.prepare("SELECT 1 AS member FROM chat_members WHERE principal_id = ? AND room_id = ?")
				.bind(targetId, args.roomId)
				.first();
			if (!member) throw new OperationError("not_found", "No room has that id, or you are not a member.");
		}
		if (!webhookHostAllowed(principal, url)) {
			throw new OperationError(
				"policy_denied",
				`The outbound policy of this agent (${principal.outbound_mode ?? "internal-only"}) does not allow events to ${new URL(url).hostname}. Ask its sponsor to add the host to the allowlist.`,
			);
		}
		const id = await subscriptionId(call, url, event.name, targetId, args.roomId);
		const now = Date.now();
		const nowText = new Date(now).toISOString();

		// A receiver that passed a short time ago, for this principal, URL and secret, needs no new POST.
		const passed = await db
			.prepare(
				`SELECT verified_at FROM webhook_endpoints WHERE created_by = ? AND protocol = 'mcp_events' AND url = ?
				AND secret = ? AND status = 'active' AND verified_at > ? ORDER BY verified_at DESC LIMIT 1`,
			)
			.bind(principal.id, url, input.secret, new Date(now - MCP_EVENT_LIMITS.verifiedMs).toISOString())
			.first<{ verified_at: string }>();
		if (!passed) await verifyCallback(id, url, input.secret);
		const verifiedAt = passed?.verified_at ?? nowText;

		await prepare[event.domain]?.(call, targetId);
		const life =
			typeof input.ttlMs === "number"
				? Math.max(MCP_EVENT_LIMITS.minTtlMs, Math.min(input.ttlMs, MCP_EVENT_LIMITS.ttlMs))
				: MCP_EVENT_LIMITS.ttlMs;
		const expiresAt = new Date(now + life).toISOString();

		/**
		 * Gives the subscription its new end and its new secret. A subscription that stopped starts again.
		 * The limits count the other subscriptions, so a subscription that expired cannot start again above
		 * a limit. The endpoint changes only when the subscription changed.
		 */
		const refresh = async (endpointId: string): Promise<boolean> => {
			const results = await db.batch<{ id: string }>([
				db
					.prepare(
						`UPDATE webhook_subscriptions SET expires_at = ?1, status = 'active', disabled_reason = NULL
						WHERE id = ?2 AND endpoint_id = ?3
						AND (SELECT COUNT(*) FROM webhook_subscriptions s
							JOIN webhook_endpoints e ON e.id = s.endpoint_id
							WHERE e.created_by = ?4 AND e.protocol = 'mcp_events' AND s.expires_at > ?5 AND s.id != ?2) < ?6
						AND (SELECT COUNT(*) FROM webhook_subscriptions s2
							JOIN webhook_endpoints e2 ON e2.id = s2.endpoint_id
							WHERE s2.event_type = ?7 AND s2.target_id = ?8 AND s2.status = 'active' AND e2.status = 'active'
							AND (s2.expires_at IS NULL OR s2.expires_at > ?5) AND s2.id != ?2
							AND (?9 IS NULL OR s2.room_id IS NULL OR s2.room_id = ?9)) < ?10
						RETURNING id`,
					)
					.bind(
						expiresAt,
						id,
						endpointId,
						principal.id,
						nowText,
						MCP_EVENT_LIMITS.subscriptionsPerCreator,
						event.name,
						targetId,
						args.roomId,
						WEBHOOK_LIMITS.perTarget,
					),
				db
					.prepare(
						`UPDATE webhook_endpoints SET
							previous_secret = CASE WHEN secret IS NOT ?1 THEN secret ELSE previous_secret END,
							previous_secret_until = CASE WHEN secret IS NOT ?1 THEN ?2 ELSE previous_secret_until END,
							consecutive_failures = CASE WHEN status = 'disabled' THEN 0 ELSE consecutive_failures END,
							secret = ?1, status = 'active', disabled_reason = NULL, verified_at = ?3
						WHERE id = ?4 AND created_by = ?5 AND protocol = 'mcp_events'
						AND EXISTS (SELECT 1 FROM webhook_subscriptions WHERE id = ?6 AND endpoint_id = ?4 AND expires_at = ?7)`,
					)
					.bind(
						input.secret,
						new Date(now + MCP_EVENT_LIMITS.secretOverlapMs).toISOString(),
						verifiedAt,
						endpointId,
						principal.id,
						id,
						expiresAt,
					),
			]);
			return (results[0]?.results.length ?? 0) > 0;
		};

		const existing = await getDelivery(db, id);
		let stored = existing !== null && (await refresh(existing.endpoint.id));
		if (!stored) {
			const binding = credentialBinding(call.caller);
			const endpointId = newId("whe");
			const results = await db.batch<{ id: string }>([
				// An expired subscription stays for a time, so a late refresh keeps its place. Then it goes.
				db
					.prepare(
						`DELETE FROM webhook_endpoints WHERE protocol = 'mcp_events' AND id IN (
							SELECT endpoint_id FROM webhook_subscriptions WHERE expires_at IS NOT NULL AND expires_at <= ?)`,
					)
					.bind(new Date(now - MCP_EVENT_LIMITS.expiredKeepMs).toISOString()),
				db
					.prepare(
						`INSERT INTO webhook_endpoints (
							id, created_by, credential_kind, credential_id, url, label, secret, created_at, protocol, verified_at)
						SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'mcp_events', ?9
						WHERE (SELECT COUNT(*) FROM webhook_subscriptions s
							JOIN webhook_endpoints e ON e.id = s.endpoint_id
							WHERE e.created_by = ?2 AND e.protocol = 'mcp_events' AND s.expires_at > ?8) < ?10
						AND (SELECT COUNT(*) FROM webhook_subscriptions s2
							JOIN webhook_endpoints e2 ON e2.id = s2.endpoint_id
							WHERE s2.event_type = ?11 AND s2.target_id = ?12 AND s2.status = 'active' AND e2.status = 'active'
							AND (s2.expires_at IS NULL OR s2.expires_at > ?8)
							AND (?13 IS NULL OR s2.room_id IS NULL OR s2.room_id = ?13)) < ?14
						RETURNING id`,
					)
					.bind(
						endpointId,
						principal.id,
						binding.kind,
						binding.id,
						url,
						new URL(url).hostname,
						input.secret,
						nowText,
						verifiedAt,
						MCP_EVENT_LIMITS.subscriptionsPerCreator,
						event.name,
						targetId,
						args.roomId,
						WEBHOOK_LIMITS.perTarget,
					),
				db
					.prepare(
						`INSERT INTO webhook_subscriptions (
							id, endpoint_id, domain, event_type, target_id, credential_kind, credential_id, created_at,
							expires_at, room_id)
						SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
						WHERE EXISTS (SELECT 1 FROM webhook_endpoints WHERE id = ?2)
						ON CONFLICT (id) DO NOTHING RETURNING id`,
					)
					.bind(
						id,
						endpointId,
						event.domain,
						event.name,
						targetId,
						binding.kind,
						binding.id,
						nowText,
						expiresAt,
						args.roomId,
					),
			]);
			const endpointStored = (results[1]?.results.length ?? 0) > 0;
			stored = (results[2]?.results.length ?? 0) > 0;
			if (endpointStored && !stored) {
				// A request at the same time stored this subscription first. Refresh that one.
				await db.prepare("DELETE FROM webhook_endpoints WHERE id = ?").bind(endpointId).run();
				const winner = await getDelivery(db, id);
				stored = winner !== null && (await refresh(winner.endpoint.id));
			}
			if (!stored) {
				throw new OperationError(
					"conflict",
					`You can have at most ${MCP_EVENT_LIMITS.subscriptionsPerCreator} event subscriptions. A target can have at most ${WEBHOOK_LIMITS.perTarget} active subscriptions of one event. Unsubscribe from an event first.`,
				);
			}
		}
		auditEvents(call, "mcp.events_subscribe", id, targetId);
		return { id, refreshBefore: expiresAt };
	}

	async function unsubscribe(call: CallContext, input: EventSubscriptionRef): Promise<void> {
		// A credential without the scope has no subscription, so its answer is the same as for an unknown name.
		const event = mcpEvents.get(input.name);
		if (!event) throw new OperationError("invalid", "Unknown event.");
		const args = parseArguments(call, event, input.arguments);
		let url: string;
		try {
			url = new URL(input.url).href;
		} catch {
			// No subscription has a URL that is not valid.
			return;
		}
		const targetId = args.targetId ?? call.caller.id;
		const id = await subscriptionId(call, url, event.name, targetId, args.roomId);
		const deleted = await call.env.DIRECTORY.prepare(
			`DELETE FROM webhook_endpoints WHERE created_by = ? AND protocol = 'mcp_events'
			AND id IN (SELECT endpoint_id FROM webhook_subscriptions WHERE id = ?) RETURNING id`,
		)
			.bind(call.caller.id, id)
			.first();
		if (deleted) auditEvents(call, "mcp.events_unsubscribe", id, targetId);
	}

	return {
		list(call) {
			return mcpEventList.flatMap((event) => {
				const definition = usableEvent(call, event.name) ? DEFINITIONS.get(event.name) : undefined;
				return definition ? [definition] : [];
			});
		},
		subscribe,
		unsubscribe,
	};
}
