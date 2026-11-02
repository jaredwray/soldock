import { AGENT_SCOPES, ALL_SCOPES, type Scope } from "@soldock/contracts";
import { audit, type HandlerMap, OperationError } from "../platform/index.ts";
import type { AuthContext, CallContext } from "./auth.ts";
import { toApiKeyOutput, toPrincipalOutput } from "./output.ts";
import {
	createApiKey,
	createPrincipal,
	domainOf,
	getApiKey,
	getPrincipal,
	listApiKeys,
	listPrincipals,
	mailDomains,
	type PrincipalRecord,
	revokeApiKey,
	scopeCeiling,
	updateOutboundPolicy,
} from "./store.ts";

type IdentityOperation =
	| "account.whoami"
	| "account.list_api_keys"
	| "account.create_api_key"
	| "account.revoke_api_key"
	| "directory.list_principals"
	| "directory.create_principal"
	| "directory.update_agent_policy";

function isAdmin(caller: AuthContext): boolean {
	return caller.principal.org_role === "owner" || caller.principal.org_role === "admin";
}

/** A human manages their own keys, the keys of the agents that they sponsor and, as an admin, anyone's keys. */
function canManageKeysOf(caller: AuthContext, target: PrincipalRecord): boolean {
	if (caller.kind !== "human") return false;
	if (target.id === caller.principal.id) return true;
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
	async "account.whoami"(call) {
		return {
			principal: toPrincipalOutput(call.caller.principal),
			scopes: [...call.caller.scopes],
			credential: call.caller.credential,
		};
	},

	async "directory.list_principals"(call) {
		return { principals: (await listPrincipals(call.env.DIRECTORY)).map(toPrincipalOutput) };
	},

	async "directory.create_principal"(call, input) {
		if (!isAdmin(call.caller)) throw new OperationError("forbidden", "Only owners and admins can create principals.");
		if (!mailDomains(call.env).has(domainOf(input.address))) {
			throw new OperationError("invalid", `The address must be on a mail domain: ${call.env.MAIL_DOMAINS}.`);
		}
		if (input.address.slice(0, input.address.lastIndexOf("@")).includes("+")) {
			throw new OperationError("invalid", "A primary address cannot contain +. Mail to user+tag reaches user.");
		}
		let sponsorId: string | null = null;
		if (input.kind === "agent") {
			if (input.org_role) throw new OperationError("invalid", "An agent has no organization role.");
			sponsorId = input.sponsor_id ?? call.caller.principal.id;
			const sponsor = await getPrincipal(call.env.DIRECTORY, sponsorId);
			if (!sponsor) throw new OperationError("not_found", "The sponsor does not exist.");
			if (sponsor.kind !== "human") throw new OperationError("invalid", "The sponsor of an agent must be a human.");
		} else if (input.sponsor_id) {
			throw new OperationError("invalid", "Only an agent has a sponsor.");
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
			},
			{ label: "First key", scopes, created_by: call.caller.principal.id },
		);
		if (!created) throw new Error("createPrincipal wrote nothing");
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
		const target = await keyOwner(call, input.principal_id);
		return { api_keys: (await listApiKeys(call.env.DIRECTORY, target.id)).map(toApiKeyOutput) };
	},

	async "account.create_api_key"(call, input) {
		const target = await keyOwner(call, input.principal_id);
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
		await keyOwner(call, key.principal_id);
		await revokeApiKey(call.env.DIRECTORY, key.id);
		auditOk(call, "account.revoke_api_key", key.id);
		return { revoked: true };
	},
};

/** The principal whose keys the call manages: the caller by default. Throws unless the caller may manage them. */
async function keyOwner(call: CallContext, principalId: string | undefined): Promise<PrincipalRecord> {
	const target =
		principalId === undefined || principalId === call.caller.principal.id
			? call.caller.principal
			: await getPrincipal(call.env.DIRECTORY, principalId);
	if (!target) throw new OperationError("not_found", "No principal has that id.");
	if (!canManageKeysOf(call.caller, target)) {
		throw new OperationError("forbidden", "You can manage only your own keys and the keys of agents that you sponsor.");
	}
	return target;
}
