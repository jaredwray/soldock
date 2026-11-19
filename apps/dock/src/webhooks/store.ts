import { WEBHOOK_LIMITS, type WebhookDomain, type WebhookEndpoint, type WebhookEvent } from "@asterra/contracts";
import type { CredentialBinding } from "../identity/index.ts";
import { audit, bytesToBase64, log } from "../platform/index.ts";
import { adoptChatBoundary } from "./legacy.ts";

export type EndpointDisabledReason = NonNullable<WebhookEndpoint["disabled_reason"]>;
export type SubscriptionDisabledReason = "access_lost" | "credential_revoked";

/** An endpoint as the directory stores it. The secret, the auth key and the header value stay here. */
export interface EndpointRow {
	id: string;
	created_by: string;
	credential_kind: CredentialBinding["kind"];
	credential_id: string | null;
	url: string;
	label: string;
	secret: string;
	status: "active" | "disabled";
	disabled_reason: EndpointDisabledReason | null;
	consecutive_failures: number;
	last_failed_delivery_id: string | null;
	last_delivery_at: string | null;
	last_failure_at: string | null;
	last_error: string | null;
	auth_key: string | null;
	header_name: string | null;
	header_value: string | null;
	created_at: string;
	/** `mcp_events`: an MCP client created the row with events/subscribe. The webhook operations do not show it. */
	protocol: "webhook" | "mcp_events";
	/** The secret that a refresh replaced. A POST has its signature too until `previous_secret_until`. */
	previous_secret: string | null;
	previous_secret_until: string | null;
	/** The time of the last callback verification that the receiver passed. */
	verified_at: string | null;
}

/** A subscription as the directory stores it. `target_id` is a mailbox, a principal or a drive. */
export interface SubscriptionRow {
	sequence: number;
	id: string;
	endpoint_id: string;
	domain: WebhookDomain;
	event_type: WebhookEvent;
	target_id: string;
	credential_kind: CredentialBinding["kind"];
	credential_id: string | null;
	status: "active" | "disabled";
	disabled_reason: SubscriptionDisabledReason | null;
	retry_until: string | null;
	retry_event_id: string | null;
	created_at: string;
	/** Null: no end. After this time the subscription sends nothing. */
	expires_at: string | null;
	/** Chat only. Null: each room of the target. Else only this room. */
	room_id: string | null;
}

export const ENDPOINT_COLUMNS = `id, created_by, credential_kind, credential_id, url, label, secret, status,
	disabled_reason, consecutive_failures, last_failed_delivery_id, last_delivery_at, last_failure_at, last_error,
	auth_key, header_name, header_value, created_at, protocol, previous_secret, previous_secret_until, verified_at`;

export const SUBSCRIPTION_COLUMNS = `sequence, id, endpoint_id, domain, event_type, target_id, credential_kind,
	credential_id, status, disabled_reason, retry_until, retry_event_id, created_at, expires_at, room_id`;

/** The subscription columns with a table alias, for a query that joins the endpoint. */
export function subscriptionColumns(alias: string): string {
	return SUBSCRIPTION_COLUMNS.split(",")
		.map((column) => `${alias}.${column.trim()}`)
		.join(", ");
}

export function toEndpoint(row: EndpointRow): WebhookEndpoint {
	return {
		id: row.id,
		url: row.url,
		label: row.label,
		created_by: row.created_by,
		status: row.status,
		disabled_reason: row.disabled_reason,
		consecutive_failures: row.consecutive_failures,
		last_delivery_at: row.last_delivery_at,
		last_failure_at: row.last_failure_at,
		last_error: row.last_error,
		has_auth_key: row.auth_key !== null,
		header_name: row.header_name,
		created_at: row.created_at,
	};
}

/** A signing secret as Standard Webhooks specifies: `whsec_` and the base64 of 32 random bytes. */
export function newSecret(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return `whsec_${bytesToBase64(bytes)}`;
}

export async function getEndpoint(db: D1Database, id: string): Promise<EndpointRow | null> {
	return db.prepare(`SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints WHERE id = ?`).bind(id).first<EndpointRow>();
}

export async function getSubscription(db: D1Database, id: string): Promise<SubscriptionRow | null> {
	return db
		.prepare(`SELECT ${SUBSCRIPTION_COLUMNS} FROM webhook_subscriptions WHERE id = ?`)
		.bind(id)
		.first<SubscriptionRow>();
}

/** The kinds of subscription on an endpoint. */
export async function endpointDomains(db: D1Database, endpointId: string): Promise<WebhookDomain[]> {
	const { results } = await db
		.prepare("SELECT DISTINCT domain FROM webhook_subscriptions WHERE endpoint_id = ?")
		.bind(endpointId)
		.all<{ domain: WebhookDomain }>();
	return results.map((row) => row.domain);
}

export async function subscriptionIdsForEndpoint(db: D1Database, endpointId: string): Promise<string[]> {
	const { results } = await db
		.prepare("SELECT id FROM webhook_subscriptions WHERE endpoint_id = ?")
		.bind(endpointId)
		.all<{ id: string }>();
	return results.map((row) => row.id);
}

