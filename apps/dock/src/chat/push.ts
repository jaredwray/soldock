import { CHAT_EVENT_REASONS, type ChatEventReason } from "@asterra/contracts";
import { checkPublicHost, log } from "../platform/index.ts";
import { fanOutPush, isChatPushFanout } from "./push-fanout.ts";
import { activeVapid, type VapidConfig } from "./push-settings.ts";
import { encryptPush, pushAuthorization } from "./web-push.ts";

export const CHAT_PUSH_QUEUE = "soldock-chat-push";
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

/**
 * One calendar reminder to one device. The CalendarDO of the principal sends it after the PrincipalDO
 * recorded the reminder in the Activity. The payload has no title, as a chat push has no text.
 */
export interface CalendarPushJob {
	v: 1;
	kind: "calendar_reminder";
	principalId: string;
	subscriptionId: string;
	/** The id of the Activity item. The device uses it as the tag, so a second delivery replaces the first. */
	reminderId: string;
	eventId: string;
	occurrenceId: string | null;
	startAt: number;
	minutes: number;
}

function isCalendarPushJob(body: unknown): body is CalendarPushJob {
	if (typeof body !== "object" || body === null) return false;
	const job = body as Partial<CalendarPushJob>;
	return (
		job.v === 1 &&
		job.kind === "calendar_reminder" &&
		typeof job.principalId === "string" &&
		typeof job.subscriptionId === "string" &&
		typeof job.reminderId === "string" &&
		typeof job.eventId === "string" &&
		(job.occurrenceId === null || typeof job.occurrenceId === "string") &&
		Number.isSafeInteger(job.startAt) &&
		Number.isSafeInteger(job.minutes)
	);
}

/** Sends calendar reminder jobs to the push queue, at most 100 in one batch. */
export async function enqueueCalendarPush(
	env: Pick<Env, "CHAT_PUSH">,
	jobs: readonly CalendarPushJob[],
): Promise<void> {
	for (let offset = 0; offset < jobs.length; offset += 100) {
		await env.CHAT_PUSH.sendBatch(jobs.slice(offset, offset + 100).map((body) => ({ body })));
	}
}

async function sendPush(
	vapid: VapidConfig,
	target: { endpoint: string; keys: { p256dh: string; auth: string } },
	payload: unknown,
	remainingMs: number,
): Promise<number> {
	const endpoint = new URL(target.endpoint);
	const signal = AbortSignal.timeout(10_000);
	await checkPublicHost(endpoint.hostname, signal);
	const body = await encryptPush(target.keys, JSON.stringify(payload));
	const response = await fetch(endpoint.href, {
		method: "POST",
		headers: {
			authorization: await pushAuthorization(vapid, endpoint.origin),
			"content-encoding": "aes128gcm",
			"content-type": "application/octet-stream",
			ttl: String(Math.ceil(remainingMs / 1000)),
		},
		body,
		redirect: "manual",
		signal,
	});
	await response.body?.cancel();
	return response.status;
}

async function deliverCalendarPush(job: CalendarPushJob, env: Env, vapid: VapidConfig): Promise<void> {
	// A reminder after the start of the occurrence helps nobody.
	const remaining = job.startAt - Date.now();
	if (remaining <= 0) return;
	const principal = env.PRINCIPAL.get(env.PRINCIPAL.idFromName(job.principalId));
	const target = await principal.calendarPushTarget(job.subscriptionId, job.reminderId);
	if (!target) return;
	const status = await sendPush(
		vapid,
		target,
		{
			kind: "calendar_reminder",
			principal_id: job.principalId,
			reminder_id: job.reminderId,
			event_id: job.eventId,
			occurrence_id: job.occurrenceId,
			start: new Date(job.startAt).toISOString(),
			minutes: job.minutes,
			sound: target.sound,
		},
		remaining,
	);
	if ([401, 403, 404, 410].includes(status)) {
		await principal.expirePushSubscription(job.subscriptionId);
	} else if (status < 200 || status >= 300) {
		throw new Error(`Push service status ${status}.`);
	}
}

async function deliverPush(job: ChatPushJob, env: Env, vapid: VapidConfig): Promise<void> {
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
			authorization: await pushAuthorization(vapid, endpoint.origin),
			"content-encoding": "aes128gcm",
			"content-type": "application/octet-stream",
			ttl: String(Math.ceil(remaining / 1000)),
		},
		body,
		redirect: "manual",
		signal,
	});
	await response.body?.cancel();
	// 404 and 410: the subscription is gone. 401 and 403: the push service refuses the key, for example after
	// an admin replaced the keys. A device with the subscription registers again at its next start.
	if ([401, 403, 404, 410].includes(response.status)) {
		await principal.expirePushSubscription(job.subscriptionId);
	} else if (!response.ok) {
		throw new Error(`Push service status ${response.status}.`);
	}
}

export async function handleChatPushBatch(batch: MessageBatch<unknown>, env: Env): Promise<void> {
	// One read of the settings for each batch. While an admin has push off, the live sounds still go to open
	// tabs, but no device gets a delivery, and a delivery job goes without a retry.
	let settings: Promise<VapidConfig | null> | undefined;
	const vapid = () => {
		settings ??= activeVapid(env);
		return settings;
	};
	for (const message of batch.messages) {
		const job = message.body;
		try {
			if (isChatPushFanout(job)) {
				if (Date.now() - job.occurredAt < PUSH_LIFETIME_MS) await fanOutPush(job, env, (await vapid()) !== null);
			} else if (isPushJob(job)) {
				const config = await vapid();
				if (config) await deliverPush(job, env, config);
			} else if (isCalendarPushJob(job)) {
				const config = await vapid();
				if (config) await deliverCalendarPush(job, env, config);
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
