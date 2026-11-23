import { describe, expect, it } from "vitest";
import { toggleMemberScope } from "../src/features/admin/mailboxScopes.ts";

describe("the scopes of a member in the settings of a shared mailbox", () => {
	// The operation refuses an empty list. Remove takes the access away, not the last check box.
	it("change one scope with a click, and never remove the last scope", () => {
		expect(toggleMemberScope(["mail.read", "mail.modify", "mail.send"], "mail.send")).toEqual([
			"mail.read",
			"mail.modify",
		]);
		// The result has the order of the settings, also when the click adds the first scope.
		expect(toggleMemberScope(["mail.send"], "mail.read")).toEqual(["mail.read", "mail.send"]);
		expect(toggleMemberScope(["mail.read"], "mail.read")).toBeNull();
	});
});
