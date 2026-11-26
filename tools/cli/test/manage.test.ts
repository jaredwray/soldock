import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rollback, secrets, status } from "../src/commands/manage.ts";
import { compareVersions, showReleaseNotes } from "../src/notes.ts";
import type { Flags } from "../src/session.ts";
import { commands, type FakeVersion, fakeCloud, fakeContext, fixtureBundle, scripted } from "./fakes.ts";

const bundle = fixtureBundle();
const flags = (more: Partial<Flags> = {}): Flags => ({ yes: true, rollback: true, bundle, name: "rivus", ...more });
const rivus = (versions: FakeVersion[], more = {}) =>
	fakeCloud({
		databases: ["asterra-rivus-directory"],
		applied: ["0001_a.sql"],
		workers: { "asterra-rivus": versions },
		...more,
	});
const KEY = ["ENCRYPTION_KEY"];

describe("status", () => {
	it("shows the release of the running version after a secret change, and the pending migrations", async () => {
		const ctx = fakeContext();
		// The secret change made a new version. Its release is the release of the deploy before it.
		const cloud = rivus([
			{ id: "deploy-2", tag: "asterra-0.2.0", hostname: "work.rivus.com" },
			{ id: "secrets-2", secretChange: true, secrets: ["SETUP_TOKEN"], hostname: "work.rivus.com" },
		]);
		await status(ctx, flags(), { wrangler: async () => cloud });
		expect(ctx.output()).toContain("0.2.0 (Worker version secrets-2)");
		expect(ctx.output()).toContain("Host       work.rivus.com");
		expect(ctx.output()).toContain("0.3.0: 2 migrations to apply");
		expect(ctx.errors()).toContain("no ENCRYPTION_KEY");
		expect(ctx.errors()).toContain("SETUP_TOKEN exists");
	});
});

describe("rollback", () => {
	// wrangler goes to the deployment before by default. After `install`, that deployment has the same
	// release with SETUP_TOKEN, and the deployment before it has no ENCRYPTION_KEY.
	it("goes to the release before, not to the version before a secret change", async () => {
		const cloud = rivus([
			{ id: "deploy-2", tag: "asterra-0.2.0", secrets: KEY },
			{ id: "deploy-3", tag: "asterra-0.3.0", secrets: KEY },
			{ id: "set-3", secretChange: true, secrets: [...KEY, "SETUP_TOKEN"] },
			{ id: "clear-3", secretChange: true, secrets: KEY },
		]);
		const ctx = fakeContext();
		await rollback(ctx, flags(), { wrangler: async () => cloud });
		expect(cloud.calls.at(-1)?.args).toEqual([
			"rollback",
			"deploy-2",
			"--name",
			"asterra-rivus",
			"--message",
			"npx asterra rollback",
			"--yes",
		]);
		expect(ctx.output()).toContain("from  the version clear-3 (Asterra 0.3.0)");
		expect(ctx.output()).toContain("to    the version deploy-2 (Asterra 0.2.0)");
	});

	it("goes to the newest version of the release before, with the secrets of that version", async () => {
		const cloud = rivus([
			{ id: "deploy-2", tag: "asterra-0.2.0" },
			{ id: "key-2", secretChange: true, secrets: KEY },
			{ id: "deploy-3", tag: "asterra-0.3.0", secrets: KEY },
		]);
		const ctx = fakeContext();
		await rollback(ctx, flags(), { wrangler: async () => cloud });
		expect(cloud.liveVersion("asterra-rivus")?.id).toBe("key-2");
		expect(ctx.output()).toContain("to    the version key-2 (Asterra 0.2.0)");
	});

	it("tells the secrets that change, asks, and does not roll back in a run without questions", async () => {
		const versions = (): FakeVersion[] => [
			{ id: "deploy-2", tag: "asterra-0.2.0" },
			{ id: "token-2", secretChange: true, secrets: ["SETUP_TOKEN"] },
			{ id: "deploy-3", tag: "asterra-0.3.0", secrets: ["SETUP_TOKEN"] },
			{ id: "key-3", secretChange: true, secrets: KEY },
		];
		const quiet = rivus(versions());
		const ctx = fakeContext();
		await expect(rollback(ctx, flags(), { wrangler: async () => quiet })).rejects.toThrow(
			/A run without questions does not do this rollback/,
		);
		expect(ctx.output()).toContain("does not have: ENCRYPTION_KEY");
		expect(ctx.output()).toContain("has: SETUP_TOKEN");
		expect(commands(quiet)).not.toContain("rollback token-2");

		const refused = rivus(versions());
		const no = scripted([false]);
		await expect(
			rollback(fakeContext({ prompt: no }), flags({ yes: false }), { wrangler: async () => refused }),
		).rejects.toThrow(/Nothing changed/);
		expect(no.asked).toEqual(["Roll back, with these secret changes?"]);
		expect(refused.liveVersion("asterra-rivus")?.id).toBe("key-3");

		const agreed = rivus(versions());
		await rollback(fakeContext({ prompt: scripted([true]) }), flags({ yes: false }), { wrangler: async () => agreed });
		expect(agreed.liveVersion("asterra-rivus")?.id).toBe("token-2");
	});

	it("refuses when wrangler lists no version from before the release", async () => {
		const only = rivus([{ id: "deploy-3", tag: "asterra-0.3.0", secrets: KEY }]);
		await expect(rollback(fakeContext(), flags(), { wrangler: async () => only })).rejects.toThrow(
			/lists no version from before Asterra 0\.3\.0/,
		);

		// wrangler lists 10 versions. The deploy of the running version is older.
		const many = rivus([
			{ id: "deploy-2", tag: "asterra-0.2.0" },
			{ id: "deploy-3", tag: "asterra-0.3.0" },
			...Array.from({ length: 10 }, (_, index) => ({ id: `change-${index}`, secretChange: true, secrets: KEY })),
		]);
		await expect(rollback(fakeContext(), flags(), { wrangler: async () => many })).rejects.toThrow(
			/cannot find the deploy of the version change-9/,
		);
		expect(commands(many).filter((command) => command.startsWith("rollback"))).toEqual([]);
	});
});

