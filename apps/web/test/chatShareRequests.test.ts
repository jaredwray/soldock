import { describe, expect, it } from "vitest";
import { shareApprovedText, shareDeniedText, shareRequestOfActivity } from "../src/features/chat/shareRequests.ts";

describe("a request of an agent to share a Drive item with an agent or a service account", () => {
	// The two operations take the id of the request. The activity item has its own id, `message_id` has the id
	// of the request, and `item.item_id` is the id of the file. With a different id, each answer gets not_found.
	it("takes the id of the request from the message id of the activity item, and the item and the role from its item", () => {
		const request = shareRequestOfActivity({
			message_id: "srq_1",
			subject: { principal_id: "prn_b", kind: "agent", display_name: "Helper" },
			item: { space_id: "prn_a", item_id: "itm_1", name: "Plan", role: "editor" },
		});
		expect(request).toEqual({ id: "srq_1", subjectName: "Helper", itemName: "Plan", role: "editor" });
	});

	// The scopes apply to the account, not only to the item, so the person who approved must see them. The
	// account is not a member of a drive, so the text for missing scopes does not call it a member.
	it("tells the person the item, the role and the scopes that the account got with the approval", () => {
		const request = { id: "srq_1", subjectName: "Helper", itemName: "Plan", role: "viewer" as const };
		const none = { agent_access_changes: [], agent_access_pending: [] };
		expect(shareApprovedText(request, none)).toBe("Helper can now view “Plan”.");
		expect(
			shareApprovedText(
				{ ...request, role: "editor" },
				{
					agent_access_changes: [{ principal_id: "prn_b", scopes_added: ["drive.read", "drive.write"] }],
					agent_access_pending: [],
				},
			),
		).toBe("Helper can now edit “Plan”. Helper now also holds drive.read, drive.write.");
		const pending = shareApprovedText(request, { agent_access_changes: [], agent_access_pending: ["prn_b"] });
		expect(pending).toContain("Helper has access to the item, but did not get the scopes of its role");
		expect(pending).not.toContain("is a member");
		expect(pending).toContain("Admin, Members");
		expect(shareDeniedText(request)).toBe("Helper does not get access to “Plan”.");
	});
});
