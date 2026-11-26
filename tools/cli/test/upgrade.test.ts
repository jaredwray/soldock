import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { upgrade } from "../src/commands/upgrade.ts";
import type { HttpResponse } from "../src/http.ts";
import type { Flags } from "../src/session.ts";
import { commands, fakeCloud, fakeContext, fixtureBundle, healthyWorker, scripted } from "./fakes.ts";

const ORIGIN = "https://work.rivus.com";
const bundle = fixtureBundle();
const flags = (more: Partial<Flags> = {}): Flags => ({
	yes: true,
	rollback: true,
	bundle,
	hostname: "work.rivus.com",
	...more,
});
const rivus = (more = {}) =>
	fakeCloud({
		databases: ["asterra-rivus-directory"],
		applied: ["0001_a.sql"],
		secrets: ["ENCRYPTION_KEY"],
		versions: { "asterra-rivus": { id: "version-old", tag: "asterra-0.2.0" } },
		...more,
	});
const releases = (async () =>
	Response.json([
		{ tag_name: "v0.3.0", body: "Calendar." },
		{ tag_name: "v0.2.0", body: "Older." },
		{ tag_name: "v0.4.0", body: "Newer." },
	])) as unknown as typeof fetch;
const broken: Record<string, HttpResponse> = { "/mail": { status: 404, contentType: "text/plain", body: "" } };

describe("upgrade", () => {
	it("applies the pending migrations before the deploy, and shows the notes of the newer releases", async () => {
		const cloud = rivus();
		const ctx = fakeContext({ httpGet: healthyWorker(ORIGIN), fetch: releases });
		await upgrade(ctx, flags(), { wrangler: async () => cloud });

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
		expect(cloud.state.deployed[0]).toMatchObject({ name: "asterra-rivus", routes: [{ pattern: "work.rivus.com" }] });
		expect(cloud.state.versions["asterra-rivus"]?.tag).toBe("asterra-0.3.0");
		expect(ctx.output()).toContain("Calendar.");
		expect(ctx.output()).not.toContain("Older.");
		expect(ctx.output()).not.toContain("Newer.");
	});

	it("does not run the migrations when none is pending", async () => {
		const cloud = rivus({ applied: ["0001_a.sql", "0002_b.sql", "0003_c.sql"] });
		await upgrade(fakeContext({ httpGet: healthyWorker(ORIGIN), fetch: releases }), flags(), {
			wrangler: async () => cloud,
		});
		expect(commands(cloud)).not.toContain("d1 migrations");
		expect(commands(cloud)).toContain("deploy --config");
	});

	it("refuses a downgrade before it changes anything", async () => {
		const cloud = rivus({ applied: ["0001_a.sql", "0004_d.sql"] });
		const run = upgrade(fakeContext({ fetch: releases }), flags(), { wrangler: async () => cloud });
		await expect(run).rejects.toThrow(/0004_d\.sql/);
		expect(commands(cloud)).not.toContain("d1 migrations");
		expect(commands(cloud)).not.toContain("deploy --config");
	});

	it("rolls back to the version from before the upgrade when the smoke check fails, unless --no-rollback", async () => {
		const cloud = rivus();
		const ctx = fakeContext({ httpGet: healthyWorker(ORIGIN, broken), fetch: releases });
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

		const kept = rivus();
		const run = upgrade(
			fakeContext({ httpGet: healthyWorker(ORIGIN, broken), fetch: releases }),
			flags({ rollback: false }),
			{
				wrangler: async () => kept,
			},
		);
		await expect(run).rejects.toThrow(/The new version stays/);
		expect(commands(kept)).not.toContain("rollback version-old");
	});

	// The development instance keeps its names: its data is in them.
	it("upgrades the instance from before the CLI only with its Worker name", async () => {
		const legacy = () =>
			fakeCloud({
				databases: ["soldock-directory"],
				applied: ["0001_a.sql"],
				secrets: ["ENCRYPTION_KEY"],
				versions: { "soldock-dock-dev": { id: "version-old" } },
			});
		await expect(
			upgrade(fakeContext({ fetch: releases }), flags(), { wrangler: async () => legacy() }),
		).rejects.toThrow(/--worker-name/);

		const cloud = legacy();
		const ctx = fakeContext({ httpGet: healthyWorker("https://work.soldock.org"), fetch: releases });
		await upgrade(ctx, flags({ prefix: "soldock", workerName: "soldock-dock-dev", hostname: "work.soldock.org" }), {
			wrangler: async () => cloud,
		});
		expect(cloud.state.deployed[0]).toMatchObject({
			name: "soldock-dock-dev",
			d1_databases: [{ database_name: "soldock-directory" }],
			r2_buckets: [{ bucket_name: "soldock-blobs" }],
		});
	});

	it("asks which instance when the account has more than one, and needs --name without questions", async () => {
		const two = () =>
			rivus({
				databases: ["asterra-rivus-directory", "asterra-wing-directory"],
				versions: { "asterra-rivus": { id: "r" }, "asterra-wing": { id: "w" } },
			});
		await expect(upgrade(fakeContext({ fetch: releases }), flags(), { wrangler: async () => two() })).rejects.toThrow(
			/--name/,
		);
		const cloud = two();
		const ctx = fakeContext({ httpGet: healthyWorker(ORIGIN), fetch: releases, prompt: scripted([1, true]) });
		await upgrade(ctx, flags({ yes: false }), { wrangler: async () => cloud });
		expect(cloud.state.deployed[0]?.name).toBe("asterra-wing");
	});

	it("warns about a missing ENCRYPTION_KEY without questions, and makes one when the operator agrees", async () => {
		const quiet = rivus({ secrets: [] });
		const ctx = fakeContext({ httpGet: healthyWorker(ORIGIN), fetch: releases });
		await upgrade(ctx, flags(), { wrangler: async () => quiet });
		expect(ctx.errors()).toContain("has no ENCRYPTION_KEY");
		expect(quiet.state.bulk).toEqual([]);

		const asked = rivus({ secrets: [] });
		const interactive = fakeContext({
			httpGet: healthyWorker(ORIGIN),
			fetch: releases,
			prompt: scripted([true, true]),
		});
		await upgrade(interactive, flags({ yes: false }), { wrangler: async () => asked });
		const key = String(asked.state.bulk[0]?.ENCRYPTION_KEY);
		expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(interactive.output()).toContain(key);
	});

	it("gives the URL and the version to a GitHub Actions workflow", async () => {
		const output = join(mkdtempSync(join(tmpdir(), "asterra-gh-")), "output");
		writeFileSync(output, "");
		const ctx = fakeContext({ httpGet: healthyWorker(ORIGIN), fetch: releases, env: { GITHUB_OUTPUT: output } });
		await upgrade(ctx, flags(), { wrangler: async () => rivus() });
		expect(readFileSync(output, "utf8")).toBe(`url=${ORIGIN}\nversion=version-1\n`);
	});
});
