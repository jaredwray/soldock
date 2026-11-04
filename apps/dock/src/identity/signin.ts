import { SIGN_IN_CODE_LENGTH, SIGN_IN_CODE_MAX_ATTEMPTS, SIGN_IN_CODE_TTL_MINUTES } from "@soldock/contracts";
import { log, newId, sameSecret, sha256Hex } from "../platform/index.ts";
import { domainOf, findSignInPrincipal, type PrincipalRecord, SIGN_IN_SENDER } from "./store.ts";

/** A person can ask for this number of codes in one hour. More requests send nothing. */
export const SIGN_IN_CODES_PER_HOUR = 5;

const HOUR_MS = 60 * 60 * 1000;
const CODE_SPACE = 10 ** SIGN_IN_CODE_LENGTH;
/** The largest multiple of CODE_SPACE below 2^32. A larger random value is refused, so each code is equally likely. */
const UNBIASED_LIMIT = Math.floor(2 ** 32 / CODE_SPACE) * CODE_SPACE;

/** A uniform random code of SIGN_IN_CODE_LENGTH digits. */
function newCode(): string {
	const value = new Uint32Array(1);
	do {
		crypto.getRandomValues(value);
	} while ((value[0] as number) >= UNBIASED_LIMIT);
	return String((value[0] as number) % CODE_SPACE).padStart(SIGN_IN_CODE_LENGTH, "0");
}

/** The stored form of a code. The code id is in the hash, so two rows with the same code differ. */
function codeHash(id: string, code: string): Promise<string> {
	return sha256Hex(`${id}:${code}`);
}

/**
 * Stores a new sign-in code for a human and returns it. The new code replaces the older ones, because
 * only the newest code works. Returns null when the human asked for SIGN_IN_CODES_PER_HOUR codes in
 * the last hour. The guarded insert counts and writes in one statement, so parallel requests cannot
 * go past the limit.
 */
export async function issueSignInCode(db: D1Database, principalId: string): Promise<string | null> {
	const now = Date.now();
	const id = newId("sic", now);
	const code = newCode();
	const hourAgo = new Date(now - HOUR_MS).toISOString();
	const [, inserted] = await db.batch([
		db.prepare("DELETE FROM sign_in_codes WHERE principal_id = ? AND created_at <= ?").bind(principalId, hourAgo),
		db
			.prepare(
				`INSERT INTO sign_in_codes (id, principal_id, code_hash, attempts, created_at, expires_at)
				SELECT ?, ?, ?, 0, ?, ?
				WHERE (SELECT COUNT(*) FROM sign_in_codes WHERE principal_id = ? AND created_at > ?) < ?`,
			)
			.bind(
				id,
				principalId,
				await codeHash(id, code),
				new Date(now).toISOString(),
				new Date(now + SIGN_IN_CODE_TTL_MINUTES * 60 * 1000).toISOString(),
				principalId,
				hourAgo,
				SIGN_IN_CODES_PER_HOUR,
			),
	]);
	return inserted?.meta.changes ? code : null;
}

/**
 * Uses the newest sign-in code of a human. Each guess adds one to the attempts of the code before
 * the compare, in one statement, so parallel guesses cannot go past SIGN_IN_CODE_MAX_ATTEMPTS. A
 * correct code works one time. Returns true when the code is correct.
 */
export async function consumeSignInCode(db: D1Database, principalId: string, code: string): Promise<boolean> {
	const now = new Date().toISOString();
	const row = await db
		.prepare(
			`UPDATE sign_in_codes SET attempts = attempts + 1
			WHERE id = (SELECT id FROM sign_in_codes WHERE principal_id = ? ORDER BY rowid DESC LIMIT 1)
			AND attempts < ? AND used_at IS NULL AND expires_at > ?
			RETURNING id, code_hash`,
		)
		.bind(principalId, SIGN_IN_CODE_MAX_ATTEMPTS, now)
		.first<{ id: string; code_hash: string }>();
	if (!row || !sameSecret(await codeHash(row.id, code), row.code_hash)) return false;
	const used = await db
		.prepare("UPDATE sign_in_codes SET used_at = ? WHERE id = ? AND used_at IS NULL")
		.bind(now, row.id)
		.run();
	return used.meta.changes === 1;
}

/** `12345678` becomes `1234 5678`, which is easier to read. The sign-in form ignores the space. */
function displayCode(code: string): string {
	const half = Math.ceil(code.length / 2);
	return `${code.slice(0, half)} ${code.slice(half)}`;
}

/** Sends a code to the sign-in email of a human, through Email Service. */
async function sendSignInCode(env: Env, principal: PrincipalRecord, code: string, origin: string): Promise<void> {
	if (!principal.sign_in_email) throw new Error(`principal ${principal.id} has no sign-in email`);
	const text = [
		"Your Soldock sign-in code is:",
		"",
		`    ${displayCode(code)}`,
		"",
		`Use it to sign in as ${principal.address} at ${origin}.`,
		`The code works one time and stops working after ${SIGN_IN_CODE_TTL_MINUTES} minutes.`,
		"",
		"If you did not ask for this code, ignore this message. Nobody can sign in without the code.",
		"Do not give the code to a person or an agent.",
		"",
	].join("\n");
	await env.EMAIL.send({
		from: { name: "Soldock", email: `${SIGN_IN_SENDER}@${domainOf(principal.address)}` },
		to: principal.sign_in_email,
		subject: "Your Soldock sign-in code",
		text,
	});
}

/**
 * Sends a sign-in code when the address belongs to a human with a sign-in email. It runs after the
 * response, and the response is the same for each address, so nobody can find out which addresses
 * have an account. A failure is logged, never shown.
 */
export async function requestSignInCode(env: Env, email: string, origin: string, requestId: string): Promise<void> {
	try {
		const principal = await findSignInPrincipal(env.DIRECTORY, email);
		if (!principal) {
			log("info", "sign-in code not sent: no person signs in with that address", { requestId });
			return;
		}
		const code = await issueSignInCode(env.DIRECTORY, principal.id);
		if (!code) {
			log("warn", "sign-in code not sent: too many codes in the last hour", { principalId: principal.id, requestId });
			return;
		}
		await sendSignInCode(env, principal, code, origin);
		log("info", "sign-in code sent", { principalId: principal.id, requestId });
	} catch (error) {
		// Only the error name: a message from Email Service can hold the sign-in email, a personal address.
		log("error", "sign-in code failed", { requestId, err: error instanceof Error ? error.name : typeof error });
	}
}
