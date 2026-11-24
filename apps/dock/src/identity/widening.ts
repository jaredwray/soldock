import {
	AGENT_RESOURCE_LIMITS,
	type AgentAccessChange,
	type AgentResources,
	isScope,
	type Scope,
} from "@asterra/contracts";
import { OperationError } from "../platform/index.ts";
import { auditOk, canManageAgent, grantableScopes, isAdmin, recordServiceChange } from "./access.ts";
import type { CallContext } from "./auth.ts";
import { endEventSockets } from "./principal.ts";
import { type AgentWidening, getPrincipal, getPrincipals, type PrincipalRecord, widenAgentAccess } from "./store.ts";

// What a membership gives to an agent or a service account. A membership of a team mailbox or a room says
// what the agent can do in that resource. The agent also needs the scopes on its account, and the resource
// in its limits when it has limits. A person who can change the access of the agent, and who makes it a
// member, decided that the agent can use the resource. So that call gives the agent this access too, and
// nobody sets its permissions a second time.

/** The resources whose memberships widen an agent. A shared drive gets the same rule later. */
type WidenedKind = "mailbox" | "room";

const LISTS: Record<WidenedKind, "mailbox_ids" | "room_ids"> = { mailbox: "mailbox_ids", room: "room_ids" };
const NAMES: Record<WidenedKind, string> = { mailbox: "mailboxes", room: "rooms" };

/** The name of an agent or a service account in a refusal. */
function agentNoun(agent: Pick<PrincipalRecord, "service">): string {
	return agent.service ? "service account" : "agent";
}

/**
 * Refuses a resource that the limits of an agent have no place for. Stored limits with more ids than the most
 * are not valid, and an agent with such limits reaches nothing. `id` is undefined for a resource that does
 * not exist yet.
 */
export function assertPlaceInLimits(agent: PrincipalRecord, kind: WidenedKind, id?: string): void {
	const listed = agent.agent_resources?.[LISTS[kind]];
	const isListed = id !== undefined && listed?.includes(id);
	if (listed && !isListed && listed.length >= AGENT_RESOURCE_LIMITS.perKind) {
		throw new OperationError(
			"invalid",
			`The limits of this ${agentNoun(agent)} name ${AGENT_RESOURCE_LIMITS.perKind} ${NAMES[kind]}, the most. Remove one from its limits, or remove its limits.`,
		);
	}
}

/**
 * Refuses a membership that the caller cannot give to an agent or a service account. The agent gets each
 * scope of the membership, so the credential of the call must hold each one (`grantableScopes`): a narrow key
 * cannot give a scope that it does not hold. The limits of the agent take the resource too, and they have
 * place for a fixed number of ids (`assertPlaceInLimits`). A person needs no check: a key of a person has
 * its own scopes.
 */
export function assertAgentMembership(
	call: CallContext,
	member: PrincipalRecord,
	kind: WidenedKind,
	scopes: readonly Scope[],
	id?: string,
): void {
	if (member.kind !== "agent") return;
	grantableScopes(call.caller, member, scopes);
	assertPlaceInLimits(member, kind, id);
}

/** The access that a membership gives to an agent, with the scopes that the agent did not hold. */
export type MemberWidening = AgentWidening & { agent: PrincipalRecord; added: Scope[] };

/**
 * The access that an agent or a service account gets with its membership: each scope of the membership that
 * it does not hold, and the resource in its limits when it has limits. Null for a person, and for an agent
 * that has the access.
 */
export function agentWidening(
	member: PrincipalRecord,
	kind: WidenedKind,
	id: string,
	scopes: readonly Scope[],
): MemberWidening | null {
	if (member.kind !== "agent") return null;
	const held = member.agent_scopes;
	const added = scopes.filter((scope) => !held.includes(scope));
	const limits = member.agent_resources;
	const list = LISTS[kind];
	const resources: AgentResources | null =
		limits === null || limits[list].includes(id) ? limits : { ...limits, [list]: [...limits[list], id] };
	if (added.length === 0 && resources === limits) return null;
	return { agent: member, scopes: [...held, ...added], resources, added };
}

/** The effects of a write of `agentWidening`: the logs get a line, and the live connections of the agent end. */
export async function afterWidening(call: CallContext, widening: MemberWidening): Promise<void> {
	const { agent, scopes, resources } = widening;
	const limits = resources === null ? "no limits" : "limits";
	// The line comes first: the write is in the directory, so the log must have it when a later step fails.
	auditOk(call, "directory.set_agent_access", `${agent.id}:${scopes.join(",")}:${limits}`);
	recordServiceChange(call, agent, "directory.set_agent_access");
	// Each live connection of the agent has the access of its open: see `directory.set_agent_access`.
	await endEventSockets(call.env, agent.id, { agentAccess: true });
}

