import {
	CHAT_LIMITS,
	CHAT_WEBHOOK_EVENT_TYPE,
	expandTemplate,
	resources,
	WEBHOOK_EVENT_TYPE,
	WEBHOOK_LIMITS,
} from "@soldock/contracts";
import { base64ToBytes, bytesToBase64, hmacSha256, log } from "../platform/index.ts";
import {
	activeWebhookIds,
	checkWebhook,
	disableWebhook,
	getWebhook,
	joinsWaitingRetry,
	recordDelivery,
	recordFailedAttempt,
	recordFailedEvent,
	type WebhookRow,
} from "./subscriptions.ts";

/** The queue that carries webhook events from the mailboxes, and one POST for each webhook. */
export const WEBHOOK_QUEUE = "soldock-webhooks";

/** New mail in the inbox of a mailbox. The `MailboxDO` sends it from its event outbox. Version 1. */
export interface WebhookEventJob {
	v: 1;
	kind: "event";
	mailboxId: string;
	/** The same id on each redelivery, so each POST of the event has the same `webhook-id`. */
	eventId: string;
	occurredAt: number;
}

/** One POST of one event to one webhook. Version 1. */
export interface WebhookDeliveryJob {
	v: 1;
	kind: "delivery";
	webhookId: string;
	mailboxId: string;
	eventId: string;
	occurredAt: number;
	/**
	 * The POST attempt, from 1. A retry is a new job with the next attempt, so a failure of Soldock
	 * itself, which retries the same job, never uses up an attempt of the receiver.
	 */
	attempt?: number;
}

/** A committed message and the members at the time of the post, except its author. */
export interface ChatWebhookEventJob {
	v: 1;
	kind: "chat_event";
	roomId: string;
	eventId: string;
	occurredAt: number;
	subscriptionSequence: number;
	recipients: { id: string; membershipId: string }[];
}
interface ChatWebhookDeliveryJob extends Omit<WebhookDeliveryJob, "kind"> {
	kind: "chat_delivery";
	roomId: string;
	membershipId: string;
}
export type WebhookJob = WebhookEventJob | WebhookDeliveryJob | ChatWebhookEventJob | ChatWebhookDeliveryJob;
type DeliveryJob = WebhookDeliveryJob | ChatWebhookDeliveryJob;

/** The delay in seconds before attempt 2, 3, 4 and 5 of a POST. */
const RETRY_DELAYS_S = [10, 60, 300, 1800] as const;
/** The delay before a job runs again after a failure of Soldock itself, such as D1. */
const INTERNAL_RETRY_S = 30;
/** The time after the planned retry while a new event still joins it, in case the retry job runs late. */
const RETRY_GRACE_MS = 2 * WEBHOOK_LIMITS.timeoutMs + 60_000;
const SECRET_PREFIX = "whsec_";

function isWebhookJob(body: unknown): body is WebhookJob {
	if (typeof body !== "object" || body === null) return false;
	const job = body as Record<string, unknown>;
	if (
		job.v !== 1 ||
		typeof job.eventId !== "string" ||
		typeof job.occurredAt !== "number" ||
		!Number.isFinite(job.occurredAt)
	)
		return false;
	if (job.kind === "chat_event")
		return (
			typeof job.roomId === "string" &&
			typeof job.subscriptionSequence === "number" &&
			Number.isSafeInteger(job.subscriptionSequence) &&
			job.subscriptionSequence >= 0 &&
			Array.isArray(job.recipients) &&
			job.recipients.length <= CHAT_LIMITS.membersPerRoom &&
			job.recipients.every(
				(r: unknown) =>
					typeof r === "object" &&
					r !== null &&
					"id" in r &&
					typeof r.id === "string" &&
					"membershipId" in r &&
					typeof r.membershipId === "string" &&
					r.membershipId.length > 0,
			)
		);
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
				job.membershipId.length > 0))
	);
}

/**
 * The consumer of `soldock-webhooks`. An event job becomes one delivery job for each active webhook of the
 * mailbox. A delivery job checks the access of the creator of the webhook again and sends one signed POST.
 * A failed POST puts a new job with the next attempt on the queue, with a delay. Jobs run in parallel, so
 * one slow receiver does not hold the others. A job that cannot be read goes to the dead-letter queue. A
 * job that fails in Soldock itself runs again, and after the `max_retries` of the consumer the queue moves
 * it to the dead-letter queue.
 */
