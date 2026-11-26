import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inAccount, signIn } from "../src/auth.ts";
import { Refusal } from "../src/errors.ts";
import { ensureWrangler, isCompatible } from "../src/wrangler.ts";
import { fakeContext, fakeWrangler, scripted, starts } from "./fakes.ts";

describe("isCompatible", () => {
	it.each([
		["4.149.0", true],
		["4.168.2", true],
		["4.149.1", true],
		["4.148.9", false],
		["5.0.0", false],
		["3.114.0", false],
		["not a version", false],
	])("wrangler %s for a release tested with 4.149.0: %s", (found, compatible) => {
		expect(isCompatible(found, "4.149.0")).toBe(compatible);
	});
});

const temp = (name: string) => mkdtempSync(join(tmpdir(), `asterra-${name}-`));

/**
 * Makes PATH a folder with only a `wrangler` program (a shell script), or with nothing. The program
 * prints its working directory, its account and each argument.
 */
function pathWith(version: string | null): void {
	const bin = temp("path");
	if (version !== null) {
		const script = [
			"#!/bin/sh",
			`if [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi`,
			'echo "cwd=$(pwd)"',
			'echo "account=$CLOUDFLARE_ACCOUNT_ID"',
			'for arg in "$@"; do echo "arg=$arg"; done',
			"",
		].join("\n");
		writeFileSync(join(bin, "wrangler"), script);
		chmodSync(join(bin, "wrangler"), 0o755);
	}
	vi.stubEnv("PATH", bin);
}

/** Writes a wrangler into the cache, as `npm install --prefix <dir> wrangler@<version>` does. */
function installInto(dir: string, version: string): void {
	const bin = join(dir, "node_modules", "wrangler", "bin", "wrangler.js");
	mkdirSync(dirname(bin), { recursive: true });
	writeFileSync(
		bin,
		`console.log(process.argv[2] === "--version" ? "${version}" : "cached " + process.argv.slice(2));\n`,
	);
}

// These tests start real programs. The CLI does not use the wrangler of PATH on Windows.
describe.skipIf(process.platform === "win32")("finding wrangler", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("uses a compatible wrangler on PATH, and asks nothing", async () => {
		pathWith("4.150.0");
		const ctx = fakeContext({ env: { ASTERRA_CACHE_DIR: temp("cache") }, prompt: scripted([]) });
		const wrangler = await ensureWrangler(ctx, "4.149.0");
		expect(wrangler.version).toBe("4.150.0");
	});

	it("uses the wrangler of its cache when the wrangler on PATH is too old", async () => {
		pathWith("3.114.0");
		const cache = temp("cache");
		installInto(join(cache, "wrangler-4.149.0"), "4.149.0");
		const wrangler = await ensureWrangler(fakeContext({ env: { ASTERRA_CACHE_DIR: cache } }), "4.149.0");
		expect(wrangler.version).toBe("4.149.0");
		expect((await wrangler.run(["d1", "list"])).stdout).toBe("cached d1,list\n");
	});

	it("installs the tested version into the cache only when the operator agrees", async () => {
		pathWith(null);
		const installs: string[] = [];
		const cache = temp("xdg");
		const context = (answer: boolean) =>
			fakeContext({
				env: { XDG_CACHE_HOME: cache },
				prompt: scripted([answer]),
				installWrangler: async (dir, version) => {
					installs.push(dir);
					installInto(dir, version);
					return true;
				},
			});
		await expect(ensureWrangler(context(false), "4.149.0")).rejects.toThrow(Refusal);
		expect(installs).toEqual([]);
		const wrangler = await ensureWrangler(context(true), "4.149.0");
		expect(installs).toEqual([join(cache, "asterra", "wrangler-4.149.0")]);
		expect(wrangler.version).toBe("4.149.0");
	});

	it("stops when npm cannot install wrangler", async () => {
		pathWith(null);
		const ctx = fakeContext({ env: { ASTERRA_CACHE_DIR: temp("cache") }, installWrangler: async () => false });
		await expect(ensureWrangler(ctx, "4.149.0")).rejects.toThrow(/npm could not install wrangler 4\.149\.0/);
	});

	// wrangler reads the config file of its working directory. An `account_id` in that file replaces
	// CLOUDFLARE_ACCOUNT_ID, so a run in a project folder could change the account of that project.
	it("starts wrangler in a folder of the CLI, not in the working directory, with the account and each argument", async () => {
		pathWith("4.149.0");
		const ctx = fakeContext({ env: { ASTERRA_CACHE_DIR: temp("cache") } });
		const wrangler = inAccount(await ensureWrangler(ctx, "4.149.0"), "a".repeat(32));
		const result = await wrangler.run(["deploy", "--message", "Asterra 0.3.0 (npx asterra)"]);
		const lines = result.stdout.trim().split("\n");
		const cwd = String(lines[0]).slice("cwd=".length);

		expect(realpathSync(cwd)).not.toBe(realpathSync(process.cwd()));
		expect(realpathSync(dirname(cwd))).toBe(realpathSync(tmpdir()));
		// The config of the folder has no account. It also stops the search of wrangler in the folders above.
		expect(JSON.parse(readFileSync(join(cwd, "wrangler.json"), "utf8"))).toEqual({});
		// No shell splits the argument that has spaces.
		expect(lines.slice(1)).toEqual([
			`account=${"a".repeat(32)}`,
			"arg=deploy",
			"arg=--message",
			"arg=Asterra 0.3.0 (npx asterra)",
		]);
	});
});

