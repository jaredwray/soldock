import { type AgentAccessChange, isScope, type Scope } from "@asterra/contracts";
import { OperationError } from "../platform/index.ts";
import { auditOk, canManageAgent, grantableScopes, isAdmin, recordServiceChange } from "./access.ts";
import type { CallContext } from "./auth.ts";
import { endEventSockets } from "./principal.ts";
import { type AgentWidening, getPrincipals, type PrincipalRecord, widenAgentAccess } from "./store.ts";

// What a membership gives to an agent or a service account. A membership of a team mailbox, a room or a shared
// drive says what the agent can do in that resource, and the agent reaches the resource because it is a
// member, as a person does. The agent also needs the scopes on its account. A person who can change the
// access of the agent, and who makes it a member, decided that the agent can use the resource. So that call
// gives the agent the scopes of the membership that it does not hold, and nobody sets its permissions a
// second time.

/**
 * Refuses a membership of a team mailbox that the caller cannot give to an agent or a service account. The
 * agent gets each scope of the membership, so the credential of the call must hold each one
 * (`grantableScopes`): a narrow key cannot give a scope that it does not hold. A person needs no check: a key
 * of a person has its own scopes.
 */
export function assertAgentMembership(call: CallContext, member: PrincipalRecord, scopes: readonly Scope[]): void {
	if (member.kind === "agent") grantableScopes(call.caller, member, scopes);
}

/** The scopes that a membership gives to an agent, with the scopes that the agent did not hold. */
export type MemberWidening = AgentWidening & { agent: PrincipalRecord; added: Scope[] };

/**
 * The scopes that an agent or a service account gets with its membership: each scope of the membership that
 * it does not hold. Null for a person, and for an agent that holds each one.
 */
export function agentWidening(member: PrincipalRecord, scopes: readonly Scope[]): MemberWidening | null {
	if (member.kind !== "agent") return null;
	const held = member.agent_scopes;
	const added = scopes.filter((scope) => !held.includes(scope));
	if (added.length === 0) return null;
	return { agent: member, scopes: [...held, ...added], added };
}

/** The effects of a write of `agentWidening`: the logs get a line, and the live connections of the agent end. */
export async function afterWidening(call: CallContext, widening: MemberWidening): Promise<void> {
	const { agent, scopes } = widening;
	// The line comes first: the write is in the directory, so the log must have it when a later step fails.
	auditOk(call, "directory.set_agent_access", `${agent.id}:${scopes.join(",")}`);
	recordServiceChange(call, agent, "directory.set_agent_access");
	// Each live connection of the agent has the access of its open: see `directory.set_agent_access`.
	await endEventSockets(call.env, agent.id, { agentAccess: true });
}

/** The change of an agent, as the result of an operation gives it. */
export function toAccessChange(widening: MemberWidening): AgentAccessChange {
	return { principal_id: widening.agent.id, scopes_added: widening.added };
}

/** The tries of a write that a parallel change of the access of an agent made match nothing. */
export const WIDENING_TRIES = 3;

/** One member of a room or a shared drive, with the scopes of its membership. */
export interface Membership {
	principal_id: string;
	scopes: readonly string[];
}

/** The scopes of a membership that a credential can hold. `chat.add_members` is a scope of a membership only. */
function credentialScopes(scopes: readonly string[]): Scope[] {
	return scopes.filter(isScope);
}

/**
 * The agents and the service accounts of these principals whose access the call can change. The caller is
 * a person who is their sponsor, an owner or an admin (`canManageAgent`), and the credential holds
 * `directory.write`, as `directory.set_agent_access` needs it. So a key of a manager with only the chat
 * scopes changes no agent. An archived agent gets no change.
 *
 * A member of a room, or a manager of a shared drive, can add an agent that it does not manage. That agent
 * uses the resource with the scopes that it holds. It gets no new scope: only a manager of the agent gives
 * one.
 */
