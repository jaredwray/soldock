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
	/** True when a human has a password. The hash never leaves the sign-in code. */
	password_set: boolean;
	/** True when sign-in also needs a TOTP code. The secret never leaves the sign-in code. */
	totp_enabled: boolean;
	created_at: string;
	/** Set while the principal is archived: it cannot sign in or use a credential. */
	archived_at: string | null;
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

interface PrincipalRow extends Omit<PrincipalRecord, "outbound_allowlist" | "password_set" | "totp_enabled"> {
	outbound_allowlist: string;
	password_set: number;
	totp_enabled: number;
}

interface ApiKeyRow extends Omit<ApiKeyRecord, "scopes"> {
	scopes: string;
}

/**
 * The principal columns of a PrincipalRecord. Only flags come from the credential columns, never their values.
 * A deleted principal has no address, so each query with the primary address leaves it out.
 */
const PRINCIPAL_COLUMNS = `p.id, p.kind, p.display_name, p.org_role, p.sponsor_id, p.outbound_mode, p.outbound_allowlist,
	p.password_hash IS NOT NULL AS password_set, p.totp_secret IS NOT NULL AS totp_enabled, p.created_at, p.archived_at`;

const PRINCIPAL_SELECT = `SELECT ${PRINCIPAL_COLUMNS}, a.address
	FROM principals p JOIN addresses a ON a.principal_id = p.id AND a.is_primary = 1`;

const API_KEY_SELECT = "SELECT id, principal_id, label, scopes, created_at, last_used_at, revoked_at FROM api_keys";

/** The prefix of every API key secret, so secret scanners and people can recognize one. */
export const API_KEY_PREFIX = "sdk_";

/** A session lasts 30 days. */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

