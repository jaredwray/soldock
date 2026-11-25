import { AGENT_SCOPES, type OutputOf, type Scope, SERVICE_SCOPES, scopeDescription } from "@asterra/contracts";
import { adminPath, chatPath, itemPath, sharedDrivePath } from "../../routes.ts";
import { memberScopes, scopesText } from "./mailboxScopes.ts";
import { roomLabel } from "./roomLabel.ts";

// The read-only Access summary of an agent or a service account on its page in Admin › Members. Each team
// mailbox, room and shared drive decides what the account can do there, and the summary links to the place
// where a person changes that access. The module has no DOM and no network, so apps/web/test checks it.

type Access = OutputOf<"directory.get_agent_access">;

/** Who looks at the summary: the links depend on what the person can open. */
export interface AccessViewer {
	id: string;
	/** True for an owner or an admin of the organization. */
	admin: boolean;
}

/** One row of the summary: a name, what the account can do there, and the page that changes it, or null. */
export interface AccessRow {
	key: string;
	name: string;
	detail: string;
	href: string | null;
}

const ROOM_KINDS: Readonly<Record<string, string>> = {
	public: "Public room",
	private: "Private room",
	dm: "Direct message",
	group_dm: "Group message",
};

/** The text of a role of a shared drive, an item or a room. */
function roleText(role: string): string {
	switch (role) {
		case "viewer":
			return "Can view";
		case "editor":
			return "Can edit";
		case "manager":
			return "Manager";
		case "owner":
			return "Owner";
		default:
			return "Member";
	}
}

/**
 * The team mailboxes, with what the membership allows. An owner or an admin changes the members in Admin ›
 * Shared mailboxes. A different person gets no link: only owners and admins change them.
 */
export function mailboxRows(access: Access, viewer: AccessViewer): AccessRow[] {
	return access.team_mailboxes.map((mailbox) => {
		const scopes = memberScopes(mailbox.scopes);
		return {
			key: mailbox.id,
			name: `${mailbox.display_name} (${mailbox.address})`,
			detail: scopes.length === 0 ? "Can do nothing" : `Can ${scopesText(scopes)}`,
			href: viewer.admin ? adminPath("shared-mailboxes") : null,
		};
	});
}

/**
 * The shared drives, with the role. An owner or an admin changes the members in Admin › Shared drives. A
 * different person opens the drive, where a manager changes the members.
 */
export function driveRows(access: Access, viewer: AccessViewer): AccessRow[] {
	return access.shared_drives.map((drive) => ({
		key: drive.id,
		name: drive.name,
		detail: roleText(drive.role),
		href: viewer.admin ? adminPath("shared-drives") : sharedDrivePath(drive.id),
	}));
}

/**
 * The rooms, with the kind and the role. A public room links to the room, where its owner changes the
 * members: each person can open a public room. A private room and a direct message get no link, because the
 * person who looks may not be a member.
 */
export function roomRows(access: Access): AccessRow[] {
	return access.chat_rooms.map((room) => ({
		key: room.id,
		name: roomLabel(room),
		detail: [room.name ? ROOM_KINDS[room.kind] : null, roleText(room.role)].filter(Boolean).join(", "),
		href: room.kind === "public" ? chatPath(room.id) : null,
	}));
}

/**
 * The items that others shared directly with the account, with the role. The person who owns the drive of an
 * item opens it and changes its sharing there. Each other person gets no link.
 */
export function sharedItemRows(access: Access, viewer: AccessViewer): AccessRow[] {
	return access.drive_shared_items.map((item) => {
		const kind = item.kind === "folder" || item.kind === "doc" || item.kind === "sheet" ? item.kind : "file";
		return {
			key: `${item.space_id}/${item.item_id}`,
			name: item.name,
			detail: roleText(item.role),
			href: item.space_id === viewer.id ? itemPath({ kind, space_id: item.space_id, id: item.item_id }) : null,
		};
	});
}

/** The account scopes of the summary: what the account can do in its own mailbox, its own drive and the organization. */
export interface AccountScopes {
	/** Each account scope, in the order of the kind, with its text. */
	held: { scope: Scope; description: string }[];
	/** The scopes of its kind that the account does not hold: a limit from before the memberships decided. */
	missing: Scope[];
}

/**
 * The account scopes of an agent or a service account. A new account holds each scope of its kind. An account
 * from before can hold fewer: nothing changes them, and they apply only to its own mailbox, its own drive and
 * the actions that have no mailbox, room or drive.
 */
export function accountScopes(access: Access, kind: "agent" | "service"): AccountScopes {
	const ceiling = kind === "service" ? SERVICE_SCOPES : AGENT_SCOPES;
	return {
		held: ceiling
			.filter((scope) => access.scopes.includes(scope))
			.map((scope) => ({ scope, description: scopeDescription(scope, kind) })),
		missing: ceiling.filter((scope) => !access.scopes.includes(scope)),
	};
}
