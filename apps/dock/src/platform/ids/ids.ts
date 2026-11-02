const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A prefixed, time-sortable id: `<prefix>_<26 Crockford base32 characters of a UUIDv7>`, for
 * example `msg_01JD3V0Y9XG8Q2W4E6R8T0Y2U4`. Ids made later sort later, to the millisecond.
 */
export function newId(prefix: string, now: number = Date.now()): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	let time = now;
	for (let i = 5; i >= 0; i--) {
		bytes[i] = time % 256;
		time = Math.floor(time / 256);
	}
	bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70; // version 7
	bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80; // RFC 9562 variant
	let value = 0n;
	for (const byte of bytes) value = (value << 8n) | BigInt(byte);
	let out = "";
	for (let i = 0; i < 26; i++) {
		out = CROCKFORD[Number(value & 31n)] + out;
		value >>= 5n;
	}
	return `${prefix}_${out}`;
}
