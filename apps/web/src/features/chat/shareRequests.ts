import type { ChatActivityItem, DriveShareRequest } from "@asterra/contracts";

// The texts of a share request: an agent asks to share a Drive item with an agent or a service account, and a
// person who manages that account approves or denies it. The activity list of Chat and the page of the
// account in Admin, Members show a request, and use this module for the same texts. It has no DOM and no
// network, so apps/web/test checks it. `requestIsGone` of memberRequests.ts applies to both kinds of request.

/** What the two buttons of a share request need: the id for the two operations, and the names for the texts. */
export interface ShareRequestSummary {
	/** The id of the request (`srq_…`). */
	id: string;
	/** The name of the agent or the service account that gets the grant after an approval. */
	subjectName: string;
	/** The name of the item at the time of the request. */
	itemName: string;
	role: DriveShareRequest["role"];
}

/** The request of an activity item of the kind `share_request`. */
export function shareRequestOfActivity(
	item: Pick<ChatActivityItem, "message_id" | "subject" | "item">,
): ShareRequestSummary {
	// The item is not about a message: `message_id` has the id of the request. The id of the item is not that id.
	return {
		id: item.message_id,
		subjectName: item.subject?.display_name ?? "The account",
		itemName: item.item?.name ?? "an item",
		role: item.item?.role ?? "viewer",
	};
}

/** The request of `drive.list_share_requests`, with the name of its account. */
export function shareRequestOfRecord(
	request: Pick<DriveShareRequest, "id" | "item_name" | "role">,
	subjectName: string,
): ShareRequestSummary {
	return { id: request.id, subjectName, itemName: request.item_name, role: request.role };
}

/** What the account can do with the item after an approval: "view" or "edit". */
export function shareRoleVerb(role: DriveShareRequest["role"]): string {
	return role === "editor" ? "edit" : "view";
}

/** The accessible name of the Approve button or the Deny button. It names the item and the account. */
export function shareDecisionLabel(decision: "approve" | "deny", request: ShareRequestSummary): string {
	const verb = decision === "approve" ? "Approve" : "Deny";
	return `${verb} the request to share “${request.itemName}” with ${request.subjectName}`;
}

/** The toast after an approval. The grant is for this item only: the account gets no scope. */
export function shareApprovedText(request: ShareRequestSummary): string {
	return `${request.subjectName} can now ${shareRoleVerb(request.role)} “${request.itemName}”.`;
}

/** The toast after a denial. */
export function shareDeniedText(request: ShareRequestSummary): string {
	return `${request.subjectName} does not get access to “${request.itemName}”.`;
}
