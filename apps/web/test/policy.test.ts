import type { OutboundPolicy } from "@soldock/contracts";
import { describe, expect, it } from "vitest";
import {
	draftAfterPolicyChange,
	type PolicyDraft,
	policyDraftDirty,
	policyDraftFrom,
} from "../src/features/admin/policy.ts";

function policy(mode: OutboundPolicy["mode"], allowlist: string[] = []): OutboundPolicy {
	return { mode, allowlist };
}

describe("policy form draft", () => {
	it("follows a stored change when the draft still matches the previous policy", () => {
		const previous = policy("internal-only");
		const draft = policyDraftFrom(previous);
		const next = policy("any");
		expect(draftAfterPolicyChange(draft, previous, next)).toEqual(policyDraftFrom(next));
		expect(policyDraftDirty(policyDraftFrom(next), next)).toBe(false);
	});

	it("keeps an unsaved choice when the stored policy changes", () => {
		const previous = policy("any");
		const draft: PolicyDraft = { mode: "internal-only", allowlistText: "" };
		const next = policy("allowlist", ["example.org"]);
		expect(draftAfterPolicyChange(draft, previous, next)).toEqual(draft);
		expect(policyDraftDirty(draft, next)).toBe(true);
	});

	it("treats a saved allowlist as saved when the text has a different shape", () => {
		const previous = policy("internal-only");
		const typed: PolicyDraft = { mode: "allowlist", allowlistText: "Example.org, ada@partner.org\n" };
		const stored = policy("allowlist", ["example.org", "ada@partner.org"]);
		const draft = draftAfterPolicyChange(typed, previous, stored);
		expect(policyDraftDirty(draft, stored)).toBe(false);
		expect(
			policyDraftDirty({ mode: "allowlist", allowlistText: "example.org\n" }, policy("allowlist", ["example.org"])),
		).toBe(false);
	});

	it("ignores allowlist text unless the mode is allowlist", () => {
		const stored = policy("internal-only");
		const draft: PolicyDraft = { mode: "internal-only", allowlistText: "example.org" };
		expect(policyDraftDirty(draft, stored)).toBe(false);
		expect(
			policyDraftDirty({ mode: "allowlist", allowlistText: "example.org" }, policy("allowlist", ["example.org"])),
		).toBe(false);
		expect(
			policyDraftDirty({ mode: "allowlist", allowlistText: "other.org" }, policy("allowlist", ["example.org"])),
		).toBe(true);
	});
});
