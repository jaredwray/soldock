// `asterra upgrade`: the release of this CLI on an instance that exists.
import {
	appliedMigrations,
	applyMigrations,
	asterraVersion,
	deploy,
	putSecrets,
	rollback,
	secretNames,
	writeConfig,
} from "../cloudflare.ts";
import { type Context, say } from "../context.ts";
import { Refusal } from "../errors.ts";
import { checkUpgrade } from "../manifest.ts";
import { showReleaseNotes } from "../notes.ts";
import { handOver, newEncryptionKey } from "../secrets.ts";
import { askHostname, type Deps, type Flags, findInstance, githubOutput, openSession } from "../session.ts";
import { runSmoke } from "./smoke.ts";

export async function upgrade(ctx: Context, flags: Flags, deps: Deps): Promise<void> {
	const session = await openSession(ctx, flags, deps);
	const { bundle, wrangler } = session;
	const instance = await findInstance(ctx, session, flags);
	const hostname = await askHostname(ctx, flags);
	const target = bundle.manifest.version;
	const running = await asterraVersion(wrangler, instance.workerName, instance.versionId);

	const config = writeConfig(bundle, { workerName: instance.workerName, prefix: instance.prefix, hostname });
	const origin = `https://${hostname}`;
	try {
		// The schema decides, not the version: an instance from before the CLI has no version tag.
		const { pending } = checkUpgrade(await appliedMigrations(wrangler, config), bundle.manifest);
		await showReleaseNotes(ctx, running, target);
		say(ctx, `Upgrade ${instance.workerName} at ${origin}: ${running ?? "a version from before the CLI"} → ${target}`);
		say(ctx, `  Migrations to apply: ${pending.length === 0 ? "none" : pending.join(", ")}`);
		if (!(await ctx.prompt.confirm("Upgrade?", true))) throw new Refusal("Nothing changed.");

		// A migration only adds, or removes what the running Worker does not use, so the running Worker
		// keeps working on the new schema until the deploy replaces it.
		if (pending.length > 0) await applyMigrations(wrangler, config);
		const versionId = await deploy(wrangler, config, target);
		githubOutput(ctx, { url: origin, version: versionId ?? "" });

		if (!(await runSmoke(ctx, origin))) {
			if (flags.rollback && (await ctx.prompt.confirm(`Roll back to the version ${instance.versionId}?`, true))) {
				await rollback(wrangler, instance.workerName, instance.versionId, `Smoke check of Asterra ${target} failed`);
				throw new Refusal(
					`The smoke check failed. The Worker is back on the version ${instance.versionId}. The migrations stay: the earlier Worker works on them.`,
				);
			}
			throw new Refusal("The smoke check failed. See the failures above. The new version stays.");
		}

		if (!(await secretNames(wrangler, instance.workerName)).includes("ENCRYPTION_KEY")) {
			// A run without questions only warns: nobody would see the new key, and a key that nobody kept is lost.
			if (
				ctx.prompt.interactive &&
				(await ctx.prompt.confirm("The Worker has no ENCRYPTION_KEY. Make one now?", true))
			) {
				const encryptionKey = newEncryptionKey();
				await putSecrets(wrangler, instance.workerName, { ENCRYPTION_KEY: encryptionKey });
				say(ctx, "Keep ENCRYPTION_KEY in a password manager. Cloudflare does not show a secret again.");
				handOver(ctx, { ENCRYPTION_KEY: encryptionKey }, flags.secretsOut);
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
