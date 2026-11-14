import { expandTemplate, resources, WEBHOOK_EVENT_TYPE, WEBHOOK_LIMITS } from "@soldock/contracts";
import { base64ToBytes, bytesToBase64, hmacSha256, log } from "../platform/index.ts";
import {
	activeWebhookIds,
	checkWebhook,
	disableWebhook,
	getWebhook,
	recordDelivery,
	recordFailedAttempt,
	recordFailedEvent,
	retryWaits,
	type WebhookRow,
} from "./webhooks.ts";

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

export type WebhookJob = WebhookEventJob | WebhookDeliveryJob;

/** The delay in seconds before attempt 2, 3, 4 and 5 of a POST. */
const RETRY_DELAYS_S = [10, 60, 300, 1800] as const;
/** The delay before a job runs again after a failure of Soldock itself, such as D1. */
const INTERNAL_RETRY_S = 30;
/** The time after the planned retry while a new event still joins it, in case the retry job runs late. */
const RETRY_GRACE_MS = 2 * WEBHOOK_LIMITS.timeoutMs + 60_000;
const SECRET_PREFIX = "whsec_";

function isWebhookJob(body: unknown): body is WebhookJob {
	const job = body as { [K in keyof WebhookDeliveryJob]?: unknown } | null;
	if (typeof job !== "object" || job === null || job.v !== 1) return false;
	const common =
		typeof job.mailboxId === "string" && typeof job.eventId === "string" && typeof job.occurredAt === "number";
	if (job.kind === "event") return common;
	const attempt = job.attempt;
	const validAttempt =
		attempt === undefined || (typeof attempt === "number" && Number.isInteger(attempt) && attempt >= 1);
	return job.kind === "delivery" && common && typeof job.webhookId === "string" && validAttempt;
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

/**
 * Sends one event to one webhook. A webhook that was deleted or disabled after the event gets nothing.
 * While a failed POST of the webhook waits for its retry, a new event joins that retry: a POST holds no
 * content, so the retry tells the receiver to read the inbox, and a receiver that is down gets one chain
 * of attempts, not one for each event.
 */
async function deliver(env: Env, job: WebhookDeliveryJob): Promise<void> {
	const db = env.DIRECTORY;
	const attempt = job.attempt ?? 1;
	const row = await getWebhook(db, job.webhookId);
	if (row?.status !== "active" || row.mailbox_id !== job.mailboxId) return;
	if (attempt === 1 && retryWaits(row, Date.now())) return;
	const check = await checkWebhook(db, row);
	if (check.action === "skip") return;
	if (check.action === "disable") {
		await disableWebhook(db, row, check.reason);
		return;
	}
	const result = await post(row, job);
	if (result === "ok") {
		await recordDelivery(db, row.id);
		return;
	}
	// Standard Webhooks: a 410 Gone asks the sender to stop.
	if (result === "gone") {
		await disableWebhook(db, row, "gone");
		return;
	}
	const delay = RETRY_DELAYS_S[attempt - 1];
	if (attempt < WEBHOOK_LIMITS.attempts && delay !== undefined) {
		await recordFailedAttempt(db, row.id, result, new Date(Date.now() + delay * 1000 + RETRY_GRACE_MS));
		await env.WEBHOOKS.send({ ...job, attempt: attempt + 1 } satisfies WebhookDeliveryJob, { delaySeconds: delay });
		return;
	}
	await recordFailedEvent(db, row, job.eventId, result);
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
 * Sends the signed POST. `ok` for a 2xx answer, `gone` for 410, and otherwise the code of the failure. The
 * POST never follows a redirect, and the response body is never read.
 */
async function post(row: WebhookRow, job: WebhookDeliveryJob): Promise<"ok" | "gone" | string> {
	const body = webhookBody(row, job.occurredAt);
	// The id of the event and the webhook: the same on each attempt, so a receiver can drop a repeat.
	const id = `${job.eventId}_${row.id}`;
	const timestamp = String(Math.floor(Date.now() / 1000));
	let response: Response;
	try {
		response = await fetch(row.url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"user-agent": "Soldock-Webhooks/1",
				"webhook-id": id,
				"webhook-timestamp": timestamp,
				"webhook-signature": await webhookSignature(row.secret, id, timestamp, body),
			},
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
