// The wrangler config of an instance. The release build makes a template from the top level of
// apps/dock/wrangler.jsonc: resource names become suffixes and the paths point into the bundle. The
// CLI then makes the config of one instance from the template, with its names and its host.
import { isAbsolute, join } from "node:path";
import { LEGACY_PREFIX, resourceName } from "./names.ts";

export type WranglerConfig = Record<string, unknown>;

/** The plain var of an instance config that holds the host of the instance. */
export const HOSTNAME_VAR = "ASTERRA_HOSTNAME";

/** Where an instance runs. */
export interface InstanceTarget {
	workerName: string;
	prefix: string;
	hostname: string;
}

// The keys that the template knows. A new key in apps/dock/wrangler.jsonc stops the release build, so
// that a new binding cannot reach an instance without a decision about its name.
const COPIED = new Set([
	"compatibility_date",
	"compatibility_flags",
	"workers_dev",
	"preview_urls",
	"observability",
	"triggers",
	"send_email",
	"durable_objects",
	"migrations",
	"vars",
]);
const DROPPED = new Set(["$schema", "name", "main", "env"]);
// "rules" is here too: the template changes it.
const NAMED = new Set(["assets", "d1_databases", "r2_buckets", "queues", "rules"]);

/** Parses wrangler.jsonc, which uses whole-line comments only. */
export function parseWranglerJsonc(text: string): WranglerConfig {
	const json = text
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("//"))
		.join("\n");
	return JSON.parse(json) as WranglerConfig;
}

/** The template of the release, from the top level of the source config. */
export function templateFromConfig(source: WranglerConfig): WranglerConfig {
	for (const key of Object.keys(source)) {
		if (!COPIED.has(key) && !DROPPED.has(key) && !NAMED.has(key)) {
			throw new Error(`The release template does not know the key "${key}" of wrangler.jsonc. Add it to config.ts.`);
		}
	}
	const template: WranglerConfig = { main: "worker/index.js", no_bundle: true };
	for (const [key, value] of Object.entries(source)) {
		if (COPIED.has(key)) template[key] = structuredClone(value);
	}
	// The bundle is built already. Without `fallthrough`, wrangler does not also apply its default rule for
	// .sql files, which attaches each module a second time.
	if (source.rules !== undefined) {
		template.rules = list(source.rules, "rules").map(({ fallthrough: _fallthrough, ...rule }) => rule);
	}
	const assets = record(source.assets, "assets");
	template.assets = { ...assets, directory: "assets" };
	template.d1_databases = list(source.d1_databases, "d1_databases").map((database) => ({
		...database,
		database_name: suffixOf(database.database_name),
		migrations_dir: "migrations",
	}));
	template.r2_buckets = list(source.r2_buckets, "r2_buckets").map((bucket) => ({
		...bucket,
		bucket_name: suffixOf(bucket.bucket_name),
	}));
	template.queues = mapQueues(record(source.queues, "queues"), suffixOf);
	return template;
}

/** The config of one instance, with absolute paths into the bundle at `bundleDir`. */
export function instanceConfig(template: WranglerConfig, target: InstanceTarget, bundleDir: string): WranglerConfig {
	const named = (suffix: unknown) => resourceName(target.prefix, String(suffix));
	const inBundle = (path: unknown) => (isAbsolute(String(path)) ? String(path) : join(bundleDir, String(path)));
	const config: WranglerConfig = structuredClone(template);
	config.name = target.workerName;
	config.main = inBundle(template.main);
	// The instance serves only its custom domain: workers.dev and Preview URLs are second origins.
	config.workers_dev = false;
	config.preview_urls = false;
	config.routes = [{ pattern: target.hostname, custom_domain: true }];
	// The instance keeps its host in a plain var, so the CLI can read it back from the version that runs.
	// The Worker does not read this var.
	config.vars = {
		...(template.vars === undefined ? {} : record(template.vars, "vars")),
		[HOSTNAME_VAR]: target.hostname,
	};
	config.assets = {
		...record(template.assets, "assets"),
		directory: inBundle(record(template.assets, "assets").directory),
	};
	config.d1_databases = list(template.d1_databases, "d1_databases").map((database) => ({
		...database,
		database_name: named(database.database_name),
		migrations_dir: inBundle(database.migrations_dir),
	}));
	config.r2_buckets = list(template.r2_buckets, "r2_buckets").map((bucket) => ({
		...bucket,
		bucket_name: named(bucket.bucket_name),
	}));
	config.queues = mapQueues(record(template.queues, "queues"), named);
	return config;
}

function mapQueues(queues: Record<string, unknown>, rename: (name: unknown) => string): Record<string, unknown> {
	return {
		...queues,
		producers: list(queues.producers ?? [], "queues.producers").map((producer) => ({
			...producer,
			queue: rename(producer.queue),
		})),
		consumers: list(queues.consumers ?? [], "queues.consumers").map((consumer) => {
			const mapped: Record<string, unknown> = { ...consumer, queue: rename(consumer.queue) };
			if (consumer.dead_letter_queue !== undefined) mapped.dead_letter_queue = rename(consumer.dead_letter_queue);
			return mapped;
		}),
	};
}

function suffixOf(name: unknown): string {
	const start = `${LEGACY_PREFIX}-`;
	if (typeof name !== "string" || !name.startsWith(start) || name.length === start.length) {
		throw new Error(`A resource name of wrangler.jsonc must start with "${start}": ${String(name)}`);
	}
	return name.slice(start.length);
}

function record(value: unknown, key: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`wrangler.jsonc: "${key}" must be an object.`);
	}
	return value as Record<string, unknown>;
}

function list(value: unknown, key: string): Record<string, unknown>[] {
	if (!Array.isArray(value)) throw new Error(`wrangler.jsonc: "${key}" must be a list.`);
	return value.map((item) => record(item, key));
}
