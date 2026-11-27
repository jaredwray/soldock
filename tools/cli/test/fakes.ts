// Fakes of the process boundaries of the CLI: the terminal, wrangler and HTTP.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWranglerJsonc, templateFromConfig } from "../src/config.ts";
import type { Context } from "../src/context.ts";
import type { HttpGet, HttpResponse } from "../src/http.ts";
import { noQuestions, type Prompter } from "../src/prompt.ts";
import type { RunOptions, RunResult, Wrangler } from "../src/wrangler.ts";

export interface Call {
	args: string[];
	options: RunOptions;
}

export type FakeWrangler = Wrangler & { calls: Call[] };

/** A wrangler that answers each command with `answer`. */
export function fakeWrangler(
	answer: (args: string[], options: RunOptions) => Partial<RunResult> | undefined,
): FakeWrangler {
	const calls: Call[] = [];
	return {
		version: "4.149.0",
		calls,
		run: async (args, options = {}) => {
			calls.push({ args: [...args], options });
			return { code: 0, stdout: "", stderr: "", ...answer([...args], options) };
		},
	};
}

/** True when the call starts with these words. */
export const starts = (args: readonly string[], ...words: string[]) =>
	words.every((word, index) => args[index] === word);

export type ScriptedPrompter = Prompter & { asked: string[] };

/** A terminal that gives the answers in order. A question without an answer fails the test. */
export function scripted(answers: Array<boolean | string | number>): ScriptedPrompter {
	const queue = [...answers];
	const asked: string[] = [];
	const next = (question: string) => {
		asked.push(question);
		if (queue.length === 0) throw new Error(`No answer for: ${question}`);
		return queue.shift();
	};
	return {
		interactive: true,
		asked,
		confirm: async (question) => next(question) as boolean,
		text: async (question) => next(question) as string,
		secret: async (question) => next(question) as string,
		choose: async (question, choices) => {
			const choice = choices[next(question) as number];
			if (!choice) throw new Error(`No choice for: ${question}`);
			return choice.value;
		},
	};
}

export interface FakeContext extends Context {
	output(): string;
	errors(): string;
}

export function fakeContext(overrides: Partial<Context> = {}): FakeContext {
	let out = "";
	let err = "";
	let clock = 1_000_000;
	const httpGet: HttpGet = async (url) => {
		throw new Error(`no HTTP fake for ${url}`);
	};
	return {
		io: {
			out: (text) => {
				out += text;
			},
			err: (text) => {
				err += text;
			},
		},
		prompt: noQuestions,
		httpGet,
		fetch: async (input) => {
			throw new Error(`no fetch fake for ${String(input)}`);
		},
		env: {},
		resolveHost: async () => [],
		installWrangler: async (dir) => {
			throw new Error(`no install fake for ${dir}`);
		},
		sleep: async (ms) => {
			clock += ms;
		},
		now: () => clock,
		output: () => out,
		errors: () => err,
		...overrides,
	};
}

/** A release bundle with the real template and three migrations. */
export function fixtureBundle(
	migrations = ["0001_a.sql", "0002_b.sql", "0003_c.sql"],
	minAppliedMigration: string | null = null,
): string {
	const dir = mkdtempSync(join(tmpdir(), "asterra-bundle-"));
	for (const folder of ["worker", "assets", "migrations"]) mkdirSync(join(dir, folder));
	writeFileSync(join(dir, "worker", "index.js"), "export default {};\n");
	writeFileSync(join(dir, "assets", "index.html"), "<div data-asterra-shell></div>\n");
	const source = parseWranglerJsonc(
		readFileSync(new URL("../../../apps/dock/wrangler.jsonc", import.meta.url), "utf8"),
	);
	writeFileSync(join(dir, "wrangler.template.json"), JSON.stringify(templateFromConfig(source)));
	const manifest = {
		version: "0.3.0",
		commit: "abc",
		wrangler: "4.149.0",
		migrations,
		min_applied_migration: minAppliedMigration,
	};
	writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
	return dir;
}

