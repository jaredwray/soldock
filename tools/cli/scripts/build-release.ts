// Usage: node tools/cli/scripts/build-release.ts [--out <dir>]
// Builds the Asterra release bundle of the CLI package into tools/cli/release (or --out). Build the
// web app first (`pnpm build`): the Worker serves apps/web/dist as its assets.
import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseWranglerJsonc, templateFromConfig } from "../src/config.ts";
import { parseManifest } from "../src/manifest.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const CLI = join(ROOT, "tools/cli");
const DOCK = join(ROOT, "apps/dock");
const WEB_DIST = join(ROOT, "apps/web/dist");

const { values } = parseArgs({ options: { out: { type: "string" } } });
const out = resolve(values.out ?? join(CLI, "release"));
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

if (!existsSync(join(WEB_DIST, "index.html"))) {
	console.error("release: apps/web/dist is missing. Run `pnpm build` first.");
	process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "worker"), { recursive: true });
const work = mkdtempSync(join(tmpdir(), "asterra-release-"));
try {
	// The Worker as wrangler bundles it. The SQL files stay separate Text modules next to index.js.
	// `--env ""` builds the top level.
	execFileSync("pnpm", ["exec", "wrangler", "deploy", "--dry-run", "--env", "", "--outdir", work], {
		cwd: DOCK,
		stdio: ["ignore", "ignore", "inherit"],
		env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
	});
	const built = readdirSync(work);
	if (!built.includes("index.js")) throw new Error("wrangler did not write index.js");
	for (const file of built) {
		if (file === "index.js" || file.endsWith(".sql")) copyFileSync(join(work, file), join(out, "worker", file));
	}
} finally {
	rmSync(work, { recursive: true, force: true });
}

cpSync(WEB_DIST, join(out, "assets"), { recursive: true });
const migrations = readdirSync(join(DOCK, "migrations"))
	.filter((file) => file.endsWith(".sql"))
	.sort();
mkdirSync(join(out, "migrations"));
for (const file of migrations) copyFileSync(join(DOCK, "migrations", file), join(out, "migrations", file));

const template = templateFromConfig(parseWranglerJsonc(readFileSync(join(DOCK, "wrangler.jsonc"), "utf8")));
writeFileSync(join(out, "wrangler.template.json"), `${JSON.stringify(template, null, "\t")}\n`);

const devDependencies = readJson(join(DOCK, "package.json")).devDependencies as Record<string, string>;
const commit =
	process.env.GITHUB_SHA ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
const manifest = parseManifest({
	version: readJson(join(CLI, "package.json")).version,
	commit,
	wrangler: devDependencies.wrangler,
	migrations,
	min_applied_migration: readJson(join(CLI, "release.json")).min_applied_migration ?? null,
});
writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
console.log(`release: ${manifest.version} (${commit.slice(0, 7)}), ${migrations.length} migrations, in ${out}`);