/**
 * The last committed chat subscription. A message records this boundary before its room transaction.
 * The copy and this read are one batch. A row that commits later gets a later sequence.
 */
export async function chatWebhookBoundary(db: D1Database): Promise<number> {
	return adoptChatBoundary(db);
}

/** The last drive subscription for one target. A drive change records this before it commits. */
export async function driveWebhookBoundary(db: D1Database, targetId: string): Promise<number> {
	const row = await db
		.prepare(
			"SELECT COALESCE(MAX(sequence), 0) AS boundary FROM webhook_subscriptions WHERE domain = 'drive' AND target_id = ?",
		)
		.bind(targetId)
		.first<{ boundary: number }>();
	return row?.boundary ?? 0;
}

export interface ActiveSubscription {
	id: string;
	target_id: string;
	created_by: string;
	sequence: number;
}

/**
 * SQL for the most POST requests that one event of one target can make: the active subscriptions for
 * all rooms, and the largest group of active subscriptions for one room. Each argument is the SQL of a
 * value, such as `?4`. With `room`, only that room counts, for a subscription of that room. `except`
 * leaves out one subscription, for a refresh of that subscription. Mail and Drive have no room.
 */
export function targetLoadSql(value: {
	event: string;
	target: string;
	now: string;
	room?: string;
	except?: string;
}): string {
	const active = `FROM webhook_subscriptions s2 JOIN webhook_endpoints e2 ON e2.id = s2.endpoint_id
		WHERE s2.event_type = ${value.event} AND s2.target_id = ${value.target}
		AND s2.status = 'active' AND e2.status = 'active'
		AND (s2.expires_at IS NULL OR s2.expires_at > ${value.now})${value.except ? ` AND s2.id != ${value.except}` : ""}`;
	const room = value.room ? ` AND (${value.room} IS NULL OR s2.room_id = ${value.room})` : "";
	return `((SELECT COUNT(*) ${active} AND s2.room_id IS NULL)
		+ COALESCE((SELECT MAX(n) FROM (
			SELECT COUNT(*) AS n ${active} AND s2.room_id IS NOT NULL${room} GROUP BY s2.room_id)), 0))`;
}

/** True when the subscription has an end and the end is not after `now`. */
export function isExpired(row: Pick<SubscriptionRow, "expires_at">, now: number): boolean {
	return row.expires_at !== null && Date.parse(row.expires_at) <= now;
}

/** Active subscriptions for one event and one target, whose endpoint is also active. An expired one is not active. */
export async function activeSubscriptions(
	db: D1Database,
	eventType: WebhookEvent,
	targetId: string,
): Promise<ActiveSubscription[]> {
	const { results } = await db
		.prepare(
			`SELECT s.id, s.target_id, s.sequence, e.created_by FROM webhook_subscriptions s
			JOIN webhook_endpoints e ON e.id = s.endpoint_id
			WHERE s.event_type = ? AND s.target_id = ? AND s.status = 'active' AND e.status = 'active'
			AND (s.expires_at IS NULL OR s.expires_at > ?)`,
		)
		.bind(eventType, targetId, new Date().toISOString())
		.all<ActiveSubscription>();
	return results;
}

export async function getDelivery(
	db: D1Database,
	subscriptionId: string,
): Promise<{ subscription: SubscriptionRow; endpoint: EndpointRow } | null> {
	const subscription = await getSubscription(db, subscriptionId);
	if (!subscription) return null;
	const endpoint = await getEndpoint(db, subscription.endpoint_id);
	if (!endpoint) return null;
	return { subscription, endpoint };
}

/** Stops an active endpoint. An endpoint that is disabled already keeps its first reason. */
export async function disableEndpoint(db: D1Database, row: EndpointRow, reason: EndpointDisabledReason): Promise<void> {
	await db
		.prepare("UPDATE webhook_endpoints SET status = 'disabled', disabled_reason = ? WHERE id = ? AND status = 'active'")
		.bind(reason, row.id)
		.run();
	log("warn", "webhook endpoint disabled", {
		endpointId: row.id,
		host: new URL(row.url).hostname,
		reason,
	});
	audit({
		op: "webhooks.disable_endpoint",
		actor: "system",
		actorKind: "system",
		credential: "none",
		target: row.id,
		result: "ok",
		code: reason,
	});
}

/** Stops each drive subscription that this principal created for one drive. */
export async function loseDriveAccess(db: D1Database, spaceId: string, principalId: string): Promise<void> {
	await db
		.prepare(
			`UPDATE webhook_subscriptions SET status = 'disabled', disabled_reason = 'access_lost'
			WHERE domain = 'drive' AND target_id = ? AND status = 'active'
			AND endpoint_id IN (SELECT id FROM webhook_endpoints WHERE created_by = ?)`,
		)
		.bind(spaceId, principalId)
		.run();
}

