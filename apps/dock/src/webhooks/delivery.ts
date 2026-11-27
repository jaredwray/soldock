import {
	CALENDAR_WEBHOOK_EVENTS,
	type CalendarWebhookEvent,
	CHAT_EVENT_REASONS,
	CHAT_LIMITS,
	CHAT_WEBHOOK_EVENTS,
	type ChatEventReason,
	type ChatWebhookEvent,
	type ChatWebhookFilter,
	DRIVE_WEBHOOK_EVENTS,
	type DriveWebhookEvent,
	expandTemplate,
	resources,
	WEBHOOK_EVENT_TYPE,
	WEBHOOK_LIMITS,
	webhookScope,
} from "@asterra/contracts";
import {
	credentialState,
	getPrincipal,
	isTeamMailboxId,
	type PrincipalRecord,
	teamMailboxMemberScopes,
} from "../identity/index.ts";
import { base64ToBytes, bytesToBase64, hmacSha256, log, openSecret, openSecretOrNull } from "../platform/index.ts";
import { adoptLegacyWebhooks, unmigratedCount } from "./legacy.ts";
import {
	activeSubscriptions,
	disableEndpoint,
	disableSubscription,
	ENDPOINT_SEAL,
	type EndpointDisabledReason,
	type EndpointRow,
	getDelivery,
	isExpired,
	joinsWaitingRetry,
	recordDelivery,
	recordFailedAttempt,
	recordFailedEvent,
	type SubscriptionDisabledReason,
	type SubscriptionRow,
} from "./store.ts";
import { outboundHostAllowed } from "./url.ts";

/** The queue that carries webhook events, and one POST for each subscription. A suffix: see `queues.ts`. */
export const WEBHOOK_QUEUE = "webhooks";

/** The result of a delivery when a sealed value of the endpoint does not open. No POST goes out. */
const SECRET_UNREADABLE = "secret_unreadable";

/** New mail in the inbox of a mailbox. The `MailboxDO` sends it from its event outbox. Version 1. */
export interface WebhookEventJob {
	v: 1;
	kind: "event";
	mailboxId: string;
	/** The same id on each redelivery, so each POST of the event has the same `webhook-id`. */
	eventId: string;
	occurredAt: number;
}

/** One POST of one mail event to one subscription. Version 1. `webhookId` is the subscription id. */
export interface WebhookDeliveryJob {
	v: 1;
	kind: "delivery";
	webhookId: string;
	mailboxId: string;
	eventId: string;
	occurredAt: number;
	/**
	 * The POST attempt, from 1. A retry is a new job with the next attempt, so a failure of Asterra
	 * itself, which retries the same job, never uses up an attempt of the receiver.
	 */
	attempt?: number;
}

/**
 * The facts of a chat message that a POST gives, so a receiver can decide before a read. A job from the
 * previous Worker has none of them, and its POST leaves them out.
 */
interface ChatEventFacts {
	/** The principal that wrote the message. */
	authorId?: string;
	/** The version that the message got from this change: a version of the room. */
	version?: number;
}

/** A committed chat change and the members at that time, except the actor. */
export interface ChatWebhookEventJob extends ChatEventFacts {
	v: 1;
	kind: "chat_event";
	roomId: string;
	eventId: string;
	occurredAt: number;
	subscriptionSequence: number;
	/**
	 * `reason`: why the event goes to this member, at the time of the change. A job from the previous
	 * Worker has no reason, and a job from a later Worker can have a reason that this Worker does not
	 * know (`knownReason`). Then a subscription with the filter `addressed` gets nothing.
	 */
	recipients: { id: string; membershipId: string; reason?: string }[];
	/**
	 * Absent on a job from the previous Worker. Then the event is `chat.message.created` and `eventId`
	 * is the message id.
	 */
	eventType?: ChatWebhookEvent;
	messageId?: string;
	/** The message that the message replies to, for a reply in a thread. */
	parentId?: string;
}

interface ChatWebhookDeliveryJob extends Omit<WebhookDeliveryJob, "kind">, ChatEventFacts {
	kind: "chat_delivery";
	roomId: string;
	membershipId: string;
	/** Why the event goes to the target of the subscription. See `knownReason`. */
	reason?: string;
	eventType?: ChatWebhookEvent;
	messageId?: string;
	parentId?: string;
}

