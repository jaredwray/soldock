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

	// A room can have no name, and the request then names no room.
	it("tells the person the room of the decision", () => {
		const request = { id: "mrq_1", subjectName: "Helper", roomName: "reports" };
		expect(approvedText(request)).toBe("Helper is now a member of #reports.");
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
