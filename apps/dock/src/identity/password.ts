import { base64ToBytes, bytesToBase64 } from "../platform/index.ts";

/**
 * PBKDF2-HMAC-SHA256 through WebCrypto. workerd refuses more than 100,000 iterations, so this is the
 * most that a Worker can use. The stored form names the scheme and the iterations, so a later version
 * can raise the work and still read old hashes.
 */
const SCHEME = "pbkdf2-sha256";
export const PASSWORD_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

const encoder = new TextEncoder();

/** The same password typed with composed or decomposed characters gives the same hash. */
function normalize(password: string): Uint8Array {
	return encoder.encode(password.normalize("NFKC"));
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("raw", normalize(password), "PBKDF2", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, HASH_BITS);
	return new Uint8Array(bits);
}

/** The stored form of a new password: `pbkdf2-sha256$<iterations>$<salt>$<hash>`, base64. */
export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const hash = await derive(password, salt, PASSWORD_ITERATIONS);
	return [SCHEME, PASSWORD_ITERATIONS, bytesToBase64(salt), bytesToBase64(hash)].join("$");
}

/** A hash that no password matches. Unknown addresses use it, so they take the same time as known ones. */
const NO_PASSWORD = `${SCHEME}$${PASSWORD_ITERATIONS}$${bytesToBase64(new Uint8Array(SALT_BYTES))}$`;

/**
 * True when the password matches the stored hash. A missing hash (no account, or no password yet)
 * still runs one derivation and gives false, so the time does not tell which case it is.
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
	const [scheme, rounds, salt, hash] = (stored ?? NO_PASSWORD).split("$");
	const iterations = Number(rounds);
	if (scheme !== SCHEME || !Number.isInteger(iterations) || iterations < 1 || iterations > PASSWORD_ITERATIONS) {
		return false;
	}
	let saltBytes: Uint8Array;
	let expected: Uint8Array;
	try {
		saltBytes = base64ToBytes(salt ?? "");
		expected = base64ToBytes(hash ?? "");
	} catch {
		return false;
	}
	const actual = await derive(password, saltBytes, iterations);
	return (
		stored !== null && expected.byteLength === actual.byteLength && crypto.subtle.timingSafeEqual(actual, expected)
	);
}
