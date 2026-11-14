import { type CreatedWebhook, WEBHOOK_LIMITS, type Webhook } from "@soldock/contracts";
import {
	type CallContext,
	type CredentialBinding,
	canManageCredentialsOf,
	canReadAgentMailboxes,
	credentialBinding,
	credentialState,
	getPrincipal,
	isTeamMailboxId,
	isTeamMailboxMember,
	teamMailboxFor,
} from "../identity/index.ts";
import { audit, bytesToBase64, type HandlerMap, log, newId, OperationError } from "../platform/index.ts";
import { mailboxStub } from "./delivery.ts";
import { webhookHostAllowed, webhookUrlProblem } from "./webhook-url.ts";

// Webhooks: a URL outside Soldock gets a signed POST when new mail arrives in the inbox of a mailbox. The
// rows live in the `webhooks` table of the directory database, which this module owns.

export type DisabledReason = NonNullable<Webhook["disabled_reason"]>;

/** A webhook as the directory stores it. The secret and the credential never leave this module. */
export interface WebhookRow {
	id: string;
	mailbox_id: string;
	created_by: string;
	credential_kind: CredentialBinding["kind"];
	credential_id: string | null;
	url: string;
	label: string;
	secret: string;
	status: "active" | "disabled";
	disabled_reason: DisabledReason | null;
	consecutive_failures: number;
	last_failed_event_id: string | null;
	retry_until: string | null;
	last_delivery_at: string | null;
	last_failure_at: string | null;
	last_error: string | null;
	created_at: string;
}

const WEBHOOK_COLUMNS = `id, mailbox_id, created_by, credential_kind, credential_id, url, label, secret, status,
	disabled_reason, consecutive_failures, last_failed_event_id, retry_until, last_delivery_at, last_failure_at,
	last_error, created_at`;

function toWebhook(row: WebhookRow): Webhook {
	return {
		id: row.id,
		mailbox_id: row.mailbox_id,
		url: row.url,
		label: row.label,
		created_by: row.created_by,
		status: row.status,
		disabled_reason: row.disabled_reason,
		consecutive_failures: row.consecutive_failures,
		last_delivery_at: row.last_delivery_at,
		last_failure_at: row.last_failure_at,
		last_error: row.last_error,
		created_at: row.created_at,
	};
}

/** A signing secret as Standard Webhooks specifies: `whsec_` and the base64 of 32 random bytes. */
function newSecret(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return `whsec_${bytesToBase64(bytes)}`;
}

/**
 * The mailbox in which the caller can create a webhook: the own mailbox, a team mailbox that the caller
 * is a member of, or, for a person, the mailbox of an agent that the person sponsors. An owner or an
 * admin who is not the sponsor can read the mail of an agent, but cannot watch it: a webhook would tell
 * when the agent gets mail, without the audit line of a read.
 */
async function creatableMailbox(call: CallContext, mailboxId: string | undefined): Promise<string> {
	const { caller } = call;
	if (mailboxId === undefined || mailboxId === caller.id) return caller.id;
	if (isTeamMailboxId(mailboxId)) return (await teamMailboxFor(call.env.DIRECTORY, mailboxId, caller.id)).id;
	const target = await getPrincipal(call.env.DIRECTORY, mailboxId);
	if (!target) throw new OperationError("not_found", "No mailbox has that id.");
	if (target.kind === "agent" && caller.kind === "human" && target.sponsor_id === caller.id) return target.id;
	throw new OperationError(
		"forbidden",
		"You can create a webhook only for your own mailbox, a team mailbox that you are a member of, and the mailbox of an agent that you sponsor.",
	);
}

/**
 * Which webhooks of a mailbox the caller can see. `all`: an owner or an admin in a team mailbox, and the
 * sponsor of an agent, an owner or an admin in the mailbox of the agent. They manage these mailboxes, so
 * they can remove a webhook that blocks the limit. `own`: the own mailbox and a team mailbox of a
 * member. The members of a team mailbox do not see the webhooks of the other members, and an agent does
 * not see the webhooks that its sponsor created for it.
 */
