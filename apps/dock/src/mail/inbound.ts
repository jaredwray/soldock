import { MAIL_LIMITS } from "@soldock/contracts";
import { resolveAddress } from "../identity/index.ts";
import { log } from "../platform/index.ts";
import { deliverStoredRaw, storeRaw } from "./delivery.ts";

/** The queue that carries inbound mail from `email()` to the parser. */
export const MAIL_INBOUND_QUEUE = "soldock-mail-inbound";

/** One message for one mailbox. The raw bytes are in R2. Version 1. */
export interface InboundJob {
	v: 1;
	principalId: string;
	rawKey: string;
	contentHash: string;
	receivedAt: number;
}

const MAX_ATTEMPTS = 5;

function isInboundJob(body: unknown): body is InboundJob {
	const job = body as Partial<InboundJob> | null;
	return (
		typeof job === "object" &&
		job !== null &&
		job.v === 1 &&
		typeof job.principalId === "string" &&
		typeof job.rawKey === "string" &&
		typeof job.contentHash === "string" &&
		typeof job.receivedAt === "number"
	);
}

/**
 * The `email()` handler. Email Routing calls it once for each recipient. An unknown recipient or a
 * message that is too large is rejected during the SMTP session, so the sender gets a bounce. An
 * accepted message is in R2 and on the queue before the handler returns.
 */
export async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
	const recipientDomain = message.to.split("@").pop()?.toLowerCase();
	const recipient = await resolveAddress(env.DIRECTORY, message.to);
	if (!recipient) {
		log("info", "inbound mail rejected: unknown recipient", { recipientDomain });
		message.setReject("5.1.1 Recipient address rejected: no such mailbox");
		return;
	}
	if (message.rawSize > MAIL_LIMITS.messageBytes) {
		log("info", "inbound mail rejected: too large", { recipientDomain, size: message.rawSize });
		message.setReject("5.3.4 Message size exceeds the limit of this mailbox");
		return;
	}
	const bytes = new Uint8Array(await new Response(message.raw).arrayBuffer());
	if (bytes.byteLength > MAIL_LIMITS.messageBytes) {
		message.setReject("5.3.4 Message size exceeds the limit of this mailbox");
		return;
	}
	const { contentHash, rawKey } = await storeRaw(env, recipient.id, bytes);
	const job: InboundJob = { v: 1, principalId: recipient.id, rawKey, contentHash, receivedAt: Date.now() };
	await env.MAIL_INBOUND.send(job);
	log("info", "inbound mail accepted", { principalId: recipient.id, size: bytes.byteLength });
}

/**
 * The consumer of `soldock-mail-inbound`. Queues deliver at least once, and the mailbox drops a
 * second copy of the same content, so a redelivery is safe. A job that cannot be read, or that
 * fails `MAX_ATTEMPTS` times, goes to the dead-letter queue for an operator.
 */
export async function handleInboundBatch(batch: MessageBatch<unknown>, env: Env): Promise<void> {
	for (const message of batch.messages) {
		if (!isInboundJob(message.body)) {
			log("error", "inbound job is not valid; sent to the dead-letter queue", { id: message.id });
			await env.MAIL_INBOUND_DLQ.send(message.body);
			message.ack();
			continue;
		}
		const job = message.body;
		try {
			const object = await env.BLOBS.get(job.rawKey);
			if (!object) throw new Error("the raw message is missing from R2");
			const bytes = new Uint8Array(await object.arrayBuffer());
			const result = await deliverStoredRaw(env, {
				principalId: job.principalId,
				bytes,
				rawKey: job.rawKey,
				contentHash: job.contentHash,
				origin: "external",
				receivedAt: job.receivedAt,
			});
			log("info", "inbound mail delivered", {
				principalId: job.principalId,
				status: result.status,
				messageId: result.messageId,
			});
			message.ack();
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			if (message.attempts >= MAX_ATTEMPTS) {
				log("error", "inbound delivery failed; sent to the dead-letter queue", {
					principalId: job.principalId,
					attempts: message.attempts,
					error: detail,
				});
				await env.MAIL_INBOUND_DLQ.send(job);
				message.ack();
			} else {
				log("warn", "inbound delivery failed; retrying", {
					principalId: job.principalId,
					attempts: message.attempts,
					error: detail,
				});
				message.retry({ delaySeconds: Math.min(30 * 2 ** (message.attempts - 1), 600) });
			}
		}
	}
}
