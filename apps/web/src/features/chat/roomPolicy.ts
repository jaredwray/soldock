import type { ChatRoom, ChatRoomPolicy } from "@asterra/contracts";
import { createContext } from "react";

/** Archive status for actions in a room or its thread, including dialogs. */
export const RoomArchiveContext = createContext(false);

export function postingNotice(policy: ChatRoomPolicy | null, role: ChatRoom["role"]): string | null {
	if (policy?.archived) return "This room is archived.";
	if (policy?.posting === "owners" && role !== "owner") return "Only room owners can post in this room.";
	return null;
}
