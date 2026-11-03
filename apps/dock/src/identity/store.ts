import { AGENT_SCOPES, ALL_SCOPES, type Scope } from "@soldock/contracts";
import { newId, OperationError, randomToken, sha256Hex } from "../platform/index.ts";

export type PrincipalKind = "human" | "agent";
export type OrgRole = "owner" | "admin" | "member";
export type OutboundMode = "internal-only" | "allowlist" | "any";

/** A principal as the directory stores it, with its primary address. */
export interface PrincipalRecord {
	id: string;
	kind: PrincipalKind;
	display_name: string;
	address: string;
	org_role: OrgRole | null;
	sponsor_id: string | null;
	outbound_mode: OutboundMode | null;
	outbound_allowlist: string[];
	created_at: string;
}

export interface ApiKeyRecord {
	id: string;
	principal_id: string;
	label: string;
	scopes: Scope[];
	created_at: string;
	last_used_at: string | null;
	revoked_at: string | null;
}

interface PrincipalRow extends Omit<PrincipalRecord, "outbound_allowlist"> {
	outbound_allowlist: string;
}

interface ApiKeyRow extends Omit<ApiKeyRecord, "scopes"> {
	scopes: string;
}

const PRINCIPAL_SELECT = `SELECT p.id, p.kind, p.display_name, p.org_role, p.sponsor_id, p.outbound_mode,
	p.outbound_allowlist, p.created_at, a.address
	FROM principals p JOIN addresses a ON a.principal_id = p.id AND a.is_primary = 1`;

const API_KEY_SELECT = "SELECT id, principal_id, label, scopes, created_at, last_used_at, revoked_at FROM api_keys";

/** The prefix of every API key secret, so secret scanners and people can recognize one. */
export const API_KEY_PREFIX = "sdk_";

/** A session lasts 30 days. */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

function toPrincipal(row: PrincipalRow): PrincipalRecord {
	return { ...row, outbound_allowlist: JSON.parse(row.outbound_allowlist) as string[] };
}

function toApiKey(row: ApiKeyRow): ApiKeyRecord {
	return { ...row, scopes: JSON.parse(row.scopes) as Scope[] };
}

/**
 * The form of an address that the directory stores: lowercase, without a `+tag` in the local part.
 * Mail to `Ada+news@Example.com` reaches `ada@example.com`.
 */
export function normalizeAddress(address: string): string {
	const lower = address.trim().toLowerCase();
	const at = lower.lastIndexOf("@");
	if (at < 0) return lower;
	const local = lower.slice(0, at);
	const plus = local.indexOf("+");
	return `${plus > 0 ? local.slice(0, plus) : local}${lower.slice(at)}`;
}

/** The mail domains of the deployment, from the `MAIL_DOMAINS` var (comma-separated). */
export function mailDomains(env: Pick<Env, "MAIL_DOMAINS">): Set<string> {
	return new Set(
		env.MAIL_DOMAINS.split(",")
			.map((domain) => domain.trim().toLowerCase())
			.filter(Boolean),
	);
}

