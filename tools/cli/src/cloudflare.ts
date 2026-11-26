// The wrangler commands of an instance. Each function takes a wrangler that acts in one account.
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bundle } from "./bundle.ts";
import { type InstanceTarget, instanceConfig } from "./config.ts";
import { Refusal } from "./errors.ts";
import { jsonOutput, type RunResult, type Wrangler } from "./wrangler.ts";

/** The binding of the directory database in the config of the Worker. */
const DIRECTORY_BINDING = "DIRECTORY";

/** A config file of one instance in a temporary folder. */
export interface ConfigFile {
	path: string;
	remove(): void;
}

export function writeConfig(bundle: Bundle, target: InstanceTarget): ConfigFile {
	const dir = mkdtempSync(join(tmpdir(), "asterra-"));
	const path = join(dir, "wrangler.json");
	writeFileSync(path, JSON.stringify(instanceConfig(bundle.template, target, bundle.dir), null, "\t"));
	return { path, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

function must(result: RunResult, what: string): RunResult {
	if (result.code !== 0) {
		const detail = (result.stderr || result.stdout).trim().split("\n").slice(-8).join("\n");
		throw new Refusal(`${what} failed${detail ? `:\n${detail}` : "."}`);
	}
	return result;
}

/** The names of the D1 databases of the account. */
export async function listDatabases(wrangler: Wrangler): Promise<string[]> {
	const result = must(await wrangler.run(["d1", "list", "--json"]), "Listing the D1 databases");
	const databases = jsonOutput<{ name: string }[]>(result.stdout);
	if (!Array.isArray(databases)) throw new Refusal("wrangler d1 list returned no list.");
	return databases.map((database) => database.name);
}

/** The migrations that the directory database applied, in order. A new database has none. */
export async function appliedMigrations(wrangler: Wrangler, config: ConfigFile): Promise<string[]> {
	const result = await wrangler.run([
		"d1",
		"execute",
		DIRECTORY_BINDING,
		"--remote",
		"--yes",
		"--json",
		"--config",
		config.path,
		"--command",
		"SELECT name FROM d1_migrations ORDER BY id",
	]);
	if (result.code !== 0 && /no such table: d1_migrations/.test(result.stdout + result.stderr)) return [];
	must(result, "Reading the migrations of the database");
	const output = jsonOutput<{ results?: { name: string }[] }[]>(result.stdout);
	if (!Array.isArray(output)) throw new Refusal("wrangler d1 execute returned no result.");
	return output.flatMap((statement) => statement.results ?? []).map((row) => row.name);
}

/** Applies the pending migrations of the bundle. */
export async function applyMigrations(wrangler: Wrangler, config: ConfigFile): Promise<void> {
	must(
		await wrangler.run(["d1", "migrations", "apply", DIRECTORY_BINDING, "--remote", "--config", config.path], {
			stdio: "show",
		}),
		"Applying the D1 migrations",
	);
}

/** The version that serves all traffic of the Worker now, or null when the Worker has no deployment. */
export async function currentVersion(wrangler: Wrangler, workerName: string): Promise<string | null> {
	const result = await wrangler.run(["deployments", "status", "--name", workerName, "--json"]);
	if (result.code !== 0) return null;
	const deployment = jsonOutput<{ versions?: { version_id: string; percentage: number }[] }>(result.stdout);
	const versions = [...(deployment?.versions ?? [])].sort((a, b) => b.percentage - a.percentage);
	return versions[0]?.version_id ?? null;
}

/** The Asterra version of a Worker version, from its tag (`asterra-<version>`), or null. */
export async function asterraVersion(
	wrangler: Wrangler,
	workerName: string,
	versionId: string,
): Promise<string | null> {
	const result = await wrangler.run(["versions", "view", versionId, "--name", workerName, "--json"]);
	if (result.code !== 0) return null;
	const version = jsonOutput<{ annotations?: Record<string, string> }>(result.stdout);
	const tag = version?.annotations?.["workers/tag"];
	return tag?.startsWith("asterra-") ? tag.slice("asterra-".length) : null;
}

/** Deploys the bundle. Returns the new version id. */
export async function deploy(wrangler: Wrangler, config: ConfigFile, version: string): Promise<string | null> {
	const outputFile = join(tmpdir(), `asterra-deploy-${randomBytes(6).toString("hex")}.ndjson`);
	try {
		must(
			await wrangler.run(
				[
					"deploy",
					"--config",
					config.path,
					"--tag",
					`asterra-${version}`,
					"--message",
					`Asterra ${version} (npx asterra)`,
				],
				{ stdio: "show", env: { WRANGLER_OUTPUT_FILE_PATH: outputFile } },
			),
			"The deploy",
		);
		return deployedVersion(safeRead(outputFile));
	} finally {
		rmSync(outputFile, { force: true });
	}
}

/** The version id in the output file of `wrangler deploy`. */
export function deployedVersion(ndjson: string): string | null {
	for (const line of ndjson.split("\n")) {
		const entry = jsonOutput<{ type?: string; version_id?: string }>(line);
		if (entry?.type === "deploy" && entry.version_id) return entry.version_id;
	}
	return null;
}

/** Sets or deletes (null) Worker secrets. The values go on stdin, never in an argument or a file. */
export async function putSecrets(
	wrangler: Wrangler,
	workerName: string,
	secrets: Record<string, string | null>,
): Promise<void> {
	must(
		await wrangler.run(["secret", "bulk", "--name", workerName], { input: JSON.stringify(secrets) }),
		`Changing the secrets ${Object.keys(secrets).join(", ")}`,
	);
}

/** The names of the secrets of the Worker. */
export async function secretNames(wrangler: Wrangler, workerName: string): Promise<string[]> {
	const result = must(
		await wrangler.run(["secret", "list", "--name", workerName, "--format", "json"]),
		"Listing the secrets",
	);
	return (jsonOutput<{ name: string }[]>(result.stdout) ?? []).map((secret) => secret.name);
}

/** Sends all traffic to an earlier version of the Worker. The migrations stay. */
export async function rollback(wrangler: Wrangler, workerName: string, versionId: string | null, message: string) {
	const args = ["rollback", ...(versionId ? [versionId] : []), "--name", workerName, "--message", message, "--yes"];
	must(await wrangler.run(args, { stdio: "show" }), "The rollback");
}

function safeRead(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}