async function visibleWebhooks(call: CallContext, mailboxId: string): Promise<"all" | "own"> {
	const { caller } = call;
	if (mailboxId === caller.id) return "own";
	if (isTeamMailboxId(mailboxId)) {
		if (canReadAgentMailboxes(caller)) return "all";
		await teamMailboxFor(call.env.DIRECTORY, mailboxId, caller.id);
		return "own";
	}
	if (await managesAgentMailbox(call, mailboxId)) return "all";
	const exists = await getPrincipal(call.env.DIRECTORY, mailboxId);
	if (!exists) throw new OperationError("not_found", "No mailbox has that id.");
	throw new OperationError(
		"forbidden",
		"You can see your own webhooks, the webhooks of the agents that you manage and, as an owner or an admin, the webhooks of team mailboxes.",
	);
}

/**
 * True when the caller can delete each webhook of the mailbox: an owner or an admin in a team mailbox,
 * and the sponsor of an agent, an owner or an admin in the mailbox of the agent.
 */
async function managesWebhooksOf(call: CallContext, mailboxId: string): Promise<boolean> {
	if (isTeamMailboxId(mailboxId)) return canReadAgentMailboxes(call.caller);
	return managesAgentMailbox(call, mailboxId);
}

/** True when the mailbox is the mailbox of an agent whose credentials the caller manages: its sponsor, an owner or an admin. */
async function managesAgentMailbox(call: CallContext, mailboxId: string): Promise<boolean> {
	if (isTeamMailboxId(mailboxId)) return false;
	const target = await getPrincipal(call.env.DIRECTORY, mailboxId);
	return target?.kind === "agent" && canManageCredentialsOf(call.caller, target);
}

function auditWebhook(call: CallContext, op: string, row: Pick<WebhookRow, "id" | "mailbox_id">): void {
	audit({
		op,
		actor: call.caller.id,
		actorKind: call.caller.kind,
		credential: call.caller.credential,
		target: row.id,
		...(row.mailbox_id === call.caller.id ? {} : { mailbox: row.mailbox_id }),
		result: "ok",
		requestId: call.requestId,
	});
}

type WebhookOperation = "mail.create_webhook" | "mail.list_webhooks" | "mail.delete_webhook";

