// Usage: node tools/budgets/check.ts <worker-dir>
// Builds the Worker with `wrangler deploy --dry-run`, profiles its startup with
// `wrangler check startup`, and fails if either exceeds <worker-dir>/budgets.json.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	bundleBytes,
	type CpuProfile,
	findOverruns,
	formatBytes,
	parseBudgets,
	startupActiveMs,
} from "./src/budgets.ts";

const workerDir = resolve(process.argv[2] ?? "apps/dock");
const budgets = parseBudgets(JSON.parse(readFileSync(join(workerDir, "budgets.json"), "utf8")));
const work = mkdtempSync(join(tmpdir(), "soldock-budgets-"));

function wrangler(...args: string[]): void {
	execFileSync("pnpm", ["exec", "wrangler", ...args], {
		cwd: workerDir,
		stdio: ["ignore", "ignore", "inherit"],
		env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
	});
}

try {
	const outdir = join(work, "bundle");
	// `--env ""` builds the top level (production) and stops the warning about the development env.
	wrangler("deploy", "--dry-run", "--env", "", "--outdir", outdir);
	const files = readdirSync(outdir, { recursive: true, encoding: "utf8" }).flatMap((path) => {
		const stat = statSync(join(outdir, path));
		return stat.isFile() ? [{ path, bytes: stat.size }] : [];
	});

	const profilePath = join(work, "startup.cpuprofile");
	wrangler("check", "startup", "--outfile", profilePath);
	const profile = JSON.parse(readFileSync(profilePath, "utf8")) as CpuProfile;

	const measured = { bundleBytes: bundleBytes(files), startupActiveMs: startupActiveMs(profile) };
	const overruns = findOverruns(measured, budgets);
	if (overruns.length > 0) {
		console.error(`budgets: ${workerDir} is over budget (see budgets.json):`);
		for (const o of overruns) console.error(`  - ${o}`);
		process.exitCode = 1;
	} else {
		console.log(
			`budgets: bundle ${formatBytes(measured.bundleBytes)} of ${formatBytes(budgets.bundle.maxBytes)}, ` +
				`startup ${measured.startupActiveMs.toFixed(1)} ms of ${budgets.startup.maxActiveMs} ms. Within budget.`,
		);
	}
} finally {
	rmSync(work, { recursive: true, force: true });
}
