import { autoLabelActive } from "../ai/index.ts";
import { addressTag, getMailbox } from "../identity/index.ts";
import { sha256Hex } from "../platform/index.ts";
import { composeMessage } from "./mime/compose.ts";
import { parseMail } from "./mime/parse.ts";

/**
 * The R2 key of a raw message in one mailbox. The key comes from the owner and the content, so a
 * retried write of the same message writes the same object, and no retry leaves an orphan. Each
 * object belongs to one mailbox only. A mailbox id is the id of a principal (their own mailbox) or
 * the id of a team mailbox.
 */
export function rawKeyFor(mailboxId: string, contentHash: string): string {
	return `mail/raw/${mailboxId}/${contentHash}`;
}

/** The id of the mailbox that owns a raw message, from its R2 key. */
export function mailboxIdOfRawKey(rawKey: string): string | null {
	return /^mail\/raw\/([^/]+)\//.exec(rawKey)?.[1] ?? null;
}

/** The authserv-id of the receiving server, whose Authentication-Results header the mailbox trusts. */
export function authservId(env: Pick<Env, "MAIL_AUTHSERV_ID">): string {
	return env.MAIL_AUTHSERV_ID || "mx.cloudflare.net";
}

export function mailboxStub(env: Pick<Env, "MAILBOX">, mailboxId: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
}

export async function storeRaw(env: Pick<Env, "BLOBS">, mailboxId: string, bytes: Uint8Array) {
	const contentHash = await sha256Hex(bytes);
	const rawKey = rawKeyFor(mailboxId, contentHash);
	await env.BLOBS.put(rawKey, bytes, { httpMetadata: { contentType: "message/rfc822" } });
	return { contentHash, rawKey };
}

/**
 * Parses a raw message that R2 already holds under `rawKey`, and delivers it to the mailbox with
 * the id `mailboxId`. The mailbox drops a second copy of the same content, so a retry is safe.
 * `tag` is the `+tag` of the recipient address. The mailbox applies the user label with that name.
 */
export async function deliverStoredRaw(
	env: Env,
	input: {
		mailboxId: string;
		bytes: Uint8Array;
		rawKey: string;
		contentHash: string;
		origin: "external" | "internal";
		receivedAt: number;
		tag: string | null;
	},
) {
	const parsed = await parseMail(input.bytes, { authservId: authservId(env) });
	// A DMARC failure on mail from the internet goes to Spam. Internal mail has no such header.
	const spam = input.origin === "external" && parsed.authentication?.dmarc === "fail";
	// One read of the AI settings. The mailbox applies auto labels only when its own setting is on too.
	const owner = !spam && (await autoLabelActive(env)) ? await getMailbox(env.DIRECTORY, input.mailboxId) : null;
	return mailboxStub(env, input.mailboxId).deliver({
		contentHash: input.contentHash,
		rawKey: input.rawKey,
		size: input.bytes.byteLength,
		origin: input.origin,
		internalDate: input.receivedAt,
		parsed,
		spam,
		tag: input.tag,
		autoLabel: owner ? { ownerAddress: owner.address } : null,
	});
}

/**
 * Stores a copy of a raw message for another mailbox of this deployment, and delivers it there.
 * `address` is the recipient address. Its `+tag` selects a user label in that mailbox.
 */
export async function deliverInternal(env: Env, mailboxId: string, address: string, bytes: Uint8Array) {
	const { contentHash, rawKey } = await storeRaw(env, mailboxId, bytes);
	return deliverStoredRaw(env, {
		mailboxId,
		bytes,
		rawKey,
		contentHash,
		origin: "internal",
		receivedAt: Date.now(),
		tag: addressTag(address),
	});
}

/**
 * Delivers a notice of Asterra itself to one mailbox of this deployment, for example the notice before
 * a token of a service account ends. It never leaves the deployment: no outbound mail, no Email Service.
 * The caller gives a fixed `messageId` and `date`, so a second delivery of the same notice has the same
 * bytes, and the mailbox drops it.
 */
export async function deliverSystemNotice(
	env: Env,
	notice: {
		from: { name: string; address: string };
		to: { mailboxId: string; address: string };
		subject: string;
		text: string;
		messageId: string;
		date: Date;
	},
) {
	const raw = composeMessage({
		from: notice.from,
		to: [notice.to.address],
		cc: [],
		subject: notice.subject,
		text: notice.text,
		messageId: notice.messageId,
		date: notice.date,
		attachments: [],
	});
	return deliverInternal(env, notice.to.mailboxId, notice.to.address, new TextEncoder().encode(raw));
}

/**
 * Turns off auto labels in a mailbox and empties its classifier outbox, when its principal is deleted. A job
 * that waits in the queue then gets nothing from the mailbox, so no mail of the deleted mailbox goes to the
 * gateway.
 */
export async function closeAutoLabels(env: Pick<Env, "MAILBOX">, mailboxId: string): Promise<void> {
	await mailboxStub(env, mailboxId).closeAutoLabels();
}
