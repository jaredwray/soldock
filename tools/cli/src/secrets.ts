// The Worker secrets that the CLI makes. Cloudflare never shows a secret again, so the CLI shows each
// value one time, or writes it to the file of --secrets-out, and never to a log.
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, rmSync, writeSync } from "node:fs";
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

/** Where a command gives new secret values to the operator. */
export interface HandOver {
	/** Shows the values one time, or adds them to the file of --secrets-out. */
	give(values: Record<string, string>): void;
	/** Closes the file. Deletes it when the command gave no value. */
	done(): void;
}

/**
 * Opens the place for new secret values: the terminal, or the file of --secrets-out. A command opens it
 * before it changes anything in Cloudflare, so a path that does not work stops the command first. The
 * file must not exist, so a run never replaces a key that the operator saved before.
 */
export function openHandOver(ctx: Context, secretsOut: string | undefined): HandOver {
	if (!secretsOut) {
		return {
			give(values) {
				say(ctx);
				for (const [name, value] of Object.entries(values)) say(ctx, `  ${name}=${value}`);
				say(ctx);
			},
			done() {},
		};
	}
	let file: number;
	try {
		file = openSync(secretsOut, "wx", 0o600);
	} catch (error) {
		throw new Refusal(`Cannot make the file ${secretsOut} for the secrets: ${(error as Error).message}`);
	}
	let given = 0;
	let open = true;
	return {
		give(values) {
			writeSync(
				file,
				Object.entries(values)
					.map(([name, value]) => `${name}=${value}\n`)
					.join(""),
			);
			fsyncSync(file);
			given += Object.keys(values).length;
			say(ctx, `The value of ${Object.keys(values).join(" and ")} is in ${secretsOut} (only you can read it).`);
		},
		done() {
			if (!open) return;
			open = false;
			closeSync(file);
			if (given === 0) rmSync(secretsOut, { force: true });
		},
	};
}
