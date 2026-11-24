import {
	AGENT_RESOURCE_LIMITS,
	type AgentAccessChange,
	type AgentResources,
	isScope,
	type Scope,
} from "@asterra/contracts";
import { OperationError } from "../platform/index.ts";
import { auditOk, canManageAgent, grantableScopes, recordServiceChange } from "./access.ts";
import type { CallContext } from "./auth.ts";
import { endEventSockets } from "./principal.ts";
import { type AgentWidening, getPrincipals, type PrincipalRecord, widenAgentAccess } from "./store.ts";

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

/** The effects of a write of `agentWidening`: the live connections of the agent end, and the logs get a line. */
export async function afterWidening(call: CallContext, widening: MemberWidening): Promise<void> {
	const { agent, scopes, resources } = widening;
	// Each live connection of the agent has the access of its open: see `directory.set_agent_access`.
	await endEventSockets(call.env, agent.id, { agentAccess: true });
	const limits = resources === null ? "no limits" : "limits";
	auditOk(call, "directory.set_agent_access", `${agent.id}:${scopes.join(",")}:${limits}`);
	recordServiceChange(call, agent, "directory.set_agent_access");
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
 * The agents and the service accounts of these principals whose access the caller can change: the caller is
 * a person who is their sponsor, an owner or an admin (`canManageAgent`). A member of a room can add an agent
 * that it does not manage. That membership gives the agent no new access: only a manager of the agent does
 * that.
 */
export function managedAgents(call: CallContext, principals: readonly PrincipalRecord[]): PrincipalRecord[] {
	return principals.filter((principal) => principal.kind === "agent" && canManageAgent(call.caller, principal));
}

/**
 * Refuses a membership of a room that the caller cannot give to an agent that it manages, before the room
 * writes the membership. `scopes` gives the scopes that the membership of a principal gets. `roomId` is
 * undefined for a room that does not exist yet.
 */
export function assertRoomMemberships(
	call: CallContext,
	principals: readonly PrincipalRecord[],
	scopes: (principal: PrincipalRecord) => readonly string[],
	roomId?: string,
): void {
	for (const agent of managedAgents(call, principals)) {
		assertAgentMembership(call, agent, "room", credentialScopes(scopes(agent)), roomId);
	}
}

/**
 * Gives each agent that the caller manages the access of its membership of a room: the chat scopes of the
 * membership that it does not hold, and the room in its limits when it has limits. The room object owns the
 * members, and the directory owns the access of an agent, so the two writes are not one transaction. The
 * membership comes first. This write is idempotent: when it fails, the same call again completes it.
 *
 * The write matches only while the access of the agent is the access of the read (`access_version`), so a
 * parallel change of the access is not lost. Then the function reads the agent and tries again.
 */
export async function widenAgentsForRoom(
	call: CallContext,
	roomId: string,
	members: readonly RoomMembership[],
): Promise<AgentAccessChange[]> {
	const { DIRECTORY } = call.env;
	const scopesOf = new Map(members.map((member) => [member.principal_id, credentialScopes(member.scopes)]));
	const changes: AgentAccessChange[] = [];
	let agents = managedAgents(call, await getPrincipals(DIRECTORY, [...scopesOf.keys()]));
	for (let attempt = 0; agents.length > 0 && attempt < WIDENING_TRIES; attempt++) {
		const lost: string[] = [];
		for (const agent of agents) {
			const scopes = scopesOf.get(agent.id) ?? [];
			assertAgentMembership(call, agent, "room", scopes, roomId);
			const widening = agentWidening(agent, "room", roomId, scopes);
			if (!widening) continue;
			if (await widenAgentAccess(DIRECTORY, widening)) {
				await afterWidening(call, widening);
				changes.push(toAccessChange(widening));
			} else {
				lost.push(agent.id);
			}
		}
		agents = lost.length === 0 ? [] : managedAgents(call, await getPrincipals(DIRECTORY, lost));
	}
	if (agents.length > 0) {
		throw new OperationError(
			"conflict",
			"The access of an agent changed during the call. The members are in the room. Send the call again.",
		);
	}
	return changes;
}
