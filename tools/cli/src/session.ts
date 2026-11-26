// What each command that acts on Cloudflare starts with: the bundle, a wrangler, the account and the
// instance. And the flags that all commands share.
import { appendFileSync } from "node:fs";
import { type Account, inAccount, signIn } from "./auth.ts";
import { type Bundle, defaultBundleDir, loadBundle } from "./bundle.ts";
import { currentVersion, listDatabases, type VersionDetail, viewVersion } from "./cloudflare.ts";
import { type Context, say } from "./context.ts";
import { Refusal } from "./errors.ts";
import { hostnameError, instancesFromDatabases, LEGACY_PREFIX, nameError, prefixOf, workerNameError } from "./names.ts";
import { ensureWrangler, type Wrangler } from "./wrangler.ts";

export interface Flags {
	yes: boolean;
	accountId?: string | undefined;
	name?: string | undefined;
	hostname?: string | undefined;
	/** upgrade: permits a --hostname that is not the stored host of the instance. */
	changeHostname?: boolean | undefined;
	/** install: permits a host that has DNS records. */
	replaceDns?: boolean | undefined;
	workerName?: string | undefined;
	/** The prefix of the instance from before the CLI (`soldock`). */
	prefix?: string | undefined;
	bundle?: string | undefined;
	device?: boolean | undefined;
	/** False with --no-rollback. */
	rollback: boolean;
	secretsOut?: string | undefined;
	ownerName?: string | undefined;
	ownerAddress?: string | undefined;
}

export interface Deps {
	/** A compatible wrangler. Tests give a fake. */
	wrangler(ctx: Context, tested: string): Promise<Wrangler>;
}

export const defaultDeps: Deps = { wrangler: (ctx, tested) => ensureWrangler(ctx, tested) };

export interface Session {
	bundle: Bundle;
	account: Account;
	/** Acts in the account of the session. */
	wrangler: Wrangler;
}

export async function openSession(ctx: Context, flags: Flags, deps: Deps): Promise<Session> {
	const bundle = loadBundle(flags.bundle ?? defaultBundleDir());
	const wrangler = await deps.wrangler(ctx, bundle.manifest.wrangler);
	const account = await signIn(ctx, wrangler, {
		...(flags.accountId === undefined ? {} : { accountId: flags.accountId }),
		...(flags.device === undefined ? {} : { device: flags.device }),
	});
	return { bundle, account, wrangler: inAccount(wrangler, account.id) };
}

/** An instance that exists in the account. */
export interface Instance {
	prefix: string;
	workerName: string;
	/** The version that serves the Worker now. */
	versionId: string;
	version: VersionDetail;
}

/**
 * The instance that the flags name, or null when the flags name none. `--name` gives a CLI instance: its
 * Worker name and its prefix are `asterra-<name>`. `--prefix` with `--worker-name` gives the instance
 * from before the CLI. No other mix is possible, so the flags cannot put the resources of one instance
 * on the Worker of a different instance.
 */
export function instanceOfFlags(flags: Flags): { prefix: string; workerName: string } | null {
	if (flags.name !== undefined) {
		if (flags.prefix !== undefined) throw new Refusal("Use --name, or --prefix with --worker-name, not the two.");
		const error = nameError(flags.name);
		if (error) throw new Refusal(`--name: ${error}`);
		const prefix = prefixOf(flags.name);
		if (flags.workerName !== undefined && flags.workerName !== prefix) {
			throw new Refusal(
				`--worker-name: the Worker of the instance "${flags.name}" is ${prefix}. Do not give --worker-name with --name.`,
			);
		}
		return { prefix, workerName: prefix };
	}
	if (flags.prefix !== undefined) {
		const error = nameError(flags.prefix);
		if (error) throw new Refusal(`--prefix: ${error}`);
		if (flags.prefix.startsWith("asterra-")) {
			throw new Refusal(`--prefix: for an instance of the CLI, use --name ${flags.prefix.slice("asterra-".length)}.`);
		}
		if (flags.workerName === undefined) {
			throw new Refusal(
				"--prefix needs --worker-name: the prefix of an instance from before the CLI does not tell its Worker.",
			);
		}
		const workerError = workerNameError(flags.workerName);
		if (workerError) throw new Refusal(`--worker-name: ${workerError}`);
		if (flags.workerName.startsWith("asterra-")) {
			throw new Refusal(
				`--worker-name: ${flags.workerName} is the Worker of an instance of the CLI. Its resources do not have the prefix ${flags.prefix}.`,
			);
		}
		return { prefix: flags.prefix, workerName: flags.workerName };
	}
	if (flags.workerName !== undefined) {
		throw new Refusal(
			`--worker-name needs --prefix (for example --prefix ${LEGACY_PREFIX}). For an instance of the CLI, use --name.`,
		);
	}
	return null;
}

