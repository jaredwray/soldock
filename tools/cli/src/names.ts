// The Cloudflare names of an instance. Each name is `<prefix>-<suffix>`, so one account can hold more
// than one instance. The prefix of a new instance is `asterra-<name>`. An instance from before the CLI
// keeps the prefix `soldock`, because its data is in resources with those names.

/** The prefix of each resource of an instance from before the CLI. */
export const LEGACY_PREFIX = "soldock";

/** The longest instance name. With the longest suffix (`-mail-inbound-dlq`), a name stays under 63 characters. */
export const MAX_NAME_LENGTH = 30;

/** The suffix of the D1 database. `upgrade` finds the instances of an account by this database. */
export const DIRECTORY_SUFFIX = "directory";

const NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// Second-level labels under which a country code domain registers names (example.co.uk).
const REGISTRY_LABELS = new Set(["ac", "co", "com", "edu", "gov", "net", "org"]);

/** The reason that `name` cannot be an instance name, or null. */
export function nameError(name: string): string | null {
	if (name.length === 0) return "The name is empty.";
	if (name.length > MAX_NAME_LENGTH) return `The name has more than ${MAX_NAME_LENGTH} characters.`;
	if (!NAME.test(name)) {
		return "Use lowercase letters, digits and hyphens. Start and end with a letter or a digit.";
	}
	return null;
}

/** The reason that `name` cannot be the name of a Worker in Cloudflare, or null. */
export function workerNameError(name: string): string | null {
	return /^[a-z0-9][a-z0-9_-]{0,62}$/.test(name)
		? null
		: "A Worker name has lowercase letters, digits, hyphens and underscores, and 63 characters or fewer.";
}

/** The reason that `hostname` cannot be the host of an instance, or null. */
export function hostnameError(hostname: string): string | null {
	if (hostname.includes("://") || hostname.includes("/"))
		return "Give the host name only, for example work.example.com.";
	const labels = hostname.split(".");
	if (labels.length < 2 || labels.some((label) => !LABEL.test(label))) {
		return "Give a lowercase host name with a domain, for example work.example.com.";
	}
	return null;
}

/** A suggested instance name for a host: the name of its domain (`work.rivus.com` gives `rivus`). */
export function suggestName(hostname: string): string {
	const labels = hostname.toLowerCase().split(".").filter(Boolean);
	let index = labels.length - 2;
	if (index > 0 && REGISTRY_LABELS.has(labels[index] ?? "") && (labels[labels.length - 1]?.length ?? 0) === 2) {
		index -= 1;
	}
	const label = labels[Math.max(index, 0)] ?? "asterra";
	const name = label
		.replace(/[^a-z0-9-]/g, "-")
		.slice(0, MAX_NAME_LENGTH)
		.replace(/^-+|-+$/g, "");
	return name.length > 0 ? name : "asterra";
}

/** The prefix of the resources of a new instance. */
export function prefixOf(name: string): string {
	return `asterra-${name}`;
}

/** The Cloudflare name of one resource of an instance. */
export function resourceName(prefix: string, suffix: string): string {
	return `${prefix}-${suffix}`;
}

/** An instance that `upgrade` found in an account. */
export interface FoundInstance {
	/** The instance name, or null for the instance from before the CLI. */
	name: string | null;
	prefix: string;
	/** The Worker name, when the database name tells it. The legacy instance does not tell it. */
	workerName: string | null;
}

/** The instances of an account, from the names of its D1 databases. */
export function instancesFromDatabases(databaseNames: readonly string[]): FoundInstance[] {
	const found: FoundInstance[] = [];
	const ending = `-${DIRECTORY_SUFFIX}`;
	for (const database of databaseNames) {
		if (database === resourceName(LEGACY_PREFIX, DIRECTORY_SUFFIX)) {
			found.push({ name: null, prefix: LEGACY_PREFIX, workerName: null });
			continue;
		}
		if (!database.startsWith("asterra-") || !database.endsWith(ending)) continue;
		const name = database.slice("asterra-".length, -ending.length);
		if (nameError(name) === null) found.push({ name, prefix: prefixOf(name), workerName: prefixOf(name) });
	}
	return found.sort((a, b) => a.prefix.localeCompare(b.prefix));
}