describe("signIn", () => {
	const rivus = { id: "a".repeat(32), name: "Rivus" };
	const wing = { id: "b".repeat(32), name: "Wingswap" };
	const signedIn = (accounts: object[]) =>
		fakeWrangler((args) =>
			starts(args, "whoami") ? { stdout: JSON.stringify({ loggedIn: true, accounts }) } : undefined,
		);

	it("uses the only account, or the account of --account-id, and asks when there are more", async () => {
		expect(await signIn(fakeContext(), signedIn([rivus]))).toEqual(rivus);
		expect(await signIn(fakeContext(), signedIn([rivus, wing]), { accountId: "Wingswap" })).toEqual(wing);
		expect(await signIn(fakeContext({ prompt: scripted([1]) }), signedIn([rivus, wing]))).toEqual(wing);
		await expect(signIn(fakeContext(), signedIn([rivus, wing]))).rejects.toThrow(/--account-id/);
		await expect(signIn(fakeContext(), signedIn([rivus]), { accountId: "Other" })).rejects.toThrow(
			/no account "Other"/,
		);
	});

	// A CI token can have no right to read its user, so `wrangler whoami` fails with a token that works.
	it("does not call whoami with CLOUDFLARE_API_TOKEN and an account id", async () => {
		const wrangler = fakeWrangler(() => ({ code: 1 }));
		const env = { CLOUDFLARE_API_TOKEN: "token", CLOUDFLARE_ACCOUNT_ID: rivus.id };
		expect(await signIn(fakeContext({ env }), wrangler)).toEqual({ id: rivus.id, name: rivus.id });
		const flag = await signIn(fakeContext({ env: { CLOUDFLARE_API_TOKEN: "token" } }), wrangler, {
			accountId: wing.id,
		});
		expect(flag.id).toBe(wing.id);
		expect(wrangler.calls).toEqual([]);
	});

	it("shows the error of wrangler when the token does not work and the account is a name", async () => {
		const wrangler = fakeWrangler(() => ({ code: 1, stderr: "\nAuthentication error [code: 10000]\n\n" }));
		const env = { CLOUDFLARE_API_TOKEN: "token", CLOUDFLARE_ACCOUNT_ID: "Rivus" };
		await expect(signIn(fakeContext({ env }), wrangler)).rejects.toThrow(
			/cannot sign in with CLOUDFLARE_API_TOKEN[\s\S]*Authentication error \[code: 10000\]/,
		);
	});

	it("signs in with the browser, or with a code over SSH, and never without a terminal", async () => {
		const loggedOut = () => {
			let loggedIn = false;
			return fakeWrangler((args) => {
				if (starts(args, "login")) loggedIn = true;
				if (starts(args, "whoami"))
					return loggedIn
						? { stdout: JSON.stringify({ loggedIn, accounts: [rivus] }) }
						: { code: 1, stdout: JSON.stringify({ loggedIn: false }) };
				return undefined;
			});
		};
		await expect(signIn(fakeContext(), loggedOut())).rejects.toThrow(/wrangler login/);

		const browser = loggedOut();
		await signIn(fakeContext({ prompt: scripted([true]) }), browser);
		expect(browser.calls.find((call) => starts(call.args, "login"))).toEqual({
			args: ["login"],
			options: { stdio: "terminal" },
		});

		const ssh = loggedOut();
		await signIn(fakeContext({ prompt: scripted([true]), env: { SSH_CONNECTION: "1" } }), ssh);
		expect(ssh.calls.find((call) => starts(call.args, "login"))?.args).toEqual(["login", "--device"]);
	});

	it("gives the account to each wrangler command", async () => {
		const wrangler = fakeWrangler(() => undefined);
		await inAccount(wrangler, rivus.id).run(["d1", "list"], { env: { X: "1" } });
		expect(wrangler.calls[0]?.options.env).toEqual({ X: "1", CLOUDFLARE_ACCOUNT_ID: rivus.id });
	});
});
