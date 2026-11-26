import { describe, expect, it } from "vitest";
import {
	canTargetSharedResource,
	inputFields,
	operationList,
	operations,
	RESOURCE_SCOPES,
	resourceDecidedScopes,
} from "../src/index.ts";

// The membership of a team mailbox, a room or a shared drive, or a share of an item, decides what an agent can do
// there. `resourceDecidedScopes` tells the invoker which scopes of a call the resource decides. A mistake gives
// an agent an action that its membership and its account do not allow, so these cases fail closed.

const ME = "prn_01JD0000000000000000000000";
const OTHER = "prn_01JD0000000000000000000001";
const TEAM = "tmb_01JD0000000000000000000000";
const DRIVE = "drv_01JD0000000000000000000000";
const ROOM = "rm_01JD0000000000000000000000";

/** Each operation that a membership or a share can decide, in the order of the names. */
const RESOURCE_DECIDED: string[] = [
	"calendar.create_event",
	"calendar.delete_event",
	"calendar.find_times",
	"calendar.get_event",
	"calendar.list_events",
	"calendar.update_event",
	"chat.add_members",
	"chat.add_reaction",
	"chat.archive_room",
	"chat.delete_message",
	"chat.download_file",
	"chat.download_link_image",
	"chat.edit_message",
	"chat.forward_message",
	"chat.get_room",
	"chat.list_card_actions",
	"chat.list_messages",
	"chat.list_pins",
	"chat.list_replies",
	"chat.list_rooms",
	"chat.pin_message",
	"chat.post_message",
	"chat.remove_link_preview",
	"chat.remove_member",
	"chat.remove_reaction",
	"chat.request_member",
	"chat.schedule_message",
	"chat.search_messages",
	"chat.set_member_scopes",
	"chat.set_posting_rules",
	"chat.set_room_retention",
	"chat.trigger_card_action",
	"chat.unarchive_room",
	"chat.unpin_message",
	"chat.update_room",
	"docs.copy_image",
	"docs.create",
	"docs.get",
	"docs.get_image",
	"docs.import_image",
	"docs.update",
	"docs.upload_image",
	"drive.abort_upload",
	"drive.complete_upload",
	"drive.copy_item",
	"drive.create_folder",
	"drive.create_upload",
	"drive.delete_items",
	"drive.download_file",
	"drive.empty_trash",
	"drive.get_about",
	"drive.get_item",
	"drive.get_shared_drive",
	"drive.get_upload",
	"drive.list_items",
	"drive.list_permissions",
	"drive.list_shared_drives",
	"drive.list_versions",
	"drive.move_items",
	"drive.move_to_drive",
	"drive.rename_item",
	"drive.request_share",
	"drive.restore_items",
	"drive.restore_version",
	"drive.set_preview",
	"drive.share_item",
	"drive.trash_items",
	"drive.unshare_item",
	"drive.upload_file",
	"drive.upload_part",
	"drive.upload_version",
	"mail.create_label",
	"mail.delete_label",
	"mail.get_attachment",
	"mail.get_auto_labels",
	"mail.get_mailbox_settings",
	"mail.get_message",
	"mail.get_profile",
	"mail.get_thread",
	"mail.list_labels",
	"mail.list_mailboxes",
	"mail.list_screener",
	"mail.list_threads",
	"mail.modify_threads",
	"mail.send",
	"mail.snooze_threads",
	"mail.suggest_recipients",
	"mail.update_mailbox_settings",
	"sheets.add_tab",
	"sheets.create",
	"sheets.delete_tab",
	"sheets.duplicate_tab",
	"sheets.format_cells",
	"sheets.get",
	"sheets.move_tab",
	"sheets.rename_tab",
	"sheets.update_cells",
];

