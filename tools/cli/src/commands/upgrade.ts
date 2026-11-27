// `asterra upgrade`: the release of this CLI on an instance that exists.
import {
	appliedMigrations,
	applyMigrations,
	type ConfigFile,
	deploy,
	putSecrets,
	rollback,
	runningRelease,
	secretNames,
	writeConfig,
} from "../cloudflare.ts";
import { type Context, say } from "../context.ts";
import { Refusal } from "../errors.ts";
import { checkUpgrade } from "../manifest.ts";
import { showReleaseNotes } from "../notes.ts";
import { type HandOver, newEncryptionKey, openHandOver } from "../secrets.ts";
import {
	type Deps,
	type Flags,
	findInstance,
	githubOutput,
	type Instance,
	instanceHostname,
	openSession,
} from "../session.ts";
import type { Wrangler } from "../wrangler.ts";
import { runSmoke } from "./smoke.ts";

export async function upgrade(ctx: Context, flags: Flags, deps: Deps): Promise<void> {
	// The upgrade can make ENCRYPTION_KEY. The file for it comes first: a path that does not work must
	// stop the run before the deploy.
	const handOver = openHandOver(ctx, flags.secretsOut);
	try {
		await upgradeInstance(ctx, flags, deps, handOver);
	} finally {
		handOver.done();
	}
}

async function upgradeInstance(ctx: Context, flags: Flags, deps: Deps, handOver: HandOver): Promise<void> {
	const session = await openSession(ctx, flags, deps);
	const { bundle, wrangler } = session;
	const instance = await findInstance(ctx, session, flags);
	const hostname = await instanceHostname(ctx, flags, instance);
	const target = bundle.manifest.version;
	const running = await runningRelease(wrangler, instance.workerName, instance.version);

	const config = writeConfig(bundle, { workerName: instance.workerName, prefix: instance.prefix, hostname });
	const origin = `https://${hostname}`;
	try {
		// The schema decides, not the version: an instance from before the CLI has no version tag.
		const { pending } = checkUpgrade(await appliedMigrations(wrangler, config), bundle.manifest);
		await showReleaseNotes(ctx, running, target);
		say(ctx, `Upgrade ${instance.workerName} at ${origin}: ${running ?? "a version from before the CLI"} → ${target}`);
		say(ctx, `  Migrations to apply: ${pending.length === 0 ? "none" : pending.join(", ")}`);
		if (instance.version.hostname && instance.version.hostname !== hostname) {
			say(ctx, `  Host: ${instance.version.hostname} → ${hostname} (--change-hostname)`);
		}
		if (!(await ctx.prompt.confirm("Upgrade?", true))) throw new Refusal("Nothing changed.");

		// A migration only adds, or removes what the running Worker does not use, so the running Worker
		// keeps working on the new schema until the deploy replaces it.
		if (pending.length > 0) await applyMigrations(wrangler, config);
		await deployAndCheck(ctx, flags, wrangler, instance, config, origin, target);

		if (!(await secretNames(wrangler, instance.workerName)).includes("ENCRYPTION_KEY")) {
			// A run without questions only warns: nobody would see the new key, and a key that nobody kept is lost.
			if (
				ctx.prompt.interactive &&
				(await ctx.prompt.confirm("The Worker has no ENCRYPTION_KEY. Make one now?", true))
			) {
				const encryptionKey = newEncryptionKey();
				await putSecrets(wrangler, instance.workerName, { ENCRYPTION_KEY: encryptionKey });
				handOver.give({ ENCRYPTION_KEY: encryptionKey });
				say(ctx, "Keep ENCRYPTION_KEY in a password manager. Cloudflare does not show a secret again.");
			} else {
				ctx.io.err(
					`warning: the Worker ${instance.workerName} has no ENCRYPTION_KEY. Set it (32 random bytes, base64url) and keep a copy.\n`,
				);
			}
		}
		say(ctx, `Asterra ${target} runs at ${origin}.`);
	} finally {
		config.remove();
	}
}

/**
 * Deploys, runs the smoke check, and rolls back when the check fails. A GitHub Actions workflow gets
 * the result of each path: `passed`, `rolled_back`, or `failed` (the new version can serve the host).
 */
async function deployAndCheck(
	ctx: Context,
	flags: Flags,
	wrangler: Wrangler,
	instance: Instance,
	config: ConfigFile,
	origin: string,
	target: string,
): Promise<void> {
	githubOutput(ctx, { url: origin });
	let result = "failed";
	try {
		const versionId = await deploy(wrangler, config, target);
		githubOutput(ctx, { version: versionId });
		if (await runSmoke(ctx, origin)) {
			result = "passed";
			return;
		}
		if (flags.rollback && (await ctx.prompt.confirm(`Roll back to the version ${instance.versionId}?`, true))) {
			// The version id from before the deploy: the same release with the same secrets.
			try {
				await rollback(wrangler, instance.workerName, instance.versionId, `Smoke check of Asterra ${target} failed`);
			} catch (error) {
				if (!(error instanceof Refusal)) throw error;
				throw new Refusal(
					`The smoke check failed, and the rollback to the version ${instance.versionId} failed too. The new version stays. ${error.message}`,
				);
			}
			result = "rolled_back";
			throw new Refusal(
				`The smoke check failed. The Worker is back on the version ${instance.versionId}. The migrations stay: the earlier Worker works on them.`,
			);
		}
		throw new Refusal("The smoke check failed. See the failures above. The new version stays.");
	} finally {
		githubOutput(ctx, { result });
	}
}