export async function handleWebhookBatch(batch: MessageBatch<unknown>, env: Env): Promise<void> {
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

/** Sends one delivery job for each active webhook of the mailbox. A mailbox has at most `perMailbox` webhooks. */
async function fanOut(env: Env, job: WebhookEventJob): Promise<void> {
	const ids = await activeWebhookIds(env.DIRECTORY, job.mailboxId);
	if (ids.length === 0) return;
	await env.WEBHOOKS.sendBatch(
		ids.map((webhookId) => ({
			body: {
				v: 1,
				kind: "delivery",
				webhookId,
				mailboxId: job.mailboxId,
				eventId: job.eventId,
				occurredAt: job.occurredAt,
			} satisfies WebhookDeliveryJob,
		})),
	);
}

/** Split both the D1 query and queue batch to respect their limits. */
async function fanOutChat(env: Env, job: ChatWebhookEventJob): Promise<void> {
	for (let start = 0; start < job.recipients.length; start += 90) {
		const recipients = job.recipients.slice(start, start + 90);
		const memberships = new Map(recipients.map((member) => [member.id, member.membershipId]));
		const { results } = await env.DIRECTORY.prepare(
			`SELECT id, mailbox_id FROM chat_webhooks WHERE status = 'active' AND sequence <= ?
    AND mailbox_id IN (${recipients.map(() => "?").join(",")})`,
		)
			.bind(job.subscriptionSequence, ...recipients.map((member) => member.id))
			.all<{ id: string; mailbox_id: string }>();
		for (let offset = 0; offset < results.length; offset += 100) {
			await env.WEBHOOKS.sendBatch(
				results.slice(offset, offset + 100).map((row) => ({
					body: {
						v: 1,
						kind: "chat_delivery",
						webhookId: row.id,
						mailboxId: row.mailbox_id,
						eventId: job.eventId,
						occurredAt: job.occurredAt,
						roomId: job.roomId,
						membershipId: memberships.get(row.mailbox_id) as string,
					} satisfies ChatWebhookDeliveryJob,
				})),
			);
		}
	}
}

/**
 * Sends one event to one webhook. A webhook that was deleted or disabled after the event gets nothing.
 * While a failed POST of the webhook waits for its retry, a new event joins that retry: a POST holds no
 * content, so the retry tells the receiver to read the inbox, and a receiver that is down gets one chain
 * of attempts, not one for each event.
 */
async function deliver(env: Env, job: DeliveryJob): Promise<void> {
	const db = env.DIRECTORY;
	const attempt = job.attempt ?? 1;
	const table = job.kind === "chat_delivery" ? "chat_webhooks" : "webhooks";
	const row = await getWebhook(db, job.webhookId, table);
	if (row?.status !== "active" || row.mailbox_id !== job.mailboxId) return;
	if (job.kind === "delivery" && attempt === 1 && joinsWaitingRetry(row, job.eventId, Date.now())) return;
	const check = await checkWebhook(db, row);
	if (check.action === "skip") return;
	if (check.action === "disable") {
		await disableWebhook(db, row, check.reason, table);
		return;
	}
	if (job.kind === "chat_delivery") {
		const room = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(job.roomId));
		if (!(await room.canNotifyWebhook(row.mailbox_id, job.eventId, job.membershipId))) return;
	}
	const result = await post(row, job);
	if (result === "ok") {
		await recordDelivery(db, row.id, table);
		return;
	}
	// Standard Webhooks: a 410 Gone asks the sender to stop.
	if (result === "gone") {
		await disableWebhook(db, row, "gone", table);
		return;
	}
	const delay = RETRY_DELAYS_S[attempt - 1];
	if (attempt < WEBHOOK_LIMITS.attempts && delay !== undefined) {
		// The retry job first: when the send fails, the queue runs this job again, and nothing marks a retry
		// that does not exist.
		await env.WEBHOOKS.send({ ...job, attempt: attempt + 1 } satisfies DeliveryJob, { delaySeconds: delay });
		await recordFailedAttempt(
			db,
			row.id,
			job.eventId,
			result,
			new Date(Date.now() + delay * 1000 + RETRY_GRACE_MS),
			table,
		);
		return;
	}
	await recordFailedEvent(db, row, job.eventId, result, table);
}

/** The body of a POST, as Standard Webhooks recommends: type, timestamp and data. It holds no mail content. */
export function webhookBody(row: Pick<WebhookRow, "id" | "mailbox_id">, occurredAt: number): string {
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
 * The `webhook-signature` header of Standard Webhooks: `v1,` and the base64 of the HMAC-SHA256 of
 * `<id>.<timestamp>.<body>`. The key is the bytes of the base64 after `whsec_`.
 */
export async function webhookSignature(secret: string, id: string, timestamp: string, body: string): Promise<string> {
	const key = base64ToBytes(secret.slice(SECRET_PREFIX.length));
	return `v1,${bytesToBase64(await hmacSha256(key, `${id}.${timestamp}.${body}`))}`;
}

/**
 * The headers of a POST. The custom header and the auth key come first, so the headers that Soldock sets
 * always win. The contract refuses a custom header with a reserved name in any case.
 */
async function postHeaders(row: WebhookRow, id: string, timestamp: string, body: string): Promise<Headers> {
	const headers = new Headers();
	if (row.header_name !== null && row.header_value !== null) headers.set(row.header_name, row.header_value);
	if (row.auth_key !== null) headers.set("authorization", `Bearer ${row.auth_key}`);
	headers.set("content-type", "application/json");
	headers.set("user-agent", "Soldock-Webhooks/1");
	headers.set("webhook-id", id);
	headers.set("webhook-timestamp", timestamp);
	headers.set("webhook-signature", await webhookSignature(row.secret, id, timestamp, body));
	return headers;
}

/**
 * Sends the signed POST. `ok` for a 2xx answer, `gone` for 410, and otherwise the code of the failure. The
 * POST never follows a redirect, and the response body is never read.
 */
async function post(row: WebhookRow, job: DeliveryJob): Promise<"ok" | "gone" | string> {
	const body =
		job.kind === "delivery"
			? webhookBody(row, job.occurredAt)
			: JSON.stringify({
					type: CHAT_WEBHOOK_EVENT_TYPE,
					timestamp: new Date(job.occurredAt).toISOString(),
					data: {
						webhook_id: row.id,
						principal_id: row.mailbox_id,
						room_id: job.roomId,
						message_id: job.eventId,
						uri: expandTemplate(resources["chat.room"].uriTemplate, { room_id: job.roomId }),
					},
				});
	// The id of the event and the webhook: the same on each attempt, so a receiver can drop a repeat.
	const id = `${job.eventId}_${row.id}`;
	const timestamp = String(Math.floor(Date.now() / 1000));
	let response: Response;
	try {
		response = await fetch(row.url, {
			method: "POST",
			headers: await postHeaders(row, id, timestamp, body),
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
