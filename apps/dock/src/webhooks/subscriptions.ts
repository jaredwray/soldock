import {
	WEBHOOK_LIMITS,
	type WebhookDomain,
	type WebhookEndpoint,
	type WebhookEvent,
	webhookDomain,
} from "@soldock/contracts";
import {
	type CallContext,
	canManageCredentialsOf,
	canReadAgentMailboxes,
	credentialBinding,
	getPrincipal,
	isTeamMailboxId,
	teamMailboxFor,
} from "../identity/index.ts";
import { audit, newId, OperationError } from "../platform/index.ts";
import { adoptLegacyWebhooks } from "./legacy.ts";
import {
	deleteLegacyRow,
	type EndpointRow,
	getEndpoint,
	getSubscription,
	type SubscriptionRow,
	subscriptionColumns,
	toEndpoint,
} from "./store.ts";
import { webhookHostAllowed } from "./url.ts";

export interface SubscriptionView {
	id: string;
	endpoint_id: string;
	event: WebhookEvent;
	target_id: string;
	status: SubscriptionRow["status"];
	disabled_reason: SubscriptionRow["disabled_reason"];
	created_at: string;
	endpoint: WebhookEndpoint;
}

function toView(row: SubscriptionRow, endpoint: WebhookEndpoint): SubscriptionView {
	return {
		id: row.id,
		endpoint_id: row.endpoint_id,
		event: row.event_type,
		target_id: row.target_id,
		status: row.status,
		disabled_reason: row.disabled_reason,
		created_at: row.created_at,
		endpoint,
	};
}

/** Columns of the endpoint that a list may return. Secrets stay out of this query. */
const ENDPOINT_LIST_COLUMNS = `e.id AS ep_id, e.created_by AS ep_created_by, e.url AS ep_url, e.label AS ep_label,
	e.status AS ep_status, e.disabled_reason AS ep_disabled_reason,
	e.consecutive_failures AS ep_consecutive_failures, e.last_delivery_at AS ep_last_delivery_at,
	e.last_failure_at AS ep_last_failure_at, e.last_error AS ep_last_error,
	e.auth_key IS NOT NULL AS ep_has_auth_key, e.header_name AS ep_header_name, e.created_at AS ep_created_at`;

interface ListedEndpoint {
	ep_id: string;
	ep_created_by: string;
	ep_url: string;
	ep_label: string;
	ep_status: EndpointRow["status"];
	ep_disabled_reason: EndpointRow["disabled_reason"];
	ep_consecutive_failures: number;
	ep_last_delivery_at: string | null;
	ep_last_failure_at: string | null;
	ep_last_error: string | null;
	ep_has_auth_key: number | boolean;
	ep_header_name: string | null;
	ep_created_at: string;
}

/** The endpoint a viewer may see. Another person's URL path and delivery history stay hidden. */
function listedEndpoint(row: ListedEndpoint, callerId: string): WebhookEndpoint {
	const own = row.ep_created_by === callerId;
	return {
		id: row.ep_id,
		url: own ? row.ep_url : new URL(row.ep_url).origin,
		label: row.ep_label,
		created_by: row.ep_created_by,
		status: row.ep_status,
		disabled_reason: row.ep_disabled_reason,
		consecutive_failures: own ? row.ep_consecutive_failures : 0,
		last_delivery_at: own ? row.ep_last_delivery_at : null,
		last_failure_at: own ? row.ep_last_failure_at : null,
		last_error: own ? row.ep_last_error : null,
		has_auth_key: own ? Boolean(row.ep_has_auth_key) : false,
		header_name: own ? row.ep_header_name : null,
		created_at: row.ep_created_at,
	};
}

/**
 * The target the caller can subscribe to. Mail: own mailbox, a team mailbox, or a sponsored agent.
 * Chat: self or a sponsored agent. Drive: own drive, a shared drive the caller belongs to, or the
 * drive of a sponsored agent.
 */
async function creatableTarget(
	call: CallContext,
	targetId: string | undefined,
	domain: WebhookDomain,
): Promise<string> {
	const { caller } = call;
	if (targetId === undefined || targetId === caller.id) return caller.id;
	if (domain === "drive" && targetId.startsWith("drv_")) {
		const space = call.env.DRIVE_SPACE.get(call.env.DRIVE_SPACE.idFromName(targetId));
		if (!(await space.hasMember(caller.id))) {
			throw new OperationError("not_found", "No shared drive has that id, or you are not a member.");
		}
		return targetId;
	}
	if (isTeamMailboxId(targetId) && domain === "mail") {
		return (await teamMailboxFor(call.env.DIRECTORY, targetId, caller.id)).id;
	}
	const target = await getPrincipal(call.env.DIRECTORY, targetId);
	if (!target) throw new OperationError("not_found", "No principal has that id.");
	if (target.kind === "agent" && caller.kind === "human" && target.sponsor_id === caller.id) return target.id;
	throw new OperationError(
		"forbidden",
		domain === "chat"
			? "You can subscribe only for yourself or an agent that you sponsor."
			: domain === "drive"
				? "You can subscribe only for your own drive, a shared drive that you belong to, or the drive of an agent that you sponsor."
				: "You can subscribe only for your own mailbox, a team mailbox that you belong to, or the mailbox of an agent that you sponsor.",
	);
}

