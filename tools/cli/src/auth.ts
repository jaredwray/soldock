// The Cloudflare login and the account of a run. A person signs in with `wrangler login`. CI sets
// CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. The CLI always tells wrangler the account, so a run
// cannot change a different account of the same login.
import { type Context, say } from "./context.ts";
import { Refusal } from "./errors.ts";
import { jsonOutput, type Wrangler } from "./wrangler.ts";

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

/** Signs in when necessary, and returns the account of the run. */
export async function signIn(ctx: Context, wrangler: Wrangler, options: SignInOptions = {}): Promise<Account> {
	let who = await whoami(wrangler);
	if (!who) {
		if (ctx.env.CLOUDFLARE_API_TOKEN) {
			throw new Refusal("wrangler cannot sign in with CLOUDFLARE_API_TOKEN. Check the token and its permissions.");
		}
		if (!ctx.prompt.interactive) {
			throw new Refusal(
				"You are not signed in to Cloudflare. Run `wrangler login`, or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.",
			);
		}
		// Over SSH, the browser of the operator cannot reach the login callback on this computer.
		const device = options.device ?? Boolean(ctx.env.SSH_CONNECTION || ctx.env.SSH_TTY);
		const how = device ? "wrangler shows a code to enter on any device." : "Your browser opens.";
		if (!(await ctx.prompt.confirm(`You are not signed in to Cloudflare. Sign in now? ${how}`, true))) {
			throw new Refusal("Sign in with `wrangler login`, then run the command again.");
		}
		const login = await wrangler.run(device ? ["login", "--device"] : ["login"], { terminal: true });
		if (login.code !== 0) throw new Refusal("The sign-in to Cloudflare did not finish.");
		who = await whoami(wrangler);
		if (!who) throw new Refusal("wrangler shows no signed-in user after the login.");
	}

	const accounts = who.accounts ?? [];
	const wanted = options.accountId ?? ctx.env.CLOUDFLARE_ACCOUNT_ID;
	let account: Account | undefined;
	if (wanted) {
		account = accounts.find((item) => item.id === wanted || item.name === wanted);
		// A token can have no right to list its accounts. An account id still works.
		if (!account && accounts.length === 0 && /^[0-9a-f]{32}$/.test(wanted)) account = { id: wanted, name: wanted };
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

async function whoami(wrangler: Wrangler): Promise<WhoAmI | null> {
	const result = await wrangler.run(["whoami", "--json"]);
	if (result.code !== 0) return null;
	const who = jsonOutput<WhoAmI>(result.stdout);
	return who?.loggedIn ? who : null;
}
