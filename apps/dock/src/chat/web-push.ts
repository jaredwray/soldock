// RFC 8291 message encryption and RFC 8292 application server identification.
// Web Crypto supplies ECDH, HKDF, AES-GCM and the ES256 signature.
import { base64ToBytes, base64UrlEncode } from "../platform/index.ts";

const utf8 = new TextEncoder();
const p256 = { name: "ECDH", namedCurve: "P-256" };

function decode(value: string): Uint8Array {
	return base64ToBytes(value.replaceAll("-", "+").replaceAll("_", "/"));
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		bytes.set(part, offset);
		offset += part.length;
	}
	return bytes;
}

async function hkdf(key: CryptoKey, salt: Uint8Array, info: Uint8Array, bits: number): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bits));
}

/** Encrypts one final aes128gcm record. The payload holds only the message location and device settings. */
export async function encryptPush(keys: { p256dh: string; auth: string }, payload: string): Promise<Uint8Array> {
	const receiverBytes = decode(keys.p256dh);
	const receiver = await crypto.subtle.importKey("raw", receiverBytes, p256, false, []);
	const sender = (await crypto.subtle.generateKey(p256, true, ["deriveBits"])) as CryptoKeyPair;
	const senderBytes = new Uint8Array((await crypto.subtle.exportKey("raw", sender.publicKey)) as ArrayBuffer);
	const agreement = { name: "ECDH", public: receiver };
	const secret = await crypto.subtle.deriveBits(agreement, sender.privateKey, 256);

	const shared = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
	const info = concat(utf8.encode("WebPush: info\0"), receiverBytes, senderBytes);
	const ikm = await hkdf(shared, decode(keys.auth), info, 256);
	const material = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const cek = await hkdf(material, salt, utf8.encode("Content-Encoding: aes128gcm\0"), 128);
	const nonce = await hkdf(material, salt, utf8.encode("Content-Encoding: nonce\0"), 96);
	const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
	const plaintext = concat(utf8.encode(payload), Uint8Array.of(2));
	const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, plaintext);

	// RFC 8188 section 2.1: salt, record size (4096, big endian), key length, key and record.
	return concat(salt, Uint8Array.of(0, 0, 16, 0, senderBytes.length), senderBytes, new Uint8Array(ciphertext));
}

/** Signs a VAPID token for exactly the origin that receives this request. */
export async function pushAuthorization(env: Env, audience: string): Promise<string> {
	const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: d, VAPID_SUBJECT: sub } = env;
	if (!publicKey || !d || !sub) throw new Error("Set the VAPID keys and contact address.");
	const point = decode(publicKey);
	const key = await crypto.subtle.importKey(
		"jwk",
		{ kty: "EC", crv: "P-256", x: base64UrlEncode(point.slice(1, 33)), y: base64UrlEncode(point.slice(33)), d },
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["sign"],
	);
	const header = base64UrlEncode(utf8.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
	const claims = base64UrlEncode(
		utf8.encode(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 3600, sub })),
	);
	const input = `${header}.${claims}`;
	const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8.encode(input));
	return `vapid t=${input}.${base64UrlEncode(new Uint8Array(signature))}, k=${publicKey}`;
}
