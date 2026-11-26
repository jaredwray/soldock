// `asterra install`: a new instance in an account.
import { applyMigrations, deploy, listDatabases, putSecrets, writeConfig } from "../cloudflare.ts";
import { type Context, say } from "../context.ts";
import { Refusal } from "../errors.ts";
import { DIRECTORY_SUFFIX, nameError, prefixOf, resourceName, suggestName } from "../names.ts";
import { handOver, newEncryptionKey, newSetupToken } from "../secrets.ts";
import { askHostname, type Deps, type Flags, githubOutput, openSession } from "../session.ts";
import { askOwner, createOwner, waitForOwner } from "../setup.ts";
import { runSmoke } from "./smoke.ts";

export async function install(ctx: Context, flags: Flags, deps: Deps): Promise<void> {
	// ENCRYPTION_KEY must reach the operator. A run without questions has no terminal to show it on.
	if (!ctx.prompt.interactive && !flags.secretsOut) {
		throw new Refusal("A run without questions needs --secrets-out <file> for the new secrets.");
	}
	const session = await openSession(ctx, flags, deps);
	const { bundle, wrangler } = session;
	const hostname = await askHostname(ctx, flags);
	const name =
		flags.name ??
		(await ctx.prompt.text("Name of the instance?", {
			default: suggestName(hostname),
			flag: "--name",
			validate: nameError,
		}));
	const nameProblem = nameError(name);
	if (nameProblem) throw new Refusal(`--name: ${nameProblem}`);
	const prefix = prefixOf(name);
	const workerName = prefix;

	const directory = resourceName(prefix, DIRECTORY_SUFFIX);
	if ((await listDatabases(wrangler)).includes(directory)) {
		throw new Refusal(
			`The instance "${name}" exists: the account has the database ${directory}. Use \`npx asterra upgrade --name ${name}\`.`,
		);
	}

	say(ctx);
	say(ctx, `Asterra ${bundle.manifest.version} goes into the account ${session.account.name}:`);
	say(ctx, `  Worker     ${workerName}, at https://${hostname} (the deploy makes its DNS record)`);
	say(ctx, `  Resources  ${prefix}-* (a D1 database, an R2 bucket, queues)`);
	say(ctx, `  Secrets    SETUP_TOKEN (deleted after setup) and ENCRYPTION_KEY (keep a copy)`);
	if (!(await ctx.prompt.confirm("Install?", true))) throw new Refusal("Nothing changed.");

	const config = writeConfig(bundle, { workerName, prefix, hostname });
	const origin = `https://${hostname}`;
	try {
		// The deploy creates the database, so the migrations come after it. Until then, the Worker
		// answers but has no schema: setup is not open yet, because SETUP_TOKEN does not exist.
		const versionId = await deploy(wrangler, config, bundle.manifest.version);
		await applyMigrations(wrangler, config);
		const setupToken = newSetupToken();
		const encryptionKey = newEncryptionKey();
		await putSecrets(wrangler, workerName, { SETUP_TOKEN: setupToken, ENCRYPTION_KEY: encryptionKey });
		githubOutput(ctx, { url: origin, version: versionId ?? "" });

		if (!(await runSmoke(ctx, origin))) {
			throw new Refusal(
				`The instance is deployed, but the smoke check failed. See the failures above. ENCRYPTION_KEY and SETUP_TOKEN are set: run \`npx asterra secrets setup-token --name ${name}\` for a new token.`,
			);
		}

		say(
			ctx,
			"Keep ENCRYPTION_KEY in a password manager. Cloudflare does not show a secret again, and a restore needs it.",
		);
		const ownerFlags = flags.ownerName !== undefined || flags.ownerAddress !== undefined;
		const inTerminal =
			ownerFlags ||
			(ctx.prompt.interactive &&
				(await ctx.prompt.confirm("Create the owner here in the terminal? (No: in the browser)", false)));
		if (inTerminal) {
			handOver(ctx, { ENCRYPTION_KEY: encryptionKey }, flags.secretsOut);
			const owner = await askOwner(ctx, { name: flags.ownerName, address: flags.ownerAddress });
			const apiKey = await createOwner(ctx, origin, setupToken, owner);
			await putSecrets(wrangler, workerName, { SETUP_TOKEN: null });
			say(ctx, "The owner exists, and SETUP_TOKEN is deleted. The first API key of the owner (it shows one time):");
			say(ctx, `  ${apiKey}`);
		} else if (ctx.prompt.interactive) {
			handOver(ctx, { ENCRYPTION_KEY: encryptionKey, SETUP_TOKEN: setupToken }, flags.secretsOut);
			say(ctx, `Open ${origin}, enter SETUP_TOKEN, and create the owner. This command waits (Ctrl+C stops it).`);
			await waitForOwner(ctx, origin, setupToken);
			await putSecrets(wrangler, workerName, { SETUP_TOKEN: null });
			say(ctx, "The owner exists, and SETUP_TOKEN is deleted.");
		} else {
			handOver(ctx, { ENCRYPTION_KEY: encryptionKey, SETUP_TOKEN: setupToken }, flags.secretsOut);
			say(ctx, `Open ${origin}, enter SETUP_TOKEN, and create the owner.`);
			say(ctx, `Then delete the token: npx asterra secrets clear-setup-token --name ${name}`);
		}
		say(ctx);
		say(ctx, `Asterra ${bundle.manifest.version} runs at ${origin}.`);
		say(ctx, `Upgrade it later with: npx asterra upgrade --name ${name} --hostname ${hostname}`);
	} finally {
		config.remove();
	}
}
