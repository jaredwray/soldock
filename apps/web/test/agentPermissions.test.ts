import { describe, expect, it } from "vitest";
import { draftOf, permissionsChange, pickKey, scopesFor, withLimit } from "../src/features/admin/permissionsDraft.ts";
import { limitText, resourceChoicesOf } from "../src/features/admin/resourceChoices.ts";

const account = { id: "prn_ci", address: "ci@example.com" };
const access = {
	principal_id: "prn_ci",
	team_mailboxes: [{ id: "tmb_1", display_name: "Support", address: "support@example.com" }],
	shared_drives: [{ id: "drv_1", name: "Releases", role: "editor" }],
	chat_rooms: [
		{ id: "rm_1", kind: "private", name: "builds", peer_name: null, role: "member" },
		{ id: "rm_2", kind: "dm", name: null, peer_name: "Ada Lovelace", role: "member" },
		{ id: "rm_3", kind: "group_dm", name: null, peer_name: null, role: "member" },
	],
	chat_rooms_truncated: false,
	drive_shared_items: [],
	drive_shared_items_truncated: false,
	tokens: [],
	scopes: ["account.read", "mail.read"],
	resources: null,
};

describe("the limits of an agent or a service account", () => {
	// The own mailbox and drive have the id of the account, as the server expects them.
	it("offers the own mailbox and drive by the id of the account, then each membership", () => {
		const choices = resourceChoicesOf(account, access);
		expect(choices.mailboxes.map((choice) => choice.id)).toEqual(["prn_ci", "tmb_1"]);
		expect(choices.drives.map((choice) => choice.id)).toEqual(["prn_ci", "drv_1"]);
		// A direct message names its other member, so two direct messages differ in the list.
		expect(choices.rooms.map((choice) => choice.label)).toEqual([
			"#builds",
			"Direct message with Ada Lovelace",
			"Group message",
		]);
	});

	// A saved limit can name a room that the account left. The form must show it, or a save removes it
	// without a sign.
	it("offers a listed resource that is not a membership, so an admin can see it and remove it", () => {
		const limited = { ...access, resources: { mailbox_ids: [], drive_ids: [], room_ids: ["rm_1", "rm_gone"] } };
		expect(resourceChoicesOf(account, limited).rooms.map((choice) => choice.id)).toEqual([
			"rm_1",
			"rm_2",
			"rm_3",
			"rm_gone",
		]);
	});

	// An empty list reaches nothing. An account without limits reaches each membership.
	it("names the listed resources, and tells apart no limit from a limit to nothing", () => {
		const choices = resourceChoicesOf(account, access);
		expect(limitText(null, choices)).toBe("All its memberships");
		expect(limitText({ mailbox_ids: [], drive_ids: [], room_ids: [] }, choices)).toBe("Nothing");
		expect(limitText({ mailbox_ids: ["tmb_1"], drive_ids: ["prn_ci"], room_ids: ["rm_1"] }, choices)).toBe(
			"Support, Own drive, #builds",
		);
		expect(limitText({ mailbox_ids: ["tmb_gone"], drive_ids: [], room_ids: [] }, choices)).toBe("tmb_gone");
	});
});

