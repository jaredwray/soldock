import type { OutboundPolicy } from "@soldock/contracts";

export const POLICY_MODES: readonly { mode: OutboundPolicy["mode"]; title: string; hint: string }[] = [
	{ mode: "internal-only", title: "Internal only", hint: "Only people and agents in this organization." },
	{ mode: "allowlist", title: "Allowlist", hint: "This organization, plus the domains and addresses in the list." },
	{ mode: "any", title: "Any recipient", hint: "Every address on the internet." },
];

export function policySummary(policy: OutboundPolicy): string {
	switch (policy.mode) {
		case "internal-only":
			return "Internal only";
		case "any":
			return "Any recipient";
		case "allowlist":
			return policy.allowlist.length > 0 ? `Allowlist: ${policy.allowlist.join(", ")}` : "Allowlist (empty)";
	}
}

/** Splits the allowlist text into entries. Commas, spaces and line breaks separate them. */
export function parseAllowlist(text: string): string[] {
	return [
		...new Set(
			text
				.split(/[\s,;]+/)
				.map((entry) => entry.trim().toLowerCase())
				.filter(Boolean),
		),
	];
}

const ENTRY =
	/^(?:[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** The entries that are not a domain or an address. The server checks them again. */
export function invalidAllowlistEntries(entries: readonly string[]): string[] {
	return entries.filter((entry) => !ENTRY.test(entry));
}
