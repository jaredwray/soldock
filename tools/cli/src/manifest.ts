// The manifest of a release bundle, and the check that an upgrade may go from the schema of an
// instance to the schema of this release.
import { Refusal } from "./errors.ts";

export interface Manifest {
	/** The Asterra version of the bundle. It is also the version of the CLI. */
	version: string;
	/** The git commit of the bundle. */
	commit: string;
	/** The wrangler version that the release was built and tested with. */
	wrangler: string;
	/** The D1 migrations of the bundle, in the order that wrangler applies them. */
	migrations: string[];
	/**
	 * The migration that an instance must have before it upgrades to this release, or null. A release sets
	 * it when the Worker of an earlier release cannot run on the new migrations. An example is a migration
	 * that removes a column that an earlier Worker uses. The migrations go in before the deploy, so that
	 * Worker would run on them for a short time. An instance without this migration must first install
	 * the release before this one.
	 */
	min_applied_migration: string | null;
}

/** Reads and checks manifest.json. */
export function parseManifest(value: unknown): Manifest {
	const fail = (detail: string): never => {
		throw new Error(`The release manifest is not valid: ${detail}`);
	};
	if (value === null || typeof value !== "object") fail("not an object");
	const manifest = value as Record<string, unknown>;
	for (const key of ["version", "commit", "wrangler"]) {
		if (typeof manifest[key] !== "string" || manifest[key] === "") fail(`"${key}" must be a string`);
	}
	const migrations = manifest.migrations;
	if (!Array.isArray(migrations) || migrations.some((name) => typeof name !== "string")) {
		fail('"migrations" must be a list of names');
	}
	const min = manifest.min_applied_migration;
	if (min !== null && (typeof min !== "string" || !(migrations as string[]).includes(min))) {
		fail('"min_applied_migration" must be null or one of the migrations');
	}
	return manifest as unknown as Manifest;
}

/**
 * Checks the migrations that the database applied against the release. Returns the migrations that
 * the upgrade applies. Refuses a downgrade (the database has a migration that the release does not
 * know) and an upgrade from a schema that is older than the release allows.
 */
export function checkUpgrade(applied: readonly string[], manifest: Manifest): { pending: string[] } {
	const known = new Set(manifest.migrations);
	const unknown = applied.filter((name) => !known.has(name));
	if (unknown.length > 0) {
		throw new Refusal(
			`The database has migrations that release ${manifest.version} does not know: ${unknown.join(", ")}. ` +
				"The instance runs a newer release. Use a newer version of the CLI.",
		);
	}
	const min = manifest.min_applied_migration;
	if (min !== null && applied.length > 0 && !applied.includes(min)) {
		throw new Refusal(
			`Release ${manifest.version} needs the migration ${min}, and the database does not have it. ` +
				"Upgrade to an earlier release first. The release notes name it.",
		);
	}
	const done = new Set(applied);
	return { pending: manifest.migrations.filter((name) => !done.has(name)) };
}
