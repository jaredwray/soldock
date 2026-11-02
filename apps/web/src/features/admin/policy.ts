import { AllowlistEntry, type OutboundPolicy } from "@soldock/contracts";

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

/** The entries that are not a domain or an address, by the same schema that the server uses. */
export function invalidAllowlistEntries(entries: readonly string[]): string[] {
	return entries.filter((entry) => !AllowlistEntry.safeParse(entry).success);
}
