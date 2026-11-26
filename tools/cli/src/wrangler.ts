// wrangler does the work with Cloudflare: it creates the resources by name, uploads the Worker and the
// assets, and signs in. The CLI does not depend on it. It uses the wrangler on PATH when that is a
// compatible version, or installs the tested version into its own cache folder.
import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, say } from "./context.ts";
import { Refusal } from "./errors.ts";

export interface RunOptions {
	/** Written to stdin. Secrets go this way, never in an argument. */
	input?: string;
	/**
	 * capture (the default): the CLI reads the output. show: the operator sees the progress of wrangler,
	 * and stdin is closed, so wrangler asks nothing and creates each resource by its name. terminal: a
	 * login, which needs the terminal.
	 */
	stdio?: "capture" | "show" | "terminal";
	env?: Record<string, string>;
}

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface Wrangler {
	version: string;
	run(args: readonly string[], options?: RunOptions): Promise<RunResult>;
}

/** How to start one wrangler. The CLI never starts it through a shell: a shell does not quote arguments. */
export interface WranglerCommand {
	command: string;
	args: string[];
}

/** The JSON of a `--json` command. wrangler can write a line before it, so this starts at the first bracket. */
export function jsonOutput<T>(stdout: string): T | null {
	const start = stdout.search(/[[{]/);
	if (start < 0) return null;
	try {
		return JSON.parse(stdout.slice(start)) as T;
	} catch {
		return null;
	}
}

/** The last lines of the output of a command, without empty lines. */
export function lastLines(text: string, count = 8): string {
	return text
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.trim() !== "")
		.slice(-count)
		.join("\n");
}

/** The parts of a version, or null. */
export function parseVersion(text: string): [number, number, number] | null {
	const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** True when `found` has the major version of `tested` and is not older. */
export function isCompatible(found: string, tested: string): boolean {
	const a = parseVersion(found);
	const b = parseVersion(tested);
	if (!a || !b || a[0] !== b[0]) return false;
	return a[1] !== b[1] ? a[1] > b[1] : a[2] >= b[2];
}

/** The cache folder of the CLI. */
export function cacheDir(env: Readonly<Record<string, string | undefined>>): string {
	if (env.ASTERRA_CACHE_DIR) return env.ASTERRA_CACHE_DIR;
	const home = homedir();
	if (process.platform === "win32") return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "asterra");
	if (process.platform === "darwin") return join(home, "Library", "Caches", "asterra");
	return join(env.XDG_CACHE_HOME ?? join(home, ".cache"), "asterra");
}

/** The folder of one installed wrangler version in the cache. */
export function cachedWranglerDir(cache: string, version: string): string {
	return join(cache, `wrangler-${version}`);
}

let ownFolder: string | undefined;

/**
 * The working directory of each wrangler command: a temporary folder that the CLI owns. wrangler reads
 * the config file of its working directory, or of a folder above it, when a command has no `--config`.
 * An `account_id` in that file replaces CLOUDFLARE_ACCOUNT_ID. So wrangler never starts in the working
 * directory of the operator. The empty config of this folder stops the search in the folders above it.
 */
function runFolder(): string {
	if (ownFolder === undefined) {
		const dir = mkdtempSync(join(tmpdir(), "asterra-run-"));
		writeFileSync(join(dir, "wrangler.json"), "{}\n");
		process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
		ownFolder = dir;
	}
	return ownFolder;
}

/** Runs `<command> --version`. Null when the command does not start. */
function probeVersion(command: WranglerCommand): string | null {
	const result: SpawnSyncReturns<string> = spawnSync(command.command, [...command.args, "--version"], {
		encoding: "utf8",
		cwd: runFolder(),
		env: { ...process.env, WRANGLER_SEND_METRICS: process.env.WRANGLER_SEND_METRICS ?? "false" },
		timeout: 60_000,
	});
	return result.status === 0 ? result.stdout.trim() : null;
}

/** True when the CLI can use a wrangler of PATH. */
export function usesPath(): boolean {
	// On Windows, the wrangler of PATH is `wrangler.cmd`. It starts only through a shell, and a shell does
	// not quote an argument that has a space. So on Windows the CLI uses only its own copy, with Node.
	return process.platform !== "win32";
}

/** The wrangler of PATH, or of the cache, that is compatible with `tested`. */
export function findWrangler(tested: string, cache: string): { command: WranglerCommand; version: string } | null {
	const cached = join(cachedWranglerDir(cache, tested), "node_modules", "wrangler", "bin", "wrangler.js");
	const candidates: WranglerCommand[] = [
		...(usesPath() ? [{ command: "wrangler", args: [] }] : []),
		...(existsSync(cached) ? [{ command: process.execPath, args: [cached] }] : []),
	];
	for (const command of candidates) {
		const output = probeVersion(command);
		const version = output === null ? null : parseVersion(output);
		if (version && isCompatible(version.join("."), tested)) return { command, version: version.join(".") };
	}
	return null;
}

/** Starts a wrangler command. The account goes in the environment, not in the config. */
export function wranglerRunner(command: WranglerCommand, version: string): Wrangler {
	return {
		version,
		run: (args, options = {}) =>
			new Promise((resolve, reject) => {
				const child = spawn(command.command, [...command.args, ...args], {
					cwd: runFolder(),
					stdio:
						options.stdio === "terminal"
							? "inherit"
							: options.stdio === "show"
								? ["ignore", "inherit", "inherit"]
								: ["pipe", "pipe", "pipe"],
					env: { ...process.env, ...options.env },
				});
				let stdout = "";
				let stderr = "";
				child.stdout?.on("data", (chunk: Buffer) => {
					stdout += chunk.toString();
				});
				child.stderr?.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});
				child.on("error", reject);
				child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
				if (child.stdin) {
					child.stdin.end(options.input ?? "");
				}
			}),
	};
}

