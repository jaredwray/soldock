import {
	canTargetSharedResource,
	OWN_KEY_SCOPES,
	operationList,
	operationNeedsScope,
	RESOURCE_SCOPES,
	type Scope,
	scopeDescription,
} from "@asterra/contracts";
import { audit, log, OperationError } from "../platform/index.ts";
import type { AuthContext, CallContext } from "./auth.ts";
import { getGrant } from "./oauth-store.ts";
import type { ServiceActivityInput } from "./service-activity.ts";
import {
	findStoppedServiceKey,
	getApiKey,
	getPrincipal,
	keyExpired,
	keyNotExpired,
	type PrincipalRecord,
	scopeCeiling,
} from "./store.ts";

// The access rules that the API key and the OAuth handlers share.

export function isAdmin(caller: AuthContext): boolean {
	return caller.principal.org_role === "owner" || caller.principal.org_role === "admin";
}

/**
 * True when the caller can read the own mailbox of each agent: an owner or an admin. Never an agent,
 * so an agent can never read the mail of a different agent. A D1 CHECK already keeps a role off an
 * agent; the kind check is a second guard. The read access does not include a change. Any credential
 * of the person with `mail.read` has this access, also a narrow API key.
 */
export function canReadAgentMailboxes(caller: AuthContext): boolean {
	return caller.kind === "human" && isAdmin(caller);
}

/**
 * True when the caller can use this scope in a resource. A person and a credential of a person need the scope.
 * For an agent or a service account in a team mailbox, a room or a shared drive (`shared`), the membership
 * decides: the object of the resource checks it, so the account scopes do not count. The ceiling of the kind
 * still applies. In its own mailbox and its own drive, an agent needs its account scope.
 */
export function holdsForResource(caller: AuthContext, scope: Scope, shared: boolean): boolean {
	if (caller.scopes.has(scope)) return true;
	if (!shared || caller.principal.kind !== "agent" || !RESOURCE_SCOPES.includes(scope)) return false;
	return scopeCeiling(caller.principal).includes(scope);
}

/**
 * Who changes the policy of an agent and reads its access: its sponsor, an owner or an admin. Only an owner or
 * an admin does this for a service account. Never an agent, also not for itself.
 */
export function canManageAgent(caller: AuthContext, target: PrincipalRecord): boolean {
	if (caller.kind !== "human" || target.kind !== "agent") return false;
	if (target.service) return isAdmin(caller);
	return target.sponsor_id === caller.principal.id || isAdmin(caller);
}

/**
 * A human manages their own credentials (keys, password and two-step verification), the keys of the
 * agents that they sponsor and, as an admin, the credentials of others. Only the owner manages the owner's
 * credentials, so an admin can never act as the owner. Only owners and admins manage the tokens of a
 * service account: its sponsor and its creator get no right from that role.
 */
export function canManageCredentialsOf(caller: AuthContext, target: PrincipalRecord): boolean {
	if (caller.kind !== "human") return false;
	if (target.service) return isAdmin(caller);
	if (target.id === caller.principal.id) return true;
	if (target.org_role === "owner") return false;
	if (target.kind === "agent" && target.sponsor_id === caller.principal.id) return true;
	return isAdmin(caller);
}

/**
 * The scopes for a new key of a person, or for an agent. The scopes can never be more than the principal
 * kind allows, and never more than the credential that gives them, so a narrow key cannot mint a wider one.
 */
export function grantableScopes(
	caller: AuthContext,
	target: Pick<PrincipalRecord, "kind" | "service">,
	requested: readonly Scope[],
): Scope[] {
	const ceiling = new Set(scopeCeiling(target));
	const outside = requested.filter((scope) => !ceiling.has(scope));
	if (outside.length > 0) {
		const holder = target.service ? "A service account" : target.kind === "agent" ? "An agent" : "A key for a person";
		throw new OperationError("invalid", `${holder} cannot hold ${outside.join(", ")}.`);
	}
	const notHeld = requested.filter((scope) => !caller.scopes.has(scope));
	if (notHeld.length > 0) {
		throw new OperationError(
			"forbidden",
			`Your credential does not hold ${notHeld.join(", ")}, so it cannot grant it.`,
		);
	}
	return [...new Set(requested)];
}

