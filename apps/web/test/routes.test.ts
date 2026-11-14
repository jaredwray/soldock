import { describe, expect, it } from "vitest";
import {
	ADMIN_SECTIONS,
	adminPath,
	chatPath,
	type DriveView,
	drivePath,
	isAgentMailbox,
	itemPath,
	type MailView,
	ownMailboxPath,
	parseRoute,
	threadPath,
	viewPath,
} from "../src/routes.ts";

const VIEWS: readonly MailView[] = [
	{ kind: "system", view: "inbox" },
	{ kind: "system", view: "starred" },
	{ kind: "system", view: "sent" },
	{ kind: "system", view: "spam" },
	{ kind: "system", view: "trash" },
	{ kind: "system", view: "all" },
	{ kind: "label", labelId: "lbl_01JD0000000000000000000000" },
	{ kind: "search", query: "" },
	{ kind: "search", query: 'from:ada@example.com label:"Clients/Acme & Co" -is:read #1 100%?' },
];

const SPACE = "prn_01JD0000000000000000000000";
const ITEM = "itm_01JD0000000000000000000000";

const DRIVE_VIEWS: readonly DriveView[] = [
	{ kind: "folder", spaceId: null, folderId: null },
	{ kind: "folder", spaceId: SPACE, folderId: ITEM },
	{ kind: "shared" },
	{ kind: "recent" },
	{ kind: "starred" },
	{ kind: "trash" },
	{ kind: "search", query: "" },
	{ kind: "search", query: "q3 report & plan #1 100%?" },
];

const THREAD = "thr_01JD0000000000000000000000";
const TEAM = "tmb_01JD0000000000000000000000";
const AGENT = "prn_01JD0000000000000000000000";

