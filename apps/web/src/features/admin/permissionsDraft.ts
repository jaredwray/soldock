import {
	AGENT_RESOURCE_LIMITS,
	AGENT_SCOPES,
	type AgentResources,
	type InputOf,
	type OutputOf,
	type Principal,
	type ResourceKind,
	type Scope,
	SERVICE_SCOPES,
} from "@asterra/contracts";
import type { ResourceChoice, ResourceChoices } from "./resourceChoices.ts";

type Access = Pick<OutputOf<"directory.get_agent_access">, "scopes" | "resources">;

/** The fields of `directory.set_agent_access` that a save sends. */
export type PermissionsChange = Omit<InputOf<"directory.set_agent_access">, "principal_id">;

/** The choices of the Permissions form of an agent or a service account, before a save. */
export interface PermissionsDraft {
	scopes: readonly Scope[];
	/** True when the agent is limited to the picked mailboxes, drives and rooms. */
	limited: boolean;
	/** The picked resources, as keys of `pickKey`. */
	picked: ReadonlySet<string>;
}

/**
 * The scopes that the Permissions form offers: `SERVICE_SCOPES` for a service account, and `AGENT_SCOPES`
 * for an agent. The server refuses a scope outside this list.
 */
export function scopesFor(principal: Pick<Principal, "kind">): readonly Scope[] {
	return principal.kind === "service" ? SERVICE_SCOPES : AGENT_SCOPES;
}

/**
 * The key of one picked resource. The own mailbox and the own drive have the same id (the id of the
 * agent). So a key has the kind too, and a selection of the own mailbox does not select the own drive.
 */
export function pickKey(kind: ResourceKind, id: string): string {
	return `${kind}:${id}`;
}

/** The form choices that show the saved scopes and limits. `offered` is the list of `scopesFor`. */
export function draftOf(access: Access, offered: readonly Scope[]): PermissionsDraft {
	const picked = new Set<string>();
	for (const id of access.resources?.mailbox_ids ?? []) picked.add(pickKey("mailbox", id));
	for (const id of access.resources?.drive_ids ?? []) picked.add(pickKey("drive", id));
	for (const id of access.resources?.room_ids ?? []) picked.add(pickKey("room", id));
	return {
		scopes: offered.filter((scope) => access.scopes.includes(scope)),
		limited: access.resources !== null,
		picked,
	};
}

/**
 * The draft after a change of the limit check box. An agent without saved limits has nothing picked, and a
 * limit to nothing stops the agent. So a limit that goes on for such an agent selects what the agent reaches
 * now: its own mailbox and drive, and each membership of the choices. The server takes at most
 * `AGENT_RESOURCE_LIMITS.perKind` ids of one kind, so the selection has the first ones of each kind. Picks
 * that the manager made stay as they are.
 */
export function withLimit(
	draft: PermissionsDraft,
	limited: boolean,
	access: Access,
	choices: ResourceChoices,
): PermissionsDraft {
	if (!limited || access.resources !== null || draft.picked.size > 0) return { ...draft, limited };
	const first = (kind: ResourceKind, list: readonly ResourceChoice[]) =>
		list.slice(0, AGENT_RESOURCE_LIMITS.perKind).map((choice) => pickKey(kind, choice.id));
	return {
		...draft,
		limited,
		picked: new Set([
			...first("mailbox", choices.mailboxes),
			...first("drive", choices.drives),
			...first("room", choices.rooms),
		]),
	};
}

/** The picked ids of one kind, in the order of the choices. */
export function pickedIds(draft: PermissionsDraft, kind: ResourceKind, choices: readonly ResourceChoice[]): string[] {
	return choices.filter((choice) => draft.picked.has(pickKey(kind, choice.id))).map((choice) => choice.id);
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((id) => b.includes(id));
}

/**
 * The input fields of `directory.set_agent_access` that the draft changes, or null when the draft is the
 * same as the saved access. A field that did not change is left out, so a save of new scopes does not
 * write the limits again.
 */
export function permissionsChange(
	draft: PermissionsDraft,
	access: Access,
	choices: ResourceChoices,
): PermissionsChange | null {
	const change: PermissionsChange = {};
	// The draft holds only scopes of `scopesFor`. The server checks the ceiling of a service account.
	if (!sameIds(draft.scopes, access.scopes)) change.scopes = [...draft.scopes];
	const resources: AgentResources | null = draft.limited
		? {
				mailbox_ids: pickedIds(draft, "mailbox", choices.mailboxes),
				drive_ids: pickedIds(draft, "drive", choices.drives),
				room_ids: pickedIds(draft, "room", choices.rooms),
			}
		: null;
	const saved = access.resources;
	const sameResources =
		resources === null || saved === null
			? resources === saved
			: sameIds(resources.mailbox_ids, saved.mailbox_ids) &&
				sameIds(resources.drive_ids, saved.drive_ids) &&
				sameIds(resources.room_ids, saved.room_ids);
	if (!sameResources) change.resources = resources;
	return change.scopes === undefined && change.resources === undefined ? null : change;
}
