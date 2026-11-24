import { describe, expect, it } from "vitest";
import { offeredRights, rightsOf, scopesOf } from "../src/features/chat/roomScopes.ts";

describe("the scopes of a member in the members dialog of a room", () => {
	// The operations refuse a list without chat.read: each member reads the room.
	it("always sends chat.read, with the scopes of the two check boxes", () => {
		expect(scopesOf({ write: false, addMembers: false })).toEqual(["chat.read"]);
		expect(scopesOf({ write: true, addMembers: false })).toEqual(["chat.read", "chat.write"]);
		expect(scopesOf({ write: false, addMembers: true })).toEqual(["chat.read", "chat.add_members"]);
		expect(rightsOf(scopesOf({ write: true, addMembers: true }))).toEqual({ write: true, addMembers: true });
	});

	// The server refuses a scope that the membership of the person who adds does not have. The form must
	// not offer it, or the usual add would fail for a member that cannot post.
	it("offers a new member the rights of its kind, without the rights that the person who adds does not have", () => {
		const all = { write: true, addMembers: true };
		expect(offeredRights("human", all)).toEqual({ write: true, addMembers: true });
		// An agent adds members only when somebody selects that right for it.
		expect(offeredRights("agent", all)).toEqual({ write: true, addMembers: false });
		expect(offeredRights("human", { write: false, addMembers: true })).toEqual({ write: false, addMembers: true });
	});
});
