import { AGENT_SCOPES, ALL_SCOPES, type Scope, SIGN_IN_LOCK_MINUTES } from "@soldock/contracts";
import { audit, type HandlerMap, OperationError } from "../platform/index.ts";
import type { AuthContext, CallContext } from "./auth.ts";
import { toApiKeyOutput, toPrincipalOutput } from "./output.ts";
import { hashPassword } from "./password.ts";
import { confirmPassword } from "./signin.ts";
import {
	addMailDomain,
	assertPrimaryAddress,
	createApiKey,
	createPrincipal,
	disableTotp,
	domainOf,
	enableTotp,
	getApiKey,
	getPrincipal,
	listApiKeys,
	listPrincipals,
	mailDomains,
	type PrincipalRecord,
	pendingTotpSecret,
	removeMailDomain,
	revokeApiKey,
	scopeCeiling,
	setPassword,
	setPendingTotpSecret,
	updateOutboundPolicy,
} from "./store.ts";
import { matchTotp, newTotpSecret, otpauthUri } from "./totp.ts";

type IdentityOperation =
	| "account.whoami"
	| "account.list_api_keys"
	| "account.create_api_key"
	| "account.revoke_api_key"
	| "account.set_password"
	| "account.create_totp_secret"
	| "account.enable_totp"
	| "account.disable_totp"
	| "directory.list_principals"
	| "directory.create_principal"
	| "directory.list_mail_domains"
	| "directory.add_mail_domain"
	| "directory.remove_mail_domain"
	| "directory.update_agent_policy";

function isAdmin(caller: AuthContext): boolean {
	return caller.principal.org_role === "owner" || caller.principal.org_role === "admin";
}

/**
 * A human manages their own credentials (keys, password and two-step verification), the keys of the
 * agents that they sponsor and, as an admin, the credentials of others. Only the owner manages the owner's
 * credentials, so an admin can never act as the owner.
 */
function canManageCredentialsOf(caller: AuthContext, target: PrincipalRecord): boolean {
	if (caller.kind !== "human") return false;
	if (target.id === caller.principal.id) return true;
	if (target.org_role === "owner") return false;
	if (target.kind === "agent" && target.sponsor_id === caller.principal.id) return true;
	return isAdmin(caller);
}

/** Only the sponsor of an agent, an owner or an admin can change the agent's policy. Never the agent. */
function canChangePolicyOf(caller: AuthContext, target: PrincipalRecord): boolean {
	if (caller.kind !== "human" || target.kind !== "agent") return false;
	return target.sponsor_id === caller.principal.id || isAdmin(caller);
}

/**
 * The scopes for a new key. A key can never hold more than its principal kind allows, and never more
 * than the credential that creates it, so a narrow key cannot mint a wider one.
 */
