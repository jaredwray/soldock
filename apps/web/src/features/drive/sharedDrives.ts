import {
	type DriveRole,
	type Principal,
	SHARED_DRIVE_ROLES,
	type SharedDriveMember,
	type SharedDriveRole,
} from "@asterra/contracts";
import { isAutomated } from "../../lib/principalKind.ts";

// The rules of the members of a shared drive that need no DOM. The Admin section, the Drive pages
// and the Node tests use them. The server applies the same rules, and it has the last word.

export const ROLE_NAMES: Record<DriveRole, string> = {
	owner: "Owner",
	manager: "Manager",
	editor: "Editor",
	viewer: "Viewer",
};

/** One line for each role, for the role control. */
export const ROLE_HINT =
	"A manager also changes the members, shares items and deletes items forever. An editor adds and changes items. A viewer reads and copies.";

/** What the role of an agent or a service account changes on its account, for the role control. */
export const AGENT_ROLE_HINT =
	"If you manage this account, it also gets the Drive scopes of its role, and this shared drive in its limits.";

/**
 * The roles that a person, an agent or a service account can have. An agent and a service account are
 * never a manager: a manager is a person.
 */
export function memberRoles(kind: Principal["kind"]): readonly SharedDriveRole[] {
	return isAutomated(kind) ? SHARED_DRIVE_ROLES.filter((role) => role !== "manager") : SHARED_DRIVE_ROLES;
}

/** The roles as the options of a role control. */
export function roleOptions(roles: readonly SharedDriveRole[]): { value: SharedDriveRole; label: string }[] {
	return roles.map((role) => ({ value: role, label: ROLE_NAMES[role] }));
}

/** The reason why a new shared drive cannot have these members, or null. */
export function membersProblem(
	members: readonly { kind: Principal["kind"]; role: SharedDriveRole; name: string }[],
): string | null {
	const agent = members.find((member) => isAutomated(member.kind) && member.role === "manager");
	if (agent) return `${agent.name} is not a person, and only a person can be a manager.`;
	if (!members.some((member) => member.kind === "human" && member.role === "manager")) {
		return "Give the manager role to at least one person.";
	}
	return null;
}

/**
 * True when the person can change the members and the name of a shared drive: a manager of the
 * drive, an owner or an admin.
 */
export function canManageDrive(role: DriveRole | null, orgAdmin: boolean): boolean {
	return orgAdmin || role === "manager";
}

/**
 * True for the only manager of a drive. A shared drive always keeps one manager who is a person, so
 * this member cannot get a lower role and cannot leave.
 */
export function isLastManager(
	member: Pick<SharedDriveMember, "principal_id" | "role">,
	members: readonly Pick<SharedDriveMember, "principal_id" | "role">[],
): boolean {
	return member.role === "manager" && members.filter((other) => other.role === "manager").length === 1;
}
