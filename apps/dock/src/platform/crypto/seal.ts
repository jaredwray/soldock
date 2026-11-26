import { log } from "../log/log.ts";
import { OperationError } from "../operations/errors.ts";
import { base64ToBytes, base64UrlEncode } from "./crypto.ts";

/**
 * Encryption at rest for the secrets that the Worker must read back: keys, tokens and signing secrets.
 * The AES key comes from the optional Worker secret ENCRYPTION_KEY.
 *
 * - With ENCRYPTION_KEY, `sealSecret` encrypts a value. Without it, `sealSecret` returns the value as it is.
 * - `openSecret` reads the two forms, so a row from before ENCRYPTION_KEY stays readable.
 * - A sealed value is `enc:v1:<base64url IV>.<base64url ciphertext and tag>`.
 * - The cipher is AES-256-GCM, with a random IV of 96 bits for each value.
 * - The AES key is HKDF-SHA-256 of ENCRYPTION_KEY, with the salt `KEY_SALT` and the info `KEY_INFO`.
 * - The purpose is the additional data of AES-GCM. A value does not open with a different purpose.
 *
 * A change of the salt, the info or the format needs a new version prefix.
 */

/** The start of each sealed value. No plaintext value of a covered column starts with it. */
export const SEALED_PREFIX = "enc:v1:";

/** The minimum length of ENCRYPTION_KEY, as for SETUP_TOKEN. A shorter value seals nothing. */
export const ENCRYPTION_KEY_MIN_LENGTH = 32;

const KEY_SALT = "asterra/encryption-key/v1";
const KEY_INFO = "asterra secret at rest, AES-256-GCM";
const IV_BYTES = 12;
/** The tag of AES-GCM has 16 bytes, so a shorter ciphertext is not valid. */
const TAG_BYTES = 16;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The bindings that the helper reads. Each `Env` has them. */
export type SealEnv = Pick<Env, "ENCRYPTION_KEY">;

/** Why a sealed value did not open. `no_key`: ENCRYPTION_KEY is not set. `bad_key`: it is too short. */
export type OpenFailure = "no_key" | "bad_key" | "failed";

export type OpenedSecret = { ok: true; value: string } | { ok: false; reason: OpenFailure };

// One AES key for each isolate. The value of ENCRYPTION_KEY names the entry, so a different value gets its own key.
let cached: { secret: string; key: Promise<CryptoKey> } | null = null;

function deriveKey(secret: string): Promise<CryptoKey> {
	if (cached?.secret === secret) return cached.key;
	const key = (async () => {
		const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
		return await crypto.subtle.deriveKey(
			{ name: "HKDF", hash: "SHA-256", salt: encoder.encode(KEY_SALT), info: encoder.encode(KEY_INFO) },
			material,
			{ name: "AES-GCM", length: 256 },
			false,
			["encrypt", "decrypt"],
		);
	})();
	cached = { secret, key };
	return key;
}

function keyState(env: SealEnv): "missing" | "too_short" | "ready" {
	const secret = env.ENCRYPTION_KEY;
	if (!secret) return "missing";
	return secret.length < ENCRYPTION_KEY_MIN_LENGTH ? "too_short" : "ready";
}

function base64UrlToBytes(text: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error("not base64url");
	return base64ToBytes(text.replaceAll("-", "+").replaceAll("_", "/"));
}

/** True when the stored value is in the sealed form. */
export function isSealed(stored: string): boolean {
	return stored.startsWith(SEALED_PREFIX);
}

/**
 * The form of a secret that goes into storage. With ENCRYPTION_KEY, the result is sealed. Without
 * it, the result is the plaintext. `purpose` is a stable name of the place of the value, such as
 * `ai_settings.api_token`. Use the same purpose to open the value.
 *
 * Throws `unavailable` when ENCRYPTION_KEY is set and too short: the Worker then writes no secret. Throws
 * `invalid` for a plaintext that starts with `SEALED_PREFIX`, because a reader cannot tell it from a
 * sealed value.
 */
export async function sealSecret(env: SealEnv, purpose: string, plaintext: string): Promise<string> {
	const state = keyState(env);
	if (state === "too_short") {
		throw new OperationError(
			"unavailable",
			`The ENCRYPTION_KEY Worker secret must have at least ${ENCRYPTION_KEY_MIN_LENGTH} characters. The Worker saves no secret until it does.`,
		);
	}
	if (isSealed(plaintext)) throw new OperationError("invalid", `A secret cannot start with ${SEALED_PREFIX}.`);
	if (state === "missing") return plaintext;
	const key = await deriveKey(env.ENCRYPTION_KEY as string);
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: encoder.encode(purpose) },
		key,
		encoder.encode(plaintext),
	);
	return `${SEALED_PREFIX}${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
}

/** `sealSecret` for a column that can be null. */
export async function sealOptionalSecret(
	env: SealEnv,
	purpose: string,
	plaintext: string | null,
): Promise<string | null> {
	return plaintext === null ? null : await sealSecret(env, purpose, plaintext);
}

function cannotOpen(purpose: string, reason: OpenFailure): OpenedSecret {
	// The line has the purpose and the reason only. It never has the value or ENCRYPTION_KEY.
	log("error", "sealed secret cannot open", { purpose, reason });
	return { ok: false, reason };
}

/**
 * The plaintext of a stored secret. A value without `SEALED_PREFIX` is plaintext from before ENCRYPTION_KEY:
 * the result is that value. A sealed value opens only with the ENCRYPTION_KEY and the purpose of its seal.
 *
 * The function does not throw for a value that does not open. It writes one error line and gives the
 * reason. The caller then acts as if the secret is not set.
 */
export async function openSecret(env: SealEnv, purpose: string, stored: string): Promise<OpenedSecret> {
	if (!isSealed(stored)) return { ok: true, value: stored };
	const state = keyState(env);
	if (state === "missing") return cannotOpen(purpose, "no_key");
	if (state === "too_short") return cannotOpen(purpose, "bad_key");
	try {
		const [ivText, ciphertextText, ...rest] = stored.slice(SEALED_PREFIX.length).split(".");
		if (!ivText || !ciphertextText || rest.length > 0) return cannotOpen(purpose, "failed");
		const iv = base64UrlToBytes(ivText);
		const ciphertext = base64UrlToBytes(ciphertextText);
		if (iv.byteLength !== IV_BYTES || ciphertext.byteLength < TAG_BYTES) return cannotOpen(purpose, "failed");
		const key = await deriveKey(env.ENCRYPTION_KEY as string);
		const plaintext = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv, additionalData: encoder.encode(purpose) },
			key,
			ciphertext,
		);
		return { ok: true, value: decoder.decode(plaintext) };
	} catch {
		// A wrong ENCRYPTION_KEY, a wrong purpose and a changed value all fail the tag check of AES-GCM.
		return cannotOpen(purpose, "failed");
	}
}

/** The plaintext of a stored secret, or null when the column is null or the value does not open. */
export async function openSecretOrNull(env: SealEnv, purpose: string, stored: string | null): Promise<string | null> {
	if (stored === null) return null;
	const opened = await openSecret(env, purpose, stored);
	return opened.ok ? opened.value : null;
}