/** A change in one drive. The `DriveSpaceDO` sends it from its webhook outbox. */
export interface DriveWebhookEventJob {
	v: 1;
	kind: "drive_event";
	spaceId: string;
	eventType: DriveWebhookEvent;
	eventId: string;
	itemId: string;
	occurredAt: number;
	/** The last subscription sequence before this change. A later subscription does not get the event. */
	subscriptionSequence: number;
	/** Members of a shared drive at the time of the event. Absent for a personal drive. */
	memberIds?: string[];
}

interface DriveWebhookDeliveryJob {
	v: 1;
	kind: "drive_delivery";
	webhookId: string;
	spaceId: string;
	eventType: DriveWebhookEvent;
	eventId: string;
	itemId: string;
	occurredAt: number;
	/** Members of a shared drive at the time of the event. Absent for a personal drive. */
	memberIds?: string[];
	attempt?: number;
}

/** The ids of one change of a calendar. They are no content: a receiver reads the event with its own credential. */
interface CalendarChangeFacts {
	calendarId: string;
	eventType: CalendarWebhookEvent;
	/** The id of the change: the same on each redelivery and in `calendar.list_changes`. */
	eventId: string;
	occurredAt: number;
	calendarEventId: string;
	occurrenceId: string | null;
	revision: number;
	actorId: string | null;
	/** The position after the change, for `calendar.list_changes`. */
	cursor: string;
}

/** A committed change of one calendar. The `CalendarDO` sends it from its change feed. */
export interface CalendarWebhookEventJob extends CalendarChangeFacts {
	v: 1;
	kind: "calendar_event";
}

interface CalendarWebhookDeliveryJob extends CalendarChangeFacts {
	v: 1;
	kind: "calendar_delivery";
	webhookId: string;
	attempt?: number;
}

export type WebhookJob =
	| WebhookEventJob
	| WebhookDeliveryJob
	| ChatWebhookEventJob
	| ChatWebhookDeliveryJob
	| DriveWebhookEventJob
	| DriveWebhookDeliveryJob
	| CalendarWebhookEventJob
	| CalendarWebhookDeliveryJob;

type DeliveryJob = WebhookDeliveryJob | ChatWebhookDeliveryJob | DriveWebhookDeliveryJob | CalendarWebhookDeliveryJob;

/** The delay in seconds before attempt 2, 3, 4 and 5 of a POST. */
const RETRY_DELAYS_S = [10, 60, 300, 1800] as const;
/** The delay before a job runs again after a failure of Asterra itself, such as D1. */
const INTERNAL_RETRY_S = 30;
/** The time after the planned retry while a new mail event still joins it, in case the retry job runs late. */
const RETRY_GRACE_MS = 2 * WEBHOOK_LIMITS.timeoutMs + 60_000;
const SECRET_PREFIX = "whsec_";
const CHAT_EVENTS = new Set<string>(CHAT_WEBHOOK_EVENTS);
const CHAT_REASONS = new Set<unknown>(CHAT_EVENT_REASONS);

/**
 * The reason of a job, or undefined for no reason and for a reason that this Worker does not know. So a
 * job from a later Worker, after a rollback, is not a job that is not valid: it sends as a job with no reason.
 */
function knownReason(reason: string | undefined): ChatEventReason | undefined {
	return CHAT_REASONS.has(reason) ? (reason as ChatEventReason) : undefined;
}
const DRIVE_EVENTS = new Set<string>(DRIVE_WEBHOOK_EVENTS);
const CALENDAR_EVENTS = new Set<string>(CALENDAR_WEBHOOK_EVENTS);

function nullableString(value: unknown): boolean {
	return value === null || typeof value === "string";
}

/** True when a calendar job has the facts of `CalendarChangeFacts` in the right form. */
function validCalendarJob(job: Record<string, unknown>): boolean {
	const attempt = job.attempt;
	return (
		typeof job.calendarId === "string" &&
		typeof job.eventType === "string" &&
		CALENDAR_EVENTS.has(job.eventType) &&
		typeof job.calendarEventId === "string" &&
		nullableString(job.occurrenceId) &&
		typeof job.revision === "number" &&
		Number.isSafeInteger(job.revision) &&
		nullableString(job.actorId) &&
		typeof job.cursor === "string" &&
		(job.kind === "calendar_event" ||
			(typeof job.webhookId === "string" &&
				(attempt === undefined || (typeof attempt === "number" && Number.isInteger(attempt) && attempt >= 1))))
	);
}

/** True when the facts of a chat job are absent or have the right form. */
function validChatFacts(job: Record<string, unknown>): boolean {
	return (
		(job.authorId === undefined || typeof job.authorId === "string") &&
		(job.version === undefined || (typeof job.version === "number" && Number.isSafeInteger(job.version)))
	);
}

