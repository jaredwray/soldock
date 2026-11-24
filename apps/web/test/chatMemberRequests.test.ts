import { ApiError } from "@asterra/contracts";
import { describe, expect, it } from "vitest";
import { approvedText, deniedText, requestIsGone, requestOfActivity } from "../src/features/chat/memberRequests.ts";

describe("a request of an agent to add an agent or a service account to a room", () => {
	// The two operations take the id of the request. The activity item has its own id, and `message_id` has
	// the id of the request. With the id of the item, each answer of the person gets not_found.
	it("takes the id of the request from the message id of the activity item", () => {
		const request = requestOfActivity({
			message_id: "mrq_1",
			room_name: "reports",
			subject: { principal_id: "prn_b", kind: "agent", display_name: "Helper" },
		});
		expect(request).toEqual({ id: "mrq_1", subjectName: "Helper", roomName: "reports" });
	});

	// The scopes apply to the account, not only to the room, so the person who approved must see them. A room
	// can have no name, and the request then names no room.
	it("tells the person the room and the scopes that the account got with the approval", () => {
		const request = { id: "mrq_1", subjectName: "Helper", roomName: "reports" };
		const none = { agent_access_changes: [], agent_access_pending: [] };
		expect(approvedText(request, none)).toBe("Helper is now a member of #reports.");
		expect(
			approvedText(request, {
				agent_access_changes: [{ principal_id: "prn_b", scopes_added: ["chat.read", "chat.write"] }],
				agent_access_pending: [],
			}),
		).toBe("Helper is now a member of #reports. Helper now also holds chat.read, chat.write.");
		// The request is gone after the approval, so the text does not tell the person to add the member again.
		const pending = approvedText(request, { agent_access_changes: [], agent_access_pending: ["prn_b"] });
		expect(pending).toContain("Helper is a member, but did not get the scopes of its membership");
		expect(pending).toContain("Admin, Members");
		expect(pending).not.toContain("Add it again");
		expect(deniedText({ ...request, roomName: null })).toBe("Helper is not added to a room.");
	});

	// The row goes away only when the server does not have the request. After a refusal of the credential or
	// a network failure, the request still waits, and the person must be able to try again.
	it("removes a request after not_found and conflict, and keeps it after each other error", () => {
		const failure = (status: number, code: string) => new ApiError(status, { code, detail: "No." });
		expect(requestIsGone(failure(404, "not_found"))).toBe(true);
		expect(requestIsGone(failure(409, "conflict"))).toBe(true);
		expect(requestIsGone(failure(403, "forbidden"))).toBe(false);
		expect(requestIsGone(failure(429, "rate_limited"))).toBe(false);
		expect(requestIsGone(new TypeError("Failed to fetch"))).toBe(false);
	});
});
