import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { instanceConfig, parseWranglerJsonc, templateFromConfig, type WranglerConfig } from "../src/config.ts";
import { MAX_NAME_LENGTH } from "../src/names.ts";

// The real config of the Worker, so a new binding or a new queue reaches these tests.
const source = parseWranglerJsonc(readFileSync(new URL("../../../apps/dock/wrangler.jsonc", import.meta.url), "utf8"));
const template = templateFromConfig(source);
const BUNDLE = "/opt/asterra/release";

/** Each Cloudflare resource name of a config: D1, R2 and the queues. */
function resourceNames(config: WranglerConfig): string[] {
	const queues = config.queues as {
		producers: { queue: string }[];
		consumers: { queue: string; dead_letter_queue?: string }[];
	};
	return [
		...(config.d1_databases as { database_name: string }[]).map((database) => database.database_name),
		...(config.r2_buckets as { bucket_name: string }[]).map((bucket) => bucket.bucket_name),
		...queues.producers.map((producer) => producer.queue),
		...queues.consumers.flatMap((consumer) =>
			consumer.dead_letter_queue === undefined ? [consumer.queue] : [consumer.queue, consumer.dead_letter_queue],
		),
	];
}

/** The binding names that the Worker code reads. Resource names and paths become "*". */
function bindingNames(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(bindingNames);
	if (value === null || typeof value !== "object") return "*";
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [
			key,
			["binding", "name", "class_name"].includes(key) ? item : bindingNames(item),
		]),
	);
}

describe("the release template", () => {
	it("holds no instance: no Worker name, no host, no account and no resource prefix", () => {
		const text = JSON.stringify(template);
		expect(text).not.toContain("soldock");
		expect(template).not.toHaveProperty("name");
		expect(template).not.toHaveProperty("env");
		expect(template).not.toHaveProperty("routes");
		expect(template).not.toHaveProperty("account_id");
		expect(template).toMatchObject({ main: "worker/index.js", no_bundle: true, assets: { directory: "assets" } });
	});

	it("stops at a key of wrangler.jsonc that it does not know, and at a resource name without the prefix", () => {
		expect(() => templateFromConfig({ ...source, kv_namespaces: [] })).toThrow(/does not know the key "kv_namespaces"/);
		const renamed = { ...source, r2_buckets: [{ binding: "BLOBS", bucket_name: "blobs" }] };
		expect(() => templateFromConfig(renamed)).toThrow(/must start with "soldock-"/);
	});
});

describe("the config of an instance", () => {
	const rivus = instanceConfig(
		template,
		{ workerName: "asterra-rivus", prefix: "asterra-rivus", hostname: "work.rivus.com" },
		BUNDLE,
	);

	it("names each resource with the prefix of the instance, and keeps the binding names of the Worker", () => {
		for (const name of resourceNames(rivus)) expect(name).toMatch(/^asterra-rivus-[a-z-]+$/);
		for (const key of ["d1_databases", "r2_buckets", "queues", "durable_objects", "send_email"]) {
			expect(bindingNames(rivus[key]), key).toEqual(bindingNames(source[key]));
		}
		expect(rivus.vars).toEqual(source.vars);
	});

	// One origin: the instance serves only its custom domain. The account comes from the login, never the config.
	it("serves only its custom domain, and names no account", () => {
		expect(rivus).toMatchObject({
			name: "asterra-rivus",
			workers_dev: false,
			preview_urls: false,
			routes: [{ pattern: "work.rivus.com", custom_domain: true }],
		});
		expect(JSON.stringify(rivus)).not.toContain("account_id");
	});

	it("points into the bundle", () => {
		expect(rivus.main).toBe(`${BUNDLE}/worker/index.js`);
		expect(rivus.assets).toMatchObject({ directory: `${BUNDLE}/assets` });
		expect(rivus.d1_databases).toMatchObject([{ migrations_dir: `${BUNDLE}/migrations` }]);
	});

	// The development instance keeps its data only if it keeps the names of each resource.
	it("gives the instance from before the CLI the resource names of wrangler.jsonc", () => {
		const legacy = instanceConfig(
			template,
			{ workerName: "soldock-dock-dev", prefix: "soldock", hostname: "work.soldock.org" },
			BUNDLE,
		);
		expect(resourceNames(legacy)).toEqual(resourceNames(source));
	});

	it("keeps each resource name of the longest instance name within the Cloudflare limit of 63 characters", () => {
		const prefix = `asterra-${"a".repeat(MAX_NAME_LENGTH)}`;
		const longest = instanceConfig(template, { workerName: prefix, prefix, hostname: "x.example.com" }, BUNDLE);
		for (const name of resourceNames(longest)) expect(name.length, name).toBeLessThanOrEqual(63);
	});
});
