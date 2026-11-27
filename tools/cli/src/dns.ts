// The DNS lookup before an install. The deploy replaces a DNS record of the host that conflicts, so
// `install` refuses a host that has records, unless the operator gives --replace-dns.
import { Resolver } from "node:dns/promises";

/** The error codes of a name that has no record of one type. */
const NO_RECORD = new Set(["ENOTFOUND", "ENODATA"]);
const TIMEOUT_MS = 5000;

/** The addresses and the aliases of a host. An empty list when the host has none. */
export async function resolveHost(hostname: string): Promise<string[]> {
	const resolver = new Resolver({ timeout: TIMEOUT_MS, tries: 2 });
	const lookups = await Promise.allSettled([
		resolver.resolve4(hostname),
		resolver.resolve6(hostname),
		resolver.resolveCname(hostname),
	]);
	const records: string[] = [];
	for (const lookup of lookups) {
		if (lookup.status === "fulfilled") {
			records.push(...lookup.value);
		} else if (!NO_RECORD.has(String((lookup.reason as { code?: unknown }).code))) {
			// A timeout or a server failure does not tell that the host has no record.
			throw lookup.reason;
		}
	}
	return [...new Set(records)];
}