type DeliveryCheck =
	| { action: "deliver"; creator: PrincipalRecord }
	| { action: "skip" }
	| { action: "disable_endpoint"; reason: EndpointDisabledReason }
	| { action: "disable_subscription"; reason: SubscriptionDisabledReason };

function isWebhookJob(body: unknown): body is WebhookJob {
	if (typeof body !== "object" || body === null) return false;
	const job = body as Record<string, unknown>;
	if (
		job.v !== 1 ||
		typeof job.eventId !== "string" ||
		typeof job.occurredAt !== "number" ||
		!Number.isFinite(job.occurredAt)
	) {
		return false;
	}
	if (job.kind === "calendar_event" || job.kind === "calendar_delivery") return validCalendarJob(job);
	if (job.kind === "drive_event" || job.kind === "drive_delivery") {
		const attempt = job.attempt;
		const validAttempt =
			job.kind === "drive_event" ||
			attempt === undefined ||
			(typeof attempt === "number" && Number.isInteger(attempt) && attempt >= 1);
		const sequenceOk =
			job.kind !== "drive_event" ||
			(typeof job.subscriptionSequence === "number" &&
				Number.isSafeInteger(job.subscriptionSequence) &&
				job.subscriptionSequence >= 0);
		return (
			sequenceOk &&
			validAttempt &&
			typeof job.spaceId === "string" &&
			typeof job.itemId === "string" &&
			typeof job.eventType === "string" &&
			DRIVE_EVENTS.has(job.eventType) &&
			(job.kind === "drive_event" || typeof job.webhookId === "string")
		);
	}
	if (job.kind === "chat_event") {
		return (
			typeof job.roomId === "string" &&
			typeof job.subscriptionSequence === "number" &&
			Number.isSafeInteger(job.subscriptionSequence) &&
			job.subscriptionSequence >= 0 &&
			(job.eventType === undefined || (typeof job.eventType === "string" && CHAT_EVENTS.has(job.eventType))) &&
			(job.messageId === undefined || typeof job.messageId === "string") &&
			validChatFacts(job) &&
			Array.isArray(job.recipients) &&
			job.recipients.length <= CHAT_LIMITS.membersPerRoom &&
			job.recipients.every(
				(recipient: unknown) =>
					typeof recipient === "object" &&
					recipient !== null &&
					"id" in recipient &&
					typeof recipient.id === "string" &&
					"membershipId" in recipient &&
					typeof recipient.membershipId === "string" &&
					recipient.membershipId.length > 0 &&
					(!("reason" in recipient) || typeof recipient.reason === "string"),
			)
		);
	}
	if (typeof job.mailboxId !== "string") return false;
	if (job.kind === "event") return true;
	const attempt = job.attempt;
	const validAttempt =
		attempt === undefined || (typeof attempt === "number" && Number.isInteger(attempt) && attempt >= 1);
	return (
		typeof job.webhookId === "string" &&
		validAttempt &&
		(job.kind === "delivery" ||
			(job.kind === "chat_delivery" &&
				typeof job.roomId === "string" &&
				typeof job.membershipId === "string" &&
				job.membershipId.length > 0 &&
				(job.eventType === undefined || (typeof job.eventType === "string" && CHAT_EVENTS.has(job.eventType))) &&
				(job.messageId === undefined || typeof job.messageId === "string") &&
				(job.reason === undefined || typeof job.reason === "string") &&
				validChatFacts(job)))
	);
}

/**
 * The consumer of `soldock-webhooks`. An event job becomes one delivery job for each active subscription.
 * A delivery job checks access again and sends one signed POST. A failed POST puts a new job with the next
 * attempt on the queue, with a delay. Jobs run in parallel, so one slow receiver does not hold the others.
 */
export async function handleWebhookBatch(batch: MessageBatch<unknown>, env: Env): Promise<void> {
	const pending = await unmigratedCount(env.DIRECTORY).first<number>("n");
	if (pending) await adoptLegacyWebhooks(env.DIRECTORY);
	await Promise.all(batch.messages.map((message) => handleJob(message, env)));
}

