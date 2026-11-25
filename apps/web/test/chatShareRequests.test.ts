import { describe, expect, it } from "vitest";
import { shareRequestOfActivity } from "../src/features/chat/shareRequests.ts";

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
});
