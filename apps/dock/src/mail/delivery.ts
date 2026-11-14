import { addressTag } from "../identity/index.ts";
import { sha256Hex } from "../platform/index.ts";
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
	return mailboxStub(env, input.mailboxId).deliver({
		contentHash: input.contentHash,
		rawKey: input.rawKey,
		size: input.bytes.byteLength,
		origin: input.origin,
		internalDate: input.receivedAt,
		parsed,
		spam,
		tag: input.tag,
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
