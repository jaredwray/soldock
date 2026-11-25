import { describe, expect, it } from "vitest";
import { defaultMailDomain } from "../src/features/admin/memberAddress.ts";

describe("the first domain of the New member address", () => {
	it.each([
		{ domains: ["alpha.test", "dock.test"], own: "ada@dock.test", expected: "dock.test" },
		// The domain part of an address can have capital letters. The saved domains are in lower case.
		{ domains: ["alpha.test", "dock.test"], own: "ada@Dock.TEST", expected: "dock.test" },
		// The admin's domain is not saved, for example after a removal: the form selects the first saved domain.
		{ domains: ["alpha.test", "beta.test"], own: "ada@dock.test", expected: "alpha.test" },
		{ domains: [], own: "ada@dock.test", expected: "" },
	])("is $expected for $own and $domains", ({ domains, own, expected }) => {
		expect(defaultMailDomain(domains, own)).toBe(expected);
	});
});
