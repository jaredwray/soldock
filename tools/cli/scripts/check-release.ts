// Usage: node tools/cli/scripts/check-release.ts [--bundle <dir>]
// Checks the release bundle with no credentials. For a new instance and for the instance from before
// the CLI, it writes the config of the instance, as `install` and `upgrade` do, and runs
// `wrangler deploy --dry-run` on it. The output must name the resources of the instance.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { defaultBundleDir, loadBundle } from "../src/bundle.ts";
import { type InstanceTarget, instanceConfig } from "../src/config.ts";

const DOCK = resolve(import.meta.dirname, "../../../apps/dock");
const { values } = parseArgs({ options: { bundle: { type: "string" } } });
const bundle = loadBundle(resolve(values.bundle ?? defaultBundleDir()));

const targets: InstanceTarget[] = [
	{ workerName: "asterra-example", prefix: "asterra-example", hostname: "asterra.example.com" },
	// The development instance keeps the names from before the CLI.
	{ workerName: "soldock-dock-dev", prefix: "soldock", hostname: "work.soldock.org" },
];

let failures = 0;
for (const target of targets) {
	const work = mkdtempSync(join(tmpdir(), "asterra-release-check-"));
	try {
		const configPath = join(work, "wrangler.json");
		writeFileSync(configPath, JSON.stringify(instanceConfig(bundle.template, target, bundle.dir)));
		const output = execFileSync(
			"pnpm",
			["exec", "wrangler", "deploy", "--dry-run", "--config", configPath, "--outdir", join(work, "out")],
			{
				cwd: DOCK,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "inherit"],
				env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
			},
		);
		const expected = [
			`env.DIRECTORY (${target.prefix}-directory)`,
			`env.BLOBS (${target.prefix}-blobs)`,
			`env.MAIL_INBOUND (${target.prefix}-mail-inbound)`,
			`env.WEBHOOKS_DLQ (${target.prefix}-webhooks-dlq)`,
			// The instance keeps its host in this var. `upgrade` reads it back.
			`env.ASTERRA_HOSTNAME ("${target.hostname}")`,
		];
		const missing = expected.filter((line) => !output.includes(line));
		if (!existsSync(join(work, "out", "index.js"))) missing.push("the Worker module index.js");
		if (missing.length > 0) {
			failures += 1;
			console.error(`release check: ${target.workerName}: the dry run does not show ${missing.join("; ")}`);
		} else {
			console.log(`release check: ${target.workerName} (${target.prefix}-*): the dry run passes.`);
		}
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}
if (failures > 0) process.exit(1);