export const ACCOUNT = { id: "c".repeat(32), name: "Rivus" };

/** One version of a fake Worker. */
export interface FakeVersion {
	id: string;
	/** The annotation `workers/tag`. A secret change has none here: the fake copies nothing from the deploy. */
	tag?: string;
	/** True when `secret bulk` made the version. */
	secretChange?: boolean;
	secrets?: string[];
	/** The var ASTERRA_HOSTNAME of the deploy. */
	hostname?: string;
}

export interface CloudState {
	databases: string[];
	/** The migrations of the database. null: the database has no `d1_migrations` table. */
	applied: string[] | null;
	/** The versions of each Worker, from the oldest to the newest. */
	workers: Record<string, FakeVersion[]>;
	/** The version that serves each Worker. The default is its newest version. */
	live: Record<string, string>;
	/** The config of each deploy, and the input of each `secret bulk`. */
	deployed: Record<string, unknown>[];
	bulk: Record<string, string | null>[];
	/** Replaces the answer of a command, for a failure of wrangler. */
	fail: (args: string[]) => Partial<RunResult> | undefined;
	/** False: `wrangler deploy` writes no entry to its output file. */
	deployEntry: boolean;
}

export type FakeCloud = FakeWrangler & {
	state: CloudState;
	/** The version that serves the Worker. */
	liveVersion(workerName: string): FakeVersion | undefined;
};

/**
 * A wrangler on a fake account: whoami, D1, deployments, versions, secrets, deploy and rollback. As in
 * Cloudflare, a secret change makes a new version, and a version holds its secrets.
 */
