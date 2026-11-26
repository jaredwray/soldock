import { describe, expect, it } from "vitest";
import { inAccount, signIn } from "../src/auth.ts";
import { Refusal } from "../src/errors.ts";
import { cacheDir, ensureWrangler, findWrangler, isCompatible, type WranglerCommand } from "../src/wrangler.ts";
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

describe("finding wrangler", () => {
	const onPath = (version: string | null) => (command: WranglerCommand) =>
		command.command === "wrangler" ? version : "4.149.0";

	it("uses a compatible wrangler on PATH, then the cache, and else finds none", () => {
		expect(findWrangler("4.149.0", "/cache", onPath("4.150.0"), () => true)?.command.command).toBe("wrangler");
		const cached = findWrangler("4.149.0", "/cache", onPath("3.0.0"), () => true);
		expect(cached?.command.args[0]).toBe("/cache/wrangler-4.149.0/node_modules/wrangler/bin/wrangler.js");
		expect(findWrangler("4.149.0", "/cache", onPath(null), () => false)).toBeNull();
	});

	it("installs the tested version into the cache only when the operator agrees", async () => {
		const installs: string[] = [];
		let installed = false;
		const deps = {
			probe: (command: WranglerCommand) => (command.command === "wrangler" ? null : "4.149.0"),
			fileExists: () => installed,
			install: async (dir: string) => {
				installs.push(dir);
				installed = true;
				return true;
			},
		};
		const env = { ASTERRA_CACHE_DIR: "/cache" };
		await expect(ensureWrangler(fakeContext({ env, prompt: scripted([false]) }), "4.149.0", deps)).rejects.toThrow(
			Refusal,
		);
		expect(installs).toEqual([]);
		const wrangler = await ensureWrangler(fakeContext({ env, prompt: scripted([true]) }), "4.149.0", deps);
		expect(installs).toEqual(["/cache/wrangler-4.149.0"]);
		expect(wrangler.version).toBe("4.149.0");
	});

	it.each([
		[{ ASTERRA_CACHE_DIR: "/x" }, "linux", "/x"],
		[{ XDG_CACHE_HOME: "/xdg" }, "linux", "/xdg/asterra"],
		[{}, "linux", "/home/op/.cache/asterra"],
		[{}, "darwin", "/home/op/Library/Caches/asterra"],
	] as const)("keeps the cache in the folder of the platform (%o, %s)", (env, platform, dir) => {
		expect(cacheDir(env, platform, "/home/op")).toBe(dir);
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

	it("signs in with the browser, or with a code over SSH, and never without a terminal", async () => {
		const loggedOut = () => {
			let loggedIn = false;
			return fakeWrangler((args) => {
				if (starts(args, "login")) loggedIn = true;
				if (starts(args, "whoami"))
					return loggedIn ? { stdout: JSON.stringify({ loggedIn, accounts: [rivus] }) } : { code: 1 };
				return undefined;
			});
		};
		await expect(signIn(fakeContext(), loggedOut())).rejects.toThrow(/wrangler login/);

		const browser = loggedOut();
		await signIn(fakeContext({ prompt: scripted([true]) }), browser);
		expect(browser.calls.find((call) => starts(call.args, "login"))).toEqual({
			args: ["login"],
			options: { terminal: true },
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