export const webhookHandlers: Pick<HandlerMap<CallContext>, WebhookOperation> = {
	async "mail.create_webhook"(call, input) {
		const mailboxId = await creatableMailbox(call, input.mailbox_id);
		const problem = webhookUrlProblem(input.url, call.origin);
		if (problem) throw new OperationError("invalid", problem);
		const { principal } = call.caller;
		if (!webhookHostAllowed(principal, input.url)) {
			throw new OperationError(
				"policy_denied",
				`The outbound policy of this agent (${principal.outbound_mode ?? "internal-only"}) does not allow a webhook to ${new URL(input.url).hostname}. Ask its sponsor to add the host to the allowlist, or to create the webhook for you.`,
			);
		}
		// The mailbox sends events from now on. It turns this on before the insert: an event with no webhook
		// costs one queue message, but a webhook whose mailbox sends no events would miss mail.
		await mailboxStub(call.env, mailboxId).enableWebhookEvents(mailboxId);
		const binding = credentialBinding(call.caller);
		const row: WebhookRow = {
			id: newId("whk"),
			mailbox_id: mailboxId,
			created_by: principal.id,
			credential_kind: binding.kind,
			credential_id: binding.id,
			url: input.url,
			label: input.label || new URL(input.url).hostname,
			secret: newSecret(),
			status: "active",
			disabled_reason: null,
			consecutive_failures: 0,
			last_failed_event_id: null,
			retry_until: null,
			last_delivery_at: null,
			last_failure_at: null,
			last_error: null,
			created_at: new Date().toISOString(),
		};
		// The limits are part of the insert, so two parallel creates cannot both pass them. The limit of a
		// mailbox counts only active webhooks, so a disabled webhook of another member cannot block it.
		const result = await call.env.DIRECTORY.prepare(
			`INSERT INTO webhooks (id, mailbox_id, created_by, credential_kind, credential_id, url, label, secret, created_at)
			SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
			WHERE (SELECT COUNT(*) FROM webhooks WHERE created_by = ?3) < ?10
			AND (SELECT COUNT(*) FROM webhooks WHERE mailbox_id = ?2 AND status = 'active') < ?11`,
		)
			.bind(
				row.id,
				row.mailbox_id,
				row.created_by,
				row.credential_kind,
				row.credential_id,
				row.url,
				row.label,
				row.secret,
				row.created_at,
				WEBHOOK_LIMITS.perCreator,
				WEBHOOK_LIMITS.perMailbox,
			)
			.run();
		if (result.meta.changes !== 1) {
			throw new OperationError(
				"conflict",
				`You can have at most ${WEBHOOK_LIMITS.perCreator} webhooks, and a mailbox at most ${WEBHOOK_LIMITS.perMailbox} active webhooks. Delete a webhook first.`,
			);
		}
		auditWebhook(call, "mail.create_webhook", row);
		const webhook: CreatedWebhook = { ...toWebhook(row), secret: row.secret };
		return { webhook };
	},

	async "mail.list_webhooks"(call, input) {
		const db = call.env.DIRECTORY;
		const callerId = call.caller.id;
		let statement: D1PreparedStatement;
		if (input.mailbox_id === undefined) {
			statement = db
				.prepare(`SELECT ${WEBHOOK_COLUMNS} FROM webhooks WHERE created_by = ? ORDER BY created_at DESC`)
				.bind(callerId);
		} else if ((await visibleWebhooks(call, input.mailbox_id)) === "all") {
			statement = db
				.prepare(`SELECT ${WEBHOOK_COLUMNS} FROM webhooks WHERE mailbox_id = ? ORDER BY created_at DESC`)
				.bind(input.mailbox_id);
		} else {
			statement = db
				.prepare(
					`SELECT ${WEBHOOK_COLUMNS} FROM webhooks WHERE mailbox_id = ? AND created_by = ? ORDER BY created_at DESC`,
				)
				.bind(input.mailbox_id, callerId);
		}
		const { results } = await statement.all<WebhookRow>();
		return { webhooks: results.map(toWebhook) };
	},

	async "mail.delete_webhook"(call, input) {
		const row = await getWebhook(call.env.DIRECTORY, input.webhook_id);
		const callerId = call.caller.id;
		const allowed = row !== null && (row.created_by === callerId || (await managesWebhooksOf(call, row.mailbox_id)));
		// A webhook that the caller cannot delete is not found, so its id tells nothing.
		if (!row || !allowed) throw new OperationError("not_found", "No webhook has that id.");
		await call.env.DIRECTORY.prepare("DELETE FROM webhooks WHERE id = ?").bind(row.id).run();
		auditWebhook(call, "mail.delete_webhook", row);
		return { deleted: true };
	},
};

// --- Delivery ------------------------------------------------------------------------------------

export async function getWebhook(db: D1Database, id: string): Promise<WebhookRow | null> {
	return db.prepare(`SELECT ${WEBHOOK_COLUMNS} FROM webhooks WHERE id = ?`).bind(id).first<WebhookRow>();
}

/** The ids of the active webhooks of a mailbox. */
export async function activeWebhookIds(db: D1Database, mailboxId: string): Promise<string[]> {
	const { results } = await db
		.prepare("SELECT id FROM webhooks WHERE mailbox_id = ? AND status = 'active'")
		.bind(mailboxId)
		.all<{ id: string }>();
	return results.map((row) => row.id);
}

/**
 * What to do with an event for a webhook, from the access of its creator now. `deliver`: send the POST.
 * `skip`: send nothing and keep the webhook, because its creator or the agent of the mailbox is archived
 * and a restore makes it work again. `disable`: stop the webhook.
 */
export type WebhookCheck = { action: "deliver" } | { action: "skip" } | { action: "disable"; reason: DisabledReason };

/**
 * Checks the access of the creator of a webhook again, with the rules of the create: its credential, its
 * access to the mailbox, and the outbound policy of an agent. Each event checks again, so a revoked key, a
 * removed team member or a new sponsor stops the POST requests at the next event.
 */
