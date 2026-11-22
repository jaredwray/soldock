import { describe, expect, it } from "vitest";
import { limitText, resourceChoicesOf } from "../src/features/settings/resourceChoices.ts";

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
	scopes: [],
};

describe("the limits of a token of a service account", () => {
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

	// An empty list reaches nothing. A token without limits reaches each membership.
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
