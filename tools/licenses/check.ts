import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { findViolations, flattenPnpmLicenses, type LicensePolicy } from "./src/policy.ts";

const policy = JSON.parse(readFileSync(new URL("./policy.json", import.meta.url), "utf8")) as LicensePolicy;
// `-r` covers every workspace package. From pnpm 11, a plain `licenses list` reads only the root package.
const raw = execFileSync("pnpm", ["-r", "licenses", "list", "--json"], {
	encoding: "utf8",
	maxBuffer: 64 * 1024 * 1024,
});
const packages = flattenPnpmLicenses(raw.trim().length > 0 ? JSON.parse(raw) : {});
const violations = findViolations(packages, policy);

if (violations.length > 0) {
	console.error("Dependency license policy violations (see plan/adr/0011-dependency-license-policy.md):");
	for (const v of violations) {
		console.error(`  - ${v.name}@${v.versions.join(",")}: ${v.license}`);
	}
	process.exit(1);
}
console.log(`licenses: ${packages.length} packages checked, all within policy.`);