describe("routes", () => {
	it("parses the path of each view back to that view", () => {
		for (const view of VIEWS) {
			expect(parseRoute(viewPath(view))).toEqual({ page: "mail", mailboxId: null, view, threadId: null });
		}
	});

	// A team mailbox has its own paths, so a deep link and a reload stay in that mailbox.
	it("parses the paths of a team mailbox back to the mailbox, the view and the thread", () => {
		for (const view of VIEWS) {
			expect(parseRoute(viewPath(view, TEAM))).toEqual({ page: "mail", mailboxId: TEAM, view, threadId: null });
			expect(parseRoute(threadPath(view, THREAD, TEAM))).toEqual({
				page: "mail",
				mailboxId: TEAM,
				view,
				threadId: THREAD,
			});
		}
		expect(viewPath({ kind: "system", view: "inbox" }, TEAM)).toBe(`/mail/team/${TEAM}/inbox`);
		expect(threadPath({ kind: "search", query: "a b" }, "thr_1", TEAM)).toBe(`/mail/team/${TEAM}/search/thr_1?q=a%20b`);
		expect(parseRoute(`/mail/team/${TEAM}`)).toEqual({ page: "redirect", to: `/mail/team/${TEAM}/inbox` });
	});

	// An owner or an admin reads the mailbox of an agent on its own paths. The prefix tells the web app
	// that the mailbox is read only.
	it("parses the paths of an agent mailbox back to the mailbox, the view and the thread", () => {
		for (const view of VIEWS) {
			expect(parseRoute(viewPath(view, AGENT))).toEqual({ page: "mail", mailboxId: AGENT, view, threadId: null });
			expect(parseRoute(threadPath(view, THREAD, AGENT))).toEqual({
				page: "mail",
				mailboxId: AGENT,
				view,
				threadId: THREAD,
			});
		}
		expect(viewPath({ kind: "system", view: "inbox" }, AGENT)).toBe(`/mail/agent/${AGENT}/inbox`);
		expect(parseRoute(`/mail/agent/${AGENT}`)).toEqual({ page: "redirect", to: `/mail/agent/${AGENT}/inbox` });
		expect([AGENT, TEAM, null].map(isAgentMailbox)).toEqual([true, false, false]);
	});

	// The server treats the own id of the person as the own mailbox, so the app must not show it read only.
	it("sends an agent mailbox path with the own id of the person to the own mailbox", () => {
		const inbox: MailView = { kind: "system", view: "inbox" };
		expect(ownMailboxPath(parseRoute(threadPath(inbox, THREAD, AGENT)), AGENT)).toBe(threadPath(inbox, THREAD));
		expect(ownMailboxPath(parseRoute(viewPath({ kind: "search", query: "a b" }, AGENT)), AGENT)).toBe(
			"/mail/search?q=a%20b",
		);
		// The id of a different principal, a team mailbox and the own paths stay as they are.
		const other = "prn_01JD0000000000000000OTHER0";
		for (const path of [viewPath(inbox, AGENT), viewPath(inbox, TEAM), viewPath(inbox), "/drive"]) {
			expect(ownMailboxPath(parseRoute(path), other), path).toBeNull();
		}
	});

	it("parses the path of a thread back to its view and thread id", () => {
		for (const view of VIEWS) {
			const path = threadPath(view, THREAD);
			expect(parseRoute(path)).toEqual({ page: "mail", mailboxId: null, view, threadId: THREAD });
		}
		expect(threadPath({ kind: "search", query: "a b" }, "thr_1")).toBe("/mail/search/thr_1?q=a%20b");
		expect(threadPath({ kind: "label", labelId: "lbl_1" }, "thr_1")).toBe("/mail/label/lbl_1/thr_1");
	});

	it("parses the path of each Drive view back to that view", () => {
		for (const view of DRIVE_VIEWS)
			expect(parseRoute(drivePath(view)), drivePath(view)).toEqual({ page: "drive", view });
		expect(drivePath({ kind: "folder", spaceId: null, folderId: null })).toBe("/drive");
		expect(drivePath({ kind: "search", query: "a b" })).toBe("/drive/search?q=a%20b");
	});

	// The path of an item has its drive, so one link works for the owner and for a person with access.
	it("gives a folder, a doc and a sheet a path with the drive of the item, and a file no path", () => {
		const item = { space_id: SPACE, id: ITEM };
		expect(parseRoute(itemPath({ ...item, kind: "folder" }) ?? "")).toEqual({
			page: "drive",
			view: { kind: "folder", spaceId: SPACE, folderId: ITEM },
		});
		expect(parseRoute(itemPath({ ...item, kind: "doc" }) ?? "")).toEqual({ page: "doc", spaceId: SPACE, itemId: ITEM });
		expect(parseRoute(itemPath({ ...item, kind: "sheet" }) ?? "")).toEqual({
			page: "sheet",
			spaceId: SPACE,
			itemId: ITEM,
		});
		expect(itemPath({ ...item, kind: "file" })).toBeNull();
	});

	// A room and a direct message have different id prefixes. The two are rooms of Chat.
	it("parses the path of Chat and of each room back to that room", () => {
		expect(parseRoute(chatPath())).toEqual({ page: "chat", roomId: null });
		for (const roomId of ["rm_01JD0000000000000000000000", "dm_01JD0000000000000000000000"]) {
			expect(parseRoute(chatPath(roomId))).toEqual({ page: "chat", roomId });
		}
		for (const path of ["/chat/itm_01JD0000000000000000000000", "/chat/rm_1/extra"]) {
			expect(parseRoute(path), path).toEqual({ page: "not-found" });
		}
	});

	// A deep link and a reload of a section open the same section.
	it("parses the path of each admin section back to that section", () => {
		expect(parseRoute("/admin")).toEqual({ page: "admin", section: null });
		for (const section of ADMIN_SECTIONS) {
			expect(parseRoute(adminPath(section))).toEqual({ page: "admin", section });
		}
	});

	it("sends / and /mail to the inbox, and gives not-found for other paths", () => {
		expect(parseRoute("/")).toEqual({ page: "redirect", to: "/mail/inbox" });
		expect(parseRoute("/mail")).toEqual({ page: "redirect", to: "/mail/inbox" });
		expect(parseRoute("/settings")).toEqual({ page: "settings" });
		expect(parseRoute("/connect/oar_01JD0000000000000000000000")).toEqual({
			page: "connect",
			requestId: "oar_01JD0000000000000000000000",
		});
		for (const path of [
			"/drive/outbox",
			"/drive/trash/extra",
			"/drive/folders",
			`/drive/folders/${SPACE}`,
			`/drive/folders/tmb_1/${ITEM}`,
			`/drive/folders/${SPACE}/thr_1`,
			`/docs/${SPACE}`,
			`/docs/${SPACE}/${ITEM}/extra`,
			`/sheets/${ITEM}/${SPACE}`,
			"/admin/extra",
			"/admin/members/extra",
			"/connect",
			"/connect/thr_01JD0000000000000000000000",
			"/mail/outbox",
			"/mail/label",
			"/mail/inbox/thr_1/extra",
			"/mail/label/lbl_1/thr_1/extra",
			"/mail/search/thr_1/extra",
			"/mail/team",
			"/mail/team/prn_1/inbox",
			"/mail/agent",
			`/mail/agent/${TEAM}/inbox`,
			`/mail/agent/${AGENT}/outbox`,
			`/mail/team/${TEAM}/outbox`,
			`/mail/team/${TEAM}/inbox/thr_1/extra`,
			"/mail/%E0%A4%A",
		]) {
			expect(parseRoute(path), path).toEqual({ page: "not-found" });
		}
	});
});
