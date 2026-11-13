import { TOTP_DIGITS, TOTP_PERIOD_SECONDS } from "@soldock/contracts";
import { sameSecret } from "../platform/index.ts";

// Time-based one-time passwords (RFC 6238) with HMAC-SHA1, 6 digits and a 30-second step: the
// settings that each common authenticator app reads from an otpauth URI.

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** 20 random bytes (160 bits), the key length that RFC 4226 recommends for HMAC-SHA1. */
const SECRET_BYTES = 20;

/** A code from the step before or after the current step also works, for a clock that is a little wrong. */
const DRIFT_STEPS = 1;

export function base32Encode(bytes: Uint8Array): string {
	let bits = 0;
	let value = 0;
	let out = "";
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += BASE32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
	return out;
}

/** Decodes base32 without padding. Spaces and lowercase letters are accepted. Throws on other characters. */
export function base32Decode(text: string): Uint8Array {
	const clean = text.replace(/[\s=]/g, "").toUpperCase();
	const out = new Uint8Array(Math.floor((clean.length * 5) / 8));
	let bits = 0;
	let value = 0;
	let index = 0;
	for (const char of clean) {
		const digit = BASE32.indexOf(char);
		if (digit < 0) throw new Error("not base32");
		value = (value << 5) | digit;
		bits += 5;
		if (bits >= 8) {
			out[index++] = (value >>> (bits - 8)) & 255;
			bits -= 8;
		}
	}
	return out;
}

/** A new random TOTP secret, base32. */
export function newTotpSecret(): string {
	return base32Encode(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
}

/** The time step of a moment in milliseconds since the epoch. */
export function totpStep(nowMs: number): number {
	return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

/** The code of one time step (RFC 4226 HOTP with the step as the counter). */
export async function totpCode(secret: string, step: number): Promise<string> {
	const key = await crypto.subtle.importKey("raw", base32Decode(secret), { name: "HMAC", hash: "SHA-1" }, false, [
		"sign",
	]);
	const counter = new DataView(new ArrayBuffer(8));
	counter.setUint32(0, Math.floor(step / 2 ** 32));
	counter.setUint32(4, step >>> 0);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter.buffer));
	const offset = (mac[mac.length - 1] as number) & 0x0f;
	const binary =
		(((mac[offset] as number) & 0x7f) << 24) |
		((mac[offset + 1] as number) << 16) |
		((mac[offset + 2] as number) << 8) |
		(mac[offset + 3] as number);
	return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/**
 * The time step that the code belongs to, or null when it matches none. Only steps after `lastStep`
 * count, so a code works one time. Each candidate is compared in constant time.
 */
export async function matchTotp(
	secret: string,
	code: string,
	lastStep: number | null,
	nowMs = Date.now(),
): Promise<number | null> {
	const current = totpStep(nowMs);
	let matched: number | null = null;
	for (let step = current - DRIFT_STEPS; step <= current + DRIFT_STEPS; step++) {
		if (lastStep !== null && step <= lastStep) continue;
		if (sameSecret(code, await totpCode(secret, step)) && matched === null) matched = step;
	}
	return matched;
}

/** The URI that an authenticator app reads from a QR code. The label names the issuer and the address. */
export function otpauthUri(secret: string, address: string, issuer = "Soldock"): string {
	const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(address)}`;
	const params = new URLSearchParams({
		secret,
		issuer,
		algorithm: "SHA1",
		digits: String(TOTP_DIGITS),
		period: String(TOTP_PERIOD_SECONDS),
	});
	return `otpauth://totp/${label}?${params}`;
}
