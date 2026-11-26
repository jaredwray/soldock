// What each command that acts on Cloudflare starts with: the bundle, a wrangler, the account and the
// instance. And the flags that all commands share.
import { appendFileSync } from "node:fs";
import { type Account, inAccount, signIn } from "./auth.ts";
import { type Bundle, defaultBundleDir, loadBundle } from "./bundle.ts";
import { currentVersion, listDatabases } from "./cloudflare.ts";
import { type Context, say } from "./context.ts";
import { Refusal } from "./errors.ts";
import { hostnameError, instancesFromDatabases, nameError, prefixOf } from "./names.ts";
import { ensureWrangler, type Wrangler } from "./wrangler.ts";

export interface Flags {
	yes: boolean;
	accountId?: string | undefined;
	name?: string | undefined;
	hostname?: string | undefined;
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
}

/** Finds the instance of the flags, or asks which instance of the account. */
export async function findInstance(ctx: Context, session: Session, flags: Flags): Promise<Instance> {
	let prefix: string;
	let workerName: string | undefined = flags.workerName;
	if (flags.prefix) {
		prefix = flags.prefix;
	} else if (flags.name) {
		const error = nameError(flags.name);
		if (error) throw new Refusal(`--name: ${error}`);
		prefix = prefixOf(flags.name);
		workerName ??= prefix;
	} else {
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
		prefix = chosen.prefix;
		workerName ??= chosen.workerName ?? undefined;
	}
	if (workerName === undefined) {
		// The database name of the instance from before the CLI does not tell its Worker name, and a guess
		// could deploy onto a different Worker. So there is no default.
		workerName = await ctx.prompt.text(`Worker name of the instance "${prefix}"?`, { flag: "--worker-name" });
	}
	const versionId = await currentVersion(session.wrangler, workerName);
	if (versionId === null) {
		throw new Refusal(
			`The Worker ${workerName} has no deployment in this account. Check the name, or use \`npx asterra install\`.`,
		);
	}
	say(ctx, `Instance: Worker ${workerName}, resources ${prefix}-*`);
	return { prefix, workerName, versionId };
}

/** The host of the instance: from --hostname, or asked. */
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
