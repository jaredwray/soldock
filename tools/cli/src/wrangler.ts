// wrangler does the work with Cloudflare: it creates the resources by name, uploads the Worker and the
// assets, and signs in. The CLI does not depend on it. It uses the wrangler on PATH when that is a
// compatible version, or installs the tested version into its own cache folder.
import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
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

/** How to start one wrangler. */
export interface WranglerCommand {
	command: string;
	args: string[];
	/** `wrangler.cmd` on Windows needs a shell. */
	shell: boolean;
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
export function cacheDir(
	env: Readonly<Record<string, string | undefined>>,
	platform = process.platform,
	home = homedir(),
): string {
	if (env.ASTERRA_CACHE_DIR) return env.ASTERRA_CACHE_DIR;
	if (platform === "win32") return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "asterra");
	if (platform === "darwin") return join(home, "Library", "Caches", "asterra");
	return join(env.XDG_CACHE_HOME ?? join(home, ".cache"), "asterra");
}

/** The folder of one installed wrangler version in the cache. */
export function cachedWranglerDir(cache: string, version: string): string {
	return join(cache, `wrangler-${version}`);
}

export type VersionProbe = (command: WranglerCommand) => string | null;

/** Runs `<command> --version`. Null when the command does not start. */
export const probeVersion: VersionProbe = (command) => {
	const result: SpawnSyncReturns<string> = spawnSync(command.command, [...command.args, "--version"], {
		encoding: "utf8",
		shell: command.shell,
		env: { ...process.env, WRANGLER_SEND_METRICS: process.env.WRANGLER_SEND_METRICS ?? "false" },
		timeout: 60_000,
	});
	return result.status === 0 ? result.stdout.trim() : null;
};

/** The wrangler of the cache, or of PATH, that is compatible with `tested`. */
export function findWrangler(
	tested: string,
	cache: string,
	probe: VersionProbe = probeVersion,
	fileExists: (path: string) => boolean = existsSync,
): { command: WranglerCommand; version: string } | null {
	const cached = join(cachedWranglerDir(cache, tested), "node_modules", "wrangler", "bin", "wrangler.js");
	const candidates: WranglerCommand[] = [
		{ command: "wrangler", args: [], shell: process.platform === "win32" },
		...(fileExists(cached) ? [{ command: process.execPath, args: [cached], shell: false }] : []),
	];
	for (const command of candidates) {
		const output = probe(command);
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
					shell: command.shell,
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

/** Installs one wrangler version into the cache with npm. */
export type Installer = (dir: string, version: string) => Promise<boolean>;

export const npmInstall: Installer = (dir, version) =>
	new Promise((resolve) => {
		const child = spawn(
			"npm",
			["install", "--prefix", dir, "--no-audit", "--no-fund", "--loglevel", "error", `wrangler@${version}`],
			{ stdio: "inherit", shell: process.platform === "win32" },
		);
		child.on("error", () => resolve(false));
		child.on("close", (code) => resolve(code === 0));
	});

/** A compatible wrangler. Offers to install the tested version when none is found. */
export async function ensureWrangler(
	ctx: Context,
	tested: string,
	deps: { probe?: VersionProbe; install?: Installer; fileExists?: (path: string) => boolean } = {},
): Promise<Wrangler> {
	const cache = cacheDir(ctx.env);
	const found = findWrangler(tested, cache, deps.probe, deps.fileExists);
	if (found) return wranglerRunner(found.command, found.version);

	const dir = cachedWranglerDir(cache, tested);
	say(ctx, `Asterra needs wrangler ${tested} or a later 4.x version. None is on PATH.`);
	const yes = await ctx.prompt.confirm(`Install wrangler ${tested} into ${dir} (about 130 MB)?`, true);
	if (!yes) {
		throw new Refusal(
			`Install wrangler ${tested} or later (npm install --global wrangler), then run the command again.`,
		);
	}
	if (!(await (deps.install ?? npmInstall)(dir, tested))) {
		throw new Refusal(`npm could not install wrangler ${tested} into ${dir}.`);
	}
	const installed = findWrangler(tested, cache, deps.probe, deps.fileExists);
	if (!installed) throw new Refusal(`wrangler ${tested} does not start from ${dir}.`);
	return wranglerRunner(installed.command, installed.version);
}
