// The wrangler commands of an instance. Each function takes a wrangler that acts in one account.
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bundle } from "./bundle.ts";
import { HOSTNAME_VAR, type InstanceTarget, instanceConfig } from "./config.ts";
import { Refusal } from "./errors.ts";
import { jsonOutput, lastLines, type RunResult, type Wrangler } from "./wrangler.ts";

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
		const detail = lastLines(result.stderr || result.stdout);
		throw new Refusal(`${what} failed${detail ? `:\n${detail}` : "."}`);
	}
	return result;
}

/** The names of the D1 databases of the account. */
export async function listDatabases(wrangler: Wrangler): Promise<string[]> {
	const result = must(await wrangler.run(["d1", "list", "--json"]), "The list of the D1 databases");
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
	must(result, "The read of the migrations of the database");
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
		"wrangler d1 migrations apply",
	);
}

// What wrangler writes when the Worker has no deployment ("The Worker <name> has no deployments."), and
// when the account has no Worker with the name (API error 10007, or 10090 for a legacy environment).
const NO_DEPLOYMENT = /has no deployments|\[code: 100(?:07|90)\]|This Worker does not exist/;

/**
 * The version that serves the most traffic of the Worker now, or null when the Worker has no deployment
 * or does not exist. A different failure stops the run: it does not tell that the Worker has no deployment.
 */
export async function currentVersion(wrangler: Wrangler, workerName: string): Promise<string | null> {
	const result = await wrangler.run(["deployments", "status", "--name", workerName, "--json"]);
	if (result.code !== 0 && NO_DEPLOYMENT.test(result.stdout + result.stderr)) return null;
	must(result, `The read of the deployment of the Worker ${workerName}`);
	const deployment = jsonOutput<{ versions?: { version_id: string; percentage: number }[] }>(result.stdout);
	const versions = [...(deployment?.versions ?? [])].sort((a, b) => b.percentage - a.percentage);
	const versionId = versions[0]?.version_id;
	if (!versionId) throw new Refusal(`wrangler deployments status showed no version of the Worker ${workerName}.`);
	return versionId;
}

/** How a Worker version started, in its annotation `workers/triggered_by`. */
const SECRET_CHANGE = "secret";

/** One version of a Worker. */
export interface WorkerVersion {
	id: string;
	createdOn: string;
	/** The annotation `workers/tag`. A deploy of the CLI sets `asterra-<version>`. */
	tag: string | null;
	/** True when a secret change made the version. Such a version has the code of the deploy before it. */
	secretChange: boolean;
}

/** A version with its bindings. */
export interface VersionDetail extends WorkerVersion {
	/** The names of the secrets of the version. A rollback to the version brings back these secrets. */
	secretNames: string[];
	/** The host that the deploy of the version stored (`ASTERRA_HOSTNAME`), or null. */
	hostname: string | null;
}

interface RawVersion {
	id?: string;
	metadata?: { created_on?: string };
	annotations?: Record<string, string>;
	resources?: { bindings?: { type?: string; name?: string; text?: string }[] };
}

function toVersion(raw: RawVersion): WorkerVersion | null {
	if (typeof raw?.id !== "string") return null;
	return {
		id: raw.id,
		createdOn: raw.metadata?.created_on ?? "",
		tag: raw.annotations?.["workers/tag"] || null,
		secretChange: raw.annotations?.["workers/triggered_by"] === SECRET_CHANGE,
	};
}

/** One version with its secret names and its stored host. */
export async function viewVersion(wrangler: Wrangler, workerName: string, versionId: string): Promise<VersionDetail> {
	const result = must(
		await wrangler.run(["versions", "view", versionId, "--name", workerName, "--json"]),
		`The read of the version ${versionId} of the Worker ${workerName}`,
	);
	const raw = jsonOutput<RawVersion>(result.stdout);
	const version = raw ? toVersion(raw) : null;
	if (!raw || !version) throw new Refusal(`wrangler versions view returned no version for ${versionId}.`);
	const bindings = raw.resources?.bindings ?? [];
	const host = bindings.find((binding) => binding.type === "plain_text" && binding.name === HOSTNAME_VAR)?.text;
	return {
		...version,
		secretNames: bindings.flatMap((binding) => (binding.type === "secret_text" && binding.name ? [binding.name] : [])),
		hostname: host || null,
	};
}

