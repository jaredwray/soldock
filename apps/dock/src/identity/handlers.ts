import {
	AGENT_SCOPES,
	ALL_SCOPES,
	API_KEY_LIMITS,
	commaListEntries,
	DIRECTORY_LIMITS,
	type DirectoryEntry,
	mentionDirectory,
	mentionHandle,
	RoomId,
	SERVICE_ACTIVITY_LIMITS,
	SharedDriveId,
	SIGN_IN_LOCK_MINUTES,
	searchFold,
	TEAM_MAILBOX_LIMITS,
	type TokenResources,
} from "@asterra/contracts";
import { audit, decodeCursor, encodeCursor, type HandlerMap, OperationError } from "../platform/index.ts";
import { auditOk, credentialOwner, grantableScopes, isAdmin, missingScopes, recordServiceChange } from "./access.ts";
import type { AuthContext, CallContext } from "./auth.ts";
import { oauthHandlers } from "./oauth-handlers.ts";
import { toApiKeyOutput, toPrincipalOutput } from "./output.ts";
import { hashPassword } from "./password.ts";
import { endEventSockets } from "./principal.ts";
import { confirmPassword } from "./signin.ts";
import {
	addMailDomain,
	archivePrincipal,
	assertPrimaryAddress,
	countSponsoredAgents,
	createApiKey,
	createPrincipal,
	type DirectoryPosition,
	type DirectoryRecord,
	deletePrincipal,
	disableTotp,
	domainOf,
	enableTotp,
	endApiKeyRotation,
	getApiKey,
	getDirectoryRecords,
	getPrincipal,
	getPrincipals,
	keyExpired,
	listApiKeys,
	listPrincipalPage,
	liveApiKeys,
	mailDomains,
	mentionCandidates,
	type PrincipalRecord,
	pendingTotpSecret,
	removeMailDomain,
	restorePrincipal,
	revokeApiKey,
	rotateApiKey,
	setPassword,
	setPendingTotpSecret,
	unknownPrincipalIds,
	updateOutboundPolicy,
	updatePrincipal,
} from "./store.ts";
import {
	addTeamMailboxMember,
	createTeamMailbox,
	getTeamMailbox,
	isTeamMailboxId,
	listTeamMailboxes,
	removeTeamMailboxMember,
	renameTeamMailbox,
	type TeamMailboxRecord,
	teamMailboxesOf,
} from "./team-mailboxes.ts";
import { matchTotp, newTotpSecret, otpauthUri } from "./totp.ts";

type IdentityOperation =
	| "account.whoami"
	| "account.list_api_keys"
	| "account.create_api_key"
	| "account.revoke_api_key"
	| "account.rotate_api_key"
	| "account.end_api_key_rotation"
	| "account.set_password"
	| "account.create_totp_secret"
	| "account.enable_totp"
	| "account.disable_totp"
	| "directory.list_principals"
	| "directory.get_principals"
	| "directory.create_principal"
	| "directory.list_mail_domains"
	| "directory.add_mail_domain"
	| "directory.remove_mail_domain"
	| "directory.update_agent_policy"
	| "directory.update_principal"
	| "directory.archive_principal"
	| "directory.restore_principal"
	| "directory.delete_principal"
	| "directory.list_team_mailboxes"
	| "directory.create_team_mailbox"
	| "directory.update_team_mailbox"
	| "directory.add_team_mailbox_member"
	| "directory.remove_team_mailbox_member"
	| "directory.create_service_account"
	| "directory.list_service_account_activity"
	| "directory.get_service_account_access";

/**
 * Only the sponsor of an agent, an owner or an admin can change the agent's policy. Never the agent. Only
 * an owner or an admin changes the policy of a service account.
 */
function canChangePolicyOf(caller: AuthContext, target: PrincipalRecord): boolean {
	if (caller.kind !== "human" || target.kind !== "agent") return false;
	if (target.service) return isAdmin(caller);
	return target.sponsor_id === caller.principal.id || isAdmin(caller);
}

/**
 * The service account that an owner or an admin reads. Throws `forbidden` for each other caller, and
 * `not_found` for a principal that is not a service account.
 */
async function serviceAccountToRead(call: CallContext, principalId: string): Promise<PrincipalRecord> {
	if (!isAdmin(call.caller)) {
		throw new OperationError("forbidden", "Only owners and admins can read the details of a service account.");
	}
	const target = await getPrincipal(call.env.DIRECTORY, principalId);
	if (!target?.service) throw new OperationError("not_found", "No service account has that id.");
	return target;
}

