// MCP Events on the webhook store: the events that a client can subscribe to, and the subscriptions.
// A subscription of MCP Events is one endpoint and one subscription. The consumer of the webhook queue
// sends its events, with the checks and the retries of each webhook.
import {
	type ChatWebhookFilter,
	defaultChatWebhookFilter,
	MCP_EVENT_LIMITS,
	type McpEventDefinition,
	mcpEventList,
	mcpEvents,
	WEBHOOK_LIMITS,
	type WebhookDomain,
	webhookScope,
} from "@asterra/contracts";
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
	isSealed,
	newId,
	OperationError,
	openSecret,
	randomToken,
	sameSecret,
	sealSecret,
	sha256Hex,
} from "../platform/index.ts";
import { webhookSignature } from "./delivery.ts";
import { ENDPOINT_SEAL, type EndpointRow, getDelivery, targetLoadSql } from "./store.ts";
import { creatableTarget } from "./subscriptions.ts";
import { outboundHostAllowed, webhookUrlProblem } from "./url.ts";

/** The header of MCP Events that names the subscription of a POST. */
export const SUBSCRIPTION_ID_HEADER = "x-mcp-subscription-id";

/**
 * What a product does before its target gets a subscription. Mail, Drive and Calendar send events only after
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

/**
 * The event when the credential holds the webhook scope of its product. Else null, as for an unknown name.
 * A calendar event also needs `calendar.read`: the event tells about an event that the credential can read.
 */
function usableEvent(call: CallContext, name: string): McpEventDefinition | null {
	const event = mcpEvents.get(name);
	if (!event || !call.caller.scopes.has(webhookScope(event.domain))) return null;
	if (event.domain === "calendar" && !call.caller.scopes.has("calendar.read")) return null;
	return event;
}

/**
 * The target, the room and the message filter that the arguments name. The default target is the caller.
 * `filter` is null when the arguments do not have it, and for Mail and Drive, which have no filter.
 */
function parseArguments(
	call: CallContext,
	event: McpEventDefinition,
	value: Record<string, unknown>,
): { targetId: string | undefined; roomId: string | null; filter: ChatWebhookFilter | null } {
	const parsed = event.input.safeParse(value);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const path = issue?.path.join(".");
		throw new OperationError("invalid", `arguments${path ? `.${path}` : ""}: ${issue?.message ?? "not valid"}`);
	}
	const fields = parsed.data as {
		mailbox_id?: string;
		room_id?: string;
		space_id?: string;
		calendar_id?: string;
		filter?: ChatWebhookFilter;
	};
	if (event.domain === "chat") {
		return { targetId: call.caller.id, roomId: fields.room_id ?? null, filter: fields.filter ?? null };
	}
	const targetId =
		event.domain === "mail" ? fields.mailbox_id : event.domain === "calendar" ? fields.calendar_id : fields.space_id;
	return { targetId, roomId: null, filter: null };
}

/**
 * The id of a subscription. The same principal, credential, URL, event, target and room give the same id,
 * so a second events/subscribe refreshes the subscription, and a different credential cannot stop it.
 * The message filter of Chat is not a part of the id: a refresh with a different filter changes the
 * filter, and a refresh without a filter keeps a filter that the client set. So one URL never gets one
 * message from two subscriptions that differ only in the filter.
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
				"user-agent": "Asterra-Webhooks/1",
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

const HOUR_MS = 60 * 60 * 1000;

/**
 * Counts one verification POST for the principal. A caller can change the secret or the path for each
 * call, so each call can cause a POST to a public host. This count limits those POSTs in one hour.
 */
