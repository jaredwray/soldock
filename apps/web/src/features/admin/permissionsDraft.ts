import {
	type InputOf,
	type OutputOf,
	type ResourceKind,
	type Scope,
	SERVICE_SCOPES,
	type ServiceResources,
} from "@asterra/contracts";
import type { ResourceChoice, ResourceChoices } from "./resourceChoices.ts";

type Access = Pick<OutputOf<"directory.get_service_account_access">, "scopes" | "resources">;

/** The fields of `directory.set_service_account_access` that a save sends. */
export type PermissionsChange = Omit<InputOf<"directory.set_service_account_access">, "principal_id">;

/** The choices of the Permissions form of a service account, before a save. */
export interface PermissionsDraft {
	scopes: readonly Scope[];
	/** True when the account is limited to the picked mailboxes, drives and rooms. */
	limited: boolean;
	/** The picked resources, as keys of `pickKey`. */
	picked: ReadonlySet<string>;
}

/**
 * The key of one picked resource. The own mailbox and the own drive have the same id (the id of the
 * account). So a key has the kind too, and a selection of the own mailbox does not select the own drive.
 */
export function pickKey(kind: ResourceKind, id: string): string {
	return `${kind}:${id}`;
}

/** The form choices that show the saved scopes and limits of the account. */
export function draftOf(access: Access): PermissionsDraft {
	const picked = new Set<string>();
	for (const id of access.resources?.mailbox_ids ?? []) picked.add(pickKey("mailbox", id));
	for (const id of access.resources?.drive_ids ?? []) picked.add(pickKey("drive", id));
	for (const id of access.resources?.room_ids ?? []) picked.add(pickKey("room", id));
	return {
		scopes: SERVICE_SCOPES.filter((scope) => access.scopes.includes(scope)),
		limited: access.resources !== null,
		picked,
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
 * The input fields of `directory.set_service_account_access` that the draft changes, or null when the
 * draft is the same as the saved access. A field that did not change is left out, so a save of new scopes
 * does not write the limits again.
 */
export function permissionsChange(
	draft: PermissionsDraft,
	access: Access,
	choices: ResourceChoices,
): PermissionsChange | null {
	const change: PermissionsChange = {};
	// The draft holds only scopes of `SERVICE_SCOPES`, which are the scopes that the operation takes.
	if (!sameIds(draft.scopes, access.scopes))
		change.scopes = [...draft.scopes] as NonNullable<PermissionsChange["scopes"]>;
	const resources: ServiceResources | null = draft.limited
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