async function handleJob(message: Message<unknown>, env: Env): Promise<void> {
	const job = message.body;
	try {
		if (!isWebhookJob(job)) {
			log("error", "webhook job is not valid; sent to the dead-letter queue", { id: message.id });
			await env.WEBHOOKS_DLQ.send(job);
		} else if (job.kind === "chat_event") {
			await fanOutChat(env, job);
		} else if (job.kind === "drive_event") {
			await fanOutDrive(env, job);
		} else if (job.kind === "calendar_event") {
			await fanOutCalendar(env, job);
		} else if (job.kind === "event") {
			await fanOut(env, job);
		} else {
			await deliver(env, job);
		}
		message.ack();
	} catch (error) {
		log("warn", "webhook job failed; retrying", {
			id: message.id,
			attempts: message.attempts,
			error: error instanceof Error ? error.message : String(error),
		});
		message.retry({ delaySeconds: INTERNAL_RETRY_S });
	}
}

/** Sends one delivery job for each active mail subscription of the mailbox. */
async function fanOut(env: Env, job: WebhookEventJob): Promise<void> {
	const rows = await activeSubscriptions(env.DIRECTORY, WEBHOOK_EVENT_TYPE, job.mailboxId);
	if (rows.length === 0) return;
	await env.WEBHOOKS.sendBatch(
		rows.map((row) => ({
			body: {
				v: 1,
				kind: "delivery",
				webhookId: row.id,
				mailboxId: job.mailboxId,
				eventId: job.eventId,
				occurredAt: job.occurredAt,
			} satisfies WebhookDeliveryJob,
		})),
	);
}

/**
 * One page stays within the D1 bind limit and the queue batch limit. A subscription with a room gets
 * only the events of that room. An expired subscription gets nothing. A subscription with the filter
 * `addressed` gets only an event whose reason for its target is not `room`, so a message that is not for
 * the target makes no delivery job and no POST.
 */
async function fanOutChat(env: Env, job: ChatWebhookEventJob): Promise<void> {
	const eventType = job.eventType ?? "chat.message.created";
	if (!CHAT_EVENTS.has(eventType)) return;
	const now = new Date().toISOString();
	for (let start = 0; start < job.recipients.length; start += 88) {
		const recipients = job.recipients.slice(start, start + 88);
		const members = new Map(recipients.map((member) => [member.id, member]));
		const { results } = await env.DIRECTORY.prepare(
			`SELECT s.id, s.target_id, s.chat_filter FROM webhook_subscriptions s
			JOIN webhook_endpoints e ON e.id = s.endpoint_id
			WHERE s.status = 'active' AND e.status = 'active' AND s.domain = 'chat' AND s.event_type = '${eventType}'
			AND s.sequence <= ? AND (s.expires_at IS NULL OR s.expires_at > ?) AND (s.room_id IS NULL OR s.room_id = ?)
			AND s.target_id IN (${recipients.map(() => "?").join(",")})`,
		)
			.bind(job.subscriptionSequence, now, job.roomId, ...recipients.map((member) => member.id))
			.all<{ id: string; target_id: string; chat_filter: ChatWebhookFilter }>();
		const jobs = results.flatMap((row): ChatWebhookDeliveryJob[] => {
			const member = members.get(row.target_id);
			if (!member) return [];
			const reason = knownReason(member.reason);
			if (row.chat_filter === "addressed" && (reason === undefined || reason === "room")) return [];
			return [
				{
					v: 1,
					kind: "chat_delivery",
					webhookId: row.id,
					mailboxId: row.target_id,
					eventId: job.eventId,
					occurredAt: job.occurredAt,
					roomId: job.roomId,
					membershipId: member.membershipId,
					eventType,
					messageId: job.messageId ?? job.eventId,
					...(job.parentId === undefined ? {} : { parentId: job.parentId }),
					...(reason === undefined ? {} : { reason }),
					...(job.authorId === undefined ? {} : { authorId: job.authorId }),
					...(job.version === undefined ? {} : { version: job.version }),
				},
			];
		});
		for (let offset = 0; offset < jobs.length; offset += 100) {
			await env.WEBHOOKS.sendBatch(jobs.slice(offset, offset + 100).map((body) => ({ body })));
		}
	}
}

async function fanOutDrive(env: Env, job: DriveWebhookEventJob): Promise<void> {
	const rows = await activeSubscriptions(env.DIRECTORY, job.eventType, job.spaceId);
	const allowed = job.memberIds === undefined ? null : new Set(job.memberIds);
	const chosen = (allowed === null ? rows : rows.filter((row) => allowed.has(row.created_by))).filter(
		(row) => row.sequence <= job.subscriptionSequence,
	);
	if (chosen.length === 0) return;
	await env.WEBHOOKS.sendBatch(
		chosen.map((row) => ({
			body: {
				v: 1,
				kind: "drive_delivery",
				webhookId: row.id,
				spaceId: job.spaceId,
				eventType: job.eventType,
				eventId: job.eventId,
				itemId: job.itemId,
				occurredAt: job.occurredAt,
				...(job.memberIds !== undefined ? { memberIds: job.memberIds } : {}),
			} satisfies DriveWebhookDeliveryJob,
		})),
	);
}

