import { describe, expect, it } from "vitest";
import { isWorkerPath, WORKER_PREFIXES } from "../src/routes.ts";
import wranglerConfig from "../wrangler.jsonc?raw";

// The config of one Worker: the top level, or one named env.
interface WorkerConfig {
	name: string;
	workers_dev?: boolean;
	preview_urls?: boolean;
	routes?: Array<{ pattern: string; custom_domain?: boolean }>;
	d1_databases?: Array<{ binding: string; database_name: string }>;
	r2_buckets?: Array<{ binding: string; bucket_name: string }>;
	queues?: {
		producers: Array<{ binding: string; queue: string }>;
		consumers: Array<{ queue: string; dead_letter_queue?: string }>;
	};
	vars?: Record<string, string>;
	[key: string]: unknown;
}

interface WranglerConfig extends WorkerConfig {
	compatibility_date: string;
	compatibility_flags: string[];
	observability: { enabled: boolean };
	assets: { binding: string; not_found_handling: string; run_worker_first: string[] };
	env: Record<string, WorkerConfig>;
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
	"find_additional_modules",
	"base_dir",
	"preserve_file_names",
	"tsconfig",
	"triggers",
	"usage_model",
	"logpush",
	"upload_source_maps",
	"keep_vars",
	"send_metrics",
	"dev",
]);

// The binding names of a config value. Resource IDs and other values differ between the
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
const envs = Object.entries(config.env);

// The D1, R2 and queue names of a Worker. They are unique in an account.
function resourceNames(worker: WorkerConfig): string[] {
	return [
		...(worker.d1_databases ?? []).map((database) => database.database_name),
		...(worker.r2_buckets ?? []).map((bucket) => bucket.bucket_name),
		...(worker.queues?.producers ?? []).map((producer) => producer.queue),
		...(worker.queues?.consumers ?? []).flatMap((consumer) =>
			[consumer.queue, consumer.dead_letter_queue ?? []].flat(),
		),
	];
}

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
	it.each(envs)("declares each production binding and var in env.%s, with the same names", (name, worker) => {
		for (const key of new Set([...Object.keys(config), ...Object.keys(worker)])) {
			if (INHERITED.has(key)) continue;
			expect(names(worker[key]), `env.${name}.${key}`).toEqual(names(config[key]));
		}
	});

	it.each(envs)("keeps env.%s on one origin, and apart from production", (name, worker) => {
		// Each Worker serves only its custom domain. A workers.dev host or a Preview URL is a second
		// origin with the same data. A named env inherits preview_urls.
		expect(config.workers_dev).toBe(false);
		expect(config.preview_urls).toBe(false);
		expect(worker.workers_dev).toBe(false);
		expect(worker.preview_urls ?? config.preview_urls).toBe(false);
		// deploy-development.yaml smoke checks the one custom domain in the deploy output.
		const routes = worker.routes ?? [];
		expect(routes).toHaveLength(1);
		expect(routes[0]?.custom_domain).toBe(true);
		expect(worker.name).not.toBe(config.name);
		// Routes are inherited. A named env must never claim production's routes.
		for (const key of ["routes", "route"]) {
			if (key in config) expect(worker, `env.${name}.${key}`).toHaveProperty(key);
		}
		// The account comes from the environment's CLOUDFLARE_ACCOUNT_ID secret, so a deploy
		// can't reach the other environment's account through the config.
		expect(wranglerConfig).not.toMatch(/"account_id"/);
	});

	// queue() selects the consumer by the queue name that the vars give. A var that names a different
	// queue acknowledges each batch of the real queue, and the mail is lost.
	it.each([["production", config as WorkerConfig], ...envs])("names the queues of %s in its vars", (_name, worker) => {
		const producer = (binding: string) => worker.queues?.producers.find((item) => item.binding === binding)?.queue;
		expect(worker.queues?.consumers).toEqual([
			expect.objectContaining({ queue: producer("MAIL_INBOUND"), dead_letter_queue: producer("MAIL_INBOUND_DLQ") }),
			expect.objectContaining({ queue: producer("WEBHOOKS"), dead_letter_queue: producer("WEBHOOKS_DLQ") }),
		]);
		expect(worker.vars?.MAIL_INBOUND_QUEUE).toBe(producer("MAIL_INBOUND"));
		expect(worker.vars?.WEBHOOKS_QUEUE).toBe(producer("WEBHOOKS"));
	});

	// The named envs (development and rivus) share the development account. A shared D1, R2 or queue name
	// shares the data, and a queue has only one consumer. Production is in its own account, so it can
	// use the names of development.
	it("gives each named env its own Worker, host, and D1, R2 and queue names", () => {
		const owner = new Map<string, string>();
		for (const [name, worker] of envs) {
			const routes = (worker.routes ?? []).map((route) => `host ${route.pattern}`);
			for (const resource of new Set([`worker ${worker.name}`, ...routes, ...resourceNames(worker)])) {
				expect(owner.get(resource), `env.${name} uses ${resource}`).toBeUndefined();
				owner.set(resource, name);
			}
		}
	});
});

describe("isWorkerPath", () => {
	it("matches the prefixes and nothing else", () => {
		expect(isWorkerPath("/healthz")).toBe(true);
		expect(isWorkerPath("/api/v1/system/ping")).toBe(true);
		expect(isWorkerPath("/mcp")).toBe(true);
		expect(isWorkerPath("/.well-known/oauth-protected-resource/mcp")).toBe(true);
		expect(isWorkerPath("/api")).toBe(false);
		expect(isWorkerPath("/mail")).toBe(false);
		expect(isWorkerPath("/")).toBe(false);
	});
});
