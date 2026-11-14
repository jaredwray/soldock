import { SIGN_IN_LOCK_MINUTES, SIGN_IN_MAX_FAILURES } from "@soldock/contracts";
import { verifyPassword } from "./password.ts";
import { createSessionIf, type PrincipalRecord, resolveAddress } from "./store.ts";
import { matchTotp } from "./totp.ts";

export type SignInOutcome =
	| {
			result: "signed_in";
			principal: PrincipalRecord;
			credential: "password" | "password_totp";
			/** The value of the new session cookie. */
			sessionToken: string;
	  }
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
 * Clears the failure count and creates the session in one transaction, only while the password hash and
 * the TOTP secret are still the ones that the attempt checked. A password change, or two-step
 * verification that turns on, during the check makes the sign-in fail, so no session outlives the
 * change. With a TOTP step, only a step after the last used one counts, so a parallel request with the
 * same code fails. Returns the session cookie value, or null.
 */
function finishSignIn(db: D1Database, principalId: string, attempt: Attempt, step: number | null) {
	const guard = db
		.prepare(
			`UPDATE principals SET sign_in_failures = 0, sign_in_locked_until = NULL,
				totp_last_step = COALESCE(?1, totp_last_step)
			WHERE id = ?2 AND password_hash = ?3 AND totp_secret IS ?4
			AND (?1 IS NULL OR totp_last_step IS NULL OR totp_last_step < ?1)`,
		)
		.bind(step, principalId, attempt.password_hash, attempt.totp_secret);
	return createSessionIf(db, principalId, guard);
}

/**
 * Checks an address, a password and, when the person turned it on, a TOTP code.
 *
 * - An unknown address, an agent, an archived person, a person without a password, a wrong password,
 *   a wrong or used code and a lock all give `refused`. Each of them runs one password derivation.
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
	if (principal.archived_at !== null) {
		await verifyPassword(input.password, null);
		return { result: "refused", principalId: principal.id, reason: "archived" };
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
	let step: number | null = null;
	if (attempt.totp_secret) {
		if (input.totp_code === undefined) return { result: "totp_required", principal };
		step = await matchTotp(attempt.totp_secret, input.totp_code, attempt.totp_last_step, nowMs);
		if (step === null) return { result: "refused", principalId: principal.id, reason: "wrong code" };
	}
	const sessionToken = await finishSignIn(db, principal.id, attempt, step);
	if (!sessionToken) {
		return { result: "refused", principalId: principal.id, reason: "credentials changed or code used" };
	}
	return { result: "signed_in", principal, credential: step === null ? "password" : "password_totp", sessionToken };
}
