import { CHAT_EVENT_REASONS, type ChatEventReason } from "@asterra/contracts";
import type { ChatPushJob } from "./push.ts";

/** Each queue message asks a bounded set of principals for their eligible devices. */
const FANOUT_SIZE = 10;

export interface ChatPushFanout {
	v: 1;
	kind: "recipients";
	roomId: string;
	messageId: string;
	parentId?: string;
	occurredAt: number;
	recipients: { id: string; membershipId: string; reason: ChatEventReason }[];
}

export function isChatPushFanout(body: unknown): body is ChatPushFanout {
	if (typeof body !== "object" || body === null) return false;
	const job = body as Partial<ChatPushFanout>;
	return (
		job.v === 1 &&
		job.kind === "recipients" &&
		typeof job.roomId === "string" &&
		typeof job.messageId === "string" &&
		(job.parentId === undefined || typeof job.parentId === "string") &&
		Number.isSafeInteger(job.occurredAt) &&
		Array.isArray(job.recipients) &&
		job.recipients.length <= FANOUT_SIZE &&
		job.recipients.every(
			(m) =>
				m && typeof m.id === "string" && typeof m.membershipId === "string" && CHAT_EVENT_REASONS.includes(m.reason),
		)
	);
}

/** A room has at most 500 members, so all parts of this event fit one queue batch. */
export async function enqueuePushFanout(env: Env, event: ChatPushFanout): Promise<void> {
	const messages = [];
	for (let i = 0; i < event.recipients.length; i += FANOUT_SIZE) {
		messages.push({ body: { ...event, recipients: event.recipients.slice(i, i + FANOUT_SIZE) } });
	}
	await env.CHAT_PUSH.sendBatch(messages);
}

export async function fanOutPush(job: ChatPushFanout, env: Env): Promise<void> {
	const devices = await Promise.all(
		job.recipients.map(async (member): Promise<ChatPushJob[]> => {
			const principal = env.PRINCIPAL.get(env.PRINCIPAL.idFromName(member.id));
			const event = {
				principalId: member.id,
				membershipId: member.membershipId,
				reason: member.reason,
				roomId: job.roomId,
				messageId: job.messageId,
				occurredAt: job.occurredAt,
			};
			const ids = await principal.chatNotificationDevices({ ...event, parentId: job.parentId ?? null });
			return ids.map((subscriptionId) => ({
				v: 1,
				...event,
				subscriptionId,
			}));
		}),
	);
	const messages = devices.flat().map((body) => ({ body }));
	for (let offset = 0; offset < messages.length; offset += 100) {
		await env.CHAT_PUSH.sendBatch(messages.slice(offset, offset + 100));
	}
}
