import { describe, expect, it } from "vitest";
import { isWorkerPath, WORKER_PREFIXES } from "../src/routes.ts";
import wranglerConfig from "../wrangler.jsonc?raw";

interface WranglerConfig {
	compatibility_date: string;
	compatibility_flags: string[];
	observability: { enabled: boolean };
	assets: { binding: string; not_found_handling: string; run_worker_first: string[] };
	name: string;
	workers_dev?: boolean;
	env: { development: Record<string, unknown> & { name: string; workers_dev?: boolean } };
	[key: string]: unknown;
}

// Keys that a named env inherits from the top level (wrangler 4.149.0). Every other top-level key is
// a binding or vars, which a named env does not inherit.
const INHERITED = new Set([
	"$schema",
	"env",
	"name",
	"main",
	"compatibility_date",
	"compatibility_flags",
	"observability",
	"assets",
	"workers_dev",
	"preview_urls",
	"routes",
	"route",
	"migrations",
	"exports",
	"limits",
	"placement",
	"build",
	"rules",
	"no_bundle",
	"minify",
	"keep_names",
	"tsconfig",
	"triggers",
	"usage_model",
	"logpush",
	"upload_source_maps",
	"keep_vars",
	"send_metrics",
	"dev",
]);

// The binding names of a config value. Resource IDs and other values differ between the two
// environments, so they become "*". The names that the code reads must be the same.
const NAME_KEYS = new Set(["binding", "name", "class_name"]);
function names(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(names);
	if (value === null || typeof value !== "object") return "*";
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, NAME_KEYS.has(key) ? item : names(item)]));
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

	// A binding that only production declares passes `wrangler deploy --dry-run` with a warning, and
	// then fails on development after the merge.
	it("declares each production binding and var in env.development, with the same names", () => {
		const development = config.env.development;
		for (const key of new Set([...Object.keys(config), ...Object.keys(development)])) {
			if (INHERITED.has(key)) continue;
			expect(names(development[key]), `env.development.${key}`).toEqual(names(config[key]));
		}
	});

	it("keeps production on one origin, and the development Worker apart from it", () => {
		// Production serves only its custom domain (ADR-0002). Development uses its workers.dev host.
		expect(config.workers_dev).toBe(false);
		expect(config.env.development.workers_dev).toBe(true);
		expect(config.env.development.name).not.toBe(config.name);
		// Routes are inherited. Development must never claim production's routes.
		for (const key of ["routes", "route"]) {
			if (key in config) expect(config.env.development, `env.development.${key}`).toHaveProperty(key);
		}
		// The account comes from the environment's CLOUDFLARE_ACCOUNT_ID secret (ADR-0015), so a deploy
		// can't reach the other environment's account through the config.
		expect(wranglerConfig).not.toMatch(/"account_id"/);
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
