// `asterra install`: a new instance in an account.
import { applyMigrations, currentVersion, deploy, listDatabases, putSecrets, writeConfig } from "../cloudflare.ts";
import { type Context, say } from "../context.ts";
import { Refusal } from "../errors.ts";
import { DIRECTORY_SUFFIX, nameError, prefixOf, resourceName, suggestName } from "../names.ts";
import { newEncryptionKey, newSetupToken, openHandOver } from "../secrets.ts";
import { askHostname, type Deps, type Flags, githubOutput, openSession } from "../session.ts";
import { askOwner, createOwner, waitForOwner } from "../setup.ts";
import { runSmoke } from "./smoke.ts";

export async function install(ctx: Context, flags: Flags, deps: Deps): Promise<void> {
	// ENCRYPTION_KEY must reach the operator. A run without questions has no terminal to show it on.
	if (!ctx.prompt.interactive && !flags.secretsOut) {
		throw new Refusal("A run without questions needs --secrets-out <file> for the new secrets.");
	}
	if (flags.prefix !== undefined || flags.workerName !== undefined) {
		throw new Refusal("install makes a new instance. Give its name with --name, not --prefix or --worker-name.");
	}
	// The file for the secrets comes first: a path that does not work must stop the run before the deploy.
	const handOver = openHandOver(ctx, flags.secretsOut);
	try {
		await installInstance(ctx, flags, deps, handOver);
	} finally {
		handOver.done();
	}
}

async function installInstance(
	ctx: Context,
	flags: Flags,
	deps: Deps,
	handOver: ReturnType<typeof openHandOver>,
): Promise<void> {
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

	// No flag skips these two checks: an install on an instance that exists would replace its Worker and
	// its secrets.
	const directory = resourceName(prefix, DIRECTORY_SUFFIX);
	if ((await listDatabases(wrangler)).includes(directory)) {
		throw new Refusal(
			`The instance "${name}" exists: the account has the database ${directory}. Use \`npx asterra upgrade --name ${name}\`.`,
		);
	}
	if ((await currentVersion(wrangler, workerName)) !== null) {
		throw new Refusal(
			`The account has a Worker with the name ${workerName}. An install would replace it. Use a different --name, or \`npx asterra upgrade --name ${name}\` if it is an instance.`,
		);
	}
	await checkDns(ctx, flags, hostname);

	say(ctx);
	say(ctx, `Asterra ${bundle.manifest.version} goes into the account ${session.account.name}:`);
	say(ctx, `  Worker     ${workerName}, at https://${hostname} (the deploy makes its DNS record)`);
	say(ctx, `  Resources  ${prefix}-* (a D1 database, an R2 bucket, queues)`);
	say(ctx, "  Secrets    SETUP_TOKEN (the CLI deletes it after setup) and ENCRYPTION_KEY (keep a copy)");
	if (!(await ctx.prompt.confirm("Install?", true))) throw new Refusal("Nothing changed.");

	const config = writeConfig(bundle, { workerName, prefix, hostname });
	const origin = `https://${hostname}`;
	githubOutput(ctx, { url: origin });
	let result = "failed";
	try {
		// The deploy creates the database, so the migrations come after it. Until then, the Worker
		// answers but has no schema: setup is not open yet, because SETUP_TOKEN does not exist.
		const versionId = await deploy(wrangler, config, bundle.manifest.version);
		githubOutput(ctx, { version: versionId });
		await applyMigrations(wrangler, config);
		const setupToken = newSetupToken();
		const encryptionKey = newEncryptionKey();
		await putSecrets(wrangler, workerName, { SETUP_TOKEN: setupToken, ENCRYPTION_KEY: encryptionKey });
		// The key goes to the operator before any step that can fail. Cloudflare does not show it again.
		handOver.give({ ENCRYPTION_KEY: encryptionKey });
		say(
			ctx,
			"Keep ENCRYPTION_KEY in a password manager. Cloudflare does not show a secret again, and a restore needs it.",
		);

		if (!(await runSmoke(ctx, origin))) {
			throw new Refusal(
				`wrangler deployed the instance, but the smoke check failed. See the failures above. The Worker has ENCRYPTION_KEY (you have its value) and a SETUP_TOKEN that nobody has. When the host answers, run \`npx asterra secrets setup-token --name ${name}\` for a new token.`,
			);
		}
		result = "passed";

		const ownerFlags = flags.ownerName !== undefined || flags.ownerAddress !== undefined;
		const inTerminal =
			ownerFlags ||
			(ctx.prompt.interactive &&
				(await ctx.prompt.confirm("Create the owner here in the terminal? (No: in the browser)", false)));
		if (inTerminal) {
			const owner = await askOwner(ctx, { name: flags.ownerName, address: flags.ownerAddress });
			await createOwner(ctx, origin, setupToken, owner);
			say(ctx, `The owner exists. Sign in at ${origin} with ${owner.address} and the password.`);
			say(ctx, "Setup creates no API key. Create keys in Settings › API keys.");
			await putSecrets(wrangler, workerName, { SETUP_TOKEN: null });
			say(ctx, "The CLI deleted SETUP_TOKEN.");
		} else if (ctx.prompt.interactive) {
			handOver.give({ SETUP_TOKEN: setupToken });
			say(ctx, `Open ${origin}, enter SETUP_TOKEN, and create the owner. This command waits (Ctrl+C stops it).`);
			await waitForOwner(ctx, origin, setupToken);
			await putSecrets(wrangler, workerName, { SETUP_TOKEN: null });
			say(ctx, "The owner exists, and the CLI deleted SETUP_TOKEN.");
		} else {
			handOver.give({ SETUP_TOKEN: setupToken });
			say(ctx, `Open ${origin}, enter SETUP_TOKEN, and create the owner.`);
			say(ctx, `Then delete the token: npx asterra secrets clear-setup-token --name ${name}`);
		}
		say(ctx);
		say(ctx, `Asterra ${bundle.manifest.version} runs at ${origin}.`);
		say(ctx, `Upgrade it later with: npx asterra upgrade --name ${name}`);
	} finally {
		githubOutput(ctx, { result });
		config.remove();
	}
}

/**
 * Refuses a host that has DNS records. The deploy attaches the host as a custom domain: it replaces a
 * record that conflicts, and it takes the host from a different Worker without a question.
 */
async function checkDns(ctx: Context, flags: Flags, hostname: string): Promise<void> {
	if (flags.replaceDns) return;
	let records: string[];
	try {
		records = await ctx.resolveHost(hostname);
	} catch (error) {
		throw new Refusal(
			`The CLI could not look up ${hostname} in DNS (${(error as Error).message}). Try again. If you know that nothing uses the host, add --replace-dns.`,
		);
	}
	if (records.length > 0) {
		throw new Refusal(
			`The host ${hostname} has DNS records (${records.slice(0, 4).join(", ")}), so a service can use it now. The deploy replaces these records. Use a host with no DNS record, or add --replace-dns.`,
		);
	}
}
