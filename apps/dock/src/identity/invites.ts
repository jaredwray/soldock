import { INVITE_DAYS } from "@asterra/contracts";
import { randomToken, sha256Hex } from "../platform/index.ts";
import { getPrincipal, type PrincipalRecord, SESSION_TTL_SECONDS } from "./store.ts";

// Invite links: a person who has no password yet opens the link, chooses a password, and is signed in. A
// person has at most one link (`invites.principal_id` is unique). Only the SHA-256 of the secret is stored.

export const INVITE_PREFIX = "sdi_";

/**
 * The rule for a person who can get or use an invite: no password, no second step, not archived and not
 * deleted. It names the columns of `principals` without a table name.
 */
const INVITABLE =
	"kind = 'human' AND password_hash IS NULL AND totp_secret IS NULL AND archived_at IS NULL AND deleted_at IS NULL";

/** A new invite before it is stored. Only `token` goes to the caller, and only in the link. */
export interface NewInvite {
	token: string;
	hash: string;
	createdAt: string;
	expiresAt: string;
}

export async function newInvite(nowMs = Date.now()): Promise<NewInvite> {
	const token = `${INVITE_PREFIX}${randomToken(32)}`;
	return {
		token,
		hash: await sha256Hex(token),
		createdAt: new Date(nowMs).toISOString(),
		expiresAt: new Date(nowMs + INVITE_DAYS * 24 * 60 * 60 * 1000).toISOString(),
	};
}

/** The link of an invite. The secret is after the `#`, so the browser does not send it with the page request. */
export function inviteUrl(origin: string, invite: NewInvite): string {
	return `${origin}/invite#${invite.token}`;
}

/**
 * The insert of a new invite. It writes only while the person can get an invite (`INVITABLE`), so it changes
 * no row when the person got a password, was archived or was deleted. A new person has no invite, so
 * `directory.create_principal` runs it in the transaction of the insert of the person.
 */
export function insertInvite(
	db: D1Database,
	invite: NewInvite,
	principalId: string,
	createdBy: string,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO invites (token_hash, principal_id, created_by, created_at, expires_at)
			SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM principals WHERE id = ?2 AND ${INVITABLE})`,
		)
		.bind(invite.hash, principalId, createdBy, invite.createdAt, invite.expiresAt);
}

/**
 * Replaces the invite of a person in one transaction: the earlier link stops. Returns false, and changes
 * nothing, when the person cannot get an invite.
 */
export async function replaceInvite(
	db: D1Database,
	invite: NewInvite,
	principalId: string,
	createdBy: string,
): Promise<boolean> {
	const [, inserted] = await db.batch([
		db
			.prepare(
				`DELETE FROM invites WHERE principal_id = ?1 AND EXISTS (SELECT 1 FROM principals WHERE id = ?1 AND ${INVITABLE})`,
			)
			.bind(principalId),
		insertInvite(db, invite, principalId, createdBy),
	]);
	return inserted?.meta.changes === 1;
}

/** The live invite of a token: the person can still use it, and it did not expire. */
export interface FoundInvite {
	principal: PrincipalRecord;
	tokenHash: string;
	expiresAt: string;
}

export async function findInvite(db: D1Database, token: string, nowMs = Date.now()): Promise<FoundInvite | null> {
	const tokenHash = await sha256Hex(token);
	const row = await db
		.prepare(
			`SELECT i.principal_id, i.expires_at FROM invites i WHERE i.token_hash = ?1 AND i.expires_at > ?2
			AND EXISTS (SELECT 1 FROM principals WHERE id = i.principal_id AND ${INVITABLE})`,
		)
		.bind(tokenHash, new Date(nowMs).toISOString())
		.first<{ principal_id: string; expires_at: string }>();
	if (!row) return null;
	const principal = await getPrincipal(db, row.principal_id);
	return principal ? { principal, tokenHash, expiresAt: row.expires_at } : null;
}

/**
 * Sets the first password of the person of an invite and creates a session, in one transaction. The write
 * matches only while the invite is live and the person can still use it, so a token works one time, and an
 * invite that a new link replaced, a password that somebody set, or an archive during the request makes the
 * accept fail. The same transaction ends the other sessions of the person, as a new password does, and deletes
 * the invite. Returns the value of the new session cookie, or null.
 */
export async function acceptInvite(
	db: D1Database,
	invite: Pick<FoundInvite, "tokenHash"> & { principalId: string },
	passwordHash: string,
	nowMs = Date.now(),
): Promise<string | null> {
	const sessionToken = randomToken(32);
	const now = new Date(nowMs).toISOString();
	// The new hash has a random salt, so it marks the row that this request changed. Each later statement runs
	// only for that row.
	const changed = "EXISTS (SELECT 1 FROM principals WHERE id = ?1 AND password_hash = ?2)";
	const [updated] = await db.batch([
		db
			.prepare(
				`UPDATE principals SET password_hash = ?2, sign_in_failures = 0, sign_in_locked_until = NULL
				WHERE id = ?1 AND ${INVITABLE}
				AND EXISTS (SELECT 1 FROM invites WHERE token_hash = ?3 AND principal_id = ?1 AND expires_at > ?4)`,
			)
			.bind(invite.principalId, passwordHash, invite.tokenHash, now),
		db.prepare(`DELETE FROM sessions WHERE principal_id = ?1 AND ${changed}`).bind(invite.principalId, passwordHash),
		db
			.prepare(
				`INSERT INTO sessions (token_hash, principal_id, created_at, expires_at) SELECT ?3, ?1, ?4, ?5 WHERE ${changed}`,
			)
			.bind(
				invite.principalId,
				passwordHash,
				await sha256Hex(sessionToken),
				now,
				new Date(nowMs + SESSION_TTL_SECONDS * 1000).toISOString(),
			),
		db.prepare(`DELETE FROM invites WHERE principal_id = ?1 AND ${changed}`).bind(invite.principalId, passwordHash),
	]);
	return updated?.meta.changes === 1 ? sessionToken : null;
}
