import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { upgrade } from "../src/commands/upgrade.ts";
import type { HttpResponse } from "../src/http.ts";
import type { Flags } from "../src/session.ts";
import { commands, fakeCloud, fakeContext, fixtureBundle, healthyWorker, scripted, starts } from "./fakes.ts";

const ORIGIN = "https://work.rivus.com";
const bundle = fixtureBundle();
const flags = (more: Partial<Flags> = {}): Flags => ({ yes: true, rollback: true, bundle, ...more });
/** The instance "rivus" on release 0.2.0. Its deploy stored the host. */
const rivus = (more = {}) =>
	fakeCloud({
		databases: ["asterra-rivus-directory"],
		applied: ["0001_a.sql"],
		workers: {
			"asterra-rivus": [
				{ id: "version-old", tag: "asterra-0.2.0", secrets: ["ENCRYPTION_KEY"], hostname: "work.rivus.com" },
			],
		},
		...more,
	});
const releases = (async () =>
	Response.json([
		{ tag_name: "v0.3.0", body: "Calendar." },
		{ tag_name: "v0.2.0", body: "Older." },
		{ tag_name: "v0.4.0", body: "Newer." },
	])) as unknown as typeof fetch;
const broken: Record<string, HttpResponse> = { "/mail": { status: 404, contentType: "text/plain", body: "" } };
const githubOutputFile = () => {
	const output = join(mkdtempSync(join(tmpdir(), "asterra-gh-")), "output");
	writeFileSync(output, "");
	return output;
};