export function fakeCloud(state: Partial<CloudState> = {}): FakeCloud {
	const cloud: CloudState = {
		databases: [],
		applied: [],
		workers: {},
		live: {},
		deployed: [],
		bulk: [],
		fail: () => undefined,
		deployEntry: true,
		...state,
	};
	const flag = (args: string[], name: string) => args[args.indexOf(name) + 1] ?? "";
	const liveVersion = (workerName: string) => {
		const versions = cloud.workers[workerName] ?? [];
		return versions.find((version) => version.id === cloud.live[workerName]) ?? versions.at(-1);
	};
	const add = (workerName: string, version: FakeVersion) => {
		cloud.workers[workerName] = [...(cloud.workers[workerName] ?? []), version];
		cloud.live[workerName] = version.id;
	};
	// The JSON of `wrangler versions view` and of one item of `wrangler versions list`.
	const json = (version: FakeVersion, index: number) => ({
		id: version.id,
		metadata: { created_on: new Date(Date.UTC(2026, 0, 1 + index)).toISOString() },
		annotations: {
			"workers/triggered_by": version.secretChange ? "secret" : "upload",
			...(version.tag ? { "workers/tag": version.tag } : {}),
		},
		resources: {
			bindings: [
				{ type: "d1", name: "DIRECTORY" },
				...(version.hostname ? [{ type: "plain_text", name: "ASTERRA_HOSTNAME", text: version.hostname }] : []),
				...(version.secrets ?? []).map((name) => ({ type: "secret_text", name })),
			],
		},
	});
	const wrangler = fakeWrangler((args, options) => {
		const failure = cloud.fail(args);
		if (failure) return failure;
		if (starts(args, "whoami")) return { stdout: JSON.stringify({ loggedIn: true, accounts: [ACCOUNT] }) };
		if (starts(args, "d1", "list")) return { stdout: JSON.stringify(cloud.databases.map((name) => ({ name }))) };
		if (starts(args, "d1", "execute")) {
			if (cloud.applied === null) return { code: 1, stderr: "✘ [ERROR] no such table: d1_migrations: SQLITE_ERROR\n" };
			return { stdout: JSON.stringify([{ results: cloud.applied.map((name) => ({ name })) }]) };
		}
		const workerName = flag(args, "--name");
		const versions = cloud.workers[workerName] ?? [];
		if (starts(args, "deployments", "status")) {
			const live = liveVersion(workerName);
			if (!live) {
				return { code: 1, stderr: "✘ [ERROR] This Worker does not exist on your account. [code: 10007]\n" };
			}
			return { stdout: JSON.stringify({ versions: [{ version_id: live.id, percentage: 100 }] }) };
		}
		if (starts(args, "versions", "view")) {
			const index = versions.findIndex((version) => version.id === args[2]);
			const version = versions[index];
			return version ? { stdout: JSON.stringify(json(version, index)) } : { code: 1, stderr: "not found\n" };
		}
		if (starts(args, "versions", "list")) {
			// wrangler shows the 10 newest versions.
			return { stdout: JSON.stringify(versions.map(json).slice(-10)) };
		}
		if (starts(args, "deploy")) {
			const config = JSON.parse(readFileSync(flag(args, "--config"), "utf8")) as Record<string, unknown>;
			cloud.deployed.push(config);
			const id = `version-${cloud.deployed.length}`;
			const name = String(config.name);
			const host = (config.vars as Record<string, unknown> | undefined)?.ASTERRA_HOSTNAME;
			add(name, {
				id,
				tag: flag(args, "--tag"),
				secrets: [...(liveVersion(name)?.secrets ?? [])],
				...(typeof host === "string" ? { hostname: host } : {}),
			});
			const output = options.env?.WRANGLER_OUTPUT_FILE_PATH;
			if (output && cloud.deployEntry) writeFileSync(output, `${JSON.stringify({ type: "deploy", version_id: id })}\n`);
			return {};
		}
		if (starts(args, "secret", "bulk")) {
			const input = JSON.parse(options.input ?? "{}") as Record<string, string | null>;
			cloud.bulk.push(input);
			const live = liveVersion(workerName);
			let secrets = [...(live?.secrets ?? [])];
			for (const [name, value] of Object.entries(input)) {
				secrets = secrets.filter((secret) => secret !== name);
				if (value !== null) secrets.push(name);
			}
			add(workerName, {
				id: `${live?.id ?? "version-0"}-secrets-${cloud.bulk.length}`,
				secretChange: true,
				secrets,
				...(live?.hostname ? { hostname: live.hostname } : {}),
			});
			return {};
		}
		if (starts(args, "secret", "list")) {
			return { stdout: JSON.stringify((liveVersion(workerName)?.secrets ?? []).map((name) => ({ name }))) };
		}
		if (starts(args, "rollback")) {
			cloud.live[workerName] = args[1] ?? "";
			return {};
		}
		return {};
	});
	return Object.assign(wrangler, { state: cloud, liveVersion });
}

/** The answers of a healthy Worker at `origin`, for httpGet. */
export function healthyWorker(origin: string, overrides: Record<string, HttpResponse> = {}): HttpGet {
	const json = (body: unknown, status = 200) => ({
		status,
		contentType: "application/json",
		body: JSON.stringify(body),
	});
	const problem = (status: number) => ({ status, contentType: "application/problem+json", body: "{}" });
	const answers: Record<string, HttpResponse> = {
		"/api/v1/system/ping": json({ ok: true }),
		"/healthz": json({ ok: true }),
		"/api/v1/nope": problem(404),
		"/hooks/nope": problem(404),
		"/mcp": problem(405),
		"/api/v1/mail/profile": problem(401),
		"/auth/setup": json({ setup_needed: true }),
		"/mail": { status: 200, contentType: "text/html", body: "<div data-asterra-shell>" },
		...overrides,
	};
	return async (url) => {
		const answer = answers[url.slice(origin.length)];
		if (!answer) throw new Error(`unexpected GET ${url}`);
		return answer;
	};
}

/** The first two words of each wrangler call. */
export const commands = (wrangler: FakeWrangler) => wrangler.calls.map((call) => call.args.slice(0, 2).join(" "));