/** Stops one subscription. The endpoint keeps its other subscriptions. */
export async function disableSubscription(
	db: D1Database,
	row: SubscriptionRow,
	reason: SubscriptionDisabledReason,
): Promise<void> {
	await db
		.prepare(
			"UPDATE webhook_subscriptions SET status = 'disabled', disabled_reason = ? WHERE id = ? AND status = 'active'",
		)
		.bind(reason, row.id)
		.run();
	log("warn", "webhook subscription disabled", {
		subscriptionId: row.id,
		endpointId: row.endpoint_id,
		targetId: row.target_id,
		reason,
	});
	audit({
		op: `${row.domain}.disable_webhook_subscription`,
		actor: "system",
		actorKind: "system",
		credential: "none",
		target: row.id,
		result: "ok",
		code: reason,
	});
}

/** Records a POST that the receiver accepted. A success ends a series of failed deliveries. */
export async function recordDelivery(db: D1Database, subscription: SubscriptionRow): Promise<void> {
	const now = new Date().toISOString();
	await db.batch([
		db
			.prepare(
				`UPDATE webhook_endpoints SET last_delivery_at = ?, consecutive_failures = 0, last_error = NULL
				WHERE id = ?`,
			)
			.bind(now, subscription.endpoint_id),
		db
			.prepare("UPDATE webhook_subscriptions SET retry_until = NULL, retry_event_id = NULL WHERE id = ?")
			.bind(subscription.id),
	]);
}

/**
 * Records one failed attempt whose retry is on the queue. For mail, a different event for the same
 * subscription joins this retry until `retryUntil`.
 */
export async function recordFailedAttempt(
	db: D1Database,
	subscription: SubscriptionRow,
	eventId: string,
	error: string,
	retryUntil: Date,
	coalesce: boolean,
): Promise<void> {
	const now = new Date().toISOString();
	const statements = [
		db
			.prepare("UPDATE webhook_endpoints SET last_failure_at = ?, last_error = ? WHERE id = ?")
			.bind(now, error, subscription.endpoint_id),
	];
	if (coalesce) {
		statements.push(
			db
				.prepare("UPDATE webhook_subscriptions SET retry_until = ?, retry_event_id = ? WHERE id = ?")
				.bind(retryUntil.toISOString(), eventId, subscription.id),
		);
	}
	await db.batch(statements);
}

/**
 * True when the event joins a retry of a different event that waits. A redelivery of the event of the
 * retry itself does not join it, so a lost retry job cannot end the attempts of its event.
 */
export function joinsWaitingRetry(
	row: Pick<SubscriptionRow, "retry_until" | "retry_event_id">,
	eventId: string,
	now: number,
): boolean {
	return row.retry_until !== null && Date.parse(row.retry_until) > now && row.retry_event_id !== eventId;
}

/**
 * Records a delivery whose last attempt failed. A delivery counts one time. After
 * `failedEventsBeforeDisable` such deliveries in a row, the endpoint is disabled.
 */
export async function recordFailedEvent(
	db: D1Database,
	endpoint: EndpointRow,
	subscription: SubscriptionRow,
	deliveryId: string,
	error: string,
): Promise<boolean> {
	const limit = WEBHOOK_LIMITS.failedEventsBeforeDisable;
	const now = new Date().toISOString();
	const updated = await db
		.prepare(
			`UPDATE webhook_endpoints SET consecutive_failures = consecutive_failures + 1,
				last_failed_delivery_id = ?2, last_failure_at = ?3, last_error = ?4,
				status = CASE WHEN consecutive_failures + 1 >= ?5 THEN 'disabled' ELSE status END,
				disabled_reason = CASE WHEN consecutive_failures + 1 >= ?5 AND status = 'active' THEN 'failures'
					ELSE disabled_reason END
			WHERE id = ?1 AND status = 'active' AND last_failed_delivery_id IS NOT ?2 RETURNING status`,
		)
		.bind(endpoint.id, deliveryId, now, error, limit)
		.first<{ status: string }>();
	await db
		.prepare("UPDATE webhook_subscriptions SET retry_until = NULL, retry_event_id = NULL WHERE id = ?")
		.bind(subscription.id)
		.run();
	const disabled = updated?.status === "disabled";
	if (disabled) {
		log("warn", "webhook endpoint disabled", {
			endpointId: endpoint.id,
			host: new URL(endpoint.url).hostname,
			reason: "failures",
		});
		audit({
			op: "webhooks.disable_endpoint",
			actor: "system",
			actorKind: "system",
			credential: "none",
			target: endpoint.id,
			result: "ok",
			code: "failures",
		});
	}
	return disabled;
}

/** Removes the legacy row with the same id, when one remains from before this model. */
export async function deleteLegacyRow(db: D1Database, id: string): Promise<void> {
	await db.batch([
		db.prepare("DELETE FROM webhooks WHERE id = ?").bind(id),
		db.prepare("DELETE FROM chat_webhooks WHERE id = ?").bind(id),
	]);
}
