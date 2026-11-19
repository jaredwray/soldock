// A fetch of a web address that a person or an agent gave, for content from outside, such as a link
// preview. The guard keeps the request off private networks:
//
// - The host is a DNS name, never an IP address.
// - Each address that DNS gives for the host (A and AAAA) must be public. One address that is not public
//   stops the fetch. The answer of DNS comes from DNS over HTTPS at Cloudflare, so it needs no service
//   outside Cloudflare.
// - Each redirect gets the same checks, and the fetch follows at most `maxRedirects`.
// - The fetch has one time limit and a limit on the bytes of the body.
//
// A Worker cannot fix the address of a request to the address of the check, so DNS can change between the
// two (DNS rebinding). The network of a Worker cannot reach a private network, so the check is a second
// layer.

/** The answer of DNS over HTTPS, in the JSON form. */
interface DnsAnswer {
	Status?: number;
	Answer?: { type?: number; data?: string }[];
}

const DNS_URL = "https://cloudflare-dns.com/dns-query";
const DNS_A = 1;
const DNS_AAAA = 28;
const MAX_DNS_ANSWERS = 256;

/** A refusal of the guard. The message is safe to show to the caller. */
export class FetchRefused extends Error {
	override name = "FetchRefused";
}

/** The IPv4 networks that are not public, as [first address, prefix length]. */
const BLOCKED_V4: [string, number][] = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["168.63.129.16", 32],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.88.99.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
];

function v4Number(address: string): number | null {
	const parts = address.split(".");
	if (parts.length !== 4) return null;
	let value = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const byte = Number(part);
		if (byte > 255) return null;
		value = value * 256 + byte;
	}
	return value;
}

/** True for an IPv4 address in dotted decimal that is public. */
export function isPublicV4(address: string): boolean {
	const value = v4Number(address);
	if (value === null) return false;
	return !BLOCKED_V4.some(([network, prefix]) => {
		const base = v4Number(network) as number;
		const size = 2 ** (32 - prefix);
		return value >= base && value < base + size;
	});
}

