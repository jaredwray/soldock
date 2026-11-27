// The Cloudflare login and the account of a run. A person signs in with `wrangler login`. CI sets
// CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. The CLI always tells wrangler the account, so a run
// cannot change a different account of the same login. wrangler.ts starts each command in a folder of the
// CLI, because an `account_id` in a config file of the working directory replaces that variable.
import { type Context, say } from "./context.ts";
import { Refusal } from "./errors.ts";
import { jsonOutput, lastLines, type Wrangler } from "./wrangler.ts";

export interface Account {
	id: string;
	name: string;
}

interface WhoAmI {
	loggedIn?: boolean;
	accounts?: Account[];
}

export interface SignInOptions {
	/** An account id or name (--account-id). */
	accountId?: string;
	/** Sign in with a code on a different device (--device). */
	device?: boolean;
}

const ACCOUNT_ID = /^[0-9a-f]{32}$/;

/** Signs in when necessary, and returns the account of the run. */
export async function signIn(ctx: Context, wrangler: Wrangler, options: SignInOptions = {}): Promise<Account> {
	const wanted = options.accountId ?? ctx.env.CLOUDFLARE_ACCOUNT_ID;
	// A token with an account id needs no `whoami`: a token can have no right to read its user or its
	// accounts. The first command in the account shows a token that does not work.
	if (ctx.env.CLOUDFLARE_API_TOKEN && wanted && ACCOUNT_ID.test(wanted)) {
		say(ctx, `Cloudflare account: ${wanted} (from CLOUDFLARE_API_TOKEN)`);
		return { id: wanted, name: wanted };
	}
	let { who, detail } = await whoami(wrangler);
	if (!who) {
		if (ctx.env.CLOUDFLARE_API_TOKEN) {
			throw new Refusal(
				`wrangler cannot sign in with CLOUDFLARE_API_TOKEN. Check the token and its permissions, or give the account id (32 hex characters) with --account-id or CLOUDFLARE_ACCOUNT_ID.${detail}`,
			);
		}
		if (!ctx.prompt.interactive) {
			throw new Refusal(
				`You are not signed in to Cloudflare. Run \`wrangler login\`, or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.${detail}`,
			);
		}
		// Over SSH, the browser of the operator cannot reach the login callback on this computer.
		const device = options.device ?? Boolean(ctx.env.SSH_CONNECTION || ctx.env.SSH_TTY);
		const how = device ? "wrangler shows a code to enter on any device." : "Your browser opens.";
		if (!(await ctx.prompt.confirm(`You are not signed in to Cloudflare. Sign in now? ${how}`, true))) {
			throw new Refusal("Sign in with `wrangler login`, then run the command again.");
		}
		const login = await wrangler.run(device ? ["login", "--device"] : ["login"], { stdio: "terminal" });
		if (login.code !== 0) throw new Refusal("The sign-in to Cloudflare did not finish.");
		({ who, detail } = await whoami(wrangler));
		if (!who) throw new Refusal(`wrangler shows no signed-in user after the login.${detail}`);
	}

	const accounts = who.accounts ?? [];
	let account: Account | undefined;
	if (wanted) {
		account = accounts.find((item) => item.id === wanted || item.name === wanted);
		// A token can have no right to list its accounts. An account id still works.
		if (!account && accounts.length === 0 && ACCOUNT_ID.test(wanted)) account = { id: wanted, name: wanted };
		if (!account) {
			const names = accounts.map((item) => `${item.name} (${item.id})`).join(", ") || "none";
			throw new Refusal(`This login has no account "${wanted}". Its accounts: ${names}.`);
		}
	} else if (accounts.length === 0) {
		throw new Refusal("This login has no Cloudflare account.");
	} else if (accounts.length === 1) {
		[account] = accounts;
	} else {
		account = await ctx.prompt.choose(
			"Which Cloudflare account?",
			accounts.map((item) => ({ label: `${item.name} (${item.id})`, value: item })),
			"--account-id",
		);
	}
	if (!account) throw new Refusal("This login has no Cloudflare account.");
	say(ctx, `Cloudflare account: ${account.name} (${account.id})`);
	return account;
}

/** A wrangler whose commands act in one account. */
export function inAccount(wrangler: Wrangler, accountId: string): Wrangler {
	return {
		version: wrangler.version,
		run: (args, options = {}) =>
			wrangler.run(args, { ...options, env: { ...options.env, CLOUDFLARE_ACCOUNT_ID: accountId } }),
	};
}

/** The signed-in user, or null with the last lines that wrangler wrote about the failure. */
async function whoami(wrangler: Wrangler): Promise<{ who: WhoAmI | null; detail: string }> {
	const result = await wrangler.run(["whoami", "--json"]);
	const who = jsonOutput<WhoAmI>(result.stdout);
	if (result.code === 0 && who?.loggedIn) return { who, detail: "" };
	// Without a login, wrangler writes `{"loggedIn": false}` and no error.
	const lines = lastLines(result.stderr);
	return { who: null, detail: lines ? `\nwrangler whoami:\n${lines}` : "" };
}
