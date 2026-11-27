// `asterra status`, `asterra rollback` and `asterra secrets`.
import {
	appliedMigrations,
	asterraVersion,
	listVersions,
	putSecrets,
	releaseOf,
	rollbackTarget,
	rollback as rollbackWorker,
	runningRelease,
	secretNames,
	viewVersion,
	writeConfig,
} from "../cloudflare.ts";
import { type Context, say } from "../context.ts";
import { Refusal } from "../errors.ts";
import { checkUpgrade } from "../manifest.ts";
import { newSetupToken, openHandOver } from "../secrets.ts";
import { type Deps, type Flags, findInstance, openSession } from "../session.ts";

export async function status(ctx: Context, flags: Flags, deps: Deps): Promise<void> {
	const session = await openSession(ctx, flags, deps);
	const instance = await findInstance(ctx, session, flags);
	const running = await runningRelease(session.wrangler, instance.workerName, instance.version);
	say(ctx, `  Version    ${running ?? "from before the CLI"} (Worker version ${instance.versionId})`);
	say(ctx, `  Host       ${instance.version.hostname ?? "not stored (the next upgrade stores it)"}`);
	// The database config does not need the host.
	const config = writeConfig(session.bundle, { ...instance, hostname: instance.version.hostname ?? "status.invalid" });
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
	const secrets = (await secretNames(session.wrangler, instance.workerName)).sort();
	say(ctx, `  Secrets    ${secrets.length === 0 ? "none" : secrets.join(", ")}`);
	if (!secrets.includes("ENCRYPTION_KEY")) ctx.io.err("warning: the Worker has no ENCRYPTION_KEY.\n");
	if (secrets.includes("SETUP_TOKEN")) {
		ctx.io.err(
			"warning: SETUP_TOKEN exists. It allows a directory reset. Delete it after setup: npx asterra secrets clear-setup-token\n",
		);
	}
}

/** The name of a release for the operator. */
const releaseName = (tag: string | null | undefined) => {
	const version = asterraVersion(tag ?? null);
	return version ? `Asterra ${version}` : "a release from before the CLI";
};

export async function rollback(ctx: Context, flags: Flags, deps: Deps): Promise<void> {
	const session = await openSession(ctx, flags, deps);
	const { wrangler } = session;
	const instance = await findInstance(ctx, session, flags);
	const { workerName } = instance;
	const versions = await listVersions(wrangler, workerName);
	const found = rollbackTarget(versions, instance.versionId);
	const manual = `To select a version, use \`wrangler versions list --name ${workerName}\` and \`wrangler rollback <version-id> --name ${workerName}\`.`;
	if (!found) {
		throw new Refusal(
			`The CLI cannot find the deploy of the version ${instance.versionId}: wrangler lists only the 10 newest versions. ${manual}`,
		);
	}
	if (!found.target) {
		throw new Refusal(`wrangler lists no version from before ${releaseName(found.current.tag)}. ${manual}`);
	}
	const target = await viewVersion(wrangler, workerName, found.target.id);
	const targetRelease = releaseOf(versions, target.id);

	say(ctx, `Roll back ${workerName}:`);
	say(ctx, `  from  the version ${instance.versionId} (${releaseName(found.current.tag)})`);
	say(
		ctx,
		`  to    the version ${target.id} (${targetRelease ? releaseName(targetRelease.tag) : "a release that wrangler does not list"})`,
	);
	say(ctx, "The migrations stay. The earlier Worker works on them, unless the release notes say otherwise.");

	// A version holds its secrets, so a rollback also brings back the secrets of the target.
	const now = new Set(instance.version.secretNames);
	const then = new Set(target.secretNames);
	const lost = [...now].filter((name) => !then.has(name)).sort();
	const back = [...then].filter((name) => !now.has(name)).sort();
	if (lost.length > 0 || back.length > 0) {
		if (lost.length > 0)
			say(ctx, `The target version does not have: ${lost.join(", ")}. The Worker loses these secrets.`);
		if (back.length > 0) say(ctx, `The target version has: ${back.join(", ")}. These secrets come back.`);
		if (back.includes("SETUP_TOKEN")) say(ctx, "A SETUP_TOKEN allows a directory reset. Delete it after the rollback.");
		if (!ctx.prompt.interactive) {
			throw new Refusal(
				"The secrets of the target version are different. A run without questions does not do this rollback. Run the command on a terminal.",
			);
		}
		if (!(await ctx.prompt.confirm("Roll back, with these secret changes?", false))) {
			throw new Refusal("Nothing changed.");
		}
	} else if (!(await ctx.prompt.confirm("Roll back?", true))) {
		throw new Refusal("Nothing changed.");
	}
	await rollbackWorker(wrangler, workerName, target.id, "npx asterra rollback");
	say(ctx, `The Worker ${workerName} is on the version ${target.id}.`);
}

export async function secrets(ctx: Context, flags: Flags, deps: Deps, action: string | undefined): Promise<void> {
	if (action !== "setup-token" && action !== "clear-setup-token") {
		throw new Refusal("Use `asterra secrets setup-token` or `asterra secrets clear-setup-token`.");
	}
	if (action === "clear-setup-token") {
		const session = await openSession(ctx, flags, deps);
		const instance = await findInstance(ctx, session, flags);
		await putSecrets(session.wrangler, instance.workerName, { SETUP_TOKEN: null });
		say(ctx, "The CLI deleted SETUP_TOKEN.");
		return;
	}
	if (!ctx.prompt.interactive && !flags.secretsOut) {
		throw new Refusal("A run without questions needs --secrets-out <file> for the new token.");
	}
	// The file for the token comes first: a path that does not work must stop the run before the change.
	const handOver = openHandOver(ctx, flags.secretsOut);
	try {
		const session = await openSession(ctx, flags, deps);
		const instance = await findInstance(ctx, session, flags);
		say(ctx, "A SETUP_TOKEN allows first-run setup and a directory reset (Start fresh), which deletes all accounts.");
		if (!(await ctx.prompt.confirm("Make a new SETUP_TOKEN?", true))) throw new Refusal("Nothing changed.");
		const token = newSetupToken();
		await putSecrets(session.wrangler, instance.workerName, { SETUP_TOKEN: token });
		handOver.give({ SETUP_TOKEN: token });
		say(ctx, "Delete it when you are done: npx asterra secrets clear-setup-token");
	} finally {
		handOver.done();
	}
}