/** The sponsor of a new agent or service account: a person who is not archived. */
async function liveSponsor(call: CallContext, sponsorId: string): Promise<PrincipalRecord> {
	const sponsor = await getPrincipal(call.env.DIRECTORY, sponsorId);
	if (!sponsor) throw new OperationError("not_found", "The sponsor does not exist.");
	if (sponsor.kind !== "human") throw new OperationError("invalid", "The sponsor must be a person.");
	if (sponsor.archived_at !== null) throw new OperationError("invalid", "The sponsor is archived.");
	return sponsor;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The end of a new key as an ISO time, or null for a key without an end. A custom end must be at least
 * `API_KEY_LIMITS.minSeconds` after now, and at most `API_KEY_LIMITS.maxDays` days after now.
 */
function keyExpiry(input: { expires_in_days?: number | undefined; expires_at?: string | undefined }): string | null {
	const now = Date.now();
	if (input.expires_in_days !== undefined) return new Date(now + input.expires_in_days * DAY_MS).toISOString();
	if (input.expires_at === undefined) return null;
	const end = Date.parse(input.expires_at);
	if (Number.isNaN(end) || end < now + API_KEY_LIMITS.minSeconds * 1000) {
		throw new OperationError("invalid", `expires_at must be at least ${API_KEY_LIMITS.minSeconds} seconds from now.`);
	}
	if (end > now + API_KEY_LIMITS.maxDays * DAY_MS) {
		throw new OperationError("invalid", `expires_at must be at most ${API_KEY_LIMITS.maxDays} days from now.`);
	}
	return new Date(end).toISOString();
}

/**
 * Checks the resource limits of a new token. Only a token of a service account can have them. A mailbox is
 * the own mailbox of the account (its id) or a team mailbox that exists. A drive is the own drive of the
 * account or a shared drive. A room is a room id. Any other id is refused, also the id of a different
 * principal: a limited token does not reach items that a person shared directly with the account.
 */
async function assertTokenResources(call: CallContext, target: PrincipalRecord, resources: TokenResources) {
	if (!target.service) throw new OperationError("invalid", "Only a token of a service account can have resources.");
	for (const id of resources.mailbox_ids) {
		if (id === target.id) continue;
		if (!isTeamMailboxId(id)) {
			throw new OperationError("invalid", `${id} is not the own mailbox of the account or a team mailbox.`);
		}
		if (!(await getTeamMailbox(call.env.DIRECTORY, id))) {
			throw new OperationError("not_found", `No team mailbox has the id ${id}.`);
		}
	}
	for (const id of resources.drive_ids) {
		if (id !== target.id && !SharedDriveId.safeParse(id).success) {
			throw new OperationError("invalid", `${id} is not the own drive of the account or a shared drive.`);
		}
	}
	for (const id of resources.room_ids) {
		if (!RoomId.safeParse(id).success) throw new OperationError("invalid", `${id} is not a room id.`);
	}
}

/** The text for the agents and service accounts that a person sponsors, for a refused archive or delete. */
function sponsoredText(name: string, count: number, action: "archive" | "delete"): string {
	const what = count === 1 ? "an agent or a service account" : `${count} agents or service accounts`;
	return `${name} sponsors ${what}. Give each one a different sponsor, or ${action} it, first.`;
}

/**
 * The principal that an owner or an admin changes, archives, restores or deletes. Only the owner manages
 * the owner, so an admin can never act on the owner. A deleted principal has no record.
 */
async function principalToManage(call: CallContext, principalId: string, action: string): Promise<PrincipalRecord> {
	if (!isAdmin(call.caller))
		throw new OperationError("forbidden", `Only owners and admins can ${action} people and agents.`);
	const target = await getPrincipal(call.env.DIRECTORY, principalId);
	if (!target) throw new OperationError("not_found", "No principal has that id.");
	if (target.org_role === "owner" && call.caller.principal.id !== target.id) {
		throw new OperationError("forbidden", "Only the owner can change the owner.");
	}
	return target;
}

/**
 * Nobody archives or deletes the owner or themselves, so the organization always keeps its owner and the
 * caller. Only a credential with every human scope can do it, so a narrow key cannot lock people out.
 */
function assertRemovable(call: CallContext, target: PrincipalRecord, action: "archive" | "delete"): void {
	if (target.org_role === "owner") throw new OperationError("forbidden", `Nobody can ${action} the owner.`);
	if (target.id === call.caller.principal.id) throw new OperationError("forbidden", `You cannot ${action} yourself.`);
	assertFullCredential(call.caller);
}

/**
 * A principal of the directory list, with the handle of a mention in Chat. Only an owner or an admin reads
 * `description` and `created_by` in the directory. Each other caller gets null for the two fields.
 */
function toDirectoryEntry(caller: AuthContext, record: DirectoryRecord): DirectoryEntry {
	const entry = { ...toPrincipalOutput(record), handle: mentionHandle(record.address, record.sharedLocal) };
	return isAdmin(caller) ? entry : { ...entry, description: null, created_by: null };
}

const DIRECTORY_CHANGED = "The directory changed during the request. Load it again and try again.";

/**
 * A sign-in gives a session with every human scope. So only a credential that holds every human scope
 * can change how a person signs in, and a narrow key cannot become a full session or lock a person out.
 */
function assertFullCredential(caller: AuthContext): void {
	const missing = ALL_SCOPES.filter((scope) => !caller.scopes.has(scope));
	if (missing.length > 0) {
		throw new OperationError(
			"forbidden",
			`A sign-in gives every human scope. Your credential does not hold ${missing.join(", ")}.`,
		);
	}
}

/**
 * A browser session that changes its own sign-in proves the current password again, so somebody with a
 * stolen session cookie cannot replace the password or the second step. A wrong password counts toward
 * the sign-in lock. An API key does not need it: a key with every human scope is the recovery credential
 * of the owner. A person without a password has nothing to prove.
 */
async function confirmCurrentPassword(
	call: CallContext,
	target: PrincipalRecord,
	currentPassword: string | undefined,
): Promise<void> {
	if (call.caller.credential !== "session" || target.id !== call.caller.principal.id || !target.password_set) return;
	if (currentPassword === undefined) {
		throw new OperationError("forbidden", "Enter your current password to change how you sign in.");
	}
	if (!(await confirmPassword(call.env.DIRECTORY, target.id, currentPassword))) {
		throw new OperationError(
			"forbidden",
			`The current password is not correct. After too many failed attempts, sign-in stops for ${SIGN_IN_LOCK_MINUTES} minutes.`,
		);
	}
}

/** The session that makes the call. A credential change from it commits only while it still exists. */
function liveSession(call: CallContext): string | null {
	return call.caller.credential === "session" ? call.caller.sessionHash : null;
}

const SESSION_ENDED = "This session ended during the request. Sign in again.";

export const identityHandlers: Pick<HandlerMap<CallContext>, IdentityOperation | keyof typeof oauthHandlers> = {
	...oauthHandlers,
	async "directory.list_mail_domains"(call) {
		if (!isAdmin(call.caller))
			throw new OperationError("forbidden", "Only owners and admins can read mail domain settings.");
		return { mail_domains: [...(await mailDomains(call.env.DIRECTORY))] };
	},

	async "directory.add_mail_domain"(call, input) {
		if (!isAdmin(call.caller)) throw new OperationError("forbidden", "Only owners and admins can add mail domains.");
		await addMailDomain(call.env.DIRECTORY, input.domain);
		auditOk(call, "directory.add_mail_domain", input.domain);
		return { mail_domains: [...(await mailDomains(call.env.DIRECTORY))] };
	},

	async "directory.remove_mail_domain"(call, input) {
		if (!isAdmin(call.caller)) throw new OperationError("forbidden", "Only owners and admins can remove mail domains.");
		await removeMailDomain(call.env.DIRECTORY, input.domain);
		auditOk(call, "directory.remove_mail_domain", input.domain);
		return { mail_domains: [...(await mailDomains(call.env.DIRECTORY))] };
	},

	async "account.whoami"(call) {
		return {
			principal: toPrincipalOutput(call.caller.principal),
			scopes: [...call.caller.scopes],
			missing_scopes: missingScopes(call.caller),
			credential: call.caller.credential,
			resources: call.caller.restriction,
			sign_in:
				call.caller.kind === "human"
					? { password_set: call.caller.principal.password_set, totp_enabled: call.caller.principal.totp_enabled }
					: null,
		};
	},

	async "directory.list_principals"(call, input) {
		const after =
			input.cursor === undefined ? null : decodeCursor<DirectoryPosition>(input.cursor, ["string", "string", "string"]);
		if (input.order === "match" && input.cursor !== undefined) {
			throw new OperationError("invalid", 'The order "match" has one page, so it takes no cursor.');
		}
		if (input.cursor !== undefined && after === null) {
			throw new OperationError(
				"invalid",
				"The cursor is not valid. Use next_cursor from the last page of the same list.",
			);
		}
		const page = await listPrincipalPage(call.env.DIRECTORY, {
			// The same fold as `lower` of SQLite: A to Z only. So an exact copy of "Élodie" finds Élodie.
			query: input.query?.replace(/[A-Z]/g, (letter) => letter.toLowerCase()) ?? null,
			// A part of the name without accents: "garcia" finds "María García".
			folded: input.query === undefined ? null : searchFold(input.query),
			activeOnly: input.active_only === "true",
			sponsorId: input.sponsor_id ?? null,
			kind: input.kind ?? null,
			byMatch: input.order === "match" && input.query !== undefined,
			after,
			limit: input.limit ?? DIRECTORY_LIMITS.defaultPageSize,
		});
		return {
			principals: page.principals.map((record) => toDirectoryEntry(call.caller, record)),
			next_cursor: page.next === null ? null : encodeCursor(page.next),
		};
	},

	async "directory.get_principals"(call, input) {
		const handles = [...new Set(commaListEntries(input.handles).map((handle) => handle.toLowerCase()))];
		// The principals that the handles can name, with the rules of a message of Chat (`mentionDirectory`).
		const named =
			handles.length === 0 ? null : mentionDirectory(await mentionCandidates(call.env.DIRECTORY, handles, []));
		const mentions = handles.flatMap((handle) => {
			const person = named?.byHandle.get(handle);
			return person ? [{ handle, principal_id: person.id }] : [];
		});
		const records = await getDirectoryRecords(call.env.DIRECTORY, [
			...commaListEntries(input.ids),
			...mentions.map((mention) => mention.principal_id),
		]);
		return { principals: records.map((record) => toDirectoryEntry(call.caller, record)), mentions };
	},

	async "directory.create_principal"(call, input) {
		if (!isAdmin(call.caller)) throw new OperationError("forbidden", "Only owners and admins can create principals.");
		const domains = await mailDomains(call.env.DIRECTORY);
		if (!domains.has(domainOf(input.address))) {
			throw new OperationError("invalid", "The address must use a saved mail domain. Check Admin settings.");
		}
		assertPrimaryAddress(input.address);
		let sponsorId: string | null = null;
		if (input.kind === "agent") {
			if (input.org_role) throw new OperationError("invalid", "An agent has no organization role.");
			if (input.password) throw new OperationError("invalid", "An agent has no password.");
			sponsorId = input.sponsor_id ?? call.caller.principal.id;
			await liveSponsor(call, sponsorId);
		} else {
			if (input.sponsor_id) throw new OperationError("invalid", "Only an agent has a sponsor.");
			if (!input.password) throw new OperationError("invalid", "A person needs a password to sign in.");
			assertFullCredential(call.caller);
		}
		const target = { kind: input.kind, sponsor_id: sponsorId, service: false } as PrincipalRecord;
		const scopes = grantableScopes(
			call.caller,
			target,
			input.key_scopes ?? (input.kind === "agent" ? AGENT_SCOPES : ALL_SCOPES),
		);
		const created = await createPrincipal(
			call.env.DIRECTORY,
			{
				kind: input.kind,
				display_name: input.display_name,
				address: input.address,
				org_role: input.kind === "human" ? (input.org_role ?? "member") : null,
				sponsor_id: sponsorId,
				password_hash: input.kind === "human" && input.password ? await hashPassword(input.password) : null,
				created_by: call.caller.principal.id,
			},
			{ label: "First key", scopes, created_by: call.caller.principal.id },
			// A sponsor archived or deleted during the request must not get a new agent.
			sponsorId ? { liveSponsorId: sponsorId } : {},
		);
		if (!created) {
			throw new OperationError(
				"conflict",
				"A directory reset is in progress, or the sponsor changed during the request. Try again.",
			);
		}
		auditOk(call, "directory.create_principal", created.principal.id);
		return {
			principal: toPrincipalOutput(created.principal),
			api_key: { ...toApiKeyOutput(created.key), secret: created.secret },
		};
	},

	async "directory.create_service_account"(call, input) {
		if (!isAdmin(call.caller)) {
			throw new OperationError("forbidden", "Only owners and admins can create service accounts.");
		}
		const domains = await mailDomains(call.env.DIRECTORY);
		if (!domains.has(domainOf(input.address))) {
			throw new OperationError("invalid", "The address must use a saved mail domain. Check Admin settings.");
		}
		assertPrimaryAddress(input.address);
		const sponsorId = input.sponsor_id ?? call.caller.principal.id;
		await liveSponsor(call, sponsorId);
		const created = await createPrincipal(
			call.env.DIRECTORY,
			{
				kind: "agent",
				service: true,
				display_name: input.display_name,
				address: input.address,
				org_role: null,
				sponsor_id: sponsorId,
				password_hash: null,
				description: input.description ?? null,
				created_by: call.caller.principal.id,
			},
			null,
			// A sponsor archived or deleted during the request must not get a new service account.
			{ liveSponsorId: sponsorId },
		);
		if (!created) {
			throw new OperationError(
				"conflict",
				"A directory reset is in progress, or the sponsor changed during the request. Try again.",
			);
		}
		auditOk(call, "directory.create_service_account", created.principal.id);
		recordServiceChange(call, created.principal, "directory.create_service_account");
		return { principal: toPrincipalOutput(created.principal) };
	},

	async "directory.list_service_account_activity"(call, input) {
		const target = await serviceAccountToRead(call, input.principal_id);
		const before = input.cursor === undefined ? null : decodeCursor<[number]>(input.cursor, ["number"]);
		if (input.cursor !== undefined && before === null) {
			throw new OperationError("invalid", "The cursor is not valid. Use next_cursor from the last page.");
		}
		const page = await call.env.PRINCIPAL.get(call.env.PRINCIPAL.idFromName(target.id)).listServiceActivity({
			before: before?.[0] ?? null,
			keyId: input.key_id ?? null,
			limit: input.limit ?? SERVICE_ACTIVITY_LIMITS.defaultPageSize,
		});
		return { entries: page.entries, next_cursor: page.next === null ? null : encodeCursor([page.next]) };
	},

	// The composition root adds the shared drives and the rooms (`src/handlers.ts`).
	async "directory.get_service_account_access"(call, input) {
		const target = await serviceAccountToRead(call, input.principal_id);
		const [mailboxes, keys] = await Promise.all([
			teamMailboxesOf(call.env.DIRECTORY, target.id),
			liveApiKeys(call.env.DIRECTORY, target.id),
		]);
		return {
			principal_id: target.id,
			team_mailboxes: mailboxes.map((mailbox) => ({
				id: mailbox.id,
				display_name: mailbox.display_name,
				address: mailbox.address,
			})),
			shared_drives: [],
			chat_rooms: [],
			chat_rooms_truncated: false,
			drive_shared_items: [],
			drive_shared_items_truncated: false,
			tokens: keys.map((key) => ({
				key_id: key.id,
				label: key.label,
				scopes: key.scopes,
				expires_at: key.expires_at,
				resources: key.resources,
			})),
			scopes: [...new Set(keys.flatMap((key) => key.scopes))].sort(),
		};
	},

	async "directory.update_agent_policy"(call, input) {
		const target = await getPrincipal(call.env.DIRECTORY, input.principal_id);
		if (target?.kind !== "agent") throw new OperationError("not_found", "No agent has that id.");
		if (!canChangePolicyOf(call.caller, target)) {
			throw new OperationError(
				"forbidden",
				target.service
					? "Only an owner or an admin can change the policy of a service account."
					: "Only the sponsor of the agent, an owner or an admin can change its policy.",
			);
		}
		const previousMode = await updateOutboundPolicy(call.env.DIRECTORY, target.id, input.mode, input.allowlist);
		if (!previousMode) throw new Error(`agent ${target.id} missing after update`);
		audit({
			op: "directory.update_agent_policy",
			actor: call.caller.principal.id,
			actorKind: call.caller.kind,
			credential: call.caller.credential,
			target: target.id,
			result: "ok",
			requestId: call.requestId,
			outboundMode: input.mode,
			previousOutboundMode: previousMode,
			allowlistSize: input.mode === "allowlist" ? input.allowlist.length : 0,
		});
		recordServiceChange(call, target, "directory.update_agent_policy");
		const updated = await getPrincipal(call.env.DIRECTORY, target.id);
		if (!updated) throw new Error(`agent ${target.id} missing after update`);
		return { principal: toPrincipalOutput(updated) };
	},

	async "directory.update_principal"(call, input) {
		const target = await principalToManage(call, input.principal_id, "change");
		if (input.org_role !== undefined) {
			if (target.kind !== "human") throw new OperationError("invalid", "An agent has no organization role.");
			if (target.org_role === "owner") throw new OperationError("invalid", "The role of the owner cannot change.");
			if (target.id === call.caller.principal.id) {
				throw new OperationError("forbidden", "You cannot change your own role.");
			}
			assertFullCredential(call.caller);
		}
		if (input.sponsor_id !== undefined) {
			if (target.kind !== "agent") {
				throw new OperationError("invalid", "Only an agent or a service account has a sponsor.");
			}
			await liveSponsor(call, input.sponsor_id);
		}
		if (input.description !== undefined && !target.service) {
			throw new OperationError("invalid", "Only a service account has a description.");
		}
		const changes = {
			display_name: input.display_name,
			org_role: input.org_role,
			sponsor_id: input.sponsor_id,
			description: input.description,
		};
		if (!(await updatePrincipal(call.env.DIRECTORY, target.id, changes))) {
			throw new OperationError("conflict", DIRECTORY_CHANGED);
		}
		auditOk(call, "directory.update_principal", target.id);
		recordServiceChange(call, target, "directory.update_principal");
		return { principal: toPrincipalOutput(await principalAfterChange(call, target.id)) };
	},

	async "directory.archive_principal"(call, input) {
		const target = await principalToManage(call, input.principal_id, "archive");
		assertRemovable(call, target, "archive");
		// An archived person could still act through the keys of an agent that they sponsor.
		const agents = await countSponsoredAgents(call.env.DIRECTORY, target.id, { activeOnly: true });
		if (agents > 0) throw new OperationError("conflict", sponsoredText(target.display_name, agents, "archive"));
		await archivePrincipal(call.env.DIRECTORY, target.id);
		const archived = await principalAfterChange(call, target.id);
		if (archived.archived_at === null) throw new OperationError("conflict", DIRECTORY_CHANGED);
		auditOk(call, "directory.archive_principal", target.id);
		recordServiceChange(call, target, "directory.archive_principal");
		return { principal: toPrincipalOutput(archived) };
	},

	async "directory.restore_principal"(call, input) {
		const target = await principalToManage(call, input.principal_id, "restore");
		assertFullCredential(call.caller);
		if (target.kind === "agent" && target.archived_at !== null) {
			const sponsor = target.sponsor_id ? await getPrincipal(call.env.DIRECTORY, target.sponsor_id) : null;
			if (!sponsor || sponsor.archived_at !== null) {
				throw new OperationError(
					"invalid",
					`The sponsor of this ${target.service ? "service account" : "agent"} is archived. Give it a different sponsor first.`,
				);
			}
		}
		await restorePrincipal(call.env.DIRECTORY, target.id);
		const restored = await principalAfterChange(call, target.id);
		if (restored.archived_at !== null) throw new OperationError("conflict", DIRECTORY_CHANGED);
		auditOk(call, "directory.restore_principal", target.id);
		recordServiceChange(call, target, "directory.restore_principal");
		return { principal: toPrincipalOutput(restored) };
	},

	async "directory.delete_principal"(call, input) {
		const target = await principalToManage(call, input.principal_id, "delete");
		assertRemovable(call, target, "delete");
		const agents = await countSponsoredAgents(call.env.DIRECTORY, target.id);
		if (agents > 0) throw new OperationError("conflict", sponsoredText(target.display_name, agents, "delete"));
		if (!(await deletePrincipal(call.env.DIRECTORY, target.id)))
			throw new OperationError("conflict", DIRECTORY_CHANGED);
		auditOk(call, "directory.delete_principal", target.id);
		recordServiceChange(call, target, "directory.delete_principal");
		return { principal_id: target.id };
	},

	async "directory.list_team_mailboxes"(call) {
		return { team_mailboxes: await listTeamMailboxes(call.env.DIRECTORY) };
	},

	async "directory.create_team_mailbox"(call, input) {
		if (!isAdmin(call.caller)) {
			throw new OperationError("forbidden", "Only owners and admins can create team mailboxes.");
		}
		const domains = await mailDomains(call.env.DIRECTORY);
		if (!domains.has(domainOf(input.address))) {
			throw new OperationError("invalid", "The address must use a saved mail domain. Check Admin settings.");
		}
		assertPrimaryAddress(input.address);
		const unknown = await unknownPrincipalIds(call.env.DIRECTORY, input.member_ids);
		if (unknown.length > 0) throw new OperationError("not_found", `No principal has the id ${unknown.join(", ")}.`);
		const created = await createTeamMailbox(call.env.DIRECTORY, {
			display_name: input.display_name,
			address: input.address,
			member_ids: input.member_ids,
			created_by: call.caller.principal.id,
		});
		if (!created) {
			throw new OperationError("conflict", "A directory reset is in progress. Try again after it completes.");
		}
		auditOk(call, "directory.create_team_mailbox", created.id);
		for (const memberId of created.member_ids) {
			auditOk(call, "directory.add_team_mailbox_member", `${created.id}:${memberId}`);
		}
		for (const member of await getPrincipals(call.env.DIRECTORY, created.member_ids)) {
			recordServiceChange(call, member, "directory.add_team_mailbox_member");
		}
		return { team_mailbox: created };
	},

	async "directory.update_team_mailbox"(call, input) {
		const mailbox = await teamMailboxToManage(call, input.mailbox_id, "rename");
		if (!(await renameTeamMailbox(call.env.DIRECTORY, mailbox.id, input.display_name))) {
			throw new OperationError("conflict", DIRECTORY_CHANGED);
		}
		auditOk(call, "directory.update_team_mailbox", mailbox.id);
		return { team_mailbox: await teamMailboxAfterChange(call, mailbox.id) };
	},

	async "directory.add_team_mailbox_member"(call, input) {
		await teamMailboxToManage(call, input.mailbox_id, "change the members of");
		const member = await getPrincipal(call.env.DIRECTORY, input.principal_id);
		if (!member) throw new OperationError("not_found", "No principal has that id.");
		if (!(await addTeamMailboxMember(call.env.DIRECTORY, input.mailbox_id, member.id, call.caller.principal.id))) {
			if (!(await getPrincipal(call.env.DIRECTORY, member.id))) {
				throw new OperationError("not_found", "No principal has that id.");
			}
			throw new OperationError("invalid", `A team mailbox can have at most ${TEAM_MAILBOX_LIMITS.members} members.`);
		}
		auditOk(call, "directory.add_team_mailbox_member", `${input.mailbox_id}:${member.id}`);
		recordServiceChange(call, member, "directory.add_team_mailbox_member");
		return { team_mailbox: await teamMailboxAfterChange(call, input.mailbox_id) };
	},

	async "directory.remove_team_mailbox_member"(call, input) {
		await teamMailboxToManage(call, input.mailbox_id, "change the members of");
		await removeTeamMailboxMember(call.env.DIRECTORY, input.mailbox_id, input.principal_id);
		auditOk(call, "directory.remove_team_mailbox_member", `${input.mailbox_id}:${input.principal_id}`);
		const member = await getPrincipal(call.env.DIRECTORY, input.principal_id);
		if (member) recordServiceChange(call, member, "directory.remove_team_mailbox_member");
		return { team_mailbox: await teamMailboxAfterChange(call, input.mailbox_id) };
	},

	async "account.list_api_keys"(call, input) {
		const target = await credentialOwner(call, input.principal_id);
		return { api_keys: (await listApiKeys(call.env.DIRECTORY, target.id)).map((key) => toApiKeyOutput(key)) };
	},

	async "account.create_api_key"(call, input) {
		const target = await credentialOwner(call, input.principal_id);
		const scopes = grantableScopes(call.caller, target, input.scopes);
		if (input.resources !== undefined) await assertTokenResources(call, target, input.resources);
		const created = await createApiKey(call.env.DIRECTORY, target.id, {
			label: input.label,
			scopes,
			created_by: call.caller.principal.id,
			description: input.description ?? null,
			expires_at: keyExpiry(input),
			resources: input.resources ?? null,
		});
		auditOk(call, "account.create_api_key", created.key.id);
		recordServiceChange(call, target, "account.create_api_key", created.key.id);
		return { api_key: { ...toApiKeyOutput(created.key), secret: created.secret } };
	},

	async "account.revoke_api_key"(call, input) {
		const key = await getApiKey(call.env.DIRECTORY, input.key_id);
		if (!key) throw new OperationError("not_found", "No API key has that id.");
		const owner = await credentialOwner(call, key.principal_id);
		const changed = await revokeApiKey(call.env.DIRECTORY, key.id, call.caller.principal.id);
		await endEventSockets(call.env, key.principal_id, { kind: "api_key", id: key.id });
		auditOk(call, "account.revoke_api_key", key.id);
		if (changed) recordServiceChange(call, owner, "account.revoke_api_key", key.id);
		return { revoked: true };
	},

	async "account.rotate_api_key"(call, input) {
		const key = await getApiKey(call.env.DIRECTORY, input.key_id);
		if (!key) throw new OperationError("not_found", "No API key has that id.");
		const owner = await credentialOwner(call, key.principal_id);
		// The new secret gives each scope of the key. So the caller must hold each one, as for a new key.
		const notHeld = key.scopes.filter((scope) => !call.caller.scopes.has(scope));
		if (notHeld.length > 0) {
			throw new OperationError(
				"forbidden",
				`Your credential does not hold ${notHeld.join(", ")}, so it cannot rotate this key.`,
			);
		}
		const overlapMinutes = input.overlap_minutes ?? API_KEY_LIMITS.rotationOverlapMinutes.default;
		const rotated = await rotateApiKey(call.env.DIRECTORY, key.id, call.caller.principal.id, overlapMinutes * 60_000);
		if (!rotated) {
			const now = await getApiKey(call.env.DIRECTORY, key.id);
			throw new OperationError(
				"conflict",
				!now || now.revoked_at !== null
					? "This key is revoked. Create a new key."
					: keyExpired(now)
						? "This key expired. Create a new key."
						: "The old secret of the last rotation still works. Wait for its end, or call account.end_api_key_rotation first.",
			);
		}
		auditOk(call, "account.rotate_api_key", key.id);
		recordServiceChange(call, owner, "account.rotate_api_key", key.id);
		return { api_key: { ...toApiKeyOutput(rotated.key), secret: rotated.secret } };
	},

	async "account.end_api_key_rotation"(call, input) {
		const key = await getApiKey(call.env.DIRECTORY, input.key_id);
		if (!key) throw new OperationError("not_found", "No API key has that id.");
		const owner = await credentialOwner(call, key.principal_id);
		// Only a call that stops a live old secret is a change, as only a revoke of a live key is.
		const live = key.prev_expires_at !== null && Date.parse(key.prev_expires_at) > Date.now();
		const ended = await endApiKeyRotation(call.env.DIRECTORY, key.id);
		if (!ended) throw new OperationError("not_found", "No API key has that id.");
		if (live) {
			auditOk(call, "account.end_api_key_rotation", key.id);
			recordServiceChange(call, owner, "account.end_api_key_rotation", key.id);
		}
		return { api_key: toApiKeyOutput(ended) };
	},

	async "account.set_password"(call, input) {
		const target = await credentialOwner(call, input.principal_id);
		if (target.kind !== "human") throw new OperationError("invalid", "Only a person has a password.");
		assertFullCredential(call.caller);
		await confirmCurrentPassword(call, target, input.current_password);
		// The change ends the other sessions of the person, so somebody who knew the old password loses
		// each session made with it. The session that makes its own change stays.
		const keep = target.id === call.caller.principal.id ? call.caller.sessionHash : null;
		const hash = await hashPassword(input.password);
		if (!(await setPassword(call.env.DIRECTORY, target.id, hash, keep, liveSession(call)))) {
			throw new OperationError("unauthenticated", SESSION_ENDED);
		}
		auditOk(call, "account.set_password", target.id);
		return { principal_id: target.id };
	},

	async "account.create_totp_secret"(call) {
		assertFullCredential(call.caller);
		const secret = newTotpSecret();
		await setPendingTotpSecret(call.env.DIRECTORY, call.caller.principal.id, secret);
		auditOk(call, "account.create_totp_secret", call.caller.principal.id);
		return { secret, otpauth_uri: otpauthUri(secret, call.caller.principal.address) };
	},

	async "account.enable_totp"(call, input) {
		assertFullCredential(call.caller);
		await confirmCurrentPassword(call, call.caller.principal, input.current_password);
		const id = call.caller.principal.id;
		const secret = await pendingTotpSecret(call.env.DIRECTORY, id);
		if (!secret) throw new OperationError("conflict", "Start with account.create_totp_secret, then send a code.");
		const step = await matchTotp(secret, input.code, null);
		if (step === null) {
			throw new OperationError(
				"invalid",
				"The code is not correct. Make sure that the clock of the device is correct, then try the newest code.",
			);
		}
		if (!(await enableTotp(call.env.DIRECTORY, id, secret, step, call.caller.sessionHash, liveSession(call)))) {
			throw new OperationError("conflict", "A newer setup replaced this secret, or this session ended. Start again.");
		}
		auditOk(call, "account.enable_totp", id);
		return { totp_enabled: true };
	},

	async "account.disable_totp"(call, input) {
		const target = await credentialOwner(call, input.principal_id);
		if (target.kind !== "human") throw new OperationError("invalid", "Only a person has two-step verification.");
		assertFullCredential(call.caller);
		await confirmCurrentPassword(call, target, input.current_password);
		if (!(await disableTotp(call.env.DIRECTORY, target.id, liveSession(call)))) {
			throw new OperationError("unauthenticated", SESSION_ENDED);
		}
		auditOk(call, "account.disable_totp", target.id);
		return { principal_id: target.id, totp_enabled: false };
	},
};

/**
 * The team mailbox that the call changes: its name or its members. Only owners and admins
 * change them. A member, also an agent, can never add itself or others: an agent holds no
 * `directory.write` scope, and these operations accept humans only.
 */
async function teamMailboxToManage(
	call: CallContext,
	mailboxId: string,
	action: "rename" | "change the members of",
): Promise<TeamMailboxRecord> {
	if (!isAdmin(call.caller)) {
		throw new OperationError("forbidden", `Only owners and admins can ${action} a team mailbox.`);
	}
	const mailbox = await getTeamMailbox(call.env.DIRECTORY, mailboxId);
	if (!mailbox) throw new OperationError("not_found", "No team mailbox has that id.");
	return mailbox;
}

async function principalAfterChange(call: CallContext, principalId: string): Promise<PrincipalRecord> {
	const principal = await getPrincipal(call.env.DIRECTORY, principalId);
	if (!principal) throw new OperationError("conflict", DIRECTORY_CHANGED);
	return principal;
}

async function teamMailboxAfterChange(call: CallContext, mailboxId: string): Promise<TeamMailboxRecord> {
	const mailbox = await getTeamMailbox(call.env.DIRECTORY, mailboxId);
	if (!mailbox) throw new Error(`team mailbox ${mailboxId} missing after a change`);
	return mailbox;
}