/** The 8 groups of an IPv6 address, or null when it does not parse. An IPv4 tail becomes two groups. */
function v6Groups(address: string): number[] | null {
	let text = address.toLowerCase();
	const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
	if (v4) {
		const value = v4Number(v4[1] as string);
		if (value === null) return null;
		text = `${text.slice(0, -(v4[1] as string).length)}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
	}
	const halves = text.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const missing = 8 - head.length - tail.length;
	if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
	const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
	if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
	return groups.map((group) => Number.parseInt(group, 16));
}

/**
 * True for an IPv6 address that is public: global unicast (2000::/3), without the blocks for special
 * use. An address with an IPv4 address in it is public only as NAT64 (64:ff9b::/96) of a public IPv4
 * address.
 */
export function isPublicV6(address: string): boolean {
	const g = v6Groups(address);
	if (!g) return false;
	const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, h = 0, i = 0] = g;
	// NAT64 with an IPv4 address in the last 32 bits.
	if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) {
		return isPublicV4(`${h >>> 8}.${h & 0xff}.${i >>> 8}.${i & 0xff}`);
	}
	if ((a & 0xe000) !== 0x2000) return false;
	if (a === 0x2001 && b < 0x0200) {
		// 2001::/23 is for special use, except 2001:3::/32 and 2001:4:112::/48.
		return b === 0x0003 || (b === 0x0004 && c === 0x0112);
	}
	if (a === 0x2001 && b === 0x0db8) return false;
	if (a === 0x2002) return false;
	// 3fff::/20 is for documentation.
	if (a === 0x3fff && b < 0x1000) return false;
	return true;
}

/** The problem with a host name, or null. Each label has 1 to 63 letters, digits or hyphens. */
export function hostNameProblem(host: string): string | null {
	if (host.length > 253) return "The host name is too long.";
	// The old forms of an IPv4 address: 1 to 4 parts, each one decimal or hex ("0x7f.1").
	const parts = host.split(".");
	const legacyV4 = parts.length <= 4 && parts.every((part) => /^(?:0x[0-9a-f]*|\d+)$/i.test(part));
	if (host.includes(":") || legacyV4) {
		return "The address must use a host name, not an IP address.";
	}
	const labels = host.split(".");
	if (labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
		return "The address must use a full host name, such as www.example.com.";
	}
	return null;
}

async function lookup(host: string, type: number, signal: AbortSignal): Promise<string[]> {
	const url = `${DNS_URL}?name=${encodeURIComponent(host)}&type=${type}`;
	const response = await fetch(url, { headers: { accept: "application/dns-json" }, signal });
	if (!response.ok) throw new FetchRefused("The address of the host could not be found.");
	let answer: DnsAnswer;
	try {
		answer = (await response.json()) as DnsAnswer;
	} catch {
		throw new FetchRefused("The address of the host could not be found.");
	}
	// NXDOMAIN and the other errors stop the fetch. So does an answer that does not parse.
	if (answer.Status !== 0) throw new FetchRefused("The host does not exist.");
	const records = answer.Answer ?? [];
	if (!Array.isArray(records) || records.length > MAX_DNS_ANSWERS) {
		throw new FetchRefused("The address of the host could not be found.");
	}
	// A CNAME record comes before the addresses of its target. Only the addresses count.
	return records
		.filter((record) => record.type === type)
		.map((record) => {
			if (typeof record.data !== "string") throw new FetchRefused("The address of the host could not be found.");
			return record.data;
		});
}

/** Refuses a host whose DNS gives no address, or an address that is not public. */
export async function checkPublicHost(host: string, signal: AbortSignal): Promise<void> {
	const problem = hostNameProblem(host);
	if (problem) throw new FetchRefused(problem);
	const [v4, v6] = await Promise.all([lookup(host, DNS_A, signal), lookup(host, DNS_AAAA, signal)]);
	if (v4.length + v6.length === 0) throw new FetchRefused("The host has no address.");
	if (!v4.every(isPublicV4) || !v6.every(isPublicV6)) {
		throw new FetchRefused("The host has an address that is not public.");
	}
}

export interface PublicFetchOptions {
	/** The `Accept` header. */
	accept: string;
	/** The most bytes of the body. A larger body stops the fetch. */
	maxBytes: number;
	/** The time limit of the whole fetch, with each DNS lookup and each redirect. */
	timeoutMs: number;
	maxRedirects: number;
	/**
	 * The checks of the caller for the first address and for each redirect, such as the rules of the
	 * address and the outbound policy of an agent. It returns the reason of a refusal, or null.
	 */
	checkUrl(url: string): string | null;
}

export interface PublicFetchResult {
	/** The address of the answer, after the redirects. */
	url: string;
	status: number;
	contentType: string;
	body: Uint8Array;
}

/** Reads a body, and stops when it has more bytes than the limit. */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
	if (Number(response.headers.get("content-length") ?? 0) > maxBytes) {
		await response.body?.cancel();
		throw new FetchRefused("The answer is too large.");
	}
	const reader = response.body?.getReader();
	if (!reader) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > maxBytes) {
			await reader.cancel();
			throw new FetchRefused("The answer is too large.");
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

/**
 * Gets a web address with the guard. The request has no cookie and no credential. A refusal or a failure
 * throws `FetchRefused`, with a reason that is safe to show.
 */
export async function publicFetch(address: string, options: PublicFetchOptions): Promise<PublicFetchResult> {
	const signal = AbortSignal.timeout(options.timeoutMs);
	let url = address;
	try {
		for (let hop = 0; hop <= options.maxRedirects; hop++) {
			const problem = options.checkUrl(url);
			if (problem) throw new FetchRefused(problem);
			await checkPublicHost(new URL(url).hostname, signal);
			const response = await fetch(url, {
				redirect: "manual",
				signal,
				headers: { accept: options.accept, "user-agent": "Asterra (link preview)" },
			});
			if (response.status >= 300 && response.status < 400) {
				await response.body?.cancel();
				const location = response.headers.get("location");
				if (location === null) throw new FetchRefused("The address redirects to no address.");
				const next = new URL(location, url);
				next.hash = "";
				url = next.href;
				continue;
			}
			let body: Uint8Array = new Uint8Array();
			if (response.ok) body = await readCapped(response, options.maxBytes);
			else await response.body?.cancel();
			return {
				url,
				status: response.status,
				contentType: (response.headers.get("content-type") ?? "").toLowerCase(),
				body,
			};
		}
	} catch (error) {
		if (error instanceof FetchRefused) throw error;
		const name = error instanceof Error ? error.name : "";
		throw new FetchRefused(
			name === "TimeoutError" || name === "AbortError"
				? "The address did not answer in time."
				: "The address did not answer.",
		);
	}
	throw new FetchRefused("The address has too many redirects.");
}
