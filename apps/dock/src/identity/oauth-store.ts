import { OAUTH_LIMITS, type Scope } from "@soldock/contracts";
import { newId, randomToken, sha256Hex } from "../platform/index.ts";
import { getPrincipal, type PrincipalRecord } from "./store.ts";

// The OAuth tables of the directory (migration 0007). Only the SHA-256 of a code or a token is stored.

/** The prefix of each OAuth access token, so secret scanners and people can recognize one. */
export const ACCESS_TOKEN_PREFIX = "sdo_";
/** The prefix of each OAuth refresh token. */
export const REFRESH_TOKEN_PREFIX = "sdr_";
/** The prefix of each authorization code. */
export const CODE_PREFIX = "sdc_";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Anybody can register a client and start a request, so the directory keeps only a limited number of
 * them. A registration deletes the clients without a grant that nobody used for 30 days. Above the
 * limit, it deletes the clients without a grant whose last use is the oldest. A client with a grant
 * stays.
 */
export const OAUTH_STORE_LIMITS = {
	idleClientMs: 30 * DAY_MS,
	clientsWithoutGrant: 1000,
	requests: 1000,
	/** The refresh token before the current one works for this long after the refresh that replaced it. */
	refreshGraceMs: 60 * 1000,
	/** A new grant of a principal deletes its grants that were revoked or expired this long before. */
	endedGrantMs: 30 * DAY_MS,
} as const;

export interface OAuthClientRecord {
	id: string;
	name: string;
	uri: string | null;
	redirect_uris: string[];
	created_at: string;
}

/** An authorization request that waits for a person. */
export interface OAuthRequestRecord {
	id: string;
	client: OAuthClientRecord;
	redirect_uri: string;
	state: string | null;
	scopes: Scope[];
	expires_at: string;
}

/** An approved request whose code a token request used. */
export interface RedeemedCode {
	request_id: string;
	client_id: string;
	redirect_uri: string;
	code_challenge: string;
	principal_id: string;
	scopes: Scope[];
	approved_by: string;
}

export interface OAuthGrantRecord {
	id: string;
	client_id: string;
	client_name: string;
	principal_id: string;
	scopes: Scope[];
	created_by: string;
	created_at: string;
	last_used_at: string | null;
	revoked_at: string | null;
	refresh_expires_at: string;
}

/** The tokens of a grant. The client gets them once. */
export interface IssuedTokens {
	grant: OAuthGrantRecord;
	access_token: string;
	refresh_token: string;
}

interface ClientRow extends Omit<OAuthClientRecord, "redirect_uris"> {
	redirect_uris: string;
}

interface GrantRow extends Omit<OAuthGrantRecord, "scopes"> {
	scopes: string;
}

const GRANT_SELECT = `SELECT g.id, g.client_id, c.name AS client_name, g.principal_id, g.scopes, g.created_by,
	g.created_at, g.last_used_at, g.revoked_at, g.refresh_expires_at
	FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id`;

function toClient(row: ClientRow): OAuthClientRecord {
	return { ...row, redirect_uris: JSON.parse(row.redirect_uris) as string[] };
}

function toGrant(row: GrantRow): OAuthGrantRecord {
	return { ...row, scopes: JSON.parse(row.scopes) as Scope[] };
}

function isoAfter(now: number, ms: number): string {
	return new Date(now + ms).toISOString();
}