/**
 * Sends one delivery job for each active subscription of the event for the calendar. A subscription from
 * after the change gets nothing: it starts from now, and `calendar.list_changes` gives the changes before it.
 */
async function fanOutCalendar(env: Env, job: CalendarWebhookEventJob): Promise<void> {
	const rows = (await activeSubscriptions(env.DIRECTORY, job.eventType, job.calendarId)).filter(
		(row) => Date.parse(row.created_at) <= job.occurredAt,
	);
	const { v: _v, kind: _kind, ...facts } = job;
	for (let offset = 0; offset < rows.length; offset += 100) {
		await env.WEBHOOKS.sendBatch(
			rows.slice(offset, offset + 100).map((row) => ({
				body: { v: 1, kind: "calendar_delivery", webhookId: row.id, ...facts } satisfies CalendarWebhookDeliveryJob,
			})),
		);
	}
}

function sameCredential(endpoint: EndpointRow, subscription: SubscriptionRow): boolean {
	return (
		endpoint.credential_kind === subscription.credential_kind && endpoint.credential_id === subscription.credential_id
	);
}

/**
 * The access of the creator now. A lost target stops that subscription. A dead credential stops the endpoint.
 */
async function checkDelivery(
	db: D1Database,
	endpoint: EndpointRow,
	subscription: SubscriptionRow,
	memberIds: string[] | undefined,
): Promise<DeliveryCheck> {
	const endpointState = await credentialState(db, {
		principalId: endpoint.created_by,
		kind: endpoint.credential_kind,
		id: endpoint.credential_id,
	});
	if (endpointState.state === "ended") return { action: "disable_endpoint", reason: "credential_revoked" };
	if (endpointState.state === "archived") return { action: "skip" };
	if (!sameCredential(endpoint, subscription)) {
		const subscriptionState = await credentialState(db, {
			principalId: endpoint.created_by,
			kind: subscription.credential_kind,
			id: subscription.credential_id,
		});
		if (subscriptionState.state === "ended") return { action: "disable_subscription", reason: "credential_revoked" };
		if (subscriptionState.state === "archived") return { action: "skip" };
	}
	const creator = endpointState.principal;
	const target = subscription.target_id;
	// The scopes of an agent can change after it made the subscription. A delivery needs the scope that a new
	// subscription needs now: the webhook scope of the domain.
	if (creator.kind === "agent" && !creator.agent_scopes.includes(webhookScope(subscription.domain))) {
		return { action: "disable_subscription", reason: "access_lost" };
	}
	if (subscription.domain === "calendar") {
		// A calendar is for its owner only: no sponsor, delegate, owner or admin, and no free/busy access, gets
		// its changes. An agent also needs calendar.read, as a read of the event does.
		if (target !== creator.id || (creator.kind === "agent" && !creator.agent_scopes.includes("calendar.read"))) {
			return { action: "disable_subscription", reason: "access_lost" };
		}
	} else if (memberIds !== undefined) {
		if (!memberIds.includes(creator.id)) return { action: "disable_subscription", reason: "access_lost" };
	} else if (subscription.domain === "drive" && target.startsWith("drv_")) {
		// A shared drive event stores its members. The directory index can be behind, so a job with no list sends nothing.
		return { action: "skip" };
	} else if (target !== creator.id) {
		if (subscription.domain === "mail" && isTeamMailboxId(target)) {
			// A member that lost mail.read in the mailbox lost the access of a new subscription.
			const scopes = await teamMailboxMemberScopes(db, target, creator.id);
			if (!scopes?.includes("mail.read")) {
				return { action: "disable_subscription", reason: "access_lost" };
			}
		} else {
			const agent = await getPrincipal(db, target);
			if (agent?.kind !== "agent" || agent.service || creator.kind !== "human" || agent.sponsor_id !== creator.id) {
				return { action: "disable_subscription", reason: "access_lost" };
			}
			if (agent.archived_at !== null) return { action: "skip" };
		}
	}
	if (!outboundHostAllowed(creator, endpoint.url)) return { action: "disable_endpoint", reason: "policy_denied" };
	return { action: "deliver", creator };
}

