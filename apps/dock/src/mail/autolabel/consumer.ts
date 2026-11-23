import { chat } from "../../ai/index.ts";
import { getMailbox } from "../../identity/index.ts";
import { log } from "../../platform/index.ts";
import { mailboxStub } from "../delivery.ts";
import { ANSWER_TOKENS, buildMessages, newNonce, outputSchema, parseModelOutput } from "./prompt.ts";

/** The queue that carries messages from the mailbox to the classifier of auto labels. */
export const MAIL_AUTOLABEL_QUEUE = "soldock-mail-autolabel";

/** One message for the classifier. Ids only: the consumer reads the message from its mailbox. Version 1. */
export interface AutoLabelJob {
	v: 1;
	mailboxId: string;
	messageId: string;
}

function isAutoLabelJob(body: unknown): body is AutoLabelJob {
	const job = body as Partial<AutoLabelJob> | null;
	return (
		typeof job === "object" &&
		job !== null &&
		job.v === 1 &&
		typeof job.mailboxId === "string" &&
		typeof job.messageId === "string"
	);
}

/**
 * The consumer of `soldock-mail-autolabel`. For each job it reads the message and the candidate labels
 * from the mailbox, calls the classifier through AI Gateway, and gives the picks back to the mailbox. The
 * mailbox does the work only while the message is in its outbox, so a second delivery of a job does
 * nothing. A transient failure of the gateway retries the job. When AI cannot take the call (off, not
 * configured, no budget), the message leaves the outbox with the labels of the rules only. A job for a
 * mailbox that is not in the directory any more makes no call.
 */
export async function handleAutoLabelBatch(batch: MessageBatch<unknown>, env: Env): Promise<void> {
	for (const message of batch.messages) {
		if (!isAutoLabelJob(message.body)) {
			log("error", "auto label job is not valid; dropped", { id: message.id });
			message.ack();
			continue;
		}
		const job = message.body;
		try {
			const box = mailboxStub(env, job.mailboxId);
			// A job can wait in the queue while a person deletes the account or the team mailbox. The mail of a
			// deleted mailbox never goes to the gateway.
			const dropIfGone = async (): Promise<boolean> => {
				if (await getMailbox(env.DIRECTORY, job.mailboxId)) return false;
				log("info", "auto label job dropped: the mailbox is gone", { mailboxId: job.mailboxId });
				await box.finishAutoLabel(job.messageId);
				message.ack();
				return true;
			};
			if (await dropIfGone()) continue;
			const context = await box.autoLabelJob(job.messageId);
			if (!context) {
				message.ack();
				continue;
			}
			// The delete can come while the mailbox reads the message. Ask the directory again just before the
			// mail leaves the Worker.
			if (await dropIfGone()) continue;
			const prompt = buildMessages(context.prompt, newNonce());
			const result = await chat(env, {
				feature: "mail.auto_label",
				resourceId: job.mailboxId,
				messages: prompt.messages,
				jsonSchema: { name: "auto_labels", schema: outputSchema(prompt.promptKeys) },
				maxTokens: ANSWER_TOKENS,
			});
			if (!result.ok) {
				if (result.retryable) {
					log("warn", "auto label call failed; retrying", { reason: result.reason, attempts: message.attempts });
					message.retry({ delaySeconds: Math.min(30 * 2 ** (message.attempts - 1), 600) });
					continue;
				}
				if (result.reason === "bad_response" || result.reason === "http") {
					// The call went out and failed for good. The message keeps the labels of the rules.
					await box.applyAutoLabels(job.messageId, []);
				} else {
					log("info", "auto label call skipped", { reason: result.reason });
					await box.finishAutoLabel(job.messageId);
				}
				message.ack();
				continue;
			}
			// The keys of the prompt become the keys of the mailbox. A key that the prompt did not offer is dropped.
			const picks = parseModelOutput(result.content).flatMap((pick) => {
				const key = prompt.keyOf.get(pick.key);
				return key ? [{ key, confidence: pick.confidence }] : [];
			});
			const applied = await box.applyAutoLabels(job.messageId, picks);
			log("info", "auto labels applied", {
				mailboxId: job.mailboxId,
				labels: applied.applied.length,
				archived: applied.archived,
			});
			message.ack();
		} catch (error) {
			log("warn", "auto label job failed; retrying", {
				attempts: message.attempts,
				error: error instanceof Error ? error.message : String(error),
			});
			message.retry({ delaySeconds: Math.min(30 * 2 ** (message.attempts - 1), 600) });
		}
	}
}
