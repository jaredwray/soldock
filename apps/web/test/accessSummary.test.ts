import { AGENT_SCOPES, type OutputOf, SERVICE_SCOPES } from "@asterra/contracts";
import { describe, expect, it } from "vitest";
import {
	accountScopes,
	delegatedMailboxRows,
	driveRows,
	mailboxRows,
	roomRows,
	sharedItemRows,
} from "../src/features/admin/accessSummary.ts";
import { roomLabel } from "../src/features/admin/roomLabel.ts";

type Access = OutputOf<"directory.get_member_access">;

const access: Access = {
	principal_id: "prn_agent",
	kind: "agent",
	team_mailboxes: [
		{ id: "tmb_support", display_name: "Support", address: "support@dock.test", scopes: ["mail.read", "mail.send"] },
		{ id: "tmb_billing", display_name: "Billing", address: "billing@dock.test", scopes: ["mail.read"] },
	],
	delegated_mailboxes: [
		{ id: "prn_ada", display_name: "Ada Lovelace", address: "ada@dock.test", scopes: ["mail.read", "mail.send"] },
	],
	shared_drives: [{ id: "drv_team", name: "Team", role: "viewer" }],
	chat_rooms: [
		{ id: "rm_public", kind: "public", name: "general", peer_name: null, role: "member" },
		{ id: "rm_private", kind: "private", name: "secret", peer_name: null, role: "member" },
		{ id: "dm_ada", kind: "dm", name: null, peer_name: "Ada Lovelace", role: "member" },
	],
	chat_rooms_truncated: false,
	drive_shared_items: [
		{ space_id: "prn_admin", item_id: "itm_brief", name: "Brief", kind: "doc", role: "editor" },
		{ space_id: "prn_other", item_id: "itm_plan", name: "Plan", kind: "file", role: "viewer" },
	],
	drive_shared_items_truncated: false,
	tokens: [],
	scopes: [...AGENT_SCOPES],
};

const admin = { id: "prn_admin", admin: true };
const sponsor = { id: "prn_sponsor", admin: false };

describe("the Access part of an agent or a service account", () => {
	// A direct message has no name. It names its other member, so two direct messages differ in the list.
	it("names a room, a direct message by its other member, and a group message", () => {
		expect(roomLabel({ kind: "private", name: "builds", peer_name: null })).toBe("#builds");
		expect(roomLabel({ kind: "dm", name: null, peer_name: "Ada Lovelace" })).toBe("Direct message with Ada Lovelace");
		expect(roomLabel({ kind: "dm", name: null, peer_name: null })).toBe("Direct message");
		expect(roomLabel({ kind: "group_dm", name: null, peer_name: null })).toBe("Group message");
	});

	// Each membership decides what the agent can do. The summary says it, and links only to a page where the
	// person who looks can change it: a link that the person cannot use would only fail.
	it("shows what each team mailbox allows, with a link for an owner or an admin only", () => {
		expect(mailboxRows(access, admin)).toEqual([
			{
				key: "tmb_support",
				name: "Support (support@dock.test)",
				detail: "Can read and send",
				href: "/admin/shared-mailboxes",
			},
			{ key: "tmb_billing", name: "Billing (billing@dock.test)", detail: "Can read", href: "/admin/shared-mailboxes" },
		]);
		expect(mailboxRows(access, sponsor).map((row) => row.href)).toEqual([null, null]);
		const narrowed = { ...access, team_mailboxes: [{ ...access.team_mailboxes[1], scopes: [] }] } as Access;
		expect(mailboxRows(narrowed, admin)[0]?.detail).toBe("Can do nothing");
	});

	// Only the owner of a mailbox changes its delegates, so no person who looks at the summary gets a link.
	it("shows what the mailbox of each person allows, with no link", () => {
		expect(delegatedMailboxRows(access)).toEqual([
			{ key: "prn_ada", name: "Ada Lovelace (ada@dock.test)", detail: "Can read and send", href: null },
		]);
	});

	it("links a shared drive to its admin section, or to the drive for a different person", () => {
		expect(driveRows(access, admin)).toEqual([
			{ key: "drv_team", name: "Team", detail: "Can view", href: "/admin/shared-drives" },
		]);
		expect(driveRows(access, sponsor)[0]?.href).toBe("/drive/shared-drives/drv_team");
	});

	// Each person can open a public room. A private room and a direct message can be closed to the person.
	it("links only a public room", () => {
		expect(roomRows(access).map((row) => [row.name, row.detail, row.href])).toEqual([
			["#general", "Public room, Member", "/chat/rm_public"],
			["#secret", "Private room, Member", null],
			["Direct message with Ada Lovelace", "Member", null],
		]);
	});

	// The owner of the drive of an item changes its sharing. A different person cannot open the item.
	it("links a shared item for the owner of its drive only", () => {
		expect(sharedItemRows(access, admin).map((row) => [row.name, row.detail, row.href])).toEqual([
			["Brief", "Can edit", "/docs/prn_admin/itm_brief"],
			["Plan", "Can view", null],
		]);
	});

	// A new account holds each scope of its kind. The summary shows one short row for each product, and no text
	// for a person. An account from before keeps its narrower list, and its rows show only what it holds.
	it("shows the account scopes as one row for each product of the kind", () => {
		const agent = accountScopes(access, "agent", "dot@dock.test");
		expect(agent.missing).toEqual([]);
		expect(agent.rows.map((row) => [row.name, row.detail, row.href])).toEqual([
			["Mailbox (dot@dock.test)", "Can read, change and send", null],
			["Drive", "Can read, change and share", null],
			["Chat", "Can find public rooms, create rooms and open direct messages", null],
			["Calendar", "Can read and change", null],
			["Meet", "Can read and host meetings", null],
			["Webhooks", "Can create for mail, drive, chat and calendar events", null],
			["Directory", "Can read", null],
			["Account", "Can read", null],
		]);
		// A service account cannot create a webhook, so it has no such row.
		const service = accountScopes({ ...access, scopes: [...SERVICE_SCOPES] }, "service", "ci@dock.test");
		expect(service.missing).toEqual([]);
		expect(service.rows.map((row) => row.name)).toEqual([
			"Mailbox (ci@dock.test)",
			"Drive",
			"Chat",
			"Calendar",
			"Meet",
			"Directory",
			"Account",
		]);
	});

	it("shows what an account from before holds, and the scopes of the kind that it does not hold", () => {
		const legacy = accountScopes(
			{ ...access, scopes: ["account.read", "mail.read", "chat.write"] },
			"agent",
			"dot@dock.test",
		);
		expect(legacy.rows.map((row) => row.detail)).toEqual([
			"Can read",
			"Can do nothing",
			"Can create rooms and open direct messages",
			"Can do nothing",
			"Can do nothing",
			"Can do nothing",
			"Can do nothing",
			"Can read",
		]);
		expect(legacy.missing).toContain("mail.send");
		expect(legacy.missing).not.toContain("account.read");
		// An account without a scope gets one line and no rows.
		expect(accountScopes({ ...access, scopes: [] }, "agent", "dot@dock.test").rows).toEqual([]);
	});
});