/** Registers a public client. It deletes idle clients without a grant, and keeps their number below the limit. */
export async function registerClient(
	db: D1Database,
	client: { name: string; uri: string | null; redirect_uris: string[] },
): Promise<OAuthClientRecord> {
	const now = Date.now();
	const record: OAuthClientRecord = { id: newId("cli", now), ...client, created_at: new Date(now).toISOString() };
	// A client with a request is kept, so a delete never breaks the foreign key of a request.
	const withoutGrant = `NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.id)
		AND NOT EXISTS (SELECT 1 FROM oauth_requests r WHERE r.client_id = c.id)`;
	await db.batch([
		db
			.prepare(
				`DELETE FROM oauth_clients WHERE id IN (SELECT c.id FROM oauth_clients c
				WHERE COALESCE(c.last_used_at, c.created_at) < ? AND ${withoutGrant})`,
			)
			.bind(new Date(now - OAUTH_STORE_LIMITS.idleClientMs).toISOString()),
		db
			.prepare(
				`DELETE FROM oauth_clients WHERE id IN (SELECT c.id FROM oauth_clients c WHERE ${withoutGrant}
				ORDER BY COALESCE(c.last_used_at, c.created_at) DESC LIMIT -1 OFFSET ?)`,
			)
			.bind(OAUTH_STORE_LIMITS.clientsWithoutGrant - 1),
		db
			.prepare("INSERT INTO oauth_clients (id, name, uri, redirect_uris, created_at) VALUES (?, ?, ?, ?, ?)")
			.bind(record.id, record.name, record.uri, JSON.stringify(record.redirect_uris), record.created_at),
	]);
	return record;
}

export async function getClient(db: D1Database, id: string): Promise<OAuthClientRecord | null> {
	const row = await db
		.prepare("SELECT id, name, uri, redirect_uris, created_at FROM oauth_clients WHERE id = ?")
		.bind(id)
		.first<ClientRow>();
	return row ? toClient(row) : null;
}

/**
 * Keeps a new authorization request, deletes the expired ones, and keeps the number of requests that wait
 * for a person below the limit. An approved request lives until its code expires. Returns null when the client no longer
 * exists, for example after a registration deleted it.
 */
export async function createRequest(
	db: D1Database,
	request: { client_id: string; redirect_uri: string; state: string | null; code_challenge: string; scopes: Scope[] },
): Promise<string | null> {
	const now = Date.now();
	const nowIso = new Date(now).toISOString();
	const id = newId("oar", now);
	const results = await db.batch([
		db.prepare("DELETE FROM oauth_requests WHERE expires_at < ?").bind(nowIso),
		db
			.prepare(
				// Only a request that waits for a person is removed. An approved request stays until its code expires,
				// so a second use of the code can still revoke its grant. Only a person can approve, so these rows are few.
				`DELETE FROM oauth_requests WHERE id IN (SELECT id FROM oauth_requests WHERE code_hash IS NULL
				ORDER BY created_at DESC LIMIT -1 OFFSET ?)`,
			)
			.bind(OAUTH_STORE_LIMITS.requests - 1),
		db.prepare("UPDATE oauth_clients SET last_used_at = ? WHERE id = ?").bind(nowIso, request.client_id),
		db
			.prepare(
				`INSERT INTO oauth_requests (id, client_id, redirect_uri, state, code_challenge, scopes, created_at, expires_at)
				SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM oauth_clients WHERE id = ?)`,
			)
			.bind(
				id,
				request.client_id,
				request.redirect_uri,
				request.state,
				request.code_challenge,
				JSON.stringify(request.scopes),
				nowIso,
				isoAfter(now, OAUTH_LIMITS.requestSeconds * 1000),
				request.client_id,
			),
	]);
	return results.at(-1)?.meta.changes === 1 ? id : null;
}

/** The SQL condition that request `?` still waits for a person. It reads the current time from the next `?`. */
const PENDING = "code_hash IS NULL AND denied_at IS NULL AND expires_at > ?";

