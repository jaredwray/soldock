import { AllowlistEntry, type OutboundPolicy } from "@soldock/contracts";

export const POLICY_MODES: readonly { mode: OutboundPolicy["mode"]; title: string; hint: string }[] = [
	{
		mode: "internal-only",
		title: "Internal only",
		hint: "Only people and agents in this organization. The agent cannot create webhooks.",
	},
	{
		mode: "allowlist",
		title: "Allowlist",
		hint: "This organization, plus the domains and addresses in the list. A webhook can use a domain in the list as its host.",
	},
	{ mode: "any", title: "Any recipient", hint: "Every address on the internet, and webhooks to each host." },
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

/** The policy form values. `allowlistText` is the textarea, one entry on each line. */
export interface PolicyDraft {
	mode: OutboundPolicy["mode"];
	allowlistText: string;
}

/** The draft that matches a stored policy. */
export function policyDraftFrom(policy: OutboundPolicy): PolicyDraft {
	return { mode: policy.mode, allowlistText: policy.allowlist.join("\n") };
}

/** True when two stored policies have the same mode and the same entries in the same order. */
export function sameOutboundPolicy(a: OutboundPolicy, b: OutboundPolicy): boolean {
	return a.mode === b.mode && a.allowlist.join("\n") === b.allowlist.join("\n");
}

/** True when the draft matches the stored policy. Allowlist text matters only in allowlist mode. */
export function samePolicyDraft(draft: PolicyDraft, saved: PolicyDraft): boolean {
	if (draft.mode !== saved.mode) return false;
	if (draft.mode !== "allowlist") return true;
	// The save parses the text, so spaces, case and a final line break still match.
	return parseAllowlist(draft.allowlistText).join("\n") === parseAllowlist(saved.allowlistText).join("\n");
}

/**
 * The draft after the stored policy changes. A draft that still matches the previous policy follows
 * the new one. A draft with an unsaved choice stays.
 */
export function draftAfterPolicyChange(
	draft: PolicyDraft,
	previous: OutboundPolicy,
	next: OutboundPolicy,
): PolicyDraft {
	if (samePolicyDraft(draft, policyDraftFrom(previous))) return policyDraftFrom(next);
	return draft;
}

/** True when the draft is not the stored policy. The stored policy stays in force until a save. */
export function policyDraftDirty(draft: PolicyDraft, policy: OutboundPolicy): boolean {
	return !samePolicyDraft(draft, policyDraftFrom(policy));
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
