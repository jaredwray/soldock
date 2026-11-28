// First-run setup of a new instance: the owner. Setup creates no API key. The CLI deletes SETUP_TOKEN
// after setup, because a valid token turns on "Start fresh", which deletes the directory.
import { type Context, say } from "./context.ts";
import { Refusal } from "./errors.ts";

export interface Owner {
	displayName: string;
	address: string;
	password: string;
}

/**
 * Waits until the owner exists. While SETUP_TOKEN exists, `GET /auth/setup` always says that setup is
 * necessary, so the CLI asks `POST /auth/setup/verify` with the token.
 */
export async function waitForOwner(ctx: Context, origin: string, token: string): Promise<void> {
	for (;;) {
		try {
			const response = await ctx.fetch(`${origin}/auth/setup/verify`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}` },
			});
			if (response.ok) {
				const result = (await response.json()) as { directory?: string };
				if (result.directory === "has_accounts") return;
			}
		} catch {
			// The host does not answer yet, or for a moment. Ask again.
		}
		await ctx.sleep(5000);
	}
}

/** Runs setup from the terminal. The owner then signs in with the address and the password. */
export async function createOwner(ctx: Context, origin: string, token: string, owner: Owner): Promise<void> {
	const response = await ctx.fetch(`${origin}/auth/setup`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify({
			mail_domain: domainOf(owner.address),
			display_name: owner.displayName,
			address: owner.address,
			password: owner.password,
		}),
	});
	if (response.status !== 201) {
		const result = (await response.json().catch(() => ({}))) as { detail?: string };
		throw new Refusal(`Setup failed (${response.status}): ${result.detail ?? "no detail"}`);
	}
}

/** The domain of an address. Setup uses it as the first mail domain. */
export function domainOf(address: string): string {
	return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/** Asks for the owner, or takes it from the flags and ASTERRA_OWNER_PASSWORD. */
export async function askOwner(
	ctx: Context,
	flags: { name?: string | undefined; address?: string | undefined },
): Promise<Owner> {
	const displayName =
		flags.name ?? (await ctx.prompt.text("Name of the owner?", { flag: "--owner-name", validate: notEmpty }));
	const address =
		flags.address ??
		(await ctx.prompt.text("Address of the owner (it also sets the first mail domain)?", {
			flag: "--owner-address",
			validate: (value) =>
				/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) ? null : "Give an address, for example you@example.com.",
		}));
	// A password never goes in a flag, because the shell keeps a history of commands.
	const password =
		ctx.env.ASTERRA_OWNER_PASSWORD ??
		(await ctx.prompt.secret("Password of the owner (12 characters or more)?", {
			flag: "the ASTERRA_OWNER_PASSWORD environment variable",
			validate: (value) => (value.length >= 12 ? null : "Use 12 characters or more."),
		}));
	if (password.length < 12) throw new Refusal("The password of the owner needs 12 characters or more.");
	say(ctx, `Owner: ${displayName} <${address}>`);
	return { displayName, address, password };
}

function notEmpty(value: string): string | null {
	return value.trim() ? null : "An answer is necessary.";
}
