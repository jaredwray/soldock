import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { run, USAGE } from "../src/cli.ts";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
	name: string;
	version: string;
	bin: Record<string, string>;
};

function capture(argv: string[]) {
	let out = "";
	let err = "";
	const code = run(argv, { out: (text) => (out += text), err: (text) => (err += text) });
	return { code, out, err };
}

describe("asterra arguments", () => {
	// Exit code 2 is a usage error, so a script can tell it from a failed command (1).
	it.each([
		{ argv: [], code: 0, out: USAGE, err: "" },
		{ argv: ["--help"], code: 0, out: USAGE, err: "" },
		{ argv: ["-h"], code: 0, out: USAGE, err: "" },
		{ argv: ["--version"], code: 0, out: `${manifest.version}\n`, err: "" },
		{ argv: ["-v"], code: 0, out: `${manifest.version}\n`, err: "" },
		{ argv: ["--nope"], code: 2, out: "", err: /^asterra: .*'--nope'[\s\S]*Usage: asterra/ },
		{ argv: ["deploy"], code: 2, out: "", err: /^asterra: unknown command "deploy"[\s\S]*Usage: asterra/ },
	])("$argv exits with $code", ({ argv, code, out, err }) => {
		const result = capture(argv);
		expect(result.code).toBe(code);
		expect(result.out).toBe(out);
		if (typeof err === "string") expect(result.err).toBe(err);
		else expect(result.err).toMatch(err);
	});
});

// npx runs the emitted JavaScript from node_modules, where Node does not strip types. This test builds
// the package into the same layout and runs its `bin` entry.
describe("the published package", () => {
	const root = mkdtempSync(join(tmpdir(), "asterra-cli-"));
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it("runs its bin entry as JavaScript and prints the package version", () => {
		const installed = join(root, "node_modules", manifest.name);
		mkdirSync(installed, { recursive: true });
		copyFileSync(join(packageDir, "package.json"), join(installed, "package.json"));
		const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");
		execFileSync(
			process.execPath,
			[tsc, "-p", join(packageDir, "tsconfig.build.json"), "--outDir", join(installed, "dist")],
			{ stdio: "pipe" },
		);

		const bin = manifest.bin.asterra;
		expect(bin).toBeDefined();
		const output = execFileSync(process.execPath, [join(installed, bin ?? ""), "--version"], {
			cwd: root,
			encoding: "utf8",
		});
		expect(output).toBe(`${manifest.version}\n`);
	}, 60_000);
});