describe("secrets", () => {
	it("deletes SETUP_TOKEN, and makes a new one only with a place for its value", async () => {
		const cloud = rivus([{ id: "version-old", secrets: ["SETUP_TOKEN", "ENCRYPTION_KEY"] }]);
		await secrets(fakeContext(), flags(), { wrangler: async () => cloud }, "clear-setup-token");
		expect(cloud.state.bulk).toEqual([{ SETUP_TOKEN: null }]);
		expect(cloud.liveVersion("asterra-rivus")?.secrets).toEqual(["ENCRYPTION_KEY"]);

		const untouched = rivus([{ id: "version-old" }]);
		const run = secrets(fakeContext(), flags(), { wrangler: async () => untouched }, "setup-token");
		await expect(run).rejects.toThrow(/--secrets-out/);
		expect(untouched.calls).toEqual([]);
	});

	it("writes the new SETUP_TOKEN to the secrets file, and makes that file before the change", async () => {
		const out = join(mkdtempSync(join(tmpdir(), "asterra-secrets-")), "token.env");
		const cloud = rivus([{ id: "version-old", secrets: KEY }]);
		const ctx = fakeContext();
		await secrets(ctx, flags({ secretsOut: out }), { wrangler: async () => cloud }, "setup-token");
		const token = String(cloud.state.bulk[0]?.SETUP_TOKEN);
		expect(readFileSync(out, "utf8")).toBe(`SETUP_TOKEN=${token}\n`);
		expect(ctx.output()).not.toContain(token);

		// The file exists now. A second run must not set a token that it cannot write.
		const again = rivus([{ id: "version-old", secrets: KEY }]);
		const run = secrets(fakeContext(), flags({ secretsOut: out }), { wrangler: async () => again }, "setup-token");
		await expect(run).rejects.toThrow(/Cannot make the file/);
		expect(again.calls).toEqual([]);
		writeFileSync(out, "");
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
	const terminal = () => scripted([]);

	it("compares versions by number, not as text", () => {
		expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
		expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
	});

	it("shows the notes after the running version up to the target, in order, and else the link", async () => {
		const ctx = fakeContext({ fetch: releases, prompt: terminal() });
		await showReleaseNotes(ctx, "0.8.0", "0.10.0");
		expect(ctx.output()).toMatch(/Nine\.[\s\S]*Ten\./);
		expect(ctx.output()).not.toContain("Eight.");

		// The fetch of this context throws, as a fetch without a network does.
		const offline = fakeContext({ prompt: terminal() });
		await showReleaseNotes(offline, null, "0.10.0");
		expect(offline.output()).toBe("Release notes: https://github.com/jaredwray/soldock/releases/tag/v0.10.0\n");
	});

	it("gives the call to GitHub a time limit", async () => {
		let signal: AbortSignal | null | undefined;
		const slow = (async (_url: string, init?: RequestInit) => {
			signal = init?.signal;
			return Response.json([]);
		}) as unknown as typeof fetch;
		await showReleaseNotes(fakeContext({ fetch: slow, prompt: terminal() }), null, "0.10.0");
		expect(signal).toBeInstanceOf(AbortSignal);
	});
});