async function managesAgent(call: CallContext, targetId: string): Promise<boolean> {
	if (isTeamMailboxId(targetId) || targetId.startsWith("drv_")) return false;
	const target = await getPrincipal(call.env.DIRECTORY, targetId);
	return target?.kind === "agent" && canManageCredentialsOf(call.caller, target);
}

/** `all` when the caller manages the target. `own` when the caller may see only their subscriptions. */
async function visibleSubscriptions(
	call: CallContext,
	targetId: string,
	domain: WebhookDomain,
): Promise<"all" | "own"> {
	const { caller } = call;
	if (targetId === caller.id) return "own";
	if (domain === "drive" && targetId.startsWith("drv_")) {
		if (canReadAgentMailboxes(caller)) return "all";
		const member = await call.env.DIRECTORY.prepare(
			`SELECT role FROM shared_drive_members m JOIN shared_drives d ON d.id = m.drive_id
			WHERE m.drive_id = ? AND m.principal_id = ? AND d.deleted_at IS NULL`,
		)
			.bind(targetId, caller.id)
			.first<{ role: string }>();
		if (!member) throw new OperationError("not_found", "No shared drive has that id, or you are not a member.");
		return member.role === "manager" ? "all" : "own";
	}
	if (isTeamMailboxId(targetId)) {
		if (canReadAgentMailboxes(caller)) return "all";
		await teamMailboxFor(call.env.DIRECTORY, targetId, caller.id);
		return "own";
	}
	if (await managesAgent(call, targetId)) return "all";
	const exists = await getPrincipal(call.env.DIRECTORY, targetId);
	if (!exists) throw new OperationError("not_found", "No target has that id.");
	throw new OperationError(
		"forbidden",
		"You can see your own subscriptions and the subscriptions of the agents that you manage.",
	);
}

async function managesSubscriptionsOf(call: CallContext, targetId: string, domain: WebhookDomain): Promise<boolean> {
	if (domain === "drive" && targetId.startsWith("drv_")) {
		if (canReadAgentMailboxes(call.caller)) return true;
		const member = await call.env.DIRECTORY.prepare(
			"SELECT role FROM shared_drive_members WHERE drive_id = ? AND principal_id = ?",
		)
			.bind(targetId, call.caller.id)
			.first<{ role: string }>();
		return member?.role === "manager";
	}
	if (isTeamMailboxId(targetId)) return canReadAgentMailboxes(call.caller);
	return managesAgent(call, targetId);
}

function auditSubscription(call: CallContext, op: string, row: Pick<SubscriptionRow, "id" | "target_id">): void {
	audit({
		op,
		actor: call.caller.id,
		actorKind: call.caller.kind,
		credential: call.caller.credential,
		target: row.id,
		...(row.target_id === call.caller.id ? {} : { mailbox: row.target_id }),
		result: "ok",
		requestId: call.requestId,
	});
}