export async function checkWebhook(db: D1Database, row: WebhookRow): Promise<WebhookCheck> {
	const state = await credentialState(db, {
		principalId: row.created_by,
		kind: row.credential_kind,
		id: row.credential_id,
	});
	if (state.state === "ended") return { action: "disable", reason: "credential_revoked" };
	if (state.state === "archived") return { action: "skip" };
	const creator = state.principal;
	if (row.mailbox_id !== creator.id) {
		if (isTeamMailboxId(row.mailbox_id)) {
			if (!(await isTeamMailboxMember(db, row.mailbox_id, creator.id))) {
				return { action: "disable", reason: "access_lost" };
			}
		} else {
			const agent = await getPrincipal(db, row.mailbox_id);
			if (agent?.kind !== "agent" || creator.kind !== "human" || agent.sponsor_id !== creator.id) {
				return { action: "disable", reason: "access_lost" };
			}
			if (agent.archived_at !== null) return { action: "skip" };
		}
	}
	if (!webhookHostAllowed(creator, row.url)) return { action: "disable", reason: "policy_denied" };
	return { action: "deliver" };
}

/** Stops an active webhook. A webhook that is disabled already keeps its first reason. */
export async function disableWebhook(db: D1Database, row: WebhookRow, reason: DisabledReason): Promise<void> {
	await db
		.prepare("UPDATE webhooks SET status = 'disabled', disabled_reason = ? WHERE id = ? AND status = 'active'")
		.bind(reason, row.id)
		.run();
	recordDisable(row, reason);
}

/** The log line and the audit line of a webhook that the system disabled. The log holds the host only, never the path. */
function recordDisable(row: WebhookRow, reason: DisabledReason): void {
	log("warn", "webhook disabled", {
		webhookId: row.id,
		mailboxId: row.mailbox_id,
		host: new URL(row.url).hostname,
		reason,
	});
	audit({
		op: "mail.disable_webhook",
		actor: "system",
		actorKind: "system",
		credential: "none",
		target: row.id,
		mailbox: row.mailbox_id,
		result: "ok",
		code: reason,
	});
}

/** Records a POST that the receiver accepted. A success ends a series of failed events and a retry. */
export async function recordDelivery(db: D1Database, id: string): Promise<void> {
	await db
		.prepare(
			"UPDATE webhooks SET last_delivery_at = ?, consecutive_failures = 0, last_error = NULL, retry_until = NULL WHERE id = ?",
		)
		.bind(new Date().toISOString(), id)
		.run();
}

/**
 * Records one failed attempt that gets a retry. Until `retryUntil`, a new event joins this retry and
 * sends no POST of its own.
 */
export async function recordFailedAttempt(db: D1Database, id: string, error: string, retryUntil: Date): Promise<void> {
	await db
		.prepare("UPDATE webhooks SET last_failure_at = ?, last_error = ?, retry_until = ? WHERE id = ?")
		.bind(new Date().toISOString(), error, retryUntil.toISOString(), id)
		.run();
}

/** True while a failed POST of the webhook waits for its next attempt. */
export function retryWaits(row: Pick<WebhookRow, "retry_until">, now: number): boolean {
	return row.retry_until !== null && Date.parse(row.retry_until) > now;
}

/**
 * Records an event whose last attempt failed, and ends its retry. An event counts one time, also when a
 * redelivery repeats its jobs. After `failedEventsBeforeDisable` such events in a row, the webhook is
 * disabled. Returns true when this event disabled it.
 */
export async function recordFailedEvent(
	db: D1Database,
	row: WebhookRow,
	eventId: string,
	error: string,
): Promise<boolean> {
	const limit = WEBHOOK_LIMITS.failedEventsBeforeDisable;
	const updated = await db
		.prepare(
			`UPDATE webhooks SET consecutive_failures = consecutive_failures + 1, last_failed_event_id = ?5,
				last_failure_at = ?1, last_error = ?2, retry_until = NULL,
				status = CASE WHEN consecutive_failures + 1 >= ?3 THEN 'disabled' ELSE status END,
				disabled_reason = CASE WHEN consecutive_failures + 1 >= ?3 AND status = 'active' THEN 'failures'
					ELSE disabled_reason END
			WHERE id = ?4 AND status = 'active' AND last_failed_event_id IS NOT ?5 RETURNING status`,
		)
		.bind(new Date().toISOString(), error, limit, row.id, eventId)
		.first<{ status: string }>();
	const disabled = updated?.status === "disabled";
	if (disabled) recordDisable(row, "failures");
	return disabled;
}