describe("the scopes that a resource decides", () => {
	it("decides the mail scopes in a team mailbox and in the mailbox of a different principal, and none in the own mailbox", () => {
		expect(resourceDecidedScopes(operations["mail.send"], { mailbox_id: TEAM }, ME)).toEqual(["mail.send"]);
		expect(resourceDecidedScopes(operations["mail.list_threads"], { mailbox_id: TEAM }, ME)).toEqual(["mail.read"]);
		expect(resourceDecidedScopes(operations["mail.send"], {}, ME)).toEqual([]);
		expect(resourceDecidedScopes(operations["mail.send"], { mailbox_id: ME }, ME)).toEqual([]);
		// The mailbox of a different principal: a grant of its owner decides, and the handler refuses a caller
		// without one.
		expect(resourceDecidedScopes(operations["mail.list_threads"], { mailbox_id: OTHER }, ME)).toEqual(["mail.read"]);
		expect(resourceDecidedScopes(operations["mail.send"], { mailbox_id: OTHER }, ME)).toEqual(["mail.send"]);
		// An id that is not the id of a mailbox names nothing.
		expect(resourceDecidedScopes(operations["mail.send"], { mailbox_id: "drv_shared" }, ME)).toEqual([]);
		// A value that is not a string names nothing.
		expect(resourceDecidedScopes(operations["mail.send"], { mailbox_id: [TEAM] }, ME)).toEqual([]);
		expect(resourceDecidedScopes(operations["mail.send"], null, ME)).toEqual([]);
		// A webhook scope is never a scope of a membership.
		const subscribe = operations["mail.create_webhook_subscription"];
		expect(resourceDecidedScopes(subscribe, { mailbox_id: TEAM }, ME)).toEqual([]);
	});

	it("decides the chat scopes of a call that names a room, and none of a call without one", () => {
		expect(resourceDecidedScopes(operations["chat.post_message"], { room_id: ROOM }, ME)).toEqual(["chat.write"]);
		const forward = { room_id: ROOM, target_room_id: ROOM };
		expect(resourceDecidedScopes(operations["chat.forward_message"], forward, ME)).toEqual(["chat.write"]);
		expect(resourceDecidedScopes(operations["chat.search_messages"], { room_id: ROOM }, ME)).toEqual(["chat.read"]);
		expect(resourceDecidedScopes(operations["chat.search_messages"], {}, ME)).toEqual([]);
		expect(resourceDecidedScopes(operations["chat.create_room"], {}, ME)).toEqual([]);
		expect(resourceDecidedScopes(operations["chat.list_threads"], {}, ME)).toEqual([]);
		// Presence needs directory.read too, and names no room.
		expect(resourceDecidedScopes(operations["chat.get_presence"], { principal_ids: OTHER }, ME)).toEqual([]);
	});

	it("decides the drive scopes only when each drive of the call is not the own drive", () => {
		const get = operations["drive.get_item"];
		expect(resourceDecidedScopes(get, { space_id: DRIVE, item_id: "itm_x" }, ME)).toEqual(["drive.read"]);
		expect(resourceDecidedScopes(get, { space_id: OTHER, item_id: "itm_x" }, ME)).toEqual(["drive.read"]);
		expect(resourceDecidedScopes(get, { space_id: ME, item_id: "itm_x" }, ME)).toEqual([]);
		expect(resourceDecidedScopes(get, { item_id: "itm_x" }, ME)).toEqual([]);
		// A copy without target_space_id goes to the own drive, so the account scopes decide it.
		const copy = operations["drive.copy_item"];
		expect(resourceDecidedScopes(copy, { space_id: DRIVE, item_id: "itm_x" }, ME)).toEqual([]);
		expect(resourceDecidedScopes(copy, { space_id: DRIVE, item_id: "itm_x", target_space_id: DRIVE }, ME)).toEqual([
			"drive.read",
			"drive.write",
		]);
		expect(resourceDecidedScopes(operations["docs.get"], { space_id: DRIVE, item_id: "itm_x" }, ME)).toEqual([
			"drive.read",
		]);
		expect(resourceDecidedScopes(operations["drive.get_shared_drive"], { drive_id: DRIVE }, ME)).toEqual([
			"drive.read",
		]);
		expect(resourceDecidedScopes(operations["drive.create_shared_drive"], { name: "x" }, ME)).toEqual([]);
	});

	// The calendar of a different person: only a grant of that person decides (`calendar.set_grant`). The own
	// calendar, and a call without calendar_id, stay with the account scopes.
	it("decides the calendar scopes for the calendar of a different principal, and none for the own calendar", () => {
		const create = operations["calendar.create_event"];
		expect(resourceDecidedScopes(create, { calendar_id: OTHER }, ME)).toEqual(["calendar.write"]);
		expect(resourceDecidedScopes(operations["calendar.list_events"], { calendar_id: OTHER }, ME)).toEqual([
			"calendar.read",
		]);
		expect(resourceDecidedScopes(operations["calendar.find_times"], { calendar_id: OTHER }, ME)).toEqual([
			"calendar.read",
		]);
		expect(resourceDecidedScopes(create, {}, ME)).toEqual([]);
		expect(resourceDecidedScopes(create, { calendar_id: ME }, ME)).toEqual([]);
		// An id that is not the id of a principal, or a value that is not a string, names nothing.
		expect(resourceDecidedScopes(create, { calendar_id: TEAM }, ME)).toEqual([]);
		expect(resourceDecidedScopes(create, { calendar_id: [OTHER] }, ME)).toEqual([]);
		// Attendees of find_times do not name the calendar of the call: the account scopes decide.
		expect(resourceDecidedScopes(operations["calendar.find_times"], { attendee_ids: OTHER }, ME)).toEqual([]);
		// Only a person manages the grants of the own calendar.
		expect(canTargetSharedResource(operations["calendar.set_grant"])).toBe(false);
		expect(canTargetSharedResource(operations["calendar.list_grants"])).toBe(false);
	});

	// A list of the resources of the caller shows only what its memberships give. The public view of the rooms
	// and the list of each shared drive are lists of the organization.
	it("decides the lists of the resources of the caller", () => {
		expect(resourceDecidedScopes(operations["mail.list_mailboxes"], {}, ME)).toEqual(["mail.read"]);
		expect(resourceDecidedScopes(operations["chat.list_rooms"], {}, ME)).toEqual(["chat.read"]);
		expect(resourceDecidedScopes(operations["chat.list_rooms"], { view: "starred" }, ME)).toEqual(["chat.read"]);
		expect(resourceDecidedScopes(operations["chat.list_rooms"], { view: "public" }, ME)).toEqual([]);
		expect(resourceDecidedScopes(operations["drive.list_shared_drives"], {}, ME)).toEqual(["drive.read"]);
		expect(resourceDecidedScopes(operations["drive.list_shared_drives"], { all: "true" }, ME)).toEqual([]);
	});

	// The object of the resource does not check the scope of these calls in the membership or the share. So
	// the account scopes decide them, as before the memberships decided the access of agents.
	it("leaves the personal state of the caller, and a caller that removes itself, to the account scopes", () => {
		expect(resourceDecidedScopes(operations["chat.mark_read"], { room_id: ROOM }, ME)).toEqual([]);
		expect(resourceDecidedScopes(operations["chat.list_drafts"], { room_id: ROOM }, ME)).toEqual([]);
		expect(resourceDecidedScopes(operations["drive.star_items"], { space_id: DRIVE }, ME)).toEqual([]);
		expect(canTargetSharedResource(operations["chat.save_draft"])).toBe(false);
		const leave = operations["chat.remove_member"];
		expect(resourceDecidedScopes(leave, { room_id: ROOM, principal_id: ME }, ME)).toEqual([]);
		expect(resourceDecidedScopes(leave, { room_id: ROOM, principal_id: OTHER }, ME)).toEqual(["chat.write"]);
		const unshare = operations["drive.unshare_item"];
		expect(resourceDecidedScopes(unshare, { space_id: OTHER, item_id: "itm_x", principal_id: ME }, ME)).toEqual([]);
		expect(resourceDecidedScopes(unshare, { space_id: DRIVE, item_id: "itm_x", principal_id: OTHER }, ME)).toEqual([
			"drive.share",
		]);
		// Only a person calls this operation, so no membership of an agent decides it.
		expect(resourceDecidedScopes(operations["chat.delete_room"], { room_id: ROOM }, ME)).toEqual([]);
	});

	// A new operation with a field that names a mailbox, a room or a drive is not in this list, so this test
	// fails. Add the operation here only when its handler or its object checks the scope of the operation in
	// the membership or the share. If it does not, add it to `ACCOUNT_DECIDED`.
	it("lets a resource decide only the operations of this list", () => {
		const everyTarget = {
			mailbox_id: TEAM,
			room_id: ROOM,
			target_room_id: ROOM,
			space_id: DRIVE,
			target_space_id: DRIVE,
			from_space_id: DRIVE,
			drive_id: DRIVE,
			calendar_id: OTHER,
		};
		const decided = operationList
			.filter((operation) => resourceDecidedScopes(operation, everyTarget, ME).length > 0)
			.map((operation) => operation.name)
			.sort();
		expect(decided).toEqual(RESOURCE_DECIDED);
		expect(
			operationList
				.filter(canTargetSharedResource)
				.map((operation) => operation.name)
				.sort(),
		).toEqual(RESOURCE_DECIDED);
	});

	it("decides only membership scopes, only for the operations that can name a shared resource", () => {
		for (const operation of operationList) {
			const decided = resourceDecidedScopes(
				operation,
				{
					mailbox_id: TEAM,
					room_id: ROOM,
					target_room_id: ROOM,
					space_id: DRIVE,
					target_space_id: DRIVE,
					from_space_id: DRIVE,
					drive_id: DRIVE,
					calendar_id: OTHER,
				},
				ME,
			);
			expect(
				decided.every((scope) => RESOURCE_SCOPES.includes(scope)),
				operation.name,
			).toBe(true);
			expect(
				decided.every((scope) => operation.scopes.includes(scope)),
				operation.name,
			).toBe(true);
			if (decided.length > 0) expect(canTargetSharedResource(operation), operation.name).toBe(true);
			if (!/^(mail|chat|drive|docs|sheets|calendar)\./.test(operation.name)) {
				expect(canTargetSharedResource(operation), operation.name).toBe(false);
			}
		}
		// The table reads the fields of each input. An input with a refine or a default still shows them.
		expect(inputFields(operations["drive.copy_item"])).toEqual(expect.arrayContaining(["space_id", "target_space_id"]));
		expect(inputFields(operations["mail.list_mailboxes"])).toEqual([]);
	});
});