/** The change of an agent, as the result of an operation gives it. */
export function toAccessChange(widening: MemberWidening): AgentAccessChange {
	return {
		principal_id: widening.agent.id,
		scopes_added: widening.added,
		limits_widened: widening.resources !== widening.agent.agent_resources,
	};
}

/** The tries of a write that a parallel change of the access of an agent made match nothing. */
export const WIDENING_TRIES = 3;

/** One member of a room, with the scopes of its membership. */
export interface RoomMembership {
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
 * A member of a room can add an agent that it does not manage. That membership gives the agent no new
 * access: only a manager of the agent does that.
 */
export function managedAgents(call: CallContext, principals: readonly PrincipalRecord[]): PrincipalRecord[] {
	if (!call.caller.scopes.has("directory.write")) return [];
	return principals.filter(
		(principal) =>
			principal.kind === "agent" && principal.archived_at === null && canManageAgent(call.caller, principal),
	);
}

/**
 * Refuses a membership of a room that gives an agent a scope that the credential of the call does not hold
 * (`grantableScopes`), before the room writes the membership. Only the scopes that the agent would get
 * count: a call that gives the agent nothing, for example one that removes a scope, needs no scope for it.
 * `scopes` gives the scopes that the membership of a principal gets.
 */
export function assertRoomGrants(
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

/** The result of `giveRoomAccess`: the changes that it wrote, and the agents that still need their access. */
export interface RoomAccessResult {
	changes: AgentAccessChange[];
	/**
	 * The agents that the caller manages, that are members of the room, and that did not get the access of
	 * their membership. Their limits have no place for the room, or a different call changed their access at
	 * the same time. The membership is in the room. A later call for the member completes the access.
	 */
	pending: string[];
}

/**
 * Gives each agent that the caller manages the access of its membership of a room: the chat scopes of the
 * membership that it does not hold, and the room in its limits when it has limits. The room object owns the
 * members, and the directory owns the access of an agent, so the two writes are not one transaction. The
 * membership comes first. This write is idempotent: when it does not complete, a later call completes it.
 *
 * The write matches only while the access of the agent is the access of the read (`access_version`), so a
 * parallel change of the access is not lost. It also matches only while a sponsor who is not an admin is
 * still the sponsor. The function reads the agent and tries again.
 *
 * It does not throw for an agent that it cannot complete. The membership is in the room, so the call
 * returns its result, and `pending` names the agent. `release` is `releaseLimits` of the room.
 */
export async function giveRoomAccess(
	call: CallContext,
	roomId: string,
	members: readonly RoomMembership[],
	release: (agent: PrincipalRecord) => Promise<boolean>,
): Promise<RoomAccessResult> {
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
			const widening = agentWidening(agent, "room", roomId, scopesOf.get(agent.id) ?? []);
			if (!widening) continue;
			try {
				// The handler checked the scopes before the room wrote the membership. A parallel change of the
				// agent can make the check fail now. The limits can have no place for one more room.
				if (widening.added.length > 0) grantableScopes(call.caller, agent, widening.added);
				if (widening.resources !== agent.agent_resources) assertPlaceInLimits(agent, "room", roomId);
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
			// A different call can remove the member between the write of the room and this write. Its own write
			// of the limits came first, and found no room in them. So the room takes the limits back for a
			// principal that is not a member now. The room does that in one step with the read of its members.
			if (widening.resources !== agent.agent_resources && (await release(agent))) continue;
			changes.push(toAccessChange(widening));
		}
		agents = lost.length === 0 ? [] : managedAgents(call, await getPrincipals(DIRECTORY, lost));
	}
	return { changes, pending: [...refused, ...agents.map((agent) => agent.id)] };
}

/**
 * The effects of a remove that took the room out of the limits of an agent: the log gets a line, and the live
 * connections of the agent end. The room object makes the write, in one step with the remove.
 */
export async function afterLimitsDrop(call: CallContext, principalId: string): Promise<void> {
	const agent = await getPrincipal(call.env.DIRECTORY, principalId);
	if (agent?.kind !== "agent") return;
	auditOk(call, "directory.set_agent_access", `${agent.id}:${agent.agent_scopes.join(",")}:limits`);
	await endEventSockets(call.env, agent.id, { agentAccess: true });
}