export function createSubscriptionHandlers(
	domain: WebhookDomain,
	beforeCreate?: (call: CallContext, targetId: string) => Promise<void>,
) {
	return {
		async create(
			call: CallContext,
			input: { endpoint_id: string; event: WebhookEvent; mailbox_id?: string },
		): Promise<{ subscription: SubscriptionView }> {
			await adoptLegacyWebhooks(call.env.DIRECTORY);
			if (webhookDomain(input.event) !== domain) {
				throw new OperationError("invalid", "That event does not belong to this product.");
			}
			const endpoint = await getEndpoint(call.env.DIRECTORY, input.endpoint_id);
			if (endpoint?.created_by !== call.caller.id) throw new OperationError("not_found", "No endpoint has that id.");
			if (endpoint.status !== "active") {
				throw new OperationError("conflict", "The endpoint is disabled. Create a new endpoint.");
			}
			const targetId = await creatableTarget(call, input.mailbox_id, domain);
			if (!webhookHostAllowed(call.caller.principal, endpoint.url)) {
				throw new OperationError(
					"policy_denied",
					`The outbound policy of this agent (${call.caller.principal.outbound_mode ?? "internal-only"}) does not allow a webhook to ${new URL(endpoint.url).hostname}. Ask its sponsor to add the host to the allowlist.`,
				);
			}
			await beforeCreate?.(call, targetId);
			const binding = credentialBinding(call.caller);
			const id = newId("whk");
			const createdAt = new Date().toISOString();
			const inserted = await call.env.DIRECTORY.prepare(
				`INSERT INTO webhook_subscriptions (
					id, endpoint_id, domain, event_type, target_id, credential_kind, credential_id, created_at)
				SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
				WHERE (SELECT COUNT(*) FROM webhook_subscriptions s
					JOIN webhook_endpoints e ON e.id = s.endpoint_id
					WHERE e.created_by = ?9 AND s.domain = ?3 AND s.event_type = ?4) < ?10
				AND (SELECT COUNT(*) FROM webhook_subscriptions s2
					JOIN webhook_endpoints e2 ON e2.id = s2.endpoint_id
					WHERE s2.domain = ?3 AND s2.event_type = ?4 AND s2.target_id = ?5
					AND s2.status = 'active' AND e2.status = 'active') < ?11
				ON CONFLICT (endpoint_id, event_type, target_id) DO NOTHING
				RETURNING id`,
			)
				.bind(
					id,
					endpoint.id,
					domain,
					input.event,
					targetId,
					binding.kind,
					binding.id,
					createdAt,
					call.caller.id,
					WEBHOOK_LIMITS.subscriptionsPerCreator,
					WEBHOOK_LIMITS.perTarget,
				)
				.first<{ id: string }>();
			if (!inserted) {
				const existing = await call.env.DIRECTORY.prepare(
					"SELECT id FROM webhook_subscriptions WHERE endpoint_id = ? AND event_type = ? AND target_id = ?",
				)
					.bind(endpoint.id, input.event, targetId)
					.first();
				if (existing) throw new OperationError("conflict", "The endpoint already has this subscription.");
				throw new OperationError(
					"conflict",
					`You can have at most ${WEBHOOK_LIMITS.subscriptionsPerCreator} subscriptions of one event. A target can have at most ${WEBHOOK_LIMITS.perTarget} active subscriptions of one event. Delete a subscription first.`,
				);
			}
			const row = await getSubscription(call.env.DIRECTORY, id);
			if (!row) throw new OperationError("internal", "The subscription was not stored.");
			auditSubscription(call, `${domain}.create_webhook_subscription`, row);
			return { subscription: toView(row, toEndpoint(endpoint)) };
		},

		async list(call: CallContext, input: { mailbox_id?: string }): Promise<{ subscriptions: SubscriptionView[] }> {
			await adoptLegacyWebhooks(call.env.DIRECTORY);
			const db = call.env.DIRECTORY;
			const columns = `${subscriptionColumns("s")}, ${ENDPOINT_LIST_COLUMNS}`;
			let statement: D1PreparedStatement;
			if (input.mailbox_id === undefined) {
				statement = db
					.prepare(
						`SELECT ${columns} FROM webhook_subscriptions s
						JOIN webhook_endpoints e ON e.id = s.endpoint_id
						WHERE s.domain = ? AND e.created_by = ? ORDER BY s.created_at DESC`,
					)
					.bind(domain, call.caller.id);
			} else if ((await visibleSubscriptions(call, input.mailbox_id, domain)) === "all") {
				statement = db
					.prepare(
						`SELECT ${columns} FROM webhook_subscriptions s
						JOIN webhook_endpoints e ON e.id = s.endpoint_id
						WHERE s.domain = ? AND s.target_id = ? ORDER BY s.created_at DESC`,
					)
					.bind(domain, input.mailbox_id);
			} else {
				statement = db
					.prepare(
						`SELECT ${columns} FROM webhook_subscriptions s
						JOIN webhook_endpoints e ON e.id = s.endpoint_id
						WHERE s.domain = ? AND s.target_id = ? AND e.created_by = ? ORDER BY s.created_at DESC`,
					)
					.bind(domain, input.mailbox_id, call.caller.id);
			}
			const { results } = await statement.all<SubscriptionRow & ListedEndpoint>();
			return {
				subscriptions: results.map((row) => toView(row, listedEndpoint(row, call.caller.id))),
			};
		},

		async delete(call: CallContext, input: { subscription_id: string }): Promise<{ deleted: true }> {
			await adoptLegacyWebhooks(call.env.DIRECTORY);
			const row = await getSubscription(call.env.DIRECTORY, input.subscription_id);
			const endpoint = row ? await getEndpoint(call.env.DIRECTORY, row.endpoint_id) : null;
			const creator = endpoint?.created_by === call.caller.id;
			const manager = row !== null && (await managesSubscriptionsOf(call, row.target_id, domain));
			if (!row || row.domain !== domain || (!creator && !manager)) {
				throw new OperationError("not_found", "No subscription has that id.");
			}
			await call.env.DIRECTORY.prepare("DELETE FROM webhook_subscriptions WHERE id = ?").bind(row.id).run();
			await deleteLegacyRow(call.env.DIRECTORY, row.id);
			auditSubscription(call, `${domain}.delete_webhook_subscription`, row);
			return { deleted: true };
		},
	};
}
