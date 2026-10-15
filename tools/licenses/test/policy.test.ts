import { describe, expect, it } from "vitest";
import { findViolations, flattenPnpmLicenses, isAllowedExpression } from "../src/policy.ts";

const allowed = new Set(["MIT", "Apache-2.0", "ISC"]);

describe("isAllowedExpression", () => {
	it("accepts simple allowed identifiers", () => {
		expect(isAllowedExpression("MIT", allowed)).toBe(true);
	});

	it("rejects copyleft and unknown identifiers", () => {
		expect(isAllowedExpression("GPL-3.0-only", allowed)).toBe(false);
		expect(isAllowedExpression("Unknown", allowed)).toBe(false);
		expect(isAllowedExpression("", allowed)).toBe(false);
	});

	it("handles OR, AND and parentheses", () => {
		expect(isAllowedExpression("(MIT OR GPL-3.0)", allowed)).toBe(true);
		expect(isAllowedExpression("MIT AND ISC", allowed)).toBe(true);
		expect(isAllowedExpression("MIT AND GPL-2.0", allowed)).toBe(false);
		expect(isAllowedExpression("(MIT AND ISC) OR AGPL-3.0", allowed)).toBe(true);
	});

	it("ignores WITH exceptions and + suffixes", () => {
		expect(isAllowedExpression("Apache-2.0 WITH LLVM-exception", allowed)).toBe(true);
		expect(isAllowedExpression("MIT+", allowed)).toBe(true);
	});
});

describe("findViolations", () => {
	const report = {
		MIT: [{ name: "a", versions: ["1.0.0"], license: "MIT" }],
		"GPL-3.0": [{ name: "b", versions: ["2.0.0"], license: "GPL-3.0" }],
		Unknown: [{ name: "c", versions: ["3.0.0"] }],
	};

	it("reports packages outside the allowlist", () => {
		const violations = findViolations(flattenPnpmLicenses(report), { allowed: ["MIT"], exceptions: [] });
		expect(violations.map((v) => v.name)).toEqual(["b", "c"]);
	});

	it("honours exceptions only for the exact license recorded", () => {
		const violations = findViolations(flattenPnpmLicenses(report), {
			allowed: ["MIT"],
			exceptions: [
				{ name: "b", license: "GPL-3.0", reason: "dev-only tool, never bundled" },
				{ name: "c", license: "MIT", reason: "mismatched license must not excuse" },
			],
		});
		expect(violations.map((v) => v.name)).toEqual(["c"]);
	});
});
