// Usage: node tools/docker/version.ts
// Prints the version tag of the development image for the commit at HEAD.
// The docker-publish workflow gives this tag to the image that it builds.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { developmentVersion } from "./src/version.ts";

const root = resolve(import.meta.dirname, "../..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
const [commit = "", committedAt = ""] = execFileSync("git", ["show", "--no-patch", "--format=%H %ct", "HEAD"], {
	cwd: root,
	encoding: "utf8",
})
	.trim()
	.split(" ");

console.log(developmentVersion({ version, commit, committedAt: Number(committedAt) }));
