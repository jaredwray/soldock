import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

/** Where the CLI writes. bin.ts gives stdout and stderr. */
export interface Output {
	out(text: string): void;
	err(text: string): void;
}

// The path is the same from src/ in the repository and from dist/ in the published package.
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

/** The version of the CLI. A release has the same version as the Asterra bundle in it. */
export const VERSION = manifest.version;

export const USAGE = `Usage: asterra [options]

Install and upgrade Asterra in your own Cloudflare account.

Options:
  -h, --help     Show this help.
  -v, --version  Show the version.

This version has no commands.
`;

/** Runs the CLI with the arguments after the program name. Returns the exit code. */
export function run(argv: readonly string[], io: Output): number {
	let parsed: ReturnType<typeof parse>;
	try {
		parsed = parse(argv);
	} catch (error) {
		io.err(`asterra: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
		return 2;
	}
	const { values, positionals } = parsed;
	if (values.version) {
		io.out(`${VERSION}\n`);
		return 0;
	}
	const [command] = positionals;
	if (command !== undefined && !values.help) {
		io.err(`asterra: unknown command "${command}"\n\n${USAGE}`);
		return 2;
	}
	io.out(USAGE);
	return 0;
}

function parse(argv: readonly string[]) {
	return parseArgs({
		args: [...argv],
		options: {
			help: { type: "boolean", short: "h" },
			version: { type: "boolean", short: "v" },
		},
		allowPositionals: true,
		strict: true,
	});
}
