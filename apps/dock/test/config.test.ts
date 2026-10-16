import { describe, expect, it } from "vitest";
import { isWorkerPath, WORKER_PREFIXES } from "../src/routes.ts";
import wranglerConfig from "../wrangler.jsonc?raw";

interface WranglerConfig {
	compatibility_date: string;
	compatibility_flags: string[];
	observability: { enabled: boolean };
	assets: { binding: string; not_found_handling: string; run_worker_first: string[] };
}

// wrangler.jsonc only uses whole-line comments, so dropping them leaves plain JSON.
const config = JSON.parse(
	wranglerConfig
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("//"))
		.join("\n"),
) as WranglerConfig;

describe("wrangler.jsonc", () => {
	it("routes exactly the Worker-owned prefixes to the Worker first", () => {
		expect(config.assets.run_worker_first).toEqual(WORKER_PREFIXES.map((prefix) => `${prefix}*`));
	});

	it("serves the SPA for every other path", () => {
		expect(config.assets.binding).toBe("ASSETS");
		expect(config.assets.not_found_handling).toBe("single-page-application");
	});

	it("pins a compatibility date and enables nodejs_compat and observability", () => {
		expect(config.compatibility_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(config.compatibility_flags).toContain("nodejs_compat");
		expect(config.observability.enabled).toBe(true);
	});
});

describe("isWorkerPath", () => {
	it("matches the prefixes and nothing else", () => {
		expect(isWorkerPath("/api/v1/system/ping")).toBe(true);
		expect(isWorkerPath("/mcp")).toBe(true);
		expect(isWorkerPath("/.well-known/oauth-protected-resource/mcp")).toBe(true);
		expect(isWorkerPath("/api")).toBe(false);
		expect(isWorkerPath("/mail")).toBe(false);
		expect(isWorkerPath("/")).toBe(false);
	});
});
