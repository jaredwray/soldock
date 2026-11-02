import { sha256Hex } from "../platform/index.ts";
import { parseMail } from "./mime/parse.ts";

/**
 * The R2 key of a raw message in one mailbox. The key comes from the owner and the content, so a
 * retried write of the same message writes the same object, and no retry leaves an orphan. Each
 * object belongs to one mailbox only.
 */
export function rawKeyFor(principalId: string, contentHash: string): string {
	return `mail/raw/${principalId}/${contentHash}`;
}

/** The authserv-id of the receiving server, whose Authentication-Results header the mailbox trusts. */
export function authservId(env: Pick<Env, "MAIL_AUTHSERV_ID">): string {
	return env.MAIL_AUTHSERV_ID || "mx.cloudflare.net";
}

export function mailboxStub(env: Pick<Env, "MAILBOX">, principalId: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(principalId));
}

export async function storeRaw(env: Pick<Env, "BLOBS">, principalId: string, bytes: Uint8Array) {
	const contentHash = await sha256Hex(bytes);
	const rawKey = rawKeyFor(principalId, contentHash);
	await env.BLOBS.put(rawKey, bytes, { httpMetadata: { contentType: "message/rfc822" } });
	return { contentHash, rawKey };
}

/**
 * Parses a raw message that R2 already holds under `rawKey`, and delivers it to the mailbox of
 * `principalId`. The mailbox drops a second copy of the same content, so a retry is safe.
 */
export async function deliverStoredRaw(
	env: Env,
	input: {
		principalId: string;
		bytes: Uint8Array;
		rawKey: string;
		contentHash: string;
		origin: "external" | "internal";
		receivedAt: number;
	},
) {
	const parsed = await parseMail(input.bytes, { authservId: authservId(env) });
	// A DMARC failure on mail from the internet goes to Spam. Internal mail has no such header.
	const spam = input.origin === "external" && parsed.authentication?.dmarc === "fail";
	return mailboxStub(env, input.principalId).deliver({
		contentHash: input.contentHash,
		rawKey: input.rawKey,
		size: input.bytes.byteLength,
		origin: input.origin,
		internalDate: input.receivedAt,
		parsed,
		spam,
	});
}

/** Stores a copy of a raw message for another mailbox of this deployment, and delivers it there. */
export async function deliverInternal(env: Env, principalId: string, bytes: Uint8Array) {
	const { contentHash, rawKey } = await storeRaw(env, principalId, bytes);
	return deliverStoredRaw(env, {
		principalId,
		bytes,
		rawKey,
		contentHash,
		origin: "internal",
		receivedAt: Date.now(),
	});
}