/** The 10 newest versions of the Worker (wrangler shows no more), from the oldest to the newest. */
export async function listVersions(wrangler: Wrangler, workerName: string): Promise<WorkerVersion[]> {
	const result = must(
		await wrangler.run(["versions", "list", "--name", workerName, "--json"]),
		`The list of the versions of the Worker ${workerName}`,
	);
	const raw = jsonOutput<RawVersion[]>(result.stdout);
	if (!Array.isArray(raw)) throw new Refusal("wrangler versions list returned no list.");
	return raw.flatMap((item) => toVersion(item) ?? []).sort((a, b) => a.createdOn.localeCompare(b.createdOn));
}

/**
 * The release of a version: the newest version at or before it that a secret change did not make. A
 * secret change makes a new Worker version with the same code, so the version that runs is frequently
 * not the version of the deploy. Null when the list does not go back to that deploy.
 */
export function releaseOf(versions: readonly WorkerVersion[], versionId: string): WorkerVersion | null {
	for (let index = versions.findIndex((version) => version.id === versionId); index >= 0; index -= 1) {
		const version = versions[index];
		if (version && !version.secretChange) return version;
	}
	return null;
}

/**
 * The version that a rollback goes to: the newest version from before the release of the current
 * version. wrangler goes to the deployment before by default, and after a secret change that deployment
 * has the same release with the earlier secrets.
 */
export function rollbackTarget(
	versions: readonly WorkerVersion[],
	currentId: string,
): { current: WorkerVersion; target: WorkerVersion | null } | null {
	const current = releaseOf(versions, currentId);
	if (!current) return null;
	return { current, target: versions[versions.indexOf(current) - 1] ?? null };
}

/** The Asterra version of a version tag (`asterra-<version>`), or null. */
export function asterraVersion(tag: string | null): string | null {
	return tag?.startsWith("asterra-") ? tag.slice("asterra-".length) : null;
}

/** The Asterra version that runs: the tag of the release of the version, or null (from before the CLI). */
export async function runningRelease(
	wrangler: Wrangler,
	workerName: string,
	version: WorkerVersion,
): Promise<string | null> {
	if (!version.secretChange) return asterraVersion(version.tag);
	const release = releaseOf(await listVersions(wrangler, workerName), version.id);
	// Without the deploy in the list, the tag of the version is the only source.
	return asterraVersion((release ?? version).tag);
}

/** Deploys the bundle. Returns the new version id. */
export async function deploy(wrangler: Wrangler, config: ConfigFile, version: string): Promise<string> {
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
			"wrangler deploy",
		);
		const versionId = deployedVersion(safeRead(outputFile));
		if (versionId === null) {
			// Without the version id, the CLI cannot tell which version the smoke check examines.
			throw new Refusal(
				"wrangler deploy ended without an error, but its output file has no deploy entry with a version id. " +
					"The CLI cannot confirm the deploy. Run `asterra status` to see the version that runs.",
			);
		}
		return versionId;
	} finally {
		rmSync(outputFile, { force: true });
	}
}

/** The version id in the output file of `wrangler deploy`. */
function deployedVersion(ndjson: string): string | null {
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
		`The change of the secrets ${Object.keys(secrets).join(", ")}`,
	);
}

/** The names of the secrets of the Worker. */
export async function secretNames(wrangler: Wrangler, workerName: string): Promise<string[]> {
	const result = must(
		await wrangler.run(["secret", "list", "--name", workerName, "--format", "json"]),
		"The list of the secrets",
	);
	return (jsonOutput<{ name: string }[]>(result.stdout) ?? []).map((secret) => secret.name);
}

/** Sends all traffic to an earlier version of the Worker. The migrations stay. */
export async function rollback(wrangler: Wrangler, workerName: string, versionId: string, message: string) {
	// The CLI always names the version. Without a version, wrangler goes to the deployment before.
	const args = ["rollback", versionId, "--name", workerName, "--message", message, "--yes"];
	must(await wrangler.run(args, { stdio: "show" }), "wrangler rollback");
}

function safeRead(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}
