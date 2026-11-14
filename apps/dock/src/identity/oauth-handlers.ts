import type { OAuthAuthorization, OAuthGrant } from "@soldock/contracts";
import { type HandlerMap, OperationError } from "../platform/index.ts";
import { auditOk, canManageCredentialsOf, credentialOwner, grantableScopes, isAdmin } from "./access.ts";
import type { CallContext } from "./auth.ts";
import {
	approveStatement,
	denyRequest,
	getGrant,
	getPendingRequest,
	listGrants,
	newCode,
	type OAuthGrantRecord,
	type OAuthRequestRecord,
	pendingRequestCondition,
	revokeGrant,
} from "./oauth-store.ts";
import { redirectHost, redirectWith } from "./oauth-urls.ts";
import { toPrincipalOutput } from "./output.ts";
import {
	assertPrimaryAddress,
	createPrincipal,
	domainOf,
	getPrincipal,
	liveSponsorCondition,
	mailDomains,
} from "./store.ts";

type OAuthOperation =
	| "oauth.get_authorization"
	| "oauth.approve_authorization"
	| "oauth.deny_authorization"
	| "oauth.list_grants"
	| "oauth.revoke_grant";

const GONE = "This request expired, or somebody approved or denied it. Start the connection again in the app.";

function toAuthorizationOutput(request: OAuthRequestRecord): OAuthAuthorization {
	return {
		id: request.id,
		untrusted: true,
		client: { id: request.client.id, name: request.client.name, uri: request.client.uri },
		redirect_uri: request.redirect_uri,
		redirect_host: redirectHost(request.redirect_uri),
		requested_scopes: request.scopes,
		expires_at: request.expires_at,
	};
}

function toGrantOutput(record: OAuthGrantRecord): OAuthGrant {
	return {
		id: record.id,
		untrusted: true,
		principal_id: record.principal_id,
		client_id: record.client_id,
		client_name: record.client_name,
		scopes: record.scopes,
		created_by: record.created_by,
		created_at: record.created_at,
		last_used_at: record.last_used_at,
		expires_at: record.refresh_expires_at,
		revoked: record.revoked_at !== null,
	};
}

async function pendingRequest(call: CallContext, id: string): Promise<OAuthRequestRecord> {
	const request = await getPendingRequest(call.env.DIRECTORY, id);
	if (!request) throw new OperationError("not_found", GONE);
	return request;
}

/** The address that sends the code and the `state` of the client back to the client. */
function codeRedirect(request: OAuthRequestRecord, code: string): string {
	return redirectWith(request.redirect_uri, { code, state: request.state });
}

export const oauthHandlers: Pick<HandlerMap<CallContext>, OAuthOperation> = {
	async "oauth.get_authorization"(call, input) {
		return { authorization: toAuthorizationOutput(await pendingRequest(call, input.request_id)) };
	},

	async "oauth.approve_authorization"(call, input) {
		const request = await pendingRequest(call, input.request_id);
		/**
		 * The approval of the transaction. Call it after each other check, just before the transaction, so its
		 * time is current. The insert of a new agent and the approval use this one time, so they agree.
		 */
		const approvalAt = async () => {
			const now = Date.now();
			const code = await newCode(now);
			const approval = {
				requestId: request.id,
				approvedBy: call.caller.principal.id,
				codeHash: code.hash,
				codeExpiresAt: code.expires_at,
				now: new Date(now).toISOString(),
			};
			return { code, approval };
		};
		if (input.new_agent) {
			// The same rules as directory.create_principal for an agent: owners and admins only, with directory.write.
			if (!isAdmin(call.caller) || !call.caller.scopes.has("directory.write")) {
				throw new OperationError(
					"forbidden",
					"Only owners and admins can create an agent. Connect an agent that you sponsor, or ask an admin.",
				);
			}
			const domains = await mailDomains(call.env.DIRECTORY);
			if (!domains.has(domainOf(input.new_agent.address))) {
				throw new OperationError("invalid", "The address must use a saved mail domain. Check Admin settings.");
			}
			assertPrimaryAddress(input.new_agent.address);
			const scopes = grantableScopes(call.caller, { kind: "agent" }, input.scopes);
			const { code, approval } = await approvalAt();
			// The request must still wait, and the approver, who becomes the sponsor, must still be active.
			const pending = pendingRequestCondition(request.id, approval.now);
			const sponsor = liveSponsorCondition(call.caller.principal.id);
			const created = await createPrincipal(
				call.env.DIRECTORY,
				{
					kind: "agent",
					display_name: input.new_agent.display_name,
					address: input.new_agent.address,
					org_role: null,
					sponsor_id: call.caller.principal.id,
					password_hash: null,
				},
				null,
				{
					condition: { sql: `${pending.sql} AND ${sponsor.sql}`, params: [...pending.params, ...sponsor.params] },
					afterCreate: (principalId) => [approveStatement(call.env.DIRECTORY, { ...approval, principalId, scopes })],
				},
			);
			if (!created) throw new OperationError("conflict", `${GONE} A directory reset can also cause this.`);
			auditOk(call, "directory.create_principal", created.principal.id);
			auditOk(call, "oauth.approve_authorization", `${request.id}:${created.principal.id}`);
			return { principal: toPrincipalOutput(created.principal), redirect_to: codeRedirect(request, code.code) };
		}
		const agent = input.agent_id ? await getPrincipal(call.env.DIRECTORY, input.agent_id) : null;
		if (agent?.kind !== "agent") throw new OperationError("not_found", "No agent has that id.");
		if (agent.archived_at !== null) throw new OperationError("invalid", "This agent is archived. Restore it first.");
		if (!canManageCredentialsOf(call.caller, agent)) {
			throw new OperationError(
				"forbidden",
				"Only the sponsor of the agent, an owner or an admin can connect an app to it.",
			);
		}
		const scopes = grantableScopes(call.caller, agent, input.scopes);
		const { code, approval } = await approvalAt();
		const statement = approveStatement(call.env.DIRECTORY, { ...approval, principalId: agent.id, scopes });
		if ((await statement.run()).meta.changes !== 1) throw new OperationError("conflict", GONE);
		auditOk(call, "oauth.approve_authorization", `${request.id}:${agent.id}`);
		return { principal: toPrincipalOutput(agent), redirect_to: codeRedirect(request, code.code) };
	},

	async "oauth.deny_authorization"(call, input) {
		const request = await pendingRequest(call, input.request_id);
		if (!(await denyRequest(call.env.DIRECTORY, request.id))) throw new OperationError("not_found", GONE);
		auditOk(call, "oauth.deny_authorization", request.id);
		const error = { error: "access_denied", error_description: "The person denied the request.", state: request.state };
		return { redirect_to: redirectWith(request.redirect_uri, error) };
	},

	async "oauth.list_grants"(call, input) {
		const target = await credentialOwner(call, input.principal_id);
		return { grants: (await listGrants(call.env.DIRECTORY, target.id)).map(toGrantOutput) };
	},

	async "oauth.revoke_grant"(call, input) {
		const grant = await getGrant(call.env.DIRECTORY, input.grant_id);
		if (!grant) throw new OperationError("not_found", "No OAuth connection has that id.");
		await credentialOwner(call, grant.principal_id);
		await revokeGrant(call.env.DIRECTORY, grant.id);
		auditOk(call, "oauth.revoke_grant", grant.id);
		return { revoked: true };
	},
};
