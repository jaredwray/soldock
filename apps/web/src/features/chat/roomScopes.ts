import { defaultRoomMemberScopes, ROOM_MEMBER_SCOPES, type RoomMemberScope } from "@asterra/contracts";

// What a member can do in a room, as the members dialog shows it. Each member reads the room, so the dialog
// has a check box only for the two other scopes.

/** The two scopes of a member that the owner of the room can give and take away. */
export interface MemberRights {
	/** `chat.write`: post, change messages, add reactions and pins. */
	write: boolean;
	/** `chat.add_members`: add members to the room. */
	addMembers: boolean;
}

export function rightsOf(scopes: readonly string[]): MemberRights {
	return { write: scopes.includes("chat.write"), addMembers: scopes.includes("chat.add_members") };
}

/** The scopes for an operation. Each member has `chat.read`. */
export function scopesOf(rights: MemberRights): RoomMemberScope[] {
	return ROOM_MEMBER_SCOPES.filter(
		(scope) => scope === "chat.read" || (scope === "chat.write" ? rights.write : rights.addMembers),
	);
}

/**
 * The rights that the form offers for a new member: the rights of its kind, without each right that the
 * person who adds does not have. A member gives only what its own membership has, and the server refuses more.
 */
export function offeredRights(kind: "human" | "agent", mine: MemberRights): MemberRights {
	const usual = rightsOf(defaultRoomMemberScopes(kind));
	return { write: usual.write && mine.write, addMembers: usual.addMembers && mine.addMembers };
}

/** The rights as text, for a toast: "read and post", "read, post and add members". */
export function rightsText(rights: MemberRights): string {
	const parts = ["read", ...(rights.write ? ["post"] : []), ...(rights.addMembers ? ["add members"] : [])];
	return parts.length === 1 ? "only read" : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}
