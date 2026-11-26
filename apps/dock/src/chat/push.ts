import { CHAT_EVENT_REASONS, type ChatEventReason } from "@asterra/contracts";
import { checkPublicHost, log } from "../platform/index.ts";
import { fanOutPush, isChatPushFanout } from "./push-fanout.ts";
import { encryptPush, pushAuthorization } from "./web-push.ts";

/** The queue that carries Web Push deliveries. A suffix: see `queues.ts`. */
export const CHAT_PUSH_QUEUE = "chat-push";
const PUSH_LIFETIME_MS = 60 * 60_000;

/** One delivery to one device. The endpoint and the encryption keys stay in its PrincipalDO. */
export interface ChatPushJob {
	v: 1;
	principalId: string;
	subscriptionId: string;
	roomId: string;
	messageId: string;
	membershipId: string;
	reason: ChatEventReason;
	occurredAt: number;
}

function isPushJob(body: unknown): body is ChatPushJob {
	if (typeof body !== "object" || body === null) return false;
	const job = body as Partial<ChatPushJob>;
	return (
		job.v === 1 &&
		typeof job.principalId === "string" &&
		typeof job.subscriptionId === "string" &&
		typeof job.roomId === "string" &&
		typeof job.messageId === "string" &&
		typeof job.membershipId === "string" &&
		job.reason !== undefined &&
		CHAT_EVENT_REASONS.includes(job.reason) &&
		typeof job.occurredAt === "number" &&
		Number.isSafeInteger(job.occurredAt)
	);
}

async function deliverPush(job: ChatPushJob, env: Env): Promise<void> {
	const remaining = job.occurredAt + PUSH_LIFETIME_MS - Date.now();
	if (remaining <= 0) return;
	const room = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(job.roomId));
	const location = await room.chatPushMessage(job.principalId, job.messageId, job.membershipId);
	if (!location) return;
	const principal = env.PRINCIPAL.get(env.PRINCIPAL.idFromName(job.principalId));
	const target = await principal.pushTarget(
		job.subscriptionId,
		job.roomId,
		job.reason,
		job.occurredAt,
		location.unread_count,
		job.membershipId,
		job.messageId,
	);
	if (!target) return;

	const endpoint = new URL(target.endpoint);
	const signal = AbortSignal.timeout(10_000);
	await checkPublicHost(endpoint.hostname, signal);
	const body = await encryptPush(
		target.keys,
		JSON.stringify({
			principal_id: job.principalId,
			room_id: job.roomId,
			message_id: job.messageId,
			seq: location.seq,
			parent_seq: location.parent_seq,
			unread_count: target.unread_count,
			sound: target.sound,
			foreground_sound: target.foreground_sound,
		}),
	);
	const response = await fetch(endpoint.href, {
		method: "POST",
		headers: {
			authorization: await pushAuthorization(env, endpoint.origin),
			"content-encoding": "aes128gcm",
			"content-type": "application/octet-stream",
			ttl: String(Math.ceil(remaining / 1000)),
		},
		body,
		redirect: "manual",
		signal,
	});
	await response.body?.cancel();
	if (response.status === 404 || response.status === 410) {
		await principal.expirePushSubscription(job.subscriptionId);
	} else if (!response.ok) {
		throw new Error(`Push service status ${response.status}.`);
	}
}

export async function handleChatPushBatch(batch: MessageBatch<unknown>, env: Env): Promise<void> {
	for (const message of batch.messages) {
		const job = message.body;
		try {
			if (isChatPushFanout(job)) {
				if (Date.now() - job.occurredAt < PUSH_LIFETIME_MS) await fanOutPush(job, env);
			} else if (isPushJob(job)) {
				await deliverPush(job, env);
			} else {
				log("warn", "invalid chat push job", { jobId: message.id });
			}
			message.ack();
		} catch {
			// Error text can contain the secret endpoint. Log only the queue id and the attempt.
			log("warn", "chat push delivery failed", { jobId: message.id, attempts: message.attempts });
			message.retry({ delaySeconds: Math.min(300, 10 * 2 ** (message.attempts - 1)) });
		}
	}
}
