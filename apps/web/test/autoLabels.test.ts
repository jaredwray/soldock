import { describe, expect, it } from "vitest";
import { removesAutoLabel, unavailableText } from "../src/features/mail/autoLabels.ts";

// The web app tells a person when a label change teaches auto labels, and why auto labels do nothing.
describe("auto labels in Mail", () => {
	it("knows when a change removes a label that auto labels applied", () => {
		const threads = [{ auto_label_ids: ["lbl_a"] }, { auto_label_ids: [] }];
		expect(removesAutoLabel(threads, ["lbl_a"])).toBe(true);
		expect(removesAutoLabel(threads, ["lbl_b", "INBOX"])).toBe(false);
		expect(removesAutoLabel([], ["lbl_a"])).toBe(false);
	});

	it("names who must turn on AI or the feature", () => {
		expect(unavailableText({ available: true, unavailable_reason: null })).toBeNull();
		expect(unavailableText({ available: false, unavailable_reason: "ai_off" })).toContain("turn on AI");
		expect(unavailableText({ available: false, unavailable_reason: "feature_off" })).toContain(
			"turn on inbox auto labels",
		);
	});
});