/** Installs one wrangler version into a folder of the cache. True when the install passed. */
export type Installer = (dir: string, version: string) => Promise<boolean>;

/** Installs with npm. bin.ts gives this installer to the context. */
export const npmInstall: Installer = (dir, version) =>
	new Promise((resolve) => {
		mkdirSync(dir, { recursive: true });
		// npm runs in the folder, so no argument holds a path. On Windows, npm is `npm.cmd` and needs a
		// shell, and a shell does not quote a path that has a space.
		const child = spawn(
			"npm",
			["install", "--prefix", ".", "--no-audit", "--no-fund", "--loglevel", "error", `wrangler@${version}`],
			{ cwd: dir, stdio: "inherit", shell: process.platform === "win32" },
		);
		child.on("error", () => resolve(false));
		child.on("close", (code) => resolve(code === 0));
	});

/** A compatible wrangler. Offers to install the tested version when none is found. */
export async function ensureWrangler(ctx: Context, tested: string): Promise<Wrangler> {
	// The version becomes a part of an npm argument.
	if (!/^\d+\.\d+\.\d+$/.test(tested)) throw new Refusal(`The release bundle names the wrangler version "${tested}".`);
	const cache = cacheDir(ctx.env);
	const found = findWrangler(tested, cache);
	if (found) return wranglerRunner(found.command, found.version);

	const dir = cachedWranglerDir(cache, tested);
	say(
		ctx,
		usesPath()
			? `Asterra needs wrangler ${tested} or a later ${tested.split(".")[0]}.x version. None is on PATH.`
			: `Asterra needs wrangler ${tested}. On Windows, the CLI uses only its own copy of wrangler.`,
	);
	const yes = await ctx.prompt.confirm(`Install wrangler ${tested} into ${dir} (about 130 MB)?`, true);
	if (!yes) {
		throw new Refusal(
			usesPath()
				? `Install wrangler ${tested} or later (npm install --global wrangler), then run the command again.`
				: `The CLI needs its own copy of wrangler ${tested}. Run the command again, and agree to the install.`,
		);
	}
	if (!(await ctx.installWrangler(dir, tested))) {
		throw new Refusal(`npm could not install wrangler ${tested} into ${dir}.`);
	}
	const installed = findWrangler(tested, cache);
	if (!installed) throw new Refusal(`wrangler ${tested} does not start from ${dir}.`);
	return wranglerRunner(installed.command, installed.version);
}