/** Finds the instance of the flags, or asks which instance of the account. */
export async function findInstance(ctx: Context, session: Session, flags: Flags): Promise<Instance> {
	let target = instanceOfFlags(flags);
	if (!target) {
		const found = instancesFromDatabases(await listDatabases(session.wrangler));
		if (found.length === 0) throw new Refusal("This account has no Asterra instance. Use `npx asterra install`.");
		const [only] = found;
		const chosen =
			found.length === 1 && only
				? only
				: await ctx.prompt.choose(
						"Which instance?",
						found.map((instance) => ({
							label: instance.name ?? `${instance.prefix} (from before the CLI)`,
							value: instance,
						})),
						"--name",
					);
		// The database name of the instance from before the CLI does not tell its Worker name, and a guess
		// could deploy onto a different Worker. So there is no default.
		const workerName =
			chosen.workerName ??
			(await ctx.prompt.text(`Worker name of the instance "${chosen.prefix}"?`, {
				flag: `--prefix ${chosen.prefix} --worker-name <name>`,
				validate: (answer) =>
					workerNameError(answer) ??
					(answer.startsWith("asterra-") ? "This is the Worker of an instance of the CLI." : null),
			}));
		target = { prefix: chosen.prefix, workerName };
	}
	const { prefix, workerName } = target;
	const versionId = await currentVersion(session.wrangler, workerName);
	if (versionId === null) {
		throw new Refusal(
			`The Worker ${workerName} has no deployment in this account. Check the name, or use \`npx asterra install\`.`,
		);
	}
	const version = await viewVersion(session.wrangler, workerName, versionId);
	say(ctx, `Instance: Worker ${workerName}, resources ${prefix}-*`);
	return { prefix, workerName, versionId, version };
}

/** The host of a new instance: from --hostname, or asked. */
export async function askHostname(ctx: Context, flags: Flags): Promise<string> {
	if (flags.hostname) {
		const error = hostnameError(flags.hostname);
		if (error) throw new Refusal(`--hostname: ${error}`);
		return flags.hostname;
	}
	return ctx.prompt.text("Host name of the instance (for example work.example.com)?", {
		flag: "--hostname",
		validate: hostnameError,
	});
}

/**
 * The host of an instance that exists. The deploy attaches the host as a custom domain, and it takes the
 * host from a different Worker without a question. So the host comes from the instance (the deploy
 * stored it), and a different --hostname needs --change-hostname, also in a run without questions.
 */
export async function instanceHostname(ctx: Context, flags: Flags, instance: Instance): Promise<string> {
	const stored = instance.version.hostname;
	if (!flags.hostname) {
		if (stored) return stored;
		// An instance from before this check has no stored host. The next deploy stores it.
		return askHostname(ctx, flags);
	}
	const hostname = await askHostname(ctx, flags);
	if (stored && stored !== hostname && !flags.changeHostname) {
		throw new Refusal(
			`--hostname: the host of the instance is ${stored}, not ${hostname}. To move the instance to ${hostname}, add --change-hostname. ` +
				`The deploy then takes ${hostname} from the Worker that has it now.`,
		);
	}
	return hostname;
}

/** In GitHub Actions, gives the workflow the values of the run (`steps.<id>.outputs`). */
export function githubOutput(ctx: Context, values: Record<string, string>): void {
	const file = ctx.env.GITHUB_OUTPUT;
	if (!file) return;
	appendFileSync(
		file,
		Object.entries(values)
			.map(([key, value]) => `${key}=${value}\n`)
			.join(""),
	);
}
