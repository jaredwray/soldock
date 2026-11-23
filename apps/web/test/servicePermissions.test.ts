import { describe, expect, it } from "vitest";
import { draftOf, permissionsChange, pickKey } from "../src/features/admin/permissionsDraft.ts";
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

describe("the limits of a service account", () => {
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

describe("the Permissions form of a service account", () => {
	const choices = resourceChoicesOf(account, access);

	it("sends nothing for the saved access, and only the field that changed", () => {
		const saved = draftOf(access);
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

	// The own mailbox and the own drive have the same id. A pick of one must not pick the other.
	it("keeps the own mailbox and the own drive apart", () => {
		const draft = { ...draftOf(access), limited: true, picked: new Set([pickKey("mailbox", "prn_ci")]) };
		expect(permissionsChange(draft, access, choices)).toEqual({
			resources: { mailbox_ids: ["prn_ci"], drive_ids: [], room_ids: [] },
		});
	});

	it("shows saved limits as picked, and sends null to remove them", () => {
		const limited = { ...access, resources: { mailbox_ids: ["tmb_1"], drive_ids: ["prn_ci"], room_ids: ["rm_gone"] } };
		const limitedChoices = resourceChoicesOf(account, limited);
		const saved = draftOf(limited);
		expect(saved.limited).toBe(true);
		// The same picks in a different order are no change, also with a listed room that is not a membership.
		expect(permissionsChange(saved, limited, limitedChoices)).toBeNull();
		expect(permissionsChange({ ...saved, limited: false }, limited, limitedChoices)).toEqual({ resources: null });
	});
});