/** The request, while it waits for a person. Null when it is unknown, expired, approved or denied. */
export async function getPendingRequest(db: D1Database, id: string): Promise<OAuthRequestRecord | null> {
	const row = await db
		.prepare(
			`SELECT r.id, r.redirect_uri, r.state, r.scopes, r.expires_at,
			c.id AS client_id, c.name AS client_name, c.uri AS client_uri, c.redirect_uris, c.created_at AS client_created_at
			FROM oauth_requests r JOIN oauth_clients c ON c.id = r.client_id
			WHERE r.id = ? AND r.code_hash IS NULL AND r.denied_at IS NULL AND r.expires_at > ?`,
		)
		.bind(id, new Date().toISOString())
		.first<{
			id: string;
			redirect_uri: string;
			state: string | null;
			scopes: string;
			expires_at: string;
			client_id: string;
			client_name: string;
			client_uri: string | null;
			redirect_uris: string;
			client_created_at: string;
		}>();
	if (!row) return null;
	return {
		id: row.id,
		client: toClient({
			id: row.client_id,
			name: row.client_name,
			uri: row.client_uri,
			redirect_uris: row.redirect_uris,
			created_at: row.client_created_at,
		}),
		redirect_uri: row.redirect_uri,
		state: row.state,
		scopes: JSON.parse(row.scopes) as Scope[],
		expires_at: row.expires_at,
	};
}

/**
 * The condition of a principal insert that request `?` still waits, for `createPrincipal`. Pass the same
 * `now` to `approveStatement`, so that the insert and the approval in one transaction agree.
 */
export function pendingRequestCondition(requestId: string, now: string): { sql: string; params: unknown[] } {
	return { sql: `EXISTS (SELECT 1 FROM oauth_requests WHERE id = ? AND ${PENDING})`, params: [requestId, now] };
}

/** A new authorization code and the time after which it stops. */
export async function newCode(now: number): Promise<{ code: string; hash: string; expires_at: string }> {
	const code = `${CODE_PREFIX}${randomToken(32)}`;
	return { code, hash: await sha256Hex(code), expires_at: isoAfter(now, OAUTH_LIMITS.codeSeconds * 1000) };
}

/**
 * The statement that approves request `requestId` for a principal. It changes the row only while the
 * request waits at `now` and the principal exists, so it can share a transaction with the insert of a
 * new agent. The row then lives until the code expires.
 */
export function approveStatement(
	db: D1Database,
	approval: {
		requestId: string;
		principalId: string;
		scopes: readonly Scope[];
		approvedBy: string;
		codeHash: string;
		codeExpiresAt: string;
		now: string;
	},
): D1PreparedStatement {
	return db
		.prepare(
			`UPDATE oauth_requests SET principal_id = ?1, granted_scopes = ?2, approved_by = ?3, code_hash = ?4,
			code_expires_at = ?5, expires_at = ?5
			WHERE id = ?6 AND code_hash IS NULL AND denied_at IS NULL AND expires_at > ?7
			AND EXISTS (SELECT 1 FROM principals WHERE id = ?1)`,
		)
		.bind(
			approval.principalId,
			JSON.stringify(approval.scopes),
			approval.approvedBy,
			approval.codeHash,
			approval.codeExpiresAt,
			approval.requestId,
			approval.now,
		);
}

/** Marks a waiting request denied. Returns false when it no longer waits. */
export async function denyRequest(db: D1Database, id: string): Promise<boolean> {
	const now = new Date().toISOString();
	const result = await db
		.prepare(`UPDATE oauth_requests SET denied_at = ? WHERE id = ? AND ${PENDING}`)
		.bind(now, id, now)
		.run();
	return result.meta.changes === 1;
}

/**
 * Uses an authorization code one time. A second use of the code revokes the grant that the first use
 * made, because somebody else can hold the code (RFC 9700). Returns null for an unknown, used or
 * expired code.
 */
