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

describe("the scopes that a resource decides", () => {
	it("decides the mail scopes in a team mailbox, and none in the own mailbox", () => {
		expect(resourceDecidedScopes(operations["mail.send"], { mailbox_id: TEAM }, ME)).toEqual(["mail.send"]);
		expect(resourceDecidedScopes(operations["mail.list_threads"], { mailbox_id: TEAM }, ME)).toEqual(["mail.read"]);
		expect(resourceDecidedScopes(operations["mail.send"], {}, ME)).toEqual([]);
		expect(resourceDecidedScopes(operations["mail.send"], { mailbox_id: ME }, ME)).toEqual([]);
		// The mailbox of a different principal is not a team mailbox: the handler refuses it for an agent.
		expect(resourceDecidedScopes(operations["mail.list_threads"], { mailbox_id: OTHER }, ME)).toEqual([]);
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
			if (!/^(mail|chat|drive|docs|sheets)\./.test(operation.name)) {
				expect(canTargetSharedResource(operation), operation.name).toBe(false);
			}
		}
		// The table reads the fields of each input. An input with a refine or a default still shows them.
		expect(inputFields(operations["drive.copy_item"])).toEqual(expect.arrayContaining(["space_id", "target_space_id"]));
		expect(inputFields(operations["mail.list_mailboxes"])).toEqual([]);
	});
});
