import { SIGN_IN_LOCK_MINUTES, SIGN_IN_MAX_FAILURES } from "@soldock/contracts";
import { verifyPassword } from "./password.ts";
import { type PrincipalRecord, resolveAddress } from "./store.ts";
import { matchTotp } from "./totp.ts";

export type SignInOutcome =
	| { result: "signed_in"; principal: PrincipalRecord; credential: "password" | "password_totp" }
	| { result: "totp_required"; principal: PrincipalRecord }
	| { result: "refused"; principalId: string | null; reason: string };

interface Attempt {
	password_hash: string | null;
	totp_secret: string | null;
	totp_last_step: number | null;
}

/**
 * Counts one attempt before the compare, in one statement, so parallel guesses cannot go past the
 * limit. The attempt that reaches SIGN_IN_MAX_FAILURES locks sign-in for SIGN_IN_LOCK_MINUTES and
 * starts the count again. Returns null while the lock is on.
 */
async function reserveAttempt(db: D1Database, principalId: string, nowMs: number): Promise<Attempt | null> {
	const now = new Date(nowMs).toISOString();
	const lockedUntil = new Date(nowMs + SIGN_IN_LOCK_MINUTES * 60 * 1000).toISOString();
	return await db
		.prepare(
			`UPDATE principals SET
				sign_in_failures = CASE WHEN sign_in_failures + 1 >= ?1 THEN 0 ELSE sign_in_failures + 1 END,
				sign_in_locked_until = CASE WHEN sign_in_failures + 1 >= ?1 THEN ?2 ELSE NULL END
			WHERE id = ?3 AND kind = 'human' AND (sign_in_locked_until IS NULL OR sign_in_locked_until <= ?4)
			RETURNING password_hash, totp_secret, totp_last_step`,
		)
		.bind(SIGN_IN_MAX_FAILURES, lockedUntil, principalId, now)
		.first<Attempt>();
}

async function clearFailures(db: D1Database, principalId: string): Promise<void> {
	await db
		.prepare("UPDATE principals SET sign_in_failures = 0, sign_in_locked_until = NULL WHERE id = ?")
		.bind(principalId)
		.run();
}

/**
 * True when the password is the current password of a human. It counts an attempt and obeys the lock
 * like a sign-in, so a stolen session cannot guess the password without a limit.
 */
export async function confirmPassword(db: D1Database, principalId: string, password: string): Promise<boolean> {
	const attempt = await reserveAttempt(db, principalId, Date.now());
	if (!(await verifyPassword(password, attempt?.password_hash ?? null)) || !attempt) return false;
	await clearFailures(db, principalId);
	return true;
}

/**
 * Checks an address, a password and, when the person turned it on, a TOTP code.
 *
 * - An unknown address, an agent, a person without a password, a wrong password, a wrong or used
 *   code and a lock all give `refused`. Each of them runs one password derivation.
 * - A correct password without a code, for a person with two-step verification, gives
 *   `totp_required` and no session.
 * - A success clears the failure count. A TOTP code works one time.
 */
export async function signInWithPassword(
	db: D1Database,
	input: { address: string; password: string; totp_code?: string | undefined },
	nowMs = Date.now(),
): Promise<SignInOutcome> {
	const principal = await resolveAddress(db, input.address);
	if (principal?.kind !== "human") {
		await verifyPassword(input.password, null);
		return { result: "refused", principalId: null, reason: "unknown address" };
	}
	const attempt = await reserveAttempt(db, principal.id, nowMs);
	if (!attempt) {
		await verifyPassword(input.password, null);
		return { result: "refused", principalId: principal.id, reason: "locked" };
	}
	if (!(await verifyPassword(input.password, attempt.password_hash))) {
		return {
			result: "refused",
			principalId: principal.id,
			reason: attempt.password_hash ? "wrong password" : "no password",
		};
	}
	if (!attempt.totp_secret) {
		await clearFailures(db, principal.id);
		return { result: "signed_in", principal, credential: "password" };
	}
	if (input.totp_code === undefined) return { result: "totp_required", principal };
	const step = await matchTotp(attempt.totp_secret, input.totp_code, attempt.totp_last_step, nowMs);
	if (step === null) return { result: "refused", principalId: principal.id, reason: "wrong code" };
	// The guard on the last step makes a parallel request with the same code fail.
	const used = await db
		.prepare(
			`UPDATE principals SET totp_last_step = ?1, sign_in_failures = 0, sign_in_locked_until = NULL
			WHERE id = ?2 AND totp_secret = ?3 AND (totp_last_step IS NULL OR totp_last_step < ?1)`,
		)
		.bind(step, principal.id, attempt.totp_secret)
		.run();
	if (used.meta.changes !== 1) return { result: "refused", principalId: principal.id, reason: "used code" };
	return { result: "signed_in", principal, credential: "password_totp" };
}
