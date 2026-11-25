import { ApiError, type ChatActivityItem, type ChatMemberRequest } from "@asterra/contracts";
import { rightsOf, rightsText } from "./roomScopes.ts";

// The texts and the rules of a member request: an agent asks to add an agent or a service account to a
// room, and a person who manages that account approves or denies it. The activity list of Chat and the
// page of the account in Admin, Members show a request, and use this module for the same texts. It has no
// DOM and no network, so apps/web/test checks it.

/** What the two buttons of a request need: the id for the two operations, and the names for the texts. */
export interface MemberRequestSummary {
	/** The id of the request (`mrq_…`). */
	id: string;
	/** The name of the agent or the service account that the request is for. */
	subjectName: string;
	/** The name of the room at the time of the request, or null. */
	roomName: string | null;
}

/** The request of an activity item of the kind `member_request`. */
export function requestOfActivity(
	item: Pick<ChatActivityItem, "message_id" | "subject" | "room_name">,
): MemberRequestSummary {
	// The item is not about a message: `message_id` has the id of the request. The id of the item is not that id.
	return {
		id: item.message_id,
		subjectName: item.subject?.display_name ?? "The account",
		roomName: item.room_name,
	};
}

/** The request of `chat.list_member_requests`, with the name of its account. */
export function requestOfRecord(
	request: Pick<ChatMemberRequest, "id" | "room_name">,
	subjectName: string,
): MemberRequestSummary {
	return { id: request.id, subjectName, roomName: request.room_name };
}

/** The room of a request in a text: `#name`, or "a room" for a room without a name. */
export function requestRoomText(roomName: string | null): string {
	return roomName ? `#${roomName}` : "a room";
}

/** The accessible name of the Approve button or the Deny button. It names the account and the room. */
export function decisionLabel(decision: "approve" | "deny", request: MemberRequestSummary): string {
	const verb = decision === "approve" ? "Approve" : "Deny";
	return `${verb} the request to add ${request.subjectName} to ${requestRoomText(request.roomName)}`;
}

/** The toast after an approval. The membership alone decides what the account can do in the room. */
export function approvedText(request: MemberRequestSummary): string {
	return `${request.subjectName} is now a member of ${requestRoomText(request.roomName)}.`;
}

/** The toast after a denial. */
export function deniedText(request: MemberRequestSummary): string {
	return `${request.subjectName} is not added to ${requestRoomText(request.roomName)}.`;
}

/**
 * True when the server does not have the request after a failed answer: a different person decided it
 * (`not_found`), or the agent that asked cannot add the member now (`conflict`). The row then goes away.
 * Each other error keeps the request, and the person can try again.
 */
export function requestIsGone(error: unknown): boolean {
	return error instanceof ApiError && (error.code === "not_found" || error.code === "conflict");
}

/** What the account can do in the room after the approval, in words: "read and post", "only read". */
export function requestRightsText(scopes: readonly string[]): string {
	return rightsText(rightsOf(scopes));
}