function targetOf(job: DeliveryJob): string {
	if (job.kind === "calendar_delivery") return job.calendarId;
	return job.kind === "drive_delivery" ? job.spaceId : job.mailboxId;
}

/**
 * Sends one event to one subscription. A subscription or an endpoint that was deleted or disabled gets
 * nothing. For mail, a new event joins a retry that already waits, so a receiver that is down gets one
 * chain of attempts.
 */
async function deliver(env: Env, job: DeliveryJob): Promise<void> {
	const db = env.DIRECTORY;
	const attempt = job.attempt ?? 1;
	const pair = await getDelivery(db, job.webhookId);
	if (!pair) return;
	if (pair.subscription.status !== "active" || pair.endpoint.status !== "active") return;
	if (pair.subscription.target_id !== targetOf(job)) return;
	// A retry can run after the end of the subscription.
	if (isExpired(pair.subscription, Date.now())) return;
	// The id of a subscription of MCP Events is the same after an unsubscribe and a new subscribe. A job
	// from before the new subscription must not go to it: these events have no replay.
	if (pair.endpoint.protocol === "mcp_events" && job.occurredAt < Date.parse(pair.subscription.created_at)) return;
	if (job.kind === "delivery" && attempt === 1 && joinsWaitingRetry(pair.subscription, job.eventId, Date.now())) return;
	const memberIds = job.kind === "drive_delivery" ? job.memberIds : undefined;
	const check = await checkDelivery(db, pair.endpoint, pair.subscription, memberIds);
	if (check.action === "skip") return;
	if (check.action === "disable_endpoint") {
		await disableEndpoint(db, pair.endpoint, check.reason);
		return;
	}
	if (check.action === "disable_subscription") {
		await disableSubscription(db, pair.subscription, check.reason);
		return;
	}
	if (job.kind === "chat_delivery") {
		// The target can change its notification level while a delivery waits for a retry.
		const target = pair.subscription.target_id;
		const principal = env.PRINCIPAL.get(env.PRINCIPAL.idFromName(target));
		if (
			!(await principal.chatNotificationAllowed(job.roomId, knownReason(job.reason), job.occurredAt, job.membershipId))
		)
			return;
		const room = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(job.roomId));
		const messageId = job.messageId ?? job.eventId;
		const eventType = job.eventType ?? "chat.message.created";
		if (!(await room.canNotifyWebhook(target, messageId, job.membershipId, eventType))) return;
	}
	const result = await post(env, pair.endpoint, pair.subscription, job);
	if (result === "ok") {
		await recordDelivery(db, pair.subscription);
		return;
	}
	if (result === "gone") {
		await disableEndpoint(db, pair.endpoint, "gone");
		return;
	}
	const delay = RETRY_DELAYS_S[attempt - 1];
	// MCP Events: a receiver that answers 413 refuses this event for good, so a retry has no use. A retry
	// also cannot open a sealed secret that did not open.
	const refused = (pair.endpoint.protocol === "mcp_events" && result === "http_413") || result === SECRET_UNREADABLE;
	if (!refused && attempt < WEBHOOK_LIMITS.attempts && delay !== undefined) {
		await env.WEBHOOKS.send({ ...job, attempt: attempt + 1 } satisfies DeliveryJob, { delaySeconds: delay });
		await recordFailedAttempt(
			db,
			pair.subscription,
			job.eventId,
			result,
			new Date(Date.now() + delay * 1000 + RETRY_GRACE_MS),
			job.kind === "delivery",
		);
		return;
	}
	await recordFailedEvent(db, pair.endpoint, pair.subscription, `${job.eventId}_${pair.subscription.id}`, result);
}

/** The body of a mail POST. It holds no mail content. The shape matches the previous Worker. */
export function webhookBody(row: { id: string; mailbox_id: string }, occurredAt: number): string {
	return JSON.stringify({
		type: WEBHOOK_EVENT_TYPE,
		timestamp: new Date(occurredAt).toISOString(),
		data: {
			webhook_id: row.id,
			mailbox_id: row.mailbox_id,
			uri: expandTemplate(resources["mail.inbox"].uriTemplate, { mailbox_id: row.mailbox_id }),
		},
	});
}

/**
 * The fields of a chat event that a POST of each form has: ids, the reason, the author and the version.
 * They are no content. A receiver uses them to decide if it reads the message.
 */