export function domainOf(address: string): string {
	return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/** The scopes that a key for this kind of principal can hold at most. */
export function scopeCeiling(kind: PrincipalKind): readonly Scope[] {
	return kind === "agent" ? AGENT_SCOPES : ALL_SCOPES;
}

/** True while the directory has no principal: first-run setup has not run. */
export async function directoryIsEmpty(db: D1Database): Promise<boolean> {
	return (await db.prepare("SELECT 1 FROM principals LIMIT 1").first()) === null;
}

export async function getPrincipal(db: D1Database, id: string): Promise<PrincipalRecord | null> {
	const row = await db.prepare(`${PRINCIPAL_SELECT} WHERE p.id = ?`).bind(id).first<PrincipalRow>();
	return row ? toPrincipal(row) : null;
}

export async function listPrincipals(db: D1Database): Promise<PrincipalRecord[]> {
	const { results } = await db.prepare(`${PRINCIPAL_SELECT} ORDER BY p.kind, p.display_name`).all<PrincipalRow>();
	return results.map(toPrincipal);
}

/** The principal that receives mail for an address, or null when the address is unknown. */
export async function resolveAddress(db: D1Database, address: string): Promise<PrincipalRecord | null> {
	const row = await db
		.prepare(
			`SELECT p.id, p.kind, p.display_name, p.org_role, p.sponsor_id, p.outbound_mode, p.outbound_allowlist,
			p.created_at, primary_address.address
			FROM addresses target
			JOIN principals p ON p.id = target.principal_id
			JOIN addresses primary_address ON primary_address.principal_id = p.id AND primary_address.is_primary = 1
			WHERE target.address = ?`,
		)
		.bind(normalizeAddress(address))
		.first<PrincipalRow>();
	return row ? toPrincipal(row) : null;
}

export interface NewPrincipal {
	kind: PrincipalKind;
	display_name: string;
	address: string;
	org_role: OrgRole | null;
	sponsor_id: string | null;
}

export interface NewApiKey {
	label: string;
	scopes: readonly Scope[];
	created_by: string | null;
}

/**
 * Creates a principal, its primary address and a first API key in one transaction. With
 * `onlyIfEmpty`, the transaction writes nothing when the directory already has a principal, so two
 * concurrent first-run setups cannot both create an owner. Returns null in that case.
 */
export async function createPrincipal(
	db: D1Database,
	principal: NewPrincipal,
	key: NewApiKey,
	options: { onlyIfEmpty?: boolean } = {},
): Promise<{ principal: PrincipalRecord; key: ApiKeyRecord; secret: string } | null> {
	const now = new Date().toISOString();
	const id = newId("prn");
	const keyId = newId("key");
	const secret = `${API_KEY_PREFIX}${randomToken(32)}`;
	const keyHash = await sha256Hex(secret);
	const outboundMode: OutboundMode | null = principal.kind === "agent" ? "internal-only" : null;
	const guard = options.onlyIfEmpty ? "WHERE NOT EXISTS (SELECT 1 FROM principals)" : "";
	try {
		const [inserted] = await db.batch([
			db
				.prepare(
					`INSERT INTO principals (id, kind, display_name, org_role, sponsor_id, outbound_mode, outbound_allowlist, created_at)
					SELECT ?, ?, ?, ?, ?, ?, '[]', ? ${guard}`,
				)
				.bind(id, principal.kind, principal.display_name, principal.org_role, principal.sponsor_id, outboundMode, now),
			db
				.prepare(
					"INSERT INTO addresses (address, principal_id, is_primary, created_at) SELECT ?, ?, 1, ? WHERE EXISTS (SELECT 1 FROM principals WHERE id = ?)",
				)
				.bind(normalizeAddress(principal.address), id, now, id),
			db
				.prepare(
					`INSERT INTO api_keys (id, principal_id, key_hash, label, scopes, created_by, created_at)
					SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM principals WHERE id = ?)`,
				)
				.bind(keyId, id, keyHash, key.label, JSON.stringify(key.scopes), key.created_by ?? id, now, id),
		]);
		if (!inserted?.meta.changes) return null;
	} catch (error) {
		if (String(error).includes("UNIQUE constraint failed: addresses.address")) {
			throw new OperationError("conflict", "That address belongs to another principal.");
		}
		throw error;
	}
	const record = await getPrincipal(db, id);
	if (!record) throw new Error(`principal ${id} missing after insert`);
	return {
		principal: record,
		key: {
			id: keyId,
			principal_id: id,
			label: key.label,
			scopes: [...key.scopes],
			created_at: now,
			last_used_at: null,
			revoked_at: null,
		},
		secret,
	};
}

export async function updateOutboundPolicy(
	db: D1Database,
	id: string,
	mode: OutboundMode,
	allowlist: string[],
): Promise<void> {
	await db
		.prepare("UPDATE principals SET outbound_mode = ?, outbound_allowlist = ? WHERE id = ? AND kind = 'agent'")
		.bind(mode, JSON.stringify(mode === "allowlist" ? allowlist : []), id)
		.run();
}

export async function createApiKey(
	db: D1Database,
	principalId: string,
	key: NewApiKey,
): Promise<{ key: ApiKeyRecord; secret: string }> {
	const now = new Date().toISOString();
	const id = newId("key");
	const secret = `${API_KEY_PREFIX}${randomToken(32)}`;
	await db
		.prepare(
			"INSERT INTO api_keys (id, principal_id, key_hash, label, scopes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		)
		.bind(id, principalId, await sha256Hex(secret), key.label, JSON.stringify(key.scopes), key.created_by, now)
		.run();
	return {
		key: {
			id,
			principal_id: principalId,
			label: key.label,
			scopes: [...key.scopes],
			created_at: now,
			last_used_at: null,
			revoked_at: null,
		},
		secret,
	};
}

export async function listApiKeys(db: D1Database, principalId: string): Promise<ApiKeyRecord[]> {
	const { results } = await db
		.prepare(`${API_KEY_SELECT} WHERE principal_id = ? ORDER BY created_at DESC`)
		.bind(principalId)
		.all<ApiKeyRow>();
	return results.map(toApiKey);
}

export async function getApiKey(db: D1Database, id: string): Promise<ApiKeyRecord | null> {
	const row = await db.prepare(`${API_KEY_SELECT} WHERE id = ?`).bind(id).first<ApiKeyRow>();
	return row ? toApiKey(row) : null;
}

/** Revokes a key and ends the browser sessions that it created, in one transaction. */
export async function revokeApiKey(db: D1Database, id: string): Promise<void> {
	await db.batch([
		db
			.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
			.bind(new Date().toISOString(), id),
		db.prepare("DELETE FROM sessions WHERE key_id = ?").bind(id),
	]);
}

/** The live key with this secret, and its principal. */
export async function findApiKey(
	db: D1Database,
	secret: string,
): Promise<{ key: ApiKeyRecord; principal: PrincipalRecord } | null> {
	if (!secret.startsWith(API_KEY_PREFIX)) return null;
	const row = await db
		.prepare(`${API_KEY_SELECT} WHERE key_hash = ? AND revoked_at IS NULL`)
		.bind(await sha256Hex(secret))
		.first<ApiKeyRow>();
	if (!row) return null;
	const principal = await getPrincipal(db, row.principal_id);
	return principal ? { key: toApiKey(row), principal } : null;
}

/** Records the use of a key, at most once an hour, so a busy agent does not write on each call. */
export async function touchApiKey(db: D1Database, key: ApiKeyRecord): Promise<void> {
	const now = new Date();
	if (key.last_used_at && now.getTime() - Date.parse(key.last_used_at) < 60 * 60 * 1000) return;
	await db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(now.toISOString(), key.id).run();
}

/**
 * Creates a session with the scopes of the key that signed in, and deletes the expired sessions of
 * the same principal. The session ends when that key is revoked. Returns the cookie value.
 */
export async function createSession(
	db: D1Database,
	principalId: string,
	key: Pick<ApiKeyRecord, "id" | "scopes">,
): Promise<string> {
	const token = randomToken(32);
	const now = Date.now();
	await db.batch([
		db
			.prepare("DELETE FROM sessions WHERE principal_id = ? AND expires_at <= ?")
			.bind(principalId, new Date(now).toISOString()),
		db
			.prepare(
				"INSERT INTO sessions (token_hash, principal_id, key_id, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.bind(
				await sha256Hex(token),
				principalId,
				key.id,
				JSON.stringify(key.scopes),
				new Date(now).toISOString(),
				new Date(now + SESSION_TTL_SECONDS * 1000).toISOString(),
			),
	]);
	return token;
}

export async function findSession(
	db: D1Database,
	token: string,
): Promise<{ principal: PrincipalRecord; scopes: Scope[] } | null> {
	const row = await db
		.prepare(
			`SELECT s.principal_id, s.scopes FROM sessions s
			JOIN api_keys k ON k.id = s.key_id AND k.revoked_at IS NULL
			WHERE s.token_hash = ? AND s.expires_at > ?`,
		)
		.bind(await sha256Hex(token), new Date().toISOString())
		.first<{ principal_id: string; scopes: string }>();
	if (!row) return null;
	const principal = await getPrincipal(db, row.principal_id);
	return principal ? { principal, scopes: JSON.parse(row.scopes) as Scope[] } : null;
}

export async function deleteSession(db: D1Database, token: string): Promise<void> {
	await db
		.prepare("DELETE FROM sessions WHERE token_hash = ?")
		.bind(await sha256Hex(token))
		.run();
}