async function countVerification(db: D1Database, principalId: string, now: number): Promise<void> {
	const counted = await db
		.prepare(
			`INSERT INTO mcp_event_verifications (principal_id, window_start, count) VALUES (?1, ?2, 1)
			ON CONFLICT (principal_id) DO UPDATE SET
				count = CASE WHEN window_start <= ?3 THEN 1 ELSE count + 1 END,
				window_start = CASE WHEN window_start <= ?3 THEN ?2 ELSE window_start END
			WHERE window_start <= ?3 OR count < ?4
			RETURNING count`,
		)
		.bind(principalId, now, now - HOUR_MS, MCP_EVENT_LIMITS.verificationsPerHour)
		.first();
	if (!counted) {
		throw new OperationError(
			"rate_limited",
			`You can verify at most ${MCP_EVENT_LIMITS.verificationsPerHour} callbacks in one hour. Try again later.`,
		);
	}
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
		// The form of the secret for the directory. A wrong ENCRYPTION_KEY stops the call here, before a POST.
		const sealedSecret = await sealSecret(call.env, ENDPOINT_SEAL.secret, input.secret);
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
		if (!outboundHostAllowed(principal, url)) {
			throw new OperationError(
				"policy_denied",
				`The outbound policy of this agent (${principal.outbound_mode ?? "internal-only"}) does not allow events to ${new URL(url).hostname}. Ask its sponsor to add the host to the allowlist.`,
			);
		}
		const id = await subscriptionId(call, url, event.name, targetId, args.roomId);
		const now = Date.now();
		const nowText = new Date(now).toISOString();

		// A receiver that passed a short time ago, for this principal, URL and secret, needs no new POST.
		// A stored secret can be sealed, so the compare of the secret is here and not in SQL.
		const { results: verified } = await db
			.prepare(
				`SELECT secret, verified_at FROM webhook_endpoints WHERE created_by = ? AND protocol = 'mcp_events' AND url = ?
				AND status = 'active' AND verified_at > ? ORDER BY verified_at DESC`,
			)
			.bind(principal.id, url, new Date(now - MCP_EVENT_LIMITS.verifiedMs).toISOString())
			.all<{ secret: string; verified_at: string }>();
		let passed: { verified_at: string } | null = null;
		for (const row of verified) {
			const opened = await openSecret(call.env, ENDPOINT_SEAL.secret, row.secret);
			if (opened.ok && sameSecret(opened.value, input.secret)) {
				passed = row;
				break;
			}
		}
		if (!passed) {
			await countVerification(db, principal.id, now);
			await verifyCallback(id, url, input.secret);
		}
		const verifiedAt = passed?.verified_at ?? nowText;

		await prepare[event.domain]?.(call, targetId);
		const life =
			typeof input.ttlMs === "number"
				? Math.max(MCP_EVENT_LIMITS.minTtlMs, Math.min(input.ttlMs, MCP_EVENT_LIMITS.ttlMs))
				: MCP_EVENT_LIMITS.ttlMs;
		const expiresAt = new Date(now + life).toISOString();
		// The filter of a chat subscription without `filter` in the arguments. Mail and Drive have no filter.
		const defaultFilter = event.domain === "chat" ? defaultChatWebhookFilter(call.caller.principal.kind) : "all";

		/**
		 * Gives the subscription its new end and its new secret. A subscription that stopped starts again.
		 * A filter in the arguments replaces the filter, and the subscription records that the client set it.
		 * Without one, the subscription keeps a filter that the client set. A subscription with the default
		 * gets the default of the caller: a subscription of an agent from before the filter changes from `all`
		 * to `addressed`, so an agent does not start a turn for each message of each room.
		 * The limits count the other subscriptions, so a subscription that expired cannot start again above
		 * a limit. The endpoint changes only when the subscription changed.
		 *
		 * A stored secret can be sealed, so SQL cannot compare it with the new secret. `endpoint` has the stored
		 * secret of a read before this write. The secret changed when that secret is not the new secret, or when
		 * a different write replaced it after the read. A stored secret that does not open counts as changed.
		 */
		const refresh = async (endpoint: EndpointRow): Promise<boolean> => {
			const endpointId = endpoint.id;
			const current = await openSecret(call.env, ENDPOINT_SEAL.secret, endpoint.secret);
			const changed = !current.ok || !sameSecret(current.value, input.secret);
			// The current secret becomes the previous secret. A plaintext secret from before ENCRYPTION_KEY is
			// sealed on the way, so the refresh leaves no plaintext copy.
			const previous =
				current.ok && !isSealed(endpoint.secret)
					? await sealSecret(call.env, ENDPOINT_SEAL.secret, current.value)
					: endpoint.secret;
			const results = await db.batch<{ id: string }>([
				db
					.prepare(
						`UPDATE webhook_subscriptions SET expires_at = ?1, status = 'active', disabled_reason = NULL,
							chat_filter = CASE WHEN ?11 IS NOT NULL THEN ?11 WHEN chat_filter_explicit = 1 THEN chat_filter ELSE ?12 END,
							chat_filter_explicit = CASE WHEN ?11 IS NOT NULL THEN 1 ELSE chat_filter_explicit END
						WHERE id = ?2 AND endpoint_id = ?3
						AND (SELECT COUNT(*) FROM webhook_subscriptions s
							JOIN webhook_endpoints e ON e.id = s.endpoint_id
							WHERE e.created_by = ?4 AND e.protocol = 'mcp_events' AND s.expires_at > ?5 AND s.id != ?2) < ?6
						AND ${targetLoadSql({ event: "?7", target: "?8", now: "?5", room: "?9", except: "?2" })} < ?10
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
						args.filter,
						defaultFilter,
					),
				db
					.prepare(
						`UPDATE webhook_endpoints SET
							previous_secret = CASE WHEN secret IS NOT ?10 THEN secret WHEN ?9 THEN ?11
								WHEN previous_secret_until <= ?8 THEN NULL ELSE previous_secret END,
							previous_secret_until = CASE WHEN (?9 OR secret IS NOT ?10) THEN ?2
								WHEN previous_secret_until <= ?8 THEN NULL ELSE previous_secret_until END,
							consecutive_failures = CASE WHEN status = 'disabled' THEN 0 ELSE consecutive_failures END,
							secret = ?1, status = 'active', disabled_reason = NULL, verified_at = ?3
						WHERE id = ?4 AND created_by = ?5 AND protocol = 'mcp_events'
						AND EXISTS (SELECT 1 FROM webhook_subscriptions WHERE id = ?6 AND endpoint_id = ?4 AND expires_at = ?7)`,
					)
					.bind(
						sealedSecret,
						new Date(now + MCP_EVENT_LIMITS.secretOverlapMs).toISOString(),
						verifiedAt,
						endpointId,
						principal.id,
						id,
						expiresAt,
						nowText,
						changed ? 1 : 0,
						endpoint.secret,
						previous,
					),
			]);
			return (results[0]?.results.length ?? 0) > 0;
		};

		const existing = await getDelivery(db, id);
		let stored = existing !== null && (await refresh(existing.endpoint));
		if (!stored) {
			const binding = credentialBinding(call.caller);
			const endpointId = newId("whe");
			const results = await db.batch<{ id: string }>([
				// An expired subscription stays for a time, so a late refresh keeps its place. Then it goes, with
				// its secret. An endpoint also goes when its subscription went with the target of the subscription.
				db
					.prepare(
						`DELETE FROM webhook_endpoints WHERE protocol = 'mcp_events' AND (
							id IN (SELECT endpoint_id FROM webhook_subscriptions WHERE expires_at IS NOT NULL AND expires_at <= ?)
							OR NOT EXISTS (SELECT 1 FROM webhook_subscriptions s WHERE s.endpoint_id = webhook_endpoints.id))`,
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
						AND ${targetLoadSql({ event: "?11", target: "?12", now: "?8", room: "?13" })} < ?14
						RETURNING id`,
					)
					.bind(
						endpointId,
						principal.id,
						binding.kind,
						binding.id,
						url,
						new URL(url).hostname,
						sealedSecret,
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
							expires_at, room_id, chat_filter, chat_filter_explicit)
						SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
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
						// Without `filter`, an agent gets only the messages for it.
						args.filter ?? defaultFilter,
						args.filter === null ? 0 : 1,
					),
			]);
			const endpointStored = (results[1]?.results.length ?? 0) > 0;
			stored = (results[2]?.results.length ?? 0) > 0;
			if (endpointStored && !stored) {
				// A request at the same time stored this subscription first. Refresh that one.
				await db.prepare("DELETE FROM webhook_endpoints WHERE id = ?").bind(endpointId).run();
				const winner = await getDelivery(db, id);
				stored = winner !== null && (await refresh(winner.endpoint));
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
		async subscribe(call, input) {
			try {
				return await subscribe(call, input);
			} catch (error) {
				// The audit of a refused change, as for each operation.
				if (error instanceof OperationError && (error.code === "forbidden" || error.code === "policy_denied")) {
					audit({
						op: "mcp.events_subscribe",
						actor: call.caller.id,
						actorKind: call.caller.kind,
						credential: call.caller.credential,
						result: "denied",
						code: error.code,
						requestId: call.requestId,
					});
				}
				throw error;
			}
		},
		unsubscribe,
	};
}
