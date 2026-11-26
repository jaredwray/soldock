// The Worker secrets that the CLI makes. Cloudflare never shows a secret again, so the CLI shows each
// value one time, or writes it to the file of --secrets-out, and never to a log.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { type Context, say } from "./context.ts";
import { Refusal } from "./errors.ts";

/** Permits first-run setup, and a directory reset. Delete it after setup. 64 hex characters. */
export function newSetupToken(): string {
	return randomBytes(32).toString("hex");
}

/** The key for the secrets that the Worker keeps in D1 (#227). 256 bits in base64url. It stays. */
export function newEncryptionKey(): string {
	return randomBytes(32).toString("base64url");
}

/**
 * Gives the operator new secret values: on the terminal, or in the file of --secrets-out. The file must
 * not exist, so a run never replaces a key that the operator saved before.
 */
export function handOver(ctx: Context, values: Record<string, string>, secretsOut: string | undefined): void {
	if (secretsOut) {
		const lines = Object.entries(values).map(([name, value]) => `${name}=${value}\n`);
		try {
			writeFileSync(secretsOut, lines.join(""), { mode: 0o600, flag: "wx" });
		} catch (error) {
			throw new Refusal(`Cannot write the secrets to ${secretsOut}: ${(error as Error).message}`);
		}
		say(ctx, `The values of ${Object.keys(values).join(" and ")} are in ${secretsOut} (only you can read it).`);
		return;
	}
	say(ctx);
	for (const [name, value] of Object.entries(values)) say(ctx, `  ${name}=${value}`);
	say(ctx);
}