describe("the Permissions form of an agent or a service account", () => {
	const choices = resourceChoicesOf(account, access);
	const serviceScopes = scopesFor({ kind: "service" });

	it("sends nothing for the saved access, and only the field that changed", () => {
		const saved = draftOf(access, serviceScopes);
		expect(permissionsChange(saved, access, choices)).toBeNull();
		// New scopes do not write the limits again.
		expect(permissionsChange({ ...saved, scopes: ["account.read", "chat.read"] }, access, choices)).toEqual({
			scopes: ["account.read", "chat.read"],
		});
		// A limit with nothing picked is a limit to nothing, not the end of the limits.
		expect(permissionsChange({ ...saved, limited: true }, access, choices)).toEqual({
			resources: { mailbox_ids: [], drive_ids: [], room_ids: [] },
		});
	});

	// An agent can hold the webhook scopes, and a service account cannot. A draft with the scopes of a service
	// account drops them, and a save of only the limits then removes them from the agent.
	it("keeps the scopes that only an agent can hold", () => {
		const agentAccess = { ...access, scopes: ["account.read", "mail.webhooks"] };
		const saved = draftOf(agentAccess, scopesFor({ kind: "agent" }));
		expect(permissionsChange(saved, agentAccess, choices)).toBeNull();
		expect(permissionsChange({ ...saved, limited: true }, agentAccess, choices)).toEqual({
			resources: { mailbox_ids: [], drive_ids: [], room_ids: [] },
		});
	});

	// The own mailbox and the own drive have the same id. A pick of one must not pick the other.
	it("keeps the own mailbox and the own drive apart", () => {
		const draft = {
			...draftOf(access, serviceScopes),
			limited: true,
			picked: new Set([pickKey("mailbox", "prn_ci")]),
		};
		expect(permissionsChange(draft, access, choices)).toEqual({
			resources: { mailbox_ids: ["prn_ci"], drive_ids: [], room_ids: [] },
		});
	});

	// A limit to nothing stops the agent. So the check box of the limit must not give an empty limit to an
	// agent that reaches its memberships now.
	it("selects what an agent without limits reaches now when the limit goes on", () => {
		const on = withLimit(draftOf(access, serviceScopes), true, access, choices);
		expect(permissionsChange(on, access, choices)).toEqual({
			resources: {
				mailbox_ids: ["prn_ci", "tmb_1"],
				drive_ids: ["prn_ci", "drv_1"],
				room_ids: ["rm_1", "rm_2", "rm_3"],
			},
		});
		// The limit goes off and on again: the picks of the manager stay.
		const picked = { ...on, picked: new Set([pickKey("room", "rm_2")]) };
		const again = withLimit(withLimit(picked, false, access, choices), true, access, choices);
		expect(permissionsChange(again, access, choices)).toEqual({
			resources: { mailbox_ids: [], drive_ids: [], room_ids: ["rm_2"] },
		});
		// The server takes at most 20 ids of one kind, so the selection stops there.
		const many = {
			...access,
			chat_rooms: Array.from({ length: 25 }, (_, index) => ({
				id: `rm_${index}`,
				kind: "private",
				name: `room-${index}`,
				peer_name: null,
				role: "member",
			})),
		};
		const manyChoices = resourceChoicesOf(account, many);
		const capped = permissionsChange(
			withLimit(draftOf(many, serviceScopes), true, many, manyChoices),
			many,
			manyChoices,
		);
		expect(capped?.resources?.room_ids).toEqual(many.chat_rooms.slice(0, 20).map((room) => room.id));
	});

	// A saved limit to nothing is a choice of a manager. The check box must not replace it with each membership.
	it("keeps a saved limit to nothing when the limit goes off and on", () => {
		const nothing = { ...access, resources: { mailbox_ids: [], drive_ids: [], room_ids: [] } };
		const off = withLimit(draftOf(nothing, serviceScopes), false, nothing, choices);
		expect(permissionsChange(withLimit(off, true, nothing, choices), nothing, choices)).toBeNull();
	});

	it("shows saved limits as picked, and sends null to remove them", () => {
		const limited = { ...access, resources: { mailbox_ids: ["tmb_1"], drive_ids: ["prn_ci"], room_ids: ["rm_gone"] } };
		const limitedChoices = resourceChoicesOf(account, limited);
		const saved = draftOf(limited, serviceScopes);
		expect(saved.limited).toBe(true);
		// The same picks in a different order are no change, also with a listed room that is not a membership.
		expect(permissionsChange(saved, limited, limitedChoices)).toBeNull();
		expect(permissionsChange({ ...saved, limited: false }, limited, limitedChoices)).toEqual({ resources: null });
	});
});
