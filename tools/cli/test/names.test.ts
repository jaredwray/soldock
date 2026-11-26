import { describe, expect, it } from "vitest";
import { hostnameError, instancesFromDatabases, nameError, suggestName } from "../src/names.ts";

describe("instance names", () => {
	it.each([
		["rivus", true],
		["wing-swap", true],
		["a", true],
		["a".repeat(30), true],
		["", false],
		["a".repeat(31), false],
		["Rivus", false],
		["-rivus", false],
		["rivus-", false],
		["ri_vus", false],
	])("%s is valid: %s", (name, valid) => {
		expect(nameError(name) === null).toBe(valid);
	});

	it.each([
		["work.rivus.com", "rivus"],
		["mail.wingswap.io", "wingswap"],
		["work.example.co.uk", "example"],
		["WORK.Rivus.COM", "rivus"],
		["x.my_site.com", "my-site"],
	])("suggests a name for %s: %s", (hostname, name) => {
		expect(suggestName(hostname)).toBe(name);
	});

	it.each([
		["work.rivus.com", true],
		["https://work.rivus.com", false],
		["work.rivus.com/mail", false],
		["localhost", false],
		["Work.rivus.com", false],
	])("%s is a valid host: %s", (hostname, valid) => {
		expect(hostnameError(hostname) === null).toBe(valid);
	});

	// `upgrade` finds the instances of an account by their D1 database. The instance from before the CLI
	// has no name, and its Worker name is not in the database name.
	it("finds the instances of an account from its database names", () => {
		const found = instancesFromDatabases([
			"asterra-rivus-directory",
			"soldock-directory",
			"other-database",
			"asterra--directory",
			"asterra-wing-swap-directory",
			"asterra-rivus-blobs",
		]);
		expect(found).toEqual([
			{ name: "rivus", prefix: "asterra-rivus", workerName: "asterra-rivus" },
			{ name: "wing-swap", prefix: "asterra-wing-swap", workerName: "asterra-wing-swap" },
			{ name: null, prefix: "soldock", workerName: null },
		]);
	});
});