/**
 * `mail.share` lets a credential give other principals access to the mailbox of its person. A grant stays
 * after the credential ends. So only the person gets the secret of a key with a scope of `OWN_KEY_SCOPES`: an
 * owner or an admin who manages the keys of a different person cannot create or rotate such a key. Throws
 * `forbidden`.
 */
export function requireOwnShareKey(
	caller: AuthContext,
	target: Pick<PrincipalRecord, "id">,
	scopes: readonly string[],
): void {
	if (target.id === caller.principal.id) return;
	const own = OWN_KEY_SCOPES.filter((scope) => scopes.includes(scope));
	if (own.length === 0) return;
	throw new OperationError(
		"forbidden",
		`Only the person can create or rotate a key of the person that holds ${own.join(", ")}. That scope gives other people and agents access to the mailbox of the person.`,
	);
}

/** A scope that the credential does not hold, and the operations of the caller kind that need it. */
export interface MissingScope {
	scope: Scope;
	description: string;
	operations: string[];
}

/**
 * The scopes that a credential of this kind can hold and this credential does not hold. Each one names
 * the operations of the caller kind that need it. A scope that no such operation needs is left out. MCP
 * lists only the tools that a credential can call, so this tells an agent which tools it cannot see. For an
 * agent, an operation that can name a team mailbox, a room or a shared drive is not in the list: MCP lists it,
 * and the membership decides it (`canTargetSharedResource`).
 */
export function missingScopes(caller: AuthContext): MissingScope[] {
	const agent = caller.principal.kind === "agent";
	return scopeCeiling(caller.principal)
		.filter((scope) => !caller.scopes.has(scope))
		.map((scope) => ({
			scope,
			description: scopeDescription(scope, caller.kind),
			operations: operationList
				.filter((operation) => operationNeedsScope(operation, scope, caller.scopes, caller.kind))
				.filter((operation) => !(agent && RESOURCE_SCOPES.includes(scope) && canTargetSharedResource(operation)))
				.map((operation) => operation.name),
		}))
		.filter((missing) => missing.operations.length > 0);
}

/** Where a call of a service account came from, for its activity log. */
export type ActivitySurface = "rest" | "mcp";

/** The outcome of one operation, as the invoker reports it to a recorder. */
export interface CallOutcome {
	op: string;
	result: "ok" | "denied" | "error";
	code: string | null;
	/** The validated input, or undefined when the input was not valid. */
	input: unknown;
}

/** The input fields that name the resource of a call, in the order of preference. */
const RESOURCE_FIELDS = ["mailbox_id", "space_id", "room_id", "principal_id", "item_id", "thread_id"] as const;

/** The mailbox, drive, room, principal, item or thread that the input of a call names, or null. */
function resourceOf(input: unknown): string | null {
	if (typeof input !== "object" || input === null) return null;
	for (const field of RESOURCE_FIELDS) {
		const value = (input as Record<string, unknown>)[field];
		if (typeof value === "string" && value.length <= 100) return value;
	}
	return null;
}