function grantableScopes(caller: AuthContext, target: PrincipalRecord, requested: readonly Scope[]): Scope[] {
	const ceiling = new Set(scopeCeiling(target.kind));
	const outside = requested.filter((scope) => !ceiling.has(scope));
	if (outside.length > 0) {
		throw new OperationError("invalid", `A key for an ${target.kind} cannot hold ${outside.join(", ")}.`);
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

function auditOk(call: CallContext, op: string, target: string): void {
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

export const identityHandlers: Pick<HandlerMap<CallContext>, IdentityOperation> = {
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
			credential: call.caller.credential,
			sign_in:
				call.caller.kind === "human"
					? { password_set: call.caller.principal.password_set, totp_enabled: call.caller.principal.totp_enabled }
					: null,
		};
	},

	async "directory.list_principals"(call) {
		return { principals: (await listPrincipals(call.env.DIRECTORY)).map(toPrincipalOutput) };
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
			const sponsor = await getPrincipal(call.env.DIRECTORY, sponsorId);
			if (!sponsor) throw new OperationError("not_found", "The sponsor does not exist.");
			if (sponsor.kind !== "human") throw new OperationError("invalid", "The sponsor of an agent must be a human.");
		} else {
			if (input.sponsor_id) throw new OperationError("invalid", "Only an agent has a sponsor.");
			if (!input.password) throw new OperationError("invalid", "A person needs a password to sign in.");
			assertFullCredential(call.caller);
		}
		const target = { kind: input.kind, sponsor_id: sponsorId } as PrincipalRecord;
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
			},
			{ label: "First key", scopes, created_by: call.caller.principal.id },
		);
		if (!created)
			throw new OperationError("conflict", "A directory reset is in progress. Try again after it completes.");
		auditOk(call, "directory.create_principal", created.principal.id);
		return {
			principal: toPrincipalOutput(created.principal),
			api_key: { ...toApiKeyOutput(created.key), secret: created.secret },
		};
	},

	async "directory.update_agent_policy"(call, input) {
		const target = await getPrincipal(call.env.DIRECTORY, input.principal_id);
		if (target?.kind !== "agent") throw new OperationError("not_found", "No agent has that id.");
		if (!canChangePolicyOf(call.caller, target)) {
			throw new OperationError(
				"forbidden",
				"Only the sponsor of the agent, an owner or an admin can change its policy.",
			);
		}
		await updateOutboundPolicy(call.env.DIRECTORY, target.id, input.mode, input.allowlist);
		auditOk(call, "directory.update_agent_policy", target.id);
		const updated = await getPrincipal(call.env.DIRECTORY, target.id);
		if (!updated) throw new Error(`agent ${target.id} missing after update`);
		return { principal: toPrincipalOutput(updated) };
	},

	async "account.list_api_keys"(call, input) {
		const target = await credentialOwner(call, input.principal_id);
		return { api_keys: (await listApiKeys(call.env.DIRECTORY, target.id)).map(toApiKeyOutput) };
	},

	async "account.create_api_key"(call, input) {
		const target = await credentialOwner(call, input.principal_id);
		const scopes = grantableScopes(call.caller, target, input.scopes);
		const created = await createApiKey(call.env.DIRECTORY, target.id, {
			label: input.label,
			scopes,
			created_by: call.caller.principal.id,
		});
		auditOk(call, "account.create_api_key", created.key.id);
		return { api_key: { ...toApiKeyOutput(created.key), secret: created.secret } };
	},

	async "account.revoke_api_key"(call, input) {
		const key = await getApiKey(call.env.DIRECTORY, input.key_id);
		if (!key) throw new OperationError("not_found", "No API key has that id.");
		await credentialOwner(call, key.principal_id);
		await revokeApiKey(call.env.DIRECTORY, key.id);
		auditOk(call, "account.revoke_api_key", key.id);
		return { revoked: true };
	},

	async "account.set_password"(call, input) {
		const target = await credentialOwner(call, input.principal_id);
		if (target.kind !== "human") throw new OperationError("invalid", "Only a person has a password.");
		assertFullCredential(call.caller);
		await confirmCurrentPassword(call, target, input.current_password);
		// The change ends the other sessions of the person, so somebody who knew the old password loses
		// each session made with it. The session that makes its own change stays.
		const keep = target.id === call.caller.principal.id ? call.caller.sessionHash : null;
		await setPassword(call.env.DIRECTORY, target.id, await hashPassword(input.password), keep);
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
		if (!(await enableTotp(call.env.DIRECTORY, id, secret, step, call.caller.sessionHash))) {
			throw new OperationError("conflict", "A newer setup replaced this secret. Start again.");
		}
		auditOk(call, "account.enable_totp", id);
		return { totp_enabled: true };
	},

	async "account.disable_totp"(call, input) {
		const target = await credentialOwner(call, input.principal_id);
		if (target.kind !== "human") throw new OperationError("invalid", "Only a person has two-step verification.");
		assertFullCredential(call.caller);
		await confirmCurrentPassword(call, target, input.current_password);
		await disableTotp(call.env.DIRECTORY, target.id);
		auditOk(call, "account.disable_totp", target.id);
		return { principal_id: target.id, totp_enabled: false };
	},
};

/**
 * The principal whose credentials the call manages: the caller by default. Throws unless the caller may
 * manage them.
 */
async function credentialOwner(call: CallContext, principalId: string | undefined): Promise<PrincipalRecord> {
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
