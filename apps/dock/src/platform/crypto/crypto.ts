const encoder = new TextEncoder();

/** The SHA-256 of a string or bytes, as lowercase hex. */
export async function sha256Hex(data: string | ArrayBuffer | Uint8Array): Promise<string> {
	const bytes = typeof data === "string" ? encoder.encode(data) : data;
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** `length` random bytes as unpadded base64url. */
export function randomToken(length = 32): string {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return base64UrlEncode(bytes);
}

export function base64UrlEncode(bytes: Uint8Array): string {
	return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

/** Decodes standard base64. Throws on characters outside the alphabet. */
export function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** Compares two secrets in constant time for equal lengths. */
export function sameSecret(given: string, expected: string): boolean {
	const a = encoder.encode(given);
	const b = encoder.encode(expected);
	return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}