export function managedAgents(call: CallContext, principals: readonly PrincipalRecord[]): PrincipalRecord[] {
	if (!call.caller.scopes.has("directory.write")) return [];
	return principals.filter(
		(principal) =>
			principal.kind === "agent" && principal.archived_at === null && canManageAgent(call.caller, principal),
	);
}

/**
 * Refuses a membership of a room or a shared drive that gives an agent a scope that the credential of the call
 * does not hold (`grantableScopes`), before the object of the resource writes the membership. Only the scopes
 * that the agent would get count: a call that gives the agent nothing, for example one that removes a scope,
 * needs no scope for it. `scopes` gives the scopes that the membership of a principal gets.
 */
export function assertMemberGrants(
	call: CallContext,
	principals: readonly PrincipalRecord[],
	scopes: (principal: PrincipalRecord) => readonly string[],
): void {
	for (const agent of managedAgents(call, principals)) {
		const held = agent.agent_scopes;
		const added = credentialScopes(scopes(agent)).filter((scope) => !held.includes(scope));
		if (added.length > 0) grantableScopes(call.caller, agent, added);
	}
}

/** The result of `giveMemberAccess`: the changes that it wrote, and the agents that still need their scopes. */
export interface MemberAccessResult {
	changes: AgentAccessChange[];
	/**
	 * The agents that the caller manages, that are members of the resource, and that did not get the scopes of
	 * their membership: a different call changed their access at the same time. The membership is in the
	 * resource. A later call for the member completes the scopes.
	 */
	pending: string[];
}

/** The fields of a result that tell what the call changed on the agents that the caller manages. */
export function accessOutput(access: MemberAccessResult): {
	agent_access_changes: AgentAccessChange[];
	agent_access_pending: string[];
} {
	return { agent_access_changes: access.changes, agent_access_pending: access.pending };
}

/**
 * Gives each agent that the caller manages the scopes of its membership of a room or a shared drive that it
 * does not hold. The object of the room or the drive owns the members, and the directory owns the scopes of
 * an agent, so the two writes are not one transaction. The membership comes first. This write is idempotent:
 * when it does not complete, a later call completes it.
 *
 * The write matches only while the access of the agent is the access of the read (`access_version`), so a
 * parallel change of the access is not lost. It also matches only while a sponsor who is not an admin is
 * still the sponsor. The function reads the agent and tries again.
 *
 * It does not throw for an agent that it cannot complete. The membership is in the resource, so the call
 * returns its result, and `pending` names the agent.
 */
export async function giveMemberAccess(call: CallContext, members: readonly Membership[]): Promise<MemberAccessResult> {
	const { DIRECTORY } = call.env;
	const scopesOf = new Map(members.map((member) => [member.principal_id, credentialScopes(member.scopes)]));
	// A sponsor who is not an admin acts only while the agent still has that sponsor, in the write itself.
	const sponsorId = isAdmin(call.caller) ? null : call.caller.principal.id;
	const changes: AgentAccessChange[] = [];
	const refused: string[] = [];
	let agents = managedAgents(call, await getPrincipals(DIRECTORY, [...scopesOf.keys()]));
	for (let attempt = 0; agents.length > 0 && attempt < WIDENING_TRIES; attempt++) {
		const lost: string[] = [];
		for (const agent of agents) {
			const widening = agentWidening(agent, scopesOf.get(agent.id) ?? []);
			if (!widening) continue;
			try {
				// The handler checked the scopes before the write of the membership. A parallel change of the
				// agent can make the check fail now.
				grantableScopes(call.caller, agent, widening.added);
			} catch (error) {
				if (!(error instanceof OperationError)) throw error;
				refused.push(agent.id);
				continue;
			}
			if (!(await widenAgentAccess(DIRECTORY, { ...widening, sponsorId }))) {
				lost.push(agent.id);
				continue;
			}
			await afterWidening(call, widening);
			changes.push(toAccessChange(widening));
		}
		agents = lost.length === 0 ? [] : managedAgents(call, await getPrincipals(DIRECTORY, lost));
	}
	return { changes, pending: [...refused, ...agents.map((agent) => agent.id)] };
}