function toPrincipal(row: PrincipalRow): PrincipalRecord {
	return {
		...row,
		outbound_allowlist: JSON.parse(row.outbound_allowlist) as string[],
		password_set: row.password_set === 1,
		totp_enabled: row.totp_enabled === 1,
	};
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

/**
 * The `+tag` in the local part of an address, or null. Mail to `ada+news@example.com` has the tag
 * `news`. It uses the same rule as `normalizeAddress`, so a tag exists only where that function removes one.
 */
export function addressTag(address: string): string | null {
	const trimmed = address.trim();
	const local = trimmed.slice(0, Math.max(trimmed.lastIndexOf("@"), 0));
	const plus = local.indexOf("+");
	return plus > 0 && plus < local.length - 1 ? local.slice(plus + 1) : null;
}

/** A primary address cannot hold a `+tag`, because mail to `user+tag@` reaches `user@`. */
export function assertPrimaryAddress(address: string): void {
	const local = address.slice(0, address.lastIndexOf("@"));
	if (local.includes("+")) {
		throw new OperationError("invalid", "A primary address cannot contain +. Mail to user+tag reaches user.");
	}
}

/** The saved mail domains. Each request reads the current settings. */
export async function mailDomains(db: D1Database): Promise<Set<string>> {
	const { results } = await db.prepare("SELECT domain FROM mail_domains ORDER BY domain").all<{ domain: string }>();
	return new Set(results.map(({ domain }) => domain));
}

export async function addMailDomain(db: D1Database, domain: string): Promise<void> {
	try {
		await db.prepare("INSERT INTO mail_domains (domain) VALUES (?) ON CONFLICT DO NOTHING").bind(domain).run();
	} catch (error) {
		throw conflictOf(error) ?? error;
	}
}

export async function removeMailDomain(db: D1Database, domain: string): Promise<void> {
	try {
		await db.prepare("DELETE FROM mail_domains WHERE domain = ?").bind(domain).run();
	} catch (error) {
		throw conflictOf(error) ?? error;
	}
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

/** The principals of the ids in the list. An id that no principal has gives no record. */
export async function getPrincipals(db: D1Database, ids: readonly string[]): Promise<PrincipalRecord[]> {
	const unique = [...new Set(ids)];
	if (unique.length === 0) return [];
	const { results } = await db
		.prepare(`${PRINCIPAL_SELECT} JOIN json_each(?) wanted ON wanted.value = p.id`)
		.bind(JSON.stringify(unique))
		.all<PrincipalRow>();
	return results.map(toPrincipal);
}

/** The ids from the list that no principal has. A deleted principal counts as unknown. */
export async function unknownPrincipalIds(db: D1Database, ids: readonly string[]): Promise<string[]> {
	const unique = [...new Set(ids)];
	if (unique.length === 0) return [];
	const { results } = await db
		.prepare("SELECT p.id FROM principals p JOIN json_each(?) wanted ON wanted.value = p.id WHERE p.deleted_at IS NULL")
		.bind(JSON.stringify(unique))
		.all<{ id: string }>();
	const known = new Set(results.map((row) => row.id));
	return unique.filter((id) => !known.has(id));
}

export async function listPrincipals(db: D1Database): Promise<PrincipalRecord[]> {
	const { results } = await db.prepare(`${PRINCIPAL_SELECT} ORDER BY p.kind, p.display_name`).all<PrincipalRow>();
	return results.map(toPrincipal);
}

/** The principal that receives mail for an address, or null when the address is unknown. */
export async function resolveAddress(db: D1Database, address: string): Promise<PrincipalRecord | null> {
	const row = await db
		.prepare(
			`SELECT ${PRINCIPAL_COLUMNS}, primary_address.address
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
	/** The stored form of the first password (`hashPassword`). Humans only. */
	password_hash: string | null;
}

/**
 * The condition of an agent insert that its sponsor is still a person who is not archived or deleted, in
 * the transaction of the insert. A sponsor that a parallel request archives or deletes gets no new agent.
 */
export function liveSponsorCondition(sponsorId: string): { sql: string; params: unknown[] } {
	return {
		sql: "EXISTS (SELECT 1 FROM principals WHERE id = ? AND kind = 'human' AND archived_at IS NULL AND deleted_at IS NULL)",
		params: [sponsorId],
	};
}

/** Turns a directory constraint failure into an error that the caller can read. */
export function conflictOf(error: unknown): OperationError | null {
	const text = String(error);
	if (text.includes("mail_domain_in_use")) {
		return new OperationError("conflict", "This domain has mailbox addresses. You cannot remove it.");
	}
	if (text.includes("address_mail_domain")) {
		return new OperationError("invalid", "The address must use a saved mail domain. Check Admin settings.");
	}
	if (text.includes("CHECK constraint failed: id = 1")) {
		return new OperationError("conflict", "Another reset replaced this request. Use the latest reset result.");
	}
	if (text.includes("UNIQUE constraint failed: addresses.address")) {
		return new OperationError("conflict", "That address belongs to another principal.");
	}
	if (text.includes("address_in_use") || text.includes("UNIQUE constraint failed: team_mailboxes.address")) {
		return new OperationError("conflict", "That address belongs to another principal or team mailbox.");
	}
	return null;
}

export interface NewApiKey {
	label: string;
	scopes: readonly Scope[];
	created_by: string | null;
}

/** Options of `createPrincipal`. */
export interface CreatePrincipalOptions {
	/** Writes nothing when the directory already has a principal. First-run setup uses it. */
	onlyIfEmpty?: boolean;
	beforeCreate?: D1PreparedStatement[];
	mailDomain?: string;
	/**
	 * One more condition of the principal insert, as SQL with `?` parameters. The transaction writes
	 * nothing when it is false. An OAuth approval uses it, so an expired request creates no agent.
	 */
	condition?: { sql: string; params: unknown[] };
	/** Statements after the inserts, in the same transaction. They get the id of the new principal. */
	afterCreate?: (principalId: string) => D1PreparedStatement[];
}

/**
 * Creates a principal, its primary address and a first API key in one transaction. With
 * `onlyIfEmpty`, the transaction writes nothing when the directory already has a principal, so two
 * concurrent first-run setups cannot both create an owner. Returns null in that case. Without a key
 * (`null`), the principal gets no API key: an agent that connects with OAuth gets tokens instead.
 */
export async function createPrincipal(
	db: D1Database,
	principal: NewPrincipal,
	key: null,
	options?: CreatePrincipalOptions,
): Promise<{ principal: PrincipalRecord; key: null; secret: null } | null>;
export async function createPrincipal(
	db: D1Database,
	principal: NewPrincipal,
	key: NewApiKey,
	options?: CreatePrincipalOptions,
): Promise<{ principal: PrincipalRecord; key: ApiKeyRecord; secret: string } | null>;
export async function createPrincipal(
	db: D1Database,
	principal: NewPrincipal,
	key: NewApiKey | null,
	options: CreatePrincipalOptions = {},
): Promise<{ principal: PrincipalRecord; key: ApiKeyRecord | null; secret: string | null } | null> {
	const now = new Date().toISOString();
	const id = newId("prn");
	const keyId = newId("key");
	const secret = key ? `${API_KEY_PREFIX}${randomToken(32)}` : null;
	const outboundMode: OutboundMode | null = principal.kind === "agent" ? "internal-only" : null;
	const guard = `WHERE NOT EXISTS (SELECT 1 FROM setup_lock WHERE token IS NOT NULL)${options.onlyIfEmpty ? " AND NOT EXISTS (SELECT 1 FROM principals)" : ""}`;
	const condition = options.condition ? ` AND ${options.condition.sql}` : "";
	try {
		const beforeCreate = [...(options.beforeCreate ?? [])];
		if (options.mailDomain) {
			// The domain and owner share one transaction and the same guard. A lost setup race writes neither.
			beforeCreate.push(
				db
					.prepare(`INSERT INTO mail_domains (domain) SELECT ? ${guard} ON CONFLICT DO NOTHING`)
					.bind(options.mailDomain),
			);
		}
		const results = await db.batch([
			...beforeCreate,
			db
				.prepare(
					`INSERT INTO principals (id, kind, display_name, org_role, sponsor_id, outbound_mode, outbound_allowlist,
					password_hash, created_at)
					SELECT ?, ?, ?, ?, ?, ?, '[]', ?, ? ${guard}${condition}`,
				)
				.bind(
					id,
					principal.kind,
					principal.display_name,
					principal.org_role,
					principal.sponsor_id,
					outboundMode,
					principal.kind === "human" ? principal.password_hash : null,
					now,
					...(options.condition?.params ?? []),
				),
			db
				.prepare(
					"INSERT INTO addresses (address, principal_id, is_primary, created_at) SELECT ?, ?, 1, ? WHERE EXISTS (SELECT 1 FROM principals WHERE id = ?)",
				)
				.bind(normalizeAddress(principal.address), id, now, id),
			...(key && secret
				? [
						db
							.prepare(
								`INSERT INTO api_keys (id, principal_id, key_hash, label, scopes, created_by, created_at)
								SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM principals WHERE id = ?)`,
							)
							.bind(
								keyId,
								id,
								await sha256Hex(secret),
								key.label,
								JSON.stringify(key.scopes),
								key.created_by ?? id,
								now,
								id,
							),
					]
				: []),
			...(options.afterCreate?.(id) ?? []),
		]);
		if (!results[beforeCreate.length]?.meta.changes) return null;
	} catch (error) {
		throw conflictOf(error) ?? error;
	}
	const record = await getPrincipal(db, id);
	if (!record) throw new Error(`principal ${id} missing after insert`);
	if (!key || !secret) return { principal: record, key: null, secret: null };
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

/** The changes of `updatePrincipal`. A field that is undefined does not change. */
export interface PrincipalChanges {
	display_name?: string | undefined;
	org_role?: "admin" | "member" | undefined;
	sponsor_id?: string | undefined;
}

/**
 * Changes the name, the role of a human or the sponsor of an agent. The update matches only while the
 * principal exists, a role change does not touch the owner, and a new sponsor is a human who is not
 * archived or deleted. So a parallel change cannot leave an agent with a sponsor who left. Returns false
 * when it matched no row.
 */
export async function updatePrincipal(db: D1Database, id: string, changes: PrincipalChanges): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE principals SET display_name = COALESCE(?1, display_name),
				org_role = CASE WHEN kind = 'human' THEN COALESCE(?2, org_role) ELSE org_role END,
				sponsor_id = CASE WHEN kind = 'agent' THEN COALESCE(?3, sponsor_id) ELSE sponsor_id END
			WHERE id = ?4 AND deleted_at IS NULL AND (?2 IS NULL OR org_role IS NOT 'owner')
			AND (?3 IS NULL OR EXISTS (SELECT 1 FROM principals sponsor WHERE sponsor.id = ?3 AND sponsor.kind = 'human'
				AND sponsor.archived_at IS NULL AND sponsor.deleted_at IS NULL))`,
		)
		.bind(changes.display_name ?? null, changes.org_role ?? null, changes.sponsor_id ?? null, id)
		.run();
	return result.meta.changes === 1;
}

/**
 * The agents that a human sponsors, without the deleted ones. With `activeOnly`, also without the
 * archived ones: an archived agent cannot act, so its sponsor can be archived.
 */
export async function countSponsoredAgents(
	db: D1Database,
	sponsorId: string,
	options: { activeOnly?: boolean } = {},
): Promise<number> {
	const active = options.activeOnly ? " AND archived_at IS NULL" : "";
	return (
		(await db
			.prepare(`SELECT COUNT(*) AS count FROM principals WHERE sponsor_id = ? AND deleted_at IS NULL${active}`)
			.bind(sponsorId)
			.first<number>("count")) ?? 0
	);
}

/**
 * Archives a principal and ends its sessions. The owner, and a human who sponsors an agent that is not
 * archived, cannot be archived: the person could still act through the keys of the agent. A second
 * archive changes nothing. The API keys and OAuth grants stay: `authenticate` refuses them while the
 * principal is archived.
 */
export async function archivePrincipal(db: D1Database, id: string): Promise<void> {
	await db.batch([
		db
			.prepare(
				`UPDATE principals SET archived_at = ?1
				WHERE id = ?2 AND archived_at IS NULL AND deleted_at IS NULL AND org_role IS NOT 'owner'
				AND NOT EXISTS (SELECT 1 FROM principals agent WHERE agent.sponsor_id = ?2 AND agent.archived_at IS NULL
					AND agent.deleted_at IS NULL)`,
			)
			.bind(new Date().toISOString(), id),
		db
			.prepare(
				"DELETE FROM sessions WHERE principal_id = ?1 AND EXISTS (SELECT 1 FROM principals WHERE id = ?1 AND archived_at IS NOT NULL)",
			)
			.bind(id),
	]);
}

/**
 * Restores an archived principal. Its keys and grants work again. An agent comes back only while its
 * sponsor is not archived. The restore deletes the sessions of the principal again, so a sign-in that
 * raced the archive cannot leave a session that returns now. A principal that is not archived does not
 * change, and keeps its sessions.
 */
export async function restorePrincipal(db: D1Database, id: string): Promise<void> {
	// changes() in the delete reads the count of the update, so only a real restore ends sessions.
	await db.batch([
		db
			.prepare(
				`UPDATE principals SET archived_at = NULL WHERE id = ?1 AND archived_at IS NOT NULL AND deleted_at IS NULL
				AND (kind = 'human' OR EXISTS (SELECT 1 FROM principals sponsor WHERE sponsor.id = principals.sponsor_id
					AND sponsor.archived_at IS NULL AND sponsor.deleted_at IS NULL))`,
			)
			.bind(id),
		db.prepare("DELETE FROM sessions WHERE principal_id = ? AND changes() = 1").bind(id),
	]);
}

/**
 * Deletes a principal in one transaction. The row stays, because keys, team mailboxes and OAuth rows of
 * other principals refer to it. The credential columns are cleared, the addresses (so the address becomes
 * free and inbound mail to it is refused), the sessions and the team mailbox memberships are removed, and
 * the keys and grants are revoked. The owner and a human who sponsors an agent cannot be deleted. Returns
 * false, and changes nothing, when the first update matched no row.
 */
export async function deletePrincipal(db: D1Database, id: string): Promise<boolean> {
	const now = new Date().toISOString();
	// Each later statement runs only for the row that this request deleted.
	const deleted = "EXISTS (SELECT 1 FROM principals WHERE id = ?2 AND deleted_at = ?1)";
	const [first] = await db.batch([
		db
			.prepare(
				`UPDATE principals SET deleted_at = ?1, archived_at = COALESCE(archived_at, ?1), password_hash = NULL,
					totp_secret = NULL, totp_pending_secret = NULL, totp_last_step = NULL
				WHERE id = ?2 AND deleted_at IS NULL AND org_role IS NOT 'owner'
				AND NOT EXISTS (SELECT 1 FROM principals agent WHERE agent.sponsor_id = ?2 AND agent.deleted_at IS NULL)`,
			)
			.bind(now, id),
		db.prepare(`DELETE FROM addresses WHERE principal_id = ?2 AND ${deleted}`).bind(now, id),
		db.prepare(`DELETE FROM sessions WHERE principal_id = ?2 AND ${deleted}`).bind(now, id),
		db.prepare(`DELETE FROM team_mailbox_members WHERE principal_id = ?2 AND ${deleted}`).bind(now, id),
		db
			.prepare(`UPDATE api_keys SET revoked_at = ?1 WHERE principal_id = ?2 AND revoked_at IS NULL AND ${deleted}`)
			.bind(now, id),
		db
			.prepare(`UPDATE oauth_grants SET revoked_at = ?1 WHERE principal_id = ?2 AND revoked_at IS NULL AND ${deleted}`)
			.bind(now, id),
	]);
	return first?.meta.changes === 1;
}

/**
 * The condition that the session which makes a change still exists, in the transaction of the change.
 * A change from a session that a password reset ended during the request must not commit. Null (an API
 * key) always passes. It reads the session hash from parameter `?n`.
 */
function liveSession(n: number): string {
	return `(?${n} IS NULL OR EXISTS (SELECT 1 FROM sessions WHERE token_hash = ?${n}))`;
}

/**
 * Sets the password of a human, clears a sign-in lock, and ends the sessions of that human, except
 * `keepSessionHash`: the session that made the change, when the human changes their own password.
 * Somebody who knew the old password must not keep a session after the change. Returns false, and
 * changes nothing, when `liveSessionHash` names a session that ended.
 */
export async function setPassword(
	db: D1Database,
	principalId: string,
	passwordHash: string,
	keepSessionHash: string | null,
	liveSessionHash: string | null,
): Promise<boolean> {
	// changes() in the delete reads the count of the update, so a refused update ends no session.
	const [updated] = await db.batch([
		db
			.prepare(
				`UPDATE principals SET password_hash = ?1, sign_in_failures = 0, sign_in_locked_until = NULL
				WHERE id = ?2 AND kind = 'human' AND ${liveSession(3)}`,
			)
			.bind(passwordHash, principalId, liveSessionHash),
		db
			.prepare("DELETE FROM sessions WHERE principal_id = ? AND token_hash IS NOT ? AND changes() = 1")
			.bind(principalId, keepSessionHash),
	]);
	return updated?.meta.changes === 1;
}

/** Keeps a new TOTP secret that waits for a code. It replaces an older waiting secret. Sign-in does not change. */
export async function setPendingTotpSecret(db: D1Database, principalId: string, secret: string): Promise<void> {
	await db
		.prepare("UPDATE principals SET totp_pending_secret = ? WHERE id = ? AND kind = 'human'")
		.bind(secret, principalId)
		.run();
}

/** The TOTP secret that waits for a code, or null. */
export async function pendingTotpSecret(db: D1Database, principalId: string): Promise<string | null> {
	return await db
		.prepare("SELECT totp_pending_secret FROM principals WHERE id = ?")
		.bind(principalId)
		.first<string | null>("totp_pending_secret");
}

/**
 * Makes the waiting secret the TOTP secret of the person, and ends the other sessions of the person,
 * except `keepSessionHash`. A session that somebody else holds must not stay after the change. The code
 * of `step` cannot sign in again. Returns false, and changes nothing, when the waiting secret changed
 * after the check (for example in a parallel request), or when `liveSessionHash` names a session that
 * ended.
 */
export async function enableTotp(
	db: D1Database,
	principalId: string,
	secret: string,
	step: number,
	keepSessionHash: string | null,
	liveSessionHash: string | null,
): Promise<boolean> {
	// changes() in the delete reads the count of the update, so a refused update ends no session.
	const [enabled] = await db.batch([
		db
			.prepare(
				`UPDATE principals SET totp_secret = totp_pending_secret, totp_pending_secret = NULL, totp_last_step = ?1
				WHERE id = ?2 AND totp_pending_secret = ?3 AND ${liveSession(4)}`,
			)
			.bind(step, principalId, secret, liveSessionHash),
		db
			.prepare("DELETE FROM sessions WHERE principal_id = ? AND token_hash IS NOT ? AND changes() = 1")
			.bind(principalId, keepSessionHash),
	]);
	return enabled?.meta.changes === 1;
}

/**
 * Turns off two-step verification for a human, and removes a secret that waits for a code. Returns
 * false, and changes nothing, when `liveSessionHash` names a session that ended.
 */
export async function disableTotp(
	db: D1Database,
	principalId: string,
	liveSessionHash: string | null,
): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE principals SET totp_secret = NULL, totp_pending_secret = NULL, totp_last_step = NULL
			WHERE id = ?1 AND ${liveSession(2)}`,
		)
		.bind(principalId, liveSessionHash)
		.run();
	return result.meta.changes === 1;
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

/** Revokes a key. Browser sessions do not come from keys, so they stay. */
export async function revokeApiKey(db: D1Database, id: string): Promise<void> {
	await db
		.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
		.bind(new Date().toISOString(), id)
		.run();
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
 * Creates a browser session for a human, and deletes the expired sessions of the same human. Returns
 * the cookie value. A session holds every human scope, because sign-in proves the password and, when
 * it is on, the TOTP code.
 */
export async function createSession(db: D1Database, principalId: string): Promise<string> {
	const token = await createSessionIf(db, principalId, null);
	if (!token) throw new Error(`session for ${principalId} was not stored`);
	return token;
}

/**
 * Creates a session in the same transaction as `guard`, and only when `guard` changes exactly one row.
 * Returns null when it does not. Sign-in uses it, so a password change during the check wins: a guard
 * that names the checked credentials then matches no row, and no session comes into existence.
 */
export async function createSessionIf(
	db: D1Database,
	principalId: string,
	guard: D1PreparedStatement | null,
): Promise<string | null> {
	const token = randomToken(32);
	const now = Date.now();
	// changes() reads the count of the statement just before the insert: the guard.
	const results = await db.batch([
		db
			.prepare("DELETE FROM sessions WHERE principal_id = ? AND expires_at <= ?")
			.bind(principalId, new Date(now).toISOString()),
		...(guard ? [guard] : []),
		db
			.prepare(
				`INSERT INTO sessions (token_hash, principal_id, created_at, expires_at)
				SELECT ?, ?, ?, ?${guard ? " WHERE changes() = 1" : ""}`,
			)
			.bind(
				await sha256Hex(token),
				principalId,
				new Date(now).toISOString(),
				new Date(now + SESSION_TTL_SECONDS * 1000).toISOString(),
			),
	]);
	return results.at(-1)?.meta.changes === 1 ? token : null;
}

/** The live session with this cookie value, its principal, and the SHA-256 that identifies it. */
export async function findSession(
	db: D1Database,
	token: string,
): Promise<{ principal: PrincipalRecord; tokenHash: string } | null> {
	const tokenHash = await sha256Hex(token);
	const row = await db
		.prepare("SELECT principal_id FROM sessions WHERE token_hash = ? AND expires_at > ?")
		.bind(tokenHash, new Date().toISOString())
		.first<{ principal_id: string }>();
	if (!row) return null;
	const principal = await getPrincipal(db, row.principal_id);
	return principal ? { principal, tokenHash } : null;
}

export async function deleteSession(db: D1Database, token: string): Promise<void> {
	await db
		.prepare("DELETE FROM sessions WHERE token_hash = ?")
		.bind(await sha256Hex(token))
		.run();
}