function chatData(job: ChatWebhookDeliveryJob): Record<string, string | number> {
	const reason = knownReason(job.reason);
	return {
		room_id: job.roomId,
		message_id: job.messageId ?? job.eventId,
		// A reply in a thread: read it with chat.list_replies of the parent.
		...(job.parentId === undefined ? {} : { parent_id: job.parentId }),
		...(reason === undefined ? {} : { reason }),
		...(job.authorId === undefined ? {} : { author_id: job.authorId }),
		...(job.version === undefined ? {} : { version: job.version }),
		uri: expandTemplate(resources["chat.room"].uriTemplate, { room_id: job.roomId }),
	};
}

function chatBody(subscription: SubscriptionRow, job: ChatWebhookDeliveryJob): string {
	return JSON.stringify({
		type: job.eventType ?? "chat.message.created",
		timestamp: new Date(job.occurredAt).toISOString(),
		data: { webhook_id: subscription.id, principal_id: subscription.target_id, ...chatData(job) },
	});
}

/** The ids of a calendar change, as the payload of `calendar.*` events gives them. No title, time or answer. */
function calendarData(job: CalendarWebhookDeliveryJob): Record<string, string | number | null> {
	return {
		calendar_id: job.calendarId,
		event_id: job.calendarEventId,
		change_id: job.eventId,
		occurrence_id: job.occurrenceId,
		revision: job.revision,
		actor_id: job.actorId,
		cursor: job.cursor,
	};
}

function calendarBody(subscription: SubscriptionRow, job: CalendarWebhookDeliveryJob): string {
	return JSON.stringify({
		type: job.eventType,
		timestamp: new Date(job.occurredAt).toISOString(),
		data: { webhook_id: subscription.id, ...calendarData(job) },
	});
}

function driveBody(subscription: SubscriptionRow, job: DriveWebhookDeliveryJob): string {
	const itemEvent = job.eventType.startsWith("drive.item.");
	const data: Record<string, string> = {
		webhook_id: subscription.id,
		space_id: job.spaceId,
		uri: itemEvent
			? expandTemplate(resources["drive.item"].uriTemplate, { space_id: job.spaceId, item_id: job.itemId })
			: expandTemplate(resources["drive.space"].uriTemplate, { drive_id: job.spaceId }),
	};
	if (itemEvent) data.item_id = job.itemId;
	return JSON.stringify({
		type: job.eventType,
		timestamp: new Date(job.occurredAt).toISOString(),
		data,
	});
}

/**
 * The body of a POST of MCP Events. `data` has the fields of the payload schema of the event. It has
 * ids, a URI and, for Chat, the facts of `chatData`: no mail, no message text and no file content.
 */
function eventBody(subscription: SubscriptionRow, job: DeliveryJob, id: string): string {
	let data: Record<string, string | number | null>;
	if (job.kind === "calendar_delivery") {
		data = calendarData(job);
	} else if (job.kind === "delivery") {
		data = {
			mailbox_id: job.mailboxId,
			uri: expandTemplate(resources["mail.inbox"].uriTemplate, { mailbox_id: job.mailboxId }),
		};
	} else if (job.kind === "chat_delivery") {
		data = chatData(job);
	} else if (job.eventType.startsWith("drive.item.")) {
		data = {
			space_id: job.spaceId,
			item_id: job.itemId,
			uri: expandTemplate(resources["drive.item"].uriTemplate, { space_id: job.spaceId, item_id: job.itemId }),
		};
	} else {
		data = {
			space_id: job.spaceId,
			uri: expandTemplate(resources["drive.space"].uriTemplate, { drive_id: job.spaceId }),
		};
	}
	return JSON.stringify({
		eventId: id,
		name: subscription.event_type,
		timestamp: new Date(job.occurredAt).toISOString(),
		data,
		// These events have no replay.
		cursor: null,
	});
}

function bodyOf(endpoint: EndpointRow, subscription: SubscriptionRow, job: DeliveryJob, id: string): string {
	if (endpoint.protocol === "mcp_events") return eventBody(subscription, job, id);
	if (job.kind === "delivery") return webhookBody({ id: subscription.id, mailbox_id: job.mailboxId }, job.occurredAt);
	if (job.kind === "chat_delivery") return chatBody(subscription, job);
	if (job.kind === "calendar_delivery") return calendarBody(subscription, job);
	return driveBody(subscription, job);
}

/**
 * The `webhook-signature` header of Standard Webhooks: `v1,` and the base64 of the HMAC-SHA256 of
 * `<id>.<timestamp>.<body>`. The key is the bytes of the base64 after `whsec_`.
 */
