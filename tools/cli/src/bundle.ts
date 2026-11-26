// The prebuilt Asterra release in the package: release/ next to dist/. In the repository,
// `pnpm release:build` makes it. `--bundle <dir>` points the CLI at a different one.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WranglerConfig } from "./config.ts";
import { type Manifest, parseManifest, Refusal } from "./manifest.ts";

export interface Bundle {
	dir: string;
	manifest: Manifest;
	template: WranglerConfig;
}

/** The release folder of the package. The path is the same from src/ and from dist/. */
export function defaultBundleDir(): string {
	return fileURLToPath(new URL("../release/", import.meta.url));
}

/** Reads the bundle at `folder`. The bundle dir is absolute: the config of an instance points into it. */
export function loadBundle(folder: string): Bundle {
	const dir = resolve(folder);
	const files = ["manifest.json", "wrangler.template.json", "worker/index.js", "assets/index.html"];
	const missing = files.filter((file) => !existsSync(join(dir, file)));
	if (missing.length > 0) {
		throw new Refusal(
			`The release bundle in ${dir} is not complete (missing: ${missing.join(", ")}). ` +
				"In the repository, run `pnpm build` and then `pnpm release:build`.",
		);
	}
	const read = (file: string) => JSON.parse(readFileSync(join(dir, file), "utf8")) as unknown;
	return {
		dir,
		manifest: parseManifest(read("manifest.json")),
		template: read("wrangler.template.json") as WranglerConfig,
	};
}