export async function redeemCode(db: D1Database, code: string): Promise<RedeemedCode | null> {
	const hash = await sha256Hex(code);
	const now = new Date().toISOString();
	const row = await db
		.prepare(
			`UPDATE oauth_requests SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND code_expires_at > ?
			RETURNING id, client_id, redirect_uri, code_challenge, principal_id, granted_scopes, approved_by`,
		)
		.bind(now, hash, now)
		.first<{
			id: string;
			client_id: string;
			redirect_uri: string;
			code_challenge: string;
			principal_id: string;
			granted_scopes: string;
			approved_by: string;
		}>();
	if (!row) {
		// The grant of the first use can still be on its way: createGrant then revokes it, because of replayed_at.
		await db.batch([
			db
				.prepare("UPDATE oauth_requests SET replayed_at = ? WHERE code_hash = ? AND used_at IS NOT NULL")
				.bind(now, hash),
			db
				.prepare(
					`UPDATE oauth_grants SET revoked_at = ?1 WHERE revoked_at IS NULL
					AND id = (SELECT grant_id FROM oauth_requests WHERE code_hash = ?2 AND used_at IS NOT NULL)`,
				)
				.bind(now, hash),
		]);
		return null;
	}
	return {
		request_id: row.id,
		client_id: row.client_id,
		redirect_uri: row.redirect_uri,
		code_challenge: row.code_challenge,
		principal_id: row.principal_id,
		scopes: JSON.parse(row.granted_scopes) as Scope[],
		approved_by: row.approved_by,
	};
}

async function newTokens(now: number) {
	const access_token = `${ACCESS_TOKEN_PREFIX}${randomToken(32)}`;
	const refresh_token = `${REFRESH_TOKEN_PREFIX}${randomToken(32)}`;
	return {
		access_token,
		refresh_token,
		access_hash: await sha256Hex(access_token),
		refresh_hash: await sha256Hex(refresh_token),
		access_expires_at: isoAfter(now, OAUTH_LIMITS.accessTokenSeconds * 1000),
		refresh_expires_at: isoAfter(now, OAUTH_LIMITS.refreshTokenDays * 24 * 60 * 60 * 1000),
	};
}

/**
 * Creates the grant of a redeemed code, with its first tokens. It deletes the grants of the principal
 * that ended long ago. Returns null when somebody sent the code again before the grant existed: the
 * grant is then revoked at once.
 */
