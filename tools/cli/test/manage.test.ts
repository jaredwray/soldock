import { describe, expect, it } from "vitest";
import { rollback, secrets, status } from "../src/commands/manage.ts";
import { compareVersions, showReleaseNotes } from "../src/notes.ts";
import type { Flags } from "../src/session.ts";
import { fakeCloud, fakeContext, fixtureBundle } from "./fakes.ts";

const bundle = fixtureBundle();
const flags = (more: Partial<Flags> = {}): Flags => ({ yes: true, rollback: true, bundle, name: "rivus", ...more });
const rivus = (more = {}) =>
	fakeCloud({
		databases: ["asterra-rivus-directory"],
		applied: ["0001_a.sql"],
		versions: { "asterra-rivus": { id: "version-old", tag: "asterra-0.2.0" } },
		...more,
	});

describe("status", () => {
	it("shows the version and the pending migrations, and warns about a SETUP_TOKEN and a missing ENCRYPTION_KEY", async () => {
		const ctx = fakeContext();
		await status(ctx, flags(), { wrangler: async () => rivus({ secrets: ["SETUP_TOKEN"] }) });
		expect(ctx.output()).toContain("0.2.0 (Worker version version-old)");
		expect(ctx.output()).toContain("0.3.0: 2 migrations to apply");
		expect(ctx.errors()).toContain("no ENCRYPTION_KEY");
		expect(ctx.errors()).toContain("SETUP_TOKEN exists");
	});
});

describe("rollback", () => {
	it("sends the traffic back to the version before, and keeps the migrations", async () => {
		const cloud = rivus();
		await rollback(fakeContext(), flags(), { wrangler: async () => cloud });
		expect(cloud.calls.at(-1)?.args).toEqual([
			"rollback",
			"--name",
			"asterra-rivus",
			"--message",
			"npx asterra rollback",
			"--yes",
		]);
	});
});

describe("secrets", () => {
	it("deletes SETUP_TOKEN, and makes a new one only with a place for its value", async () => {
		const cloud = rivus({ secrets: ["SETUP_TOKEN", "ENCRYPTION_KEY"] });
		await secrets(fakeContext(), flags(), { wrangler: async () => cloud }, "clear-setup-token");
		expect(cloud.state.bulk).toEqual([{ SETUP_TOKEN: null }]);
		expect(cloud.state.secrets).toEqual(["ENCRYPTION_KEY"]);

		const untouched = rivus();
		const run = secrets(fakeContext(), flags(), { wrangler: async () => untouched }, "setup-token");
		await expect(run).rejects.toThrow(/--secrets-out/);
		expect(untouched.calls).toEqual([]);
	});
});

describe("release notes", () => {
	const releases = (async () =>
		Response.json([
			{ tag_name: "v0.10.0", body: "Ten." },
			{ tag_name: "v0.9.0", body: "Nine." },
			{ tag_name: "v0.8.0", body: "Eight." },
			{ tag_name: "v0.11.0", body: "Eleven.", draft: true },
		])) as unknown as typeof fetch;

	it("compares versions by number, not as text", () => {
		expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
		expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
	});

	it("shows the notes after the running version up to the target, in order, and else the link", async () => {
		const ctx = fakeContext({ fetch: releases });
		await showReleaseNotes(ctx, "0.8.0", "0.10.0");
		expect(ctx.output()).toMatch(/Nine\.[\s\S]*Ten\./);
		expect(ctx.output()).not.toContain("Eight.");

		const offline = fakeContext();
		await showReleaseNotes(offline, null, "0.10.0");
		expect(offline.output()).toBe("Release notes: https://github.com/jaredwray/soldock/releases/tag/v0.10.0\n");
	});
});
