import type { Principal } from "@asterra/contracts";
import { describe, expect, it } from "vitest";
import { accessMembers, toggleMemberScope } from "../src/features/admin/mailboxScopes.ts";

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

	// The editor shows who has access. A read of the directory that fails must not hide a principal that has
	// access: the person could not see the grant, and could not remove it.
	it("keep a row for a principal that the directory did not give", () => {
		const ada = { id: "prn_ada", kind: "human", display_name: "Ada", address: "ada@x.test", archived_at: null };
		const stored = [
			{ principal_id: "prn_gone", scopes: ["mail.read", "mail.send"] },
			{ principal_id: "prn_ada", scopes: ["mail.read"] },
		];
		expect(accessMembers(stored, [ada as Principal])).toEqual([
			{
				id: "prn_gone",
				name: "Unknown account",
				note: "prn_gone",
				kind: null,
				archived: false,
				scopes: ["mail.read", "mail.send"],
			},
			{ id: "prn_ada", name: "Ada", note: "ada@x.test", kind: "human", archived: false, scopes: ["mail.read"] },
		]);
		expect(accessMembers(stored, []).map((member) => member.id)).toEqual(["prn_gone", "prn_ada"]);
	});
});