export async function webhookSignature(secret: string, id: string, timestamp: string, body: string): Promise<string> {
	const key = base64ToBytes(secret.slice(SECRET_PREFIX.length));
	return `v1,${bytesToBase64(await hmacSha256(key, `${id}.${timestamp}.${body}`))}`;
}

/** The plaintext of the sealed values of an endpoint. */
interface EndpointSecrets {
	secret: string;
	/** The secret that a refresh replaced, only while its signature is still necessary. */
	previousSecret: string | null;
	authKey: string | null;
	headerValue: string | null;
}

/**
 * Opens the values that a POST needs. Null when the secret, the auth key or the header value does not open:
 * a POST without one of them is not the POST that the receiver expects. A previous secret that does not
 * open only loses its signature.
 */
async function openEndpointSecrets(env: Env, endpoint: EndpointRow): Promise<EndpointSecrets | null> {
	const secret = await openSecret(env, ENDPOINT_SEAL.secret, endpoint.secret);
	if (!secret.ok) return null;
	const authKey = await openSecretOrNull(env, ENDPOINT_SEAL.authKey, endpoint.auth_key);
	if (endpoint.auth_key !== null && authKey === null) return null;
	const headerValue = await openSecretOrNull(env, ENDPOINT_SEAL.headerValue, endpoint.header_value);
	if (endpoint.header_value !== null && headerValue === null) return null;
	const overlap =
		endpoint.previous_secret !== null &&
		endpoint.previous_secret_until !== null &&
		Date.parse(endpoint.previous_secret_until) > Date.now();
	const previousSecret = overlap ? await openSecretOrNull(env, ENDPOINT_SEAL.secret, endpoint.previous_secret) : null;
	return { secret: secret.value, previousSecret, authKey, headerValue };
}

/**
 * The headers of a POST. The custom header and the auth key come first, so the headers that Asterra sets
 * always win. A POST of MCP Events names its subscription. After a refresh with a new secret, it has the
 * signature of the old secret too, for a short time.
 */
async function postHeaders(
	endpoint: EndpointRow,
	secrets: EndpointSecrets,
	subscription: SubscriptionRow,
	id: string,
	timestamp: string,
	body: string,
): Promise<Headers> {
	const headers = new Headers();
	if (endpoint.header_name !== null && secrets.headerValue !== null) {
		headers.set(endpoint.header_name, secrets.headerValue);
	}
	if (secrets.authKey !== null) headers.set("authorization", `Bearer ${secrets.authKey}`);
	headers.set("content-type", "application/json");
	headers.set("user-agent", "Asterra-Webhooks/1");
	headers.set("webhook-id", id);
	headers.set("webhook-timestamp", timestamp);
	const signatures = [await webhookSignature(secrets.secret, id, timestamp, body)];
	if (secrets.previousSecret !== null) {
		signatures.push(await webhookSignature(secrets.previousSecret, id, timestamp, body));
	}
	headers.set("webhook-signature", signatures.join(" "));
	if (endpoint.protocol === "mcp_events") headers.set("x-mcp-subscription-id", subscription.id);
	return headers;
}

/**
 * Sends the signed POST. `ok` for a 2xx answer, `gone` for 410, and otherwise the code of the failure. The
 * POST never follows a redirect, and the response body is never read. `secret_unreadable`: a sealed value of
 * the endpoint did not open, and no POST went out.
 */
async function post(
	env: Env,
	endpoint: EndpointRow,
	subscription: SubscriptionRow,
	job: DeliveryJob,
): Promise<"ok" | "gone" | string> {
	const id = `${job.eventId}_${subscription.id}`;
	const body = bodyOf(endpoint, subscription, job, id);
	const timestamp = String(Math.floor(Date.now() / 1000));
	const secrets = await openEndpointSecrets(env, endpoint);
	if (!secrets) return SECRET_UNREADABLE;
	let response: Response;
	try {
		response = await fetch(endpoint.url, {
			method: "POST",
			headers: await postHeaders(endpoint, secrets, subscription, id, timestamp, body),
			body,
			redirect: "manual",
			signal: AbortSignal.timeout(WEBHOOK_LIMITS.timeoutMs),
		});
	} catch (error) {
		const name = error instanceof Error ? error.name : "";
		return name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
	}
	await response.body?.cancel();
	if (response.status >= 200 && response.status < 300) return "ok";
	if (response.status === 410) return "gone";
	if (response.status >= 300 && response.status < 400) return "redirect";
	return `http_${response.status}`;
}