describe("upgrade", () => {
	it("applies the pending migrations before the deploy, on the stored host, and shows the notes of the newer releases", async () => {
		const cloud = rivus();
		const prompt = scripted([true]);
		const ctx = fakeContext({ httpGet: healthyWorker(ORIGIN), fetch: releases, prompt });
		await upgrade(ctx, flags({ yes: false }), { wrangler: async () => cloud });

		expect(commands(cloud)).toEqual([
			"whoami --json",
			"d1 list",
			"deployments status",
			"versions view",
			"d1 execute",
			"d1 migrations",
			"deploy --config",
			"secret list",
		]);
		// The host comes from the instance: no flag, and no question.
		expect(prompt.asked).toEqual(["Upgrade?"]);
		expect(cloud.state.deployed[0]).toMatchObject({ name: "asterra-rivus", routes: [{ pattern: "work.rivus.com" }] });
		expect(cloud.liveVersion("asterra-rivus")?.tag).toBe("asterra-0.3.0");
		expect(ctx.output()).toContain("Calendar.");
		expect(ctx.output()).not.toContain("Older.");
		expect(ctx.output()).not.toContain("Newer.");
	});

	it("shows only the link to the release notes in a run without questions, and does not call GitHub", async () => {
		const ctx = fakeContext({ httpGet: healthyWorker(ORIGIN) });
		// The fetch of this context fails the test when a command calls it.
		await upgrade(ctx, flags(), { wrangler: async () => rivus() });
		expect(ctx.output()).toContain("Release notes: https://github.com/jaredwray/soldock/releases/tag/v0.3.0\n");
	});

	it("does not run the migrations when none is pending", async () => {
		const cloud = rivus({ applied: ["0001_a.sql", "0002_b.sql", "0003_c.sql"] });
		await upgrade(fakeContext({ httpGet: healthyWorker(ORIGIN) }), flags(), { wrangler: async () => cloud });
		expect(commands(cloud)).not.toContain("d1 migrations");
		expect(commands(cloud)).toContain("deploy --config");
	});

	// wrangler makes the table `d1_migrations` with the first migration.
	it("applies each migration to a database that has no migrations table", async () => {
		const cloud = rivus({ applied: null });
		const ctx = fakeContext({ httpGet: healthyWorker(ORIGIN) });
		await upgrade(ctx, flags(), { wrangler: async () => cloud });
		expect(ctx.output()).toContain("Migrations to apply: 0001_a.sql, 0002_b.sql, 0003_c.sql");
		expect(commands(cloud)).toContain("d1 migrations");
	});

	it("refuses a downgrade before it changes anything", async () => {
		const cloud = rivus({ applied: ["0001_a.sql", "0004_d.sql"] });
		const run = upgrade(fakeContext(), flags(), { wrangler: async () => cloud });
		await expect(run).rejects.toThrow(/0004_d\.sql/);
		expect(commands(cloud)).not.toContain("d1 migrations");
		expect(commands(cloud)).not.toContain("deploy --config");
	});

	it("refuses a database without min_applied_migration before it changes anything", async () => {
		const cloud = rivus();
		const strict = fixtureBundle(["0001_a.sql", "0002_b.sql", "0003_c.sql"], "0002_b.sql");
		const run = upgrade(fakeContext(), flags({ bundle: strict }), { wrangler: async () => cloud });
		await expect(run).rejects.toThrow(/needs the migration 0002_b\.sql.*earlier release first/);
		expect(commands(cloud)).not.toContain("d1 migrations");
		expect(commands(cloud)).not.toContain("deploy --config");
	});

	it("rolls back to the version from before the upgrade when the smoke check fails, unless --no-rollback", async () => {
		const cloud = rivus();
		const output = githubOutputFile();
		const ctx = fakeContext({ httpGet: healthyWorker(ORIGIN, broken), env: { GITHUB_OUTPUT: output } });
		await expect(upgrade(ctx, flags(), { wrangler: async () => cloud })).rejects.toThrow(
			/back on the version version-old/,
		);
		expect(cloud.calls.at(-1)?.args).toEqual([
			"rollback",
			"version-old",
			"--name",
			"asterra-rivus",
			"--message",
			"Smoke check of Asterra 0.3.0 failed",
			"--yes",
		]);
		expect(readFileSync(output, "utf8")).toBe(`url=${ORIGIN}\nversion=version-1\nresult=rolled_back\n`);

		const kept = rivus();
		const keptOutput = githubOutputFile();
		const run = upgrade(
			fakeContext({ httpGet: healthyWorker(ORIGIN, broken), env: { GITHUB_OUTPUT: keptOutput } }),
			flags({ rollback: false }),
			{ wrangler: async () => kept },
		);
		await expect(run).rejects.toThrow(/The new version stays/);
		expect(commands(kept)).not.toContain("rollback version-old");
		expect(readFileSync(keptOutput, "utf8")).toBe(`url=${ORIGIN}\nversion=version-1\nresult=failed\n`);
	});

	// The job summary of the development deploy shows `result`. It must not show a rollback that failed.
	it("tells that the new version stays when the rollback fails", async () => {
		const cloud = rivus({
			fail: (args: string[]) => (starts(args, "rollback") ? { code: 1 } : undefined),
		});
		const output = githubOutputFile();
		const ctx = fakeContext({ httpGet: healthyWorker(ORIGIN, broken), env: { GITHUB_OUTPUT: output } });
		await expect(upgrade(ctx, flags(), { wrangler: async () => cloud })).rejects.toThrow(
			/the rollback to the version version-old failed too\. The new version stays/,
		);
		expect(readFileSync(output, "utf8")).toBe(`url=${ORIGIN}\nversion=version-1\nresult=failed\n`);
	});

	it("stops when wrangler gives no version id for the deploy", async () => {
		const cloud = rivus({ deployEntry: false });
		const output = githubOutputFile();
		const ctx = fakeContext({ httpGet: healthyWorker(ORIGIN), env: { GITHUB_OUTPUT: output } });
		await expect(upgrade(ctx, flags(), { wrangler: async () => cloud })).rejects.toThrow(/no deploy entry/);
		expect(readFileSync(output, "utf8")).toBe(`url=${ORIGIN}\nresult=failed\n`);
	});

	it("gives the URL, the version and the result to a GitHub Actions workflow", async () => {
		const output = githubOutputFile();
		const ctx = fakeContext({ httpGet: healthyWorker(ORIGIN), env: { GITHUB_OUTPUT: output } });
		await upgrade(ctx, flags(), { wrangler: async () => rivus() });
		expect(readFileSync(output, "utf8")).toBe(`url=${ORIGIN}\nversion=version-1\nresult=passed\n`);
	});

	// The deploy attaches the host as a custom domain, and takes it from the Worker that has it.
	it("refuses a --hostname that is not the host of the instance, also with --yes, unless --change-hostname", async () => {
		const cloud = rivus();
		const run = upgrade(fakeContext(), flags({ hostname: "mail.wingswap.com" }), { wrangler: async () => cloud });
		await expect(run).rejects.toThrow(/the host of the instance is work\.rivus\.com.*--change-hostname/);
		expect(commands(cloud)).not.toContain("d1 migrations");
		expect(commands(cloud)).not.toContain("deploy --config");

		const moved = rivus();
		const ctx = fakeContext({ httpGet: healthyWorker("https://new.rivus.com") });
		await upgrade(ctx, flags({ hostname: "new.rivus.com", changeHostname: true }), { wrangler: async () => moved });
		expect(moved.liveVersion("asterra-rivus")?.hostname).toBe("new.rivus.com");
	});

	// The development instance keeps its names: its data is in them.
	describe("the instance from before the CLI", () => {
		const legacy = () =>
			fakeCloud({
				databases: ["soldock-directory"],
				applied: ["0001_a.sql"],
				workers: { "soldock-dock-dev": [{ id: "version-old", secrets: ["ENCRYPTION_KEY"] }] },
			});
		const named = { prefix: "soldock", workerName: "soldock-dock-dev" };

		it("needs its prefix and its Worker name", async () => {
			const run = upgrade(fakeContext(), flags({ hostname: "work.soldock.org" }), { wrangler: async () => legacy() });
			await expect(run).rejects.toThrow(/--prefix soldock --worker-name/);
		});

		it("needs --hostname until a deploy stores the host, and then upgrades without it", async () => {
			const cloud = legacy();
			const first = upgrade(fakeContext(), flags(named), { wrangler: async () => cloud });
			await expect(first).rejects.toThrow(/--hostname/);
			expect(commands(cloud)).not.toContain("deploy --config");

			const ctx = () => fakeContext({ httpGet: healthyWorker("https://work.soldock.org") });
			await upgrade(ctx(), flags({ ...named, hostname: "work.soldock.org" }), { wrangler: async () => cloud });
			expect(cloud.state.deployed[0]).toMatchObject({
				name: "soldock-dock-dev",
				routes: [{ pattern: "work.soldock.org", custom_domain: true }],
				d1_databases: [{ database_name: "soldock-directory" }],
				r2_buckets: [{ bucket_name: "soldock-blobs" }],
				vars: { ASTERRA_HOSTNAME: "work.soldock.org" },
			});

			await upgrade(ctx(), flags(named), { wrangler: async () => cloud });
			expect(cloud.state.deployed[1]).toMatchObject({ routes: [{ pattern: "work.soldock.org" }] });

			// The development workflow gives --hostname in each run. The stored host is the same, so the run passes.
			await upgrade(ctx(), flags({ ...named, hostname: "work.soldock.org" }), { wrangler: async () => cloud });
			expect(cloud.state.deployed).toHaveLength(3);
		});
	});

	// One flag set names one instance. A mix could deploy the resources of an instance onto a different Worker.
	it.each([
		[{ name: "rivus", workerName: "asterra-wing" }, /Do not give --worker-name with --name/],
		[{ name: "rivus", prefix: "soldock", workerName: "soldock-dock-dev" }, /not the two/],
		[{ workerName: "asterra-wing" }, /--worker-name needs --prefix/],
		[{ prefix: "soldock" }, /--prefix needs --worker-name/],
		[{ prefix: "asterra-wing", workerName: "asterra-rivus" }, /use --name wing/],
		[{ prefix: "soldock", workerName: "asterra-rivus" }, /is the Worker of an instance of the CLI/],
	] as const)("refuses the flags %o", async (mix, message) => {
		const cloud = rivus({ databases: ["asterra-rivus-directory", "asterra-wing-directory", "soldock-directory"] });
		const run = upgrade(fakeContext(), flags({ hostname: "work.rivus.com", ...mix }), { wrangler: async () => cloud });
		await expect(run).rejects.toThrow(message);
		expect(commands(cloud)).toEqual(["whoami --json"]);
	});

	it("asks which instance when the account has more than one, and needs --name without questions", async () => {
		const two = () =>
			rivus({
				databases: ["asterra-rivus-directory", "asterra-wing-directory"],
				workers: {
					"asterra-rivus": [{ id: "r", hostname: "work.rivus.com" }],
					"asterra-wing": [{ id: "w", hostname: "work.rivus.com" }],
				},
			});
		await expect(upgrade(fakeContext(), flags(), { wrangler: async () => two() })).rejects.toThrow(/--name/);
		const cloud = two();
		const ctx = fakeContext({ httpGet: healthyWorker(ORIGIN), fetch: releases, prompt: scripted([1, true, false]) });
		await upgrade(ctx, flags({ yes: false }), { wrangler: async () => cloud });
		expect(cloud.state.deployed[0]?.name).toBe("asterra-wing");
	});

	// A failure of wrangler does not tell that the Worker has no deployment.
	it("shows the error of wrangler when it cannot read the deployment", async () => {
		const cloud = rivus({
			fail: (args: string[]) =>
				starts(args, "deployments", "status")
					? {
							code: 1,
							stderr: "✘ [ERROR] A request to the Cloudflare API failed.\n  Authentication error [code: 10000]\n",
						}
					: undefined,
		});
		const run = upgrade(fakeContext(), flags({ name: "rivus" }), { wrangler: async () => cloud });
		await expect(run).rejects.toThrow(/Authentication error \[code: 10000\]/);
		await expect(upgrade(fakeContext(), flags({ name: "wing" }), { wrangler: async () => rivus() })).rejects.toThrow(
			/The Worker asterra-wing has no deployment/,
		);
	});

	describe("a missing ENCRYPTION_KEY", () => {
		const without = () => rivus({ workers: { "asterra-rivus": [{ id: "version-old", hostname: "work.rivus.com" }] } });

		it("gives a warning in a run without questions", async () => {
			const quiet = without();
			const ctx = fakeContext({ httpGet: healthyWorker(ORIGIN) });
			await upgrade(ctx, flags(), { wrangler: async () => quiet });
			expect(ctx.errors()).toContain("has no ENCRYPTION_KEY");
			expect(quiet.state.bulk).toEqual([]);
		});

		it("makes the key when the operator agrees, and shows it one time", async () => {
			const asked = without();
			const prompt = scripted([true, true]);
			const ctx = fakeContext({ httpGet: healthyWorker(ORIGIN), fetch: releases, prompt });
			await upgrade(ctx, flags({ yes: false }), { wrangler: async () => asked });
			const key = String(asked.state.bulk[0]?.ENCRYPTION_KEY);
			expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
			expect(ctx.output().split(key)).toHaveLength(2);
		});

		it("makes the secrets file before the deploy, so a path that does not work stops the run", async () => {
			const cloud = without();
			const out = join(mkdtempSync(join(tmpdir(), "asterra-secrets-")), "secrets.env");
			writeFileSync(out, "kept\n");
			const ctx = fakeContext({ prompt: scripted([]) });
			const run = upgrade(ctx, flags({ yes: false, secretsOut: out }), { wrangler: async () => cloud });
			await expect(run).rejects.toThrow(/Cannot make the file/);
			expect(cloud.calls).toEqual([]);
		});
	});
});
