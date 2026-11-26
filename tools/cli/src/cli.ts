import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { install } from "./commands/install.ts";
import { rollback, secrets, status } from "./commands/manage.ts";
import { runSmoke } from "./commands/smoke.ts";
import { upgrade } from "./commands/upgrade.ts";
import type { Context, Output } from "./context.ts";
import { Refusal } from "./errors.ts";
import { type Deps, defaultDeps, type Flags } from "./session.ts";

export type { Output };

// The path is the same from src/ in the repository and from dist/ in the published package.
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

/** The version of the CLI. A release has the same version as the Asterra bundle in it. */
export const VERSION = manifest.version;

export const USAGE = `Usage: asterra <command> [options]

Install and upgrade Asterra in your own Cloudflare account.

Commands:
  install                      Make a new instance: deploy, migrations, secrets, setup.
  upgrade                      Upgrade an instance to the release of this CLI.
  status                       Show the version, the migrations and the secrets of an instance.
  rollback                     Send the traffic of an instance back to the version before.
  secrets setup-token          Make a new SETUP_TOKEN (setup, or a directory reset).
  secrets clear-setup-token    Delete SETUP_TOKEN.
  smoke <url>                  Run the smoke check against a host.

Options:
  --name <name>          The instance (resources asterra-<name>-*).
  --hostname <host>      The host of the instance, for example work.example.com.
  --account-id <id>      The Cloudflare account (id or name).
  --yes                  Ask nothing. Give each answer with a flag.
  --secrets-out <file>   Write new secrets to this new file, not to the terminal.
  --owner-name <name>    install: create the owner in the terminal, with this name.
  --owner-address <a>    install: the address of the owner. Its domain is the first mail domain.
                         The password comes from ASTERRA_OWNER_PASSWORD, or the CLI asks.
  --no-rollback          upgrade: keep the new version when the smoke check fails.
  --device               Sign in with a code on a different device (for SSH).
  --worker-name <name>   The Worker name, for an instance from before the CLI.
  --prefix <prefix>      The resource prefix, for an instance from before the CLI (soldock).
  --bundle <dir>         A different release bundle (for development).
  -h, --help             Show this help.
  -v, --version          Show the version.

In CI, set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, and use --yes.
`;

const OPTIONS = {
	help: { type: "boolean", short: "h" },
	version: { type: "boolean", short: "v" },
	yes: { type: "boolean", short: "y" },
	name: { type: "string" },
	hostname: { type: "string" },
	"account-id": { type: "string" },
	"secrets-out": { type: "string" },
	"owner-name": { type: "string" },
	"owner-address": { type: "string" },
	"no-rollback": { type: "boolean" },
	device: { type: "boolean" },
	"worker-name": { type: "string" },
	prefix: { type: "string" },
	bundle: { type: "string" },
} as const;

/** Parses the arguments after the program name. */
export function parse(argv: readonly string[]) {
	const { values, positionals } = parseArgs({
		args: [...argv],
		options: OPTIONS,
		allowPositionals: true,
		strict: true,
	});
	const flags: Flags = {
		yes: values.yes === true,
		rollback: values["no-rollback"] !== true,
		accountId: values["account-id"],
		name: values.name,
		hostname: values.hostname,
		workerName: values["worker-name"],
		prefix: values.prefix,
		bundle: values.bundle,
		device: values.device,
		secretsOut: values["secrets-out"],
		ownerName: values["owner-name"],
		ownerAddress: values["owner-address"],
	};
	return { flags, help: values.help === true, version: values.version === true, positionals };
}

/**
 * Runs the CLI. Returns the exit code: 0 for success, 1 for a failed command, 2 for a usage error.
 * `context` makes the context of a command after the parse (bin.ts asks on a terminal unless --yes).
 */
export async function run(
	argv: readonly string[],
	io: Output,
	context: (flags: Flags) => Context = () => {
		throw new Error("no context");
	},
	deps: Deps = defaultDeps,
): Promise<number> {
	let parsed: ReturnType<typeof parse>;
	try {
		parsed = parse(argv);
	} catch (error) {
		io.err(`asterra: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
		return 2;
	}
	const { flags, positionals } = parsed;
	if (parsed.version) {
		io.out(`${VERSION}\n`);
		return 0;
	}
	const [command, ...rest] = positionals;
	if (parsed.help || command === undefined) {
		io.out(USAGE);
		return 0;
	}
	const usage = (message: string) => {
		io.err(`asterra: ${message}\n\n${USAGE}`);
		return 2;
	};
	const commands: Record<string, (ctx: Context) => Promise<unknown>> = {
		install: (ctx) => install(ctx, flags, deps),
		upgrade: (ctx) => upgrade(ctx, flags, deps),
		status: (ctx) => status(ctx, flags, deps),
		rollback: (ctx) => rollback(ctx, flags, deps),
		secrets: (ctx) => secrets(ctx, flags, deps, rest[0]),
	};
	if (command === "smoke") {
		if (rest.length !== 1) return usage("smoke needs one URL.");
		const url = rest[0] ?? "";
		if (!/^https?:\/\//.test(url)) return usage("smoke needs a URL with http:// or https://.");
		return (await runSmoke(context(flags), url)) ? 0 : 1;
	}
	const action = commands[command];
	if (!action) return usage(`unknown command "${command}"`);
	try {
		await action(context(flags));
		return 0;
	} catch (error) {
		if (error instanceof Refusal) {
			io.err(`asterra: ${error.message}\n`);
			return 1;
		}
		throw error;
	}
}
