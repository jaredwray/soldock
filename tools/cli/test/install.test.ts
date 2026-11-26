import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { install } from "../src/commands/install.ts";
import { Refusal } from "../src/errors.ts";
import type { Flags } from "../src/session.ts";
import { commands, fakeCloud, fakeContext, fixtureBundle, healthyWorker, scripted } from "./fakes.ts";

const ORIGIN = "https://work.rivus.com";
const bundle = fixtureBundle();
const flags = (more: Partial<Flags> = {}): Flags => ({
	yes: true,
	rollback: true,
	bundle,
	name: "rivus",
	hostname: "work.rivus.com",
	...more,
});
const secretsFile = () => join(mkdtempSync(join(tmpdir(), "asterra-secrets-")), "secrets.env");

/** The Worker of the fake host: POST /auth/setup and /auth/setup/verify. */
function setupApi(verifyAnswers: string[] = ["has_accounts"]) {
	const requests: { url: string; init: RequestInit }[] = [];
	const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
		const url = String(input);
		requests.push({ url, init });
		if (url === `${ORIGIN}/auth/setup`) {
			return Response.json({ api_key: { secret: "sdk_owner_key" } }, { status: 201 });
		}
		if (url === `${ORIGIN}/auth/setup/verify`)
			return Response.json({ directory: verifyAnswers.shift() ?? "has_accounts" });
		throw new Error(`unexpected fetch ${url}`);
	};
	return { requests, fetch: fetch as typeof globalThis.fetch };
}

describe("install", () => {
	it("deploys, migrates, sets the secrets, creates the owner in the terminal, and deletes SETUP_TOKEN", async () => {
		const cloud = fakeCloud();
		const api = setupApi();
		const out = secretsFile();
		const ctx = fakeContext({
			httpGet: healthyWorker(ORIGIN),
			fetch: api.fetch,
			env: { ASTERRA_OWNER_PASSWORD: "a-long-password" },
		});
		await install(ctx, flags({ secretsOut: out, ownerName: "Olive Owner", ownerAddress: "olive@rivus.com" }), {
			wrangler: async () => cloud,
		});

		// The database exists only after the deploy, so the migrations come after it.
		expect(commands(cloud)).toEqual([
			"whoami --json",
			"d1 list",
			"deploy --config",
			"d1 migrations",
			"secret bulk",
			"secret bulk",
		]);
		expect(cloud.state.deployed[0]).toMatchObject({
			name: "asterra-rivus",
			routes: [{ pattern: "work.rivus.com", custom_domain: true }],
			d1_databases: [{ database_name: "asterra-rivus-directory" }],
		});

		const [set, cleared] = cloud.state.bulk;
		expect(set?.SETUP_TOKEN).toMatch(/^[0-9a-f]{64}$/);
		expect(set?.ENCRYPTION_KEY).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(cleared).toEqual({ SETUP_TOKEN: null });
		// Secret values go on stdin only: never in an argument, and never on the terminal of a run without questions.
		const values = [String(set?.SETUP_TOKEN), String(set?.ENCRYPTION_KEY)];
		for (const call of cloud.calls) for (const value of values) expect(call.args.join(" ")).not.toContain(value);
		for (const value of values) expect(ctx.output() + ctx.errors()).not.toContain(value);

		const setup = api.requests.find((request) => request.url === `${ORIGIN}/auth/setup`);
		expect(setup?.init.headers).toMatchObject({ authorization: `Bearer ${set?.SETUP_TOKEN}` });
		expect(JSON.parse(String(setup?.init.body))).toEqual({
			mail_domain: "rivus.com",
			display_name: "Olive Owner",
			address: "olive@rivus.com",
			password: "a-long-password",
		});
		expect(ctx.output()).toContain("sdk_owner_key");

		// The key reaches the operator in a new file that only the operator can read.
		expect(readFileSync(out, "utf8")).toBe(`ENCRYPTION_KEY=${set?.ENCRYPTION_KEY}\n`);
		expect(statSync(out).mode & 0o777).toBe(0o600);
	});

	it("waits for the owner in the browser, and then deletes SETUP_TOKEN", async () => {
		const cloud = fakeCloud();
		const api = setupApi(["empty", "empty", "has_accounts"]);
		const prompt = scripted([true, false]);
		const ctx = fakeContext({ httpGet: healthyWorker(ORIGIN), fetch: api.fetch, prompt });
		await install(ctx, flags({ yes: false }), { wrangler: async () => cloud });

		expect(prompt.asked).toEqual(["Install?", "Create the owner here in the terminal? (No: in the browser)"]);
		const token = String(cloud.state.bulk[0]?.SETUP_TOKEN);
		expect(ctx.output().split(token)).toHaveLength(2);
		expect(api.requests.filter((request) => request.url.endsWith("/verify"))).toHaveLength(3);
		expect(cloud.state.bulk.at(-1)).toEqual({ SETUP_TOKEN: null });
		expect(cloud.state.secrets).toEqual(["ENCRYPTION_KEY"]);
	});

	it("refuses an instance that exists, before it changes anything", async () => {
		const cloud = fakeCloud({ databases: ["asterra-rivus-directory"] });
		const run = install(fakeContext(), flags({ secretsOut: secretsFile() }), { wrangler: async () => cloud });
		await expect(run).rejects.toThrow(/npx asterra upgrade --name rivus/);
		expect(commands(cloud)).toEqual(["whoami --json", "d1 list"]);
	});

	it("needs --secrets-out in a run without questions, before it signs in", async () => {
		const cloud = fakeCloud();
		await expect(install(fakeContext(), flags(), { wrangler: async () => cloud })).rejects.toThrow(Refusal);
		expect(cloud.calls).toEqual([]);
	});
});
