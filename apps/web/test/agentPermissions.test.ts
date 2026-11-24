import { describe, expect, it } from "vitest";
import { draftOf, permissionsChange, scopesFor } from "../src/features/admin/permissionsDraft.ts";
import { roomLabel } from "../src/features/admin/roomLabel.ts";

describe("the Access part of an agent or a service account", () => {
	// A direct message has no name. It names its other member, so two direct messages differ in the list.
	it("names a room, a direct message by its other member, and a group message", () => {
		expect(roomLabel({ kind: "private", name: "builds", peer_name: null })).toBe("#builds");
		expect(roomLabel({ kind: "dm", name: null, peer_name: "Ada Lovelace" })).toBe("Direct message with Ada Lovelace");
		expect(roomLabel({ kind: "dm", name: null, peer_name: null })).toBe("Direct message");
		expect(roomLabel({ kind: "group_dm", name: null, peer_name: null })).toBe("Group message");
	});
});

describe("the Permissions form of an agent or a service account", () => {
	const serviceScopes = scopesFor({ kind: "service" });

	it("sends nothing for the saved scopes, and the full new list for a change", () => {
		// The server gives the scopes in its own order. The same scopes in a different order are no change.
		const access = { scopes: ["mail.read", "account.read"] };
		const saved = draftOf(access, serviceScopes);
		expect(permissionsChange(saved, access)).toBeNull();
		// `directory.set_agent_access` replaces the list, so a save sends each scope of the draft.
		expect(permissionsChange([...saved, "chat.read"], access)).toEqual(["account.read", "mail.read", "chat.read"]);
		expect(permissionsChange(["account.read"], access)).toEqual(["account.read"]);
	});

	// An agent can hold the webhook scopes, and a service account cannot. A draft with the scopes of a service
	// account drops them, and a save of a different scope then removes them from the agent.
	it("keeps the scopes that only an agent can hold", () => {
		const access = { scopes: ["account.read", "mail.webhooks"] };
		const saved = draftOf(access, scopesFor({ kind: "agent" }));
		expect(saved).toContain("mail.webhooks");
		expect(permissionsChange(saved, access)).toBeNull();
	});
});
