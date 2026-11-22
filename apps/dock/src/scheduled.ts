// The jobs of the cron trigger (`triggers.crons` in wrangler.jsonc). The composition root calls
// `runScheduled` from the `scheduled` handler.
import { API_KEY_LIMITS } from "@asterra/contracts";
import {
	dueExpiryNotices,
	isNoticeDue,
	markExpiryNotice,
	noticeRecipients,
	recordExpiryNotice,
} from "./identity/index.ts";
import { deliverSystemNotice } from "./mail/index.ts";
import { log } from "./platform/index.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The most mails of notices in one run, so that a run stays inside the subrequest limit of a Worker. A
 * token whose mails do not fit waits for the next run.
 */
const DELIVERIES_PER_RUN = 200;

/** Runs each job of the cron trigger at `now`. A failed job writes an error and does not stop the others. */
export async function runScheduled(env: Env, now: number): Promise<void> {
	try {
		await sendExpiryNotices(env, now);
	} catch (error) {
		log("error", "scheduled: the expiry notices failed", {
			error: error instanceof Error ? (error.stack ?? error.message) : String(error),
		});
	}
}

/**
 * Sends one notice for each token of a service account that ends within the days of the limit: an
 * internal mail to each owner and admin.
 *
 * - Just before the mails of a token, the job reads the token again. A token that an owner or an admin
 *   revoked, or whose account was archived, after the first read gets no mail.
 * - A token gets its mark when each mail arrived, or when the organization has no owner or admin to tell.
 *   When a mail failed, the token stays without a mark, and the next run sends each mail again. The tries
 *   stop at the end of the token, because an ended token is not due.
 * - The bytes of a notice are the same in each run (a fixed Message-ID and date), so a mailbox keeps one
 *   copy when a run sends again, or stops between the mail and the mark.
 */
async function sendExpiryNotices(env: Env, now: number): Promise<void> {
	const due = await dueExpiryNotices(env.DIRECTORY, now);
	if (due.length === 0) return;
	const recipients = await noticeRecipients(env.DIRECTORY);
	let budget = DELIVERIES_PER_RUN;
	for (const notice of due) {
		if (recipients.length > budget) break;
		if (!(await isNoticeDue(env.DIRECTORY, notice.keyId, now))) continue;
		budget -= recipients.length;
		const end = new Date(notice.expiresAt);
		let failed = 0;
		for (const recipient of recipients) {
			try {
				await deliverSystemNotice(env, {
					from: { name: "Asterra", address: notice.accountAddress },
					to: { mailboxId: recipient.id, address: recipient.address },
					subject: `The token "${notice.label}" of ${notice.accountName} ends on ${end.toUTCString()}`,
					text: [
						`The token "${notice.label}" of the service account ${notice.accountName} (${notice.accountAddress}) stops on ${end.toUTCString()}.`,
						"",
						"A rotation keeps this end. Create a new token with a later end in Admin › Members, and put it in each script before that time. Each script that uses the old token stops at its end.",
					].join("\n"),
					messageId: `<token-expiry.${notice.keyId.toLowerCase()}@${notice.accountAddress.split("@")[1]}>`,
					date: new Date(end.getTime() - API_KEY_LIMITS.expiryNoticeDays * DAY_MS),
				});
			} catch (error) {
				failed++;
				log("warn", "scheduled: an expiry notice did not arrive", {
					keyId: notice.keyId,
					recipient: recipient.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		if (failed > 0) continue;
		if (await markExpiryNotice(env.DIRECTORY, notice.keyId, now)) await recordExpiryNotice(env, notice, now);
	}
}
