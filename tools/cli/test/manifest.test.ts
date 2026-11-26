import { describe, expect, it } from "vitest";
import { checkUpgrade, type Manifest, parseManifest, Refusal } from "../src/manifest.ts";

const manifest: Manifest = {
	version: "0.3.0",
	commit: "abc",
	wrangler: "4.149.0",
	migrations: ["0001_a.sql", "0002_b.sql", "0003_c.sql"],
	min_applied_migration: null,
};

describe("checkUpgrade", () => {
	it("returns the migrations that the database does not have", () => {
		expect(checkUpgrade([], manifest).pending).toEqual(manifest.migrations);
		expect(checkUpgrade(["0001_a.sql"], manifest).pending).toEqual(["0002_b.sql", "0003_c.sql"]);
		expect(checkUpgrade(manifest.migrations, manifest).pending).toEqual([]);
	});

	// An older CLI must not deploy an older Worker onto a newer schema.
	it("refuses a database with a migration that the release does not know", () => {
		expect(() => checkUpgrade(["0001_a.sql", "0004_d.sql"], manifest)).toThrow(Refusal);
		expect(() => checkUpgrade(["0001_a.sql", "0004_d.sql"], manifest)).toThrow(/0004_d\.sql/);
	});

	it("refuses a database older than the release allows, and accepts a new database", () => {
		const strict = { ...manifest, min_applied_migration: "0002_b.sql" };
		expect(() => checkUpgrade(["0001_a.sql"], strict)).toThrow(/needs the migration 0002_b\.sql/);
		expect(checkUpgrade(["0001_a.sql", "0002_b.sql"], strict).pending).toEqual(["0003_c.sql"]);
		expect(checkUpgrade([], strict).pending).toEqual(manifest.migrations);
	});
});

describe("parseManifest", () => {
	it("accepts a valid manifest and refuses a minimum that is not one of the migrations", () => {
		expect(parseManifest(manifest)).toEqual(manifest);
		expect(() => parseManifest({ ...manifest, min_applied_migration: "0009_x.sql" })).toThrow(/min_applied_migration/);
		expect(() => parseManifest({ ...manifest, version: "" })).toThrow(/"version"/);
	});
});
