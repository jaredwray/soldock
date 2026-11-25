import type { OutputOf } from "@asterra/contracts";

type Room = OutputOf<"directory.get_member_access">["chat_rooms"][number];

/** The name of a room in the access of a member: `#name`, or the other member of a direct message. */
export function roomLabel(room: Pick<Room, "kind" | "name" | "peer_name">): string {
	if (room.name) return `#${room.name}`;
	if (room.peer_name) return `Direct message with ${room.peer_name}`;
	return room.kind === "group_dm" ? "Group message" : "Direct message";
}