/** Adds one entry to the activity log of a service account. A failure only writes a warning. */
async function appendServiceActivity(env: Env, principalId: string, entry: ServiceActivityInput): Promise<void> {
	try {
		await env.PRINCIPAL.get(env.PRINCIPAL.idFromName(principalId)).recordServiceActivity(entry);
	} catch (error) {
		log("warn", "service activity: the write failed", {
			op: entry.op,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * The recorder of the calls of a service account, or undefined for each other caller. The invoker calls it
 * after each call of an operation. The write does not wait: `waitUntil` holds it, so a slow or failed
 * write never slows or fails the call.
 */
export function activityRecorder(
	caller: AuthContext,
	env: Env,
	waitUntil: (promise: Promise<unknown>) => void,
	requestId: string,
	surface: ActivitySurface,
): ((outcome: CallOutcome) => void) | undefined {
	if (caller.kind !== "service") return undefined;
	return (outcome) =>
		waitUntil(
			appendServiceActivity(env, caller.principal.id, {
				at: Date.now(),
				op: outcome.op,
				result: outcome.result,
				code: outcome.code,
				surface,
				keyId: caller.keyId,
				actorId: caller.principal.id,
				resourceId: resourceOf(outcome.input),
				requestId,
			}),
		);
}

/**
 * Records a socket that a service account opened, or tried to open, in its activity log. Nothing is
 * recorded for each other caller. A failure never fails the open.
 */
export function recordSocketOpen(
	caller: AuthContext,
	env: Env,
	waitUntil: (promise: Promise<unknown>) => void,
	requestId: string,
	op: "events.open_socket" | "chat.open_room_socket",
	input: { room_id?: string } = {},
	outcome: { result: "ok" | "denied" | "error"; code: string | null } = { result: "ok", code: null },
): void {
	try {
		activityRecorder(caller, env, waitUntil, requestId, "rest")?.({ op, ...outcome, input });
	} catch {
		// The record of an open is best effort. The socket stays open.
	}
}

/** The outcome of a refused socket open, for `recordSocketOpen`. */
export function refusedOutcome(error: unknown): { result: "denied" | "error"; code: string } {
	if (error instanceof OperationError) {
		return { result: error.code === "forbidden" ? "denied" : "error", code: error.code };
	}
	return { result: "error", code: "internal" };
}

/** Where a request came from, for the activity log of a token that the request names. */
export interface RequestTrace {
	requestId: string;
	surface: ActivitySurface;
}

/**
 * Records a refused token of a service account (revoked, expired, or of an archived account) in the
 * activity log of the account, as `auth.refused_token` with the reason as the code. A secret of no token,
 * and a key of a person or an agent, record nothing. The log keeps at most one such entry for each token
 * in each minute. A failure only writes a warning.
 */
export async function recordRefusedToken(env: Env, secret: string, trace: RequestTrace): Promise<void> {
	try {
		const stopped = await findStoppedServiceKey(env.DIRECTORY, secret);
		if (!stopped) return;
		await appendServiceActivity(env, stopped.principalId, {
			at: Date.now(),
			op: "auth.refused_token",
			result: "denied",
			code: stopped.reason,
			surface: trace.surface,
			keyId: stopped.keyId,
			actorId: stopped.principalId,
			resourceId: null,
			requestId: trace.requestId,
		});
	} catch (error) {
		log("warn", "service activity: the record of a refused token failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Records a change that an owner or an admin made to a service account or to one of its tokens, in the
 * activity log of that account. Nothing is recorded for a principal that is not a service account.
 */
export function recordServiceChange(
	call: CallContext,
	target: Pick<PrincipalRecord, "id" | "service">,
	op: string,
	keyId: string | null = null,
): void {
	if (!target.service) return;
	call.waitUntil(
		appendServiceActivity(call.env, target.id, {
			at: Date.now(),
			op,
			result: "ok",
			code: null,
			surface: "admin",
			keyId,
			actorId: call.caller.principal.id,
			resourceId: target.id,
			requestId: call.requestId,
		}),
	);
}

/**
 * Records a membership change that a different principal made for service accounts: a room, a shared
 * drive or a share of a Drive item. Each listed id that is a service account gets one entry with the
 * caller as the actor, and the room, the drive or the item as the resource. The surface is `admin` for an
 * owner or an admin, and `member` for each other caller, which has its own count limit. The own id of the
 * caller is left out, because its own call is in its log already. The write does not wait, and a failure
 * only writes a warning.
 */
export function recordServiceMemberships(
	call: CallContext,
	principalIds: readonly string[],
	op: string,
	resourceId: string,
): void {
	const ids = [...new Set(principalIds)].filter((id) => id !== call.caller.principal.id);
	if (ids.length === 0) return;
	const surface = isAdmin(call.caller) ? "admin" : "member";
	call.waitUntil(
		(async () => {
			try {
				const { results } = await call.env.DIRECTORY.prepare(
					`SELECT p.id FROM json_each(?) wanted CROSS JOIN principals p ON p.id = wanted.value
					WHERE p.service = 1 AND p.deleted_at IS NULL`,
				)
					.bind(JSON.stringify(ids))
					.all<{ id: string }>();
				const at = Date.now();
				await Promise.all(
					results.map((row) =>
						appendServiceActivity(call.env, row.id, {
							at,
							op,
							result: "ok",
							code: null,
							surface,
							keyId: null,
							actorId: call.caller.principal.id,
							resourceId,
							requestId: call.requestId,
						}),
					),
				);
			} catch (error) {
				log("warn", "service activity: the record of a membership change failed", {
					op,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		})(),
	);
}

export function auditOk(call: CallContext, op: string, target: string): void {
	audit({
		op,
		actor: call.caller.principal.id,
		actorKind: call.caller.kind,
		credential: call.caller.credential,
		target,
		result: "ok",
		requestId: call.requestId,
	});
}

/**
 * The principal whose credentials the call manages: the caller by default. Throws unless the caller may
 * manage them.
 */
export async function credentialOwner(call: CallContext, principalId: string | undefined): Promise<PrincipalRecord> {
	const target =
		principalId === undefined || principalId === call.caller.principal.id
			? call.caller.principal
			: await getPrincipal(call.env.DIRECTORY, principalId);
	if (!target) throw new OperationError("not_found", "No principal has that id.");
	if (!canManageCredentialsOf(call.caller, target)) {
		throw new OperationError(
			"forbidden",
			"You can manage only your own credentials and the keys of agents that you sponsor.",
		);
	}
	return target;
}

/** The credential that made a lasting effect, such as a webhook. The effect stops when the credential stops. */
export interface CredentialBinding {
	principalId: string;
	kind: AuthContext["credential"];
	/** The API key or the OAuth grant. Null for a session: the effect then stops only with its principal. */
	id: string | null;
}

export function credentialBinding(caller: AuthContext): CredentialBinding {
	const id = caller.credential === "api_key" ? caller.keyId : caller.credential === "oauth" ? caller.grantId : null;
	return { principalId: caller.principal.id, kind: caller.credential, id };
}

/**
 * The state of a credential binding now. `live`: the principal and its credential work. `archived`: the
 * principal is archived, and a restore makes the credential work again. `ended`: the principal was
 * deleted, or the key or the OAuth grant was revoked or expired. A session binding ends only with its
 * principal: a sign-out does not end it.
 */
export async function credentialState(
	db: D1Database,
	binding: CredentialBinding,
): Promise<{ state: "live"; principal: PrincipalRecord } | { state: "archived" } | { state: "ended" }> {
	// A deleted principal has no address, so getPrincipal does not find it.
	const principal = await getPrincipal(db, binding.principalId);
	if (!principal) return { state: "ended" };
	if (binding.kind === "api_key") {
		const key = binding.id ? await getApiKey(db, binding.id) : null;
		if (!key || key.revoked_at !== null || key.principal_id !== principal.id || keyExpired(key)) {
			return { state: "ended" };
		}
	} else if (binding.kind === "oauth") {
		const grant = binding.id ? await getGrant(db, binding.id) : null;
		if (
			!grant ||
			grant.revoked_at !== null ||
			grant.principal_id !== principal.id ||
			Date.parse(grant.refresh_expires_at) <= Date.now()
		) {
			return { state: "ended" };
		}
	}
	if (principal.archived_at !== null) return { state: "archived" };
	return { state: "live", principal };
}

/**
 * A credential, named by a value that is not its secret: the SHA-256 of a session cookie, the id of
 * an API key, or the SHA-256 of an OAuth access token. A live connection keeps it, and asks again
 * later if the credential works. For OAuth it names the token and not the grant, so a connection
 * stops with the token that opened it. `grantId` then names the grant, which can give a new token.
 */
export interface CredentialRef {
	principalId: string;
	kind: AuthContext["credential"];
	id: string;
	grantId?: string;
	/**
	 * The number of the secret of an API key, when the key rotated before the open (1 or more). A ref
	 * without it names the first secret (0), so the refs of keys that never rotated do not change.
	 */
	gen?: number;
}

/** The same credential can open several sockets and register a push device. */
export function credentialKey(ref: CredentialRef): string {
	return `${ref.kind}:${ref.id}`;
}

export function credentialRef(caller: AuthContext): CredentialRef {
	const id =
		caller.credential === "session"
			? caller.sessionHash
			: caller.credential === "api_key"
				? caller.keyId
				: caller.accessHash;
	if (id === null) throw new Error(`a ${caller.credential} credential without an id`);
	const ref: CredentialRef = { principalId: caller.principal.id, kind: caller.credential, id };
	if (caller.grantId !== null) ref.grantId = caller.grantId;
	if (caller.keyGeneration !== null && caller.keyGeneration > 0) ref.gen = caller.keyGeneration;
	return ref;
}

/**
 * What a credential can do now.
 * - `live`: it works.
 * - `renew`: the connection must authenticate again. An OAuth access token that expired, or that a refresh
 *   replaced, while its grant works: the client gets a new token.
 * - `ended`: it does not work, and its owner cannot renew it.
 */
export type CredentialCheck = "live" | "renew" | "ended";

/**
 * For each credential, what it can do now, by the rules of `authenticate`: the principal is not
 * archived and not deleted, a session did not expire and its person did not sign out, an API key is
 * not revoked and did not expire, an OAuth access token is the current token of a grant that is not
 * revoked, and did not expire. So a refresh of a grant, which replaces its access token, stops the old token
 * here too.
 * A stored ref from an older Worker, such as the ref of a push device, can have the field `av`. The check
 * ignores it.
 * One query reads the whole list, and a credential that the list has many times is read one time. So
 * a room with many sockets makes one read.
 */
export async function checkCredentials(db: D1Database, refs: readonly CredentialRef[]): Promise<CredentialCheck[]> {
	if (refs.length === 0) return [];
	// Two secrets of one key are two credentials here: the old one stops with its overlap. The key of a
	// ref has the number of its secret. `credentialKey` stays as it is, because push devices match on it.
	const keys = refs.map((ref) => `${credentialKey(ref)}:${ref.gen ?? 0}`);
	const unique = [...new Map(refs.map((ref, index) => [keys[index] as string, ref])).values()];
	const { results } = await db
		.prepare(
			`SELECT json_extract(ref.value, '$.kind') || ':' || json_extract(ref.value, '$.id') || ':'
					|| COALESCE(json_extract(ref.value, '$.gen'), 0) AS key,
				CASE json_extract(ref.value, '$.kind')
					WHEN 'session' THEN CASE WHEN p.kind = 'human' AND EXISTS (
						SELECT 1 FROM sessions s
						WHERE s.token_hash = json_extract(ref.value, '$.id') AND s.principal_id = p.id AND s.expires_at > ?2)
						THEN 'live' END
					WHEN 'api_key' THEN CASE WHEN EXISTS (
						SELECT 1 FROM api_keys k
						WHERE k.id = json_extract(ref.value, '$.id') AND k.principal_id = p.id AND k.revoked_at IS NULL
							AND ${keyNotExpired(2, "k")}
							AND (COALESCE(json_extract(ref.value, '$.gen'), 0) = k.rotation
								OR (COALESCE(json_extract(ref.value, '$.gen'), 0) = k.rotation - 1 AND k.prev_expires_at > ?2)))
						THEN 'live' END
					WHEN 'oauth' THEN CASE
						WHEN EXISTS (
							SELECT 1 FROM oauth_grants g
							WHERE g.access_hash = json_extract(ref.value, '$.id') AND g.principal_id = p.id
								AND g.revoked_at IS NULL AND g.access_expires_at > ?2)
							THEN 'live'
						WHEN EXISTS (
							SELECT 1 FROM oauth_grants g
							WHERE g.id = json_extract(ref.value, '$.grantId') AND g.principal_id = p.id
								AND g.revoked_at IS NULL AND g.refresh_expires_at > ?2)
							THEN 'renew' END
				END AS state
			FROM json_each(?1) AS ref
			JOIN principals p ON p.id = json_extract(ref.value, '$.principalId')
				AND p.archived_at IS NULL AND p.deleted_at IS NULL`,
		)
		.bind(JSON.stringify(unique), new Date().toISOString())
		.all<{ key: string; state: CredentialCheck | null }>();
	const states = new Map(results.map((row) => [row.key, row.state ?? "ended"]));
	return keys.map((key) => states.get(key) ?? "ended");
}
