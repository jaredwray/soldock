// `asterra status`, `asterra rollback` and `asterra secrets`.
import {
	appliedMigrations,
	asterraVersion,
	putSecrets,
	rollback as rollbackWorker,
	secretNames,
	writeConfig,
} from "../cloudflare.ts";
import { type Context, say } from "../context.ts";
import { Refusal } from "../errors.ts";
import { checkUpgrade } from "../manifest.ts";
import { handOver, newSetupToken } from "../secrets.ts";
import { type Deps, type Flags, findInstance, openSession } from "../session.ts";

export async function status(ctx: Context, flags: Flags, deps: Deps): Promise<void> {
	const session = await openSession(ctx, flags, deps);
	const instance = await findInstance(ctx, session, flags);
	const running = await asterraVersion(session.wrangler, instance.workerName, instance.versionId);
	say(ctx, `  Version    ${running ?? "from before the CLI"} (Worker version ${instance.versionId})`);
	// The database config does not need the host.
	const config = writeConfig(session.bundle, { ...instance, hostname: "status.invalid" });
	try {
		const applied = await appliedMigrations(session.wrangler, config);
		say(ctx, `  Migrations ${applied.length} applied`);
		try {
			const { pending } = checkUpgrade(applied, session.bundle.manifest);
			say(ctx, `  Upgrade    ${session.bundle.manifest.version}: ${pending.length} migrations to apply`);
		} catch (error) {
			if (!(error instanceof Refusal)) throw error;
			say(ctx, `  Upgrade    not possible with this CLI: ${error.message}`);
		}
	} finally {
		config.remove();
	}
	const secrets = await secretNames(session.wrangler, instance.workerName);
	say(ctx, `  Secrets    ${secrets.length === 0 ? "none" : secrets.sort().join(", ")}`);
	if (!secrets.includes("ENCRYPTION_KEY")) ctx.io.err("warning: the Worker has no ENCRYPTION_KEY.\n");
	if (secrets.includes("SETUP_TOKEN")) {
		ctx.io.err(
			"warning: SETUP_TOKEN exists. It allows a directory reset. Delete it after setup: npx asterra secrets clear-setup-token\n",
		);
	}
}

export async function rollback(ctx: Context, flags: Flags, deps: Deps): Promise<void> {
	const session = await openSession(ctx, flags, deps);
	const instance = await findInstance(ctx, session, flags);
	say(ctx, `Roll back ${instance.workerName} from the version ${instance.versionId} to the version before it.`);
	say(ctx, "The migrations stay. The earlier Worker works on them, unless the release notes say otherwise.");
	if (!(await ctx.prompt.confirm("Roll back?", true))) throw new Refusal("Nothing changed.");
	await rollbackWorker(session.wrangler, instance.workerName, null, "npx asterra rollback");
}

export async function secrets(ctx: Context, flags: Flags, deps: Deps, action: string | undefined): Promise<void> {
	if (action !== "setup-token" && action !== "clear-setup-token") {
		throw new Refusal("Use `asterra secrets setup-token` or `asterra secrets clear-setup-token`.");
	}
	if (action === "setup-token" && !ctx.prompt.interactive && !flags.secretsOut) {
		throw new Refusal("A run without questions needs --secrets-out <file> for the new token.");
	}
	const session = await openSession(ctx, flags, deps);
	const instance = await findInstance(ctx, session, flags);
	if (action === "clear-setup-token") {
		await putSecrets(session.wrangler, instance.workerName, { SETUP_TOKEN: null });
		say(ctx, "SETUP_TOKEN is deleted.");
		return;
	}
	say(ctx, "A SETUP_TOKEN allows first-run setup and a directory reset (Start fresh), which deletes all accounts.");
	if (!(await ctx.prompt.confirm("Make a new SETUP_TOKEN?", true))) throw new Refusal("Nothing changed.");
	const token = newSetupToken();
	await putSecrets(session.wrangler, instance.workerName, { SETUP_TOKEN: token });
	handOver(ctx, { SETUP_TOKEN: token }, flags.secretsOut);
	say(ctx, "Delete it when you are done: npx asterra secrets clear-setup-token");
}
