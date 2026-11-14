import { MAIL_LIMITS } from "@soldock/contracts";
import { addressTag, resolveMailboxAddress } from "../identity/index.ts";
import { log } from "../platform/index.ts";
import { deliverStoredRaw, storeRaw } from "./delivery.ts";

/** The queue that carries inbound mail from `email()` to the parser. */
export const MAIL_INBOUND_QUEUE = "soldock-mail-inbound";

/** One message for one mailbox. The raw bytes are in R2. Version 1. */
export interface InboundJob {
	v: 1;
	/**
	 * The id of the mailbox: the id of a principal, or the id of a team mailbox. The name is from before
	 * team mailboxes, and it stays, so jobs that wait in the queue during a deploy stay valid.
	 */
	principalId: string;
	rawKey: string;
	contentHash: string;
	receivedAt: number;
	/**
	 * The `+tag` of the recipient address, if it has one. The field is optional, so jobs from before
	 * it stay valid. The mailbox applies the user label with the same name, if one exists.
	 */
	tag?: string;
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
		typeof job.receivedAt === "number" &&
		(job.tag === undefined || typeof job.tag === "string")
	);
}

/**
 * The `email()` handler. Email Routing calls it once for each recipient. An unknown recipient or a
 * message that is too large is rejected during the SMTP session, so the sender gets a bounce. An
 * accepted message is in R2 and on the queue before the handler returns.
 */
export async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
	const recipientDomain = message.to.split("@").pop()?.toLowerCase();
	const recipient = await resolveMailboxAddress(env.DIRECTORY, message.to);
	if (!recipient) {
		log("info", "inbound mail rejected: unknown recipient", { recipientDomain });
		message.setReject("5.1.1 Recipient address rejected: no such mailbox");
		return;
	}
	if (message.rawSize > MAIL_LIMITS.inboundMessageBytes) {
		log("info", "inbound mail rejected: too large", { recipientDomain, size: message.rawSize });
		message.setReject("5.3.4 Message size exceeds the limit of this mailbox");
		return;
	}
	const bytes = new Uint8Array(await new Response(message.raw).arrayBuffer());
	if (bytes.byteLength > MAIL_LIMITS.inboundMessageBytes) {
		message.setReject("5.3.4 Message size exceeds the limit of this mailbox");
		return;
	}
	const { contentHash, rawKey } = await storeRaw(env, recipient.id, bytes);
	const job: InboundJob = { v: 1, principalId: recipient.id, rawKey, contentHash, receivedAt: Date.now() };
	const tag = addressTag(message.to);
	if (tag) job.tag = tag;
	await env.MAIL_INBOUND.send(job);
	log("info", "inbound mail accepted", { mailboxId: recipient.id, size: bytes.byteLength });
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
				mailboxId: job.principalId,
				bytes,
				rawKey: job.rawKey,
				contentHash: job.contentHash,
				origin: "external",
				receivedAt: job.receivedAt,
				tag: job.tag ?? null,
			});
			log("info", "inbound mail delivered", {
				mailboxId: job.principalId,
				status: result.status,
				messageId: result.messageId,
			});
			message.ack();
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			if (message.attempts >= MAX_ATTEMPTS) {
				log("error", "inbound delivery failed; sent to the dead-letter queue", {
					mailboxId: job.principalId,
					attempts: message.attempts,
					error: detail,
				});
				await env.MAIL_INBOUND_DLQ.send(job);
				message.ack();
			} else {
				log("warn", "inbound delivery failed; retrying", {
					mailboxId: job.principalId,
					attempts: message.attempts,
					error: detail,
				});
				message.retry({ delaySeconds: Math.min(30 * 2 ** (message.attempts - 1), 600) });
			}
		}
	}
}
