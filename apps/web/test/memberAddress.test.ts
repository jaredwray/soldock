import { describe, expect, it } from "vitest";
import { addressToCheck, defaultMailDomain } from "../src/features/admin/memberAddress.ts";

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

describe("the address that the New member form checks", () => {
	it.each([
		{ local: "ada.lovelace", domain: "dock.test", expected: "ada.lovelace@dock.test" },
		{ local: "  ada ", domain: "dock.test", expected: "ada@dock.test" },
		// Nothing to check: no mailbox name, no domain, a full address in the name field, or a name that is not valid.
		{ local: "", domain: "dock.test", expected: null },
		{ local: "ada", domain: "", expected: null },
		{ local: "ada@dock.test", domain: "dock.test", expected: null },
		{ local: "ada lovelace", domain: "dock.test", expected: null },
	])("is $expected for '$local' and '$domain'", ({ local, domain, expected }) => {
		expect(addressToCheck(local, domain)).toBe(expected);
	});
});
