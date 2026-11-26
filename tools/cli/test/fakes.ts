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
export function fixtureBundle(migrations = ["0001_a.sql", "0002_b.sql", "0003_c.sql"]): string {
	const dir = mkdtempSync(join(tmpdir(), "asterra-bundle-"));
	for (const folder of ["worker", "assets", "migrations"]) mkdirSync(join(dir, folder));
	writeFileSync(join(dir, "worker", "index.js"), "export default {};\n");
	writeFileSync(join(dir, "assets", "index.html"), "<div data-asterra-shell></div>\n");
	const source = parseWranglerJsonc(
		readFileSync(new URL("../../../apps/dock/wrangler.jsonc", import.meta.url), "utf8"),
	);
	writeFileSync(join(dir, "wrangler.template.json"), JSON.stringify(templateFromConfig(source)));
	const manifest = { version: "0.3.0", commit: "abc", wrangler: "4.149.0", migrations, min_applied_migration: null };
	writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
	return dir;
}

export const ACCOUNT = { id: "c".repeat(32), name: "Rivus" };

export interface CloudState {
	databases: string[];
	applied: string[];
	secrets: string[];
	/** The live version of each Worker. */
	versions: Record<string, { id: string; tag?: string }>;
	/** The config of each deploy, and the input of each `secret bulk`. */
	deployed: Record<string, unknown>[];
	bulk: Record<string, string | null>[];
}

/** A wrangler on a fake account: whoami, D1, deployments, versions, secrets, deploy and rollback. */
export function fakeCloud(state: Partial<CloudState> = {}): FakeWrangler & { state: CloudState } {
	const cloud: CloudState = { databases: [], applied: [], secrets: [], versions: {}, deployed: [], bulk: [], ...state };
	const flag = (args: string[], name: string) => args[args.indexOf(name) + 1] ?? "";
	const wrangler = fakeWrangler((args, options) => {
		if (starts(args, "whoami")) return { stdout: JSON.stringify({ loggedIn: true, accounts: [ACCOUNT] }) };
		if (starts(args, "d1", "list")) return { stdout: JSON.stringify(cloud.databases.map((name) => ({ name }))) };
		if (starts(args, "d1", "execute"))
			return { stdout: JSON.stringify([{ results: cloud.applied.map((name) => ({ name })) }]) };
		if (starts(args, "deployments", "status")) {
			const live = cloud.versions[flag(args, "--name")];
			return live ? { stdout: JSON.stringify({ versions: [{ version_id: live.id, percentage: 100 }] }) } : { code: 1 };
		}
		if (starts(args, "versions", "view")) {
			const live = Object.values(cloud.versions).find((version) => version.id === args[2]);
			return { stdout: JSON.stringify({ annotations: live?.tag ? { "workers/tag": live.tag } : {} }) };
		}
		if (starts(args, "deploy")) {
			const config = JSON.parse(readFileSync(flag(args, "--config"), "utf8")) as Record<string, unknown>;
			cloud.deployed.push(config);
			const id = `version-${cloud.deployed.length}`;
			cloud.versions[String(config.name)] = { id, tag: flag(args, "--tag") };
			const output = options.env?.WRANGLER_OUTPUT_FILE_PATH;
			if (output) writeFileSync(output, `${JSON.stringify({ type: "deploy", version_id: id })}\n`);
			return {};
		}
		if (starts(args, "secret", "bulk")) {
			const input = JSON.parse(options.input ?? "{}") as Record<string, string | null>;
			cloud.bulk.push(input);
			for (const [name, value] of Object.entries(input)) {
				cloud.secrets = cloud.secrets.filter((secret) => secret !== name);
				if (value !== null) cloud.secrets.push(name);
			}
			return {};
		}
		if (starts(args, "secret", "list")) return { stdout: JSON.stringify(cloud.secrets.map((name) => ({ name }))) };
		return {};
	});
	return Object.assign(wrangler, { state: cloud });
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