export async function createGrant(db: D1Database, redeemed: RedeemedCode): Promise<IssuedTokens | null> {
	const now = Date.now();
	const nowIso = new Date(now).toISOString();
	const id = newId("grt", now);
	const tokens = await newTokens(now);
	const ended = new Date(now - OAUTH_STORE_LIMITS.endedGrantMs).toISOString();
	await db.batch([
		db
			.prepare("DELETE FROM oauth_grants WHERE principal_id = ?1 AND (revoked_at < ?2 OR refresh_expires_at < ?2)")
			.bind(redeemed.principal_id, ended),
		db
			.prepare(
				`INSERT INTO oauth_grants (id, client_id, principal_id, scopes, created_by, created_at, access_hash,
				access_expires_at, refresh_hash, refresh_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				id,
				redeemed.client_id,
				redeemed.principal_id,
				JSON.stringify(redeemed.scopes),
				redeemed.approved_by,
				nowIso,
				tokens.access_hash,
				tokens.access_expires_at,
				tokens.refresh_hash,
				tokens.refresh_expires_at,
			),
		db.prepare("UPDATE oauth_requests SET grant_id = ? WHERE id = ?").bind(id, redeemed.request_id),
		db
			.prepare(
				`UPDATE oauth_grants SET revoked_at = ?1 WHERE id = ?2
				AND EXISTS (SELECT 1 FROM oauth_requests WHERE id = ?3 AND replayed_at IS NOT NULL)`,
			)
			.bind(nowIso, id, redeemed.request_id),
	]);
	const grant = await getGrant(db, id);
	if (!grant) throw new Error(`grant ${id} missing after insert`);
	if (grant.revoked_at !== null) return null;
	return { grant, access_token: tokens.access_token, refresh_token: tokens.refresh_token };
}

/**
 * Gives a grant new tokens for a refresh token of the client, and replaces the refresh token
 * (rotation). The token that a refresh replaced works one more time, for 60 seconds, so a lost response
 * does not end the connection. A use of that token after the 60 seconds revokes the grant: somebody else
 * can hold a copy of it (reuse detection). The old access token stops.
 */
export async function refreshGrant(
	db: D1Database,
	refreshToken: string,
	clientId: string,
): Promise<{ tokens: IssuedTokens } | { reused: string } | null> {
	if (!refreshToken.startsWith(REFRESH_TOKEN_PREFIX)) return null;
	const used = await sha256Hex(refreshToken);
	const now = Date.now();
	const nowIso = new Date(now).toISOString();
	const tokens = await newTokens(now);
	// SQLite reads the old row in each SET expression, so previous_refresh_hash gets the current token before
	// the change. The token that the client sent, when it was the previous one, becomes unknown: a replaced
	// token works at most one time, and two holders of one grant soon send a token after its grace period.
	const row = await db
		.prepare(
			`UPDATE oauth_grants SET access_hash = ?1, access_expires_at = ?2, refresh_hash = ?3, refresh_expires_at = ?4,
			previous_refresh_hash = refresh_hash, previous_refresh_until = ?6
			WHERE client_id = ?7 AND revoked_at IS NULL AND refresh_expires_at > ?8
			AND (refresh_hash = ?5 OR (previous_refresh_hash = ?5 AND previous_refresh_until > ?8))
			AND EXISTS (SELECT 1 FROM principals WHERE id = oauth_grants.principal_id)
			RETURNING id`,
		)
		.bind(
			tokens.access_hash,
			tokens.access_expires_at,
			tokens.refresh_hash,
			tokens.refresh_expires_at,
			used,
			isoAfter(now, OAUTH_STORE_LIMITS.refreshGraceMs),
			clientId,
			nowIso,
		)
		.first<{ id: string }>();
	if (!row) {
		const reused = await db
			.prepare(
				`UPDATE oauth_grants SET revoked_at = ?1
				WHERE previous_refresh_hash = ?2 AND previous_refresh_until <= ?1 AND revoked_at IS NULL RETURNING id`,
			)
			.bind(nowIso, used)
			.first<{ id: string }>();
		return reused ? { reused: reused.id } : null;
	}
	const grant = await getGrant(db, row.id);
	if (!grant) return null;
	return { tokens: { grant, access_token: tokens.access_token, refresh_token: tokens.refresh_token } };
}

/** The live grant of an access token, and its principal. */
export async function findGrantByAccessToken(
	db: D1Database,
	token: string,
): Promise<{ grant: OAuthGrantRecord; principal: PrincipalRecord } | null> {
	if (!token.startsWith(ACCESS_TOKEN_PREFIX)) return null;
	const row = await db
		.prepare(`${GRANT_SELECT} WHERE g.access_hash = ? AND g.revoked_at IS NULL AND g.access_expires_at > ?`)
		.bind(await sha256Hex(token), new Date().toISOString())
		.first<GrantRow>();
	if (!row) return null;
	const principal = await getPrincipal(db, row.principal_id);
	return principal ? { grant: toGrant(row), principal } : null;
}

/** Records the use of a grant, at most once an hour, so a busy agent does not write on each call. */
export async function touchGrant(db: D1Database, grant: OAuthGrantRecord): Promise<void> {
	const now = new Date();
	if (grant.last_used_at && now.getTime() - Date.parse(grant.last_used_at) < 60 * 60 * 1000) return;
	await db.prepare("UPDATE oauth_grants SET last_used_at = ? WHERE id = ?").bind(now.toISOString(), grant.id).run();
}

export async function getGrant(db: D1Database, id: string): Promise<OAuthGrantRecord | null> {
	const row = await db.prepare(`${GRANT_SELECT} WHERE g.id = ?`).bind(id).first<GrantRow>();
	return row ? toGrant(row) : null;
}

export async function listGrants(db: D1Database, principalId: string): Promise<OAuthGrantRecord[]> {
	const { results } = await db
		.prepare(`${GRANT_SELECT} WHERE g.principal_id = ? ORDER BY g.created_at DESC`)
		.bind(principalId)
		.all<GrantRow>();
	return results.map(toGrant);
}

/** Revokes a grant: its access token and its refresh tokens stop at once. */
export async function revokeGrant(db: D1Database, id: string): Promise<void> {
	await db
		.prepare("UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
		.bind(new Date().toISOString(), id)
		.run();
}
