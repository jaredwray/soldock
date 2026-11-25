import { describe, expect, it } from "vitest";
import {
	ADMIN_SECTIONS,
	adminPath,
	chatActivityPath,
	chatDraftsPath,
	chatPath,
	chatSavedPath,
	chatSearchPath,
	chatThreadsPath,
	type DriveView,
	drivePath,
	isAgentMailbox,
	itemPath,
	type MailView,
	mailSettingsPath,
	memberPath,
	ownMailboxPath,
	parseRoute,
	profilePath,
	SETTINGS_SECTIONS,
	screenerPath,
	settingsPath,
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
const SHARED_DRIVE = "drv_01JD0000000000000000000000";

const DRIVE_VIEWS: readonly DriveView[] = [
	{ kind: "folder", spaceId: null, folderId: null },
	{ kind: "folder", spaceId: SPACE, folderId: ITEM },
	{ kind: "shared" },
	{ kind: "recent" },
	{ kind: "starred" },
	{ kind: "trash" },
	{ kind: "search", query: "" },
	{ kind: "search", query: "q3 report & plan #1 100%?" },
	// A shared drive has its own paths, so a deep link and a reload stay in that drive.
	{ kind: "shared-drives" },
	{ kind: "folder", spaceId: SHARED_DRIVE, folderId: null },
	{ kind: "folder", spaceId: SHARED_DRIVE, folderId: ITEM },
	{ kind: "trash", spaceId: SHARED_DRIVE },
	{ kind: "search", query: "a b", spaceId: SHARED_DRIVE },
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

	// The settings view of a mailbox has its own path under the mailbox, so a reload and a deep link stay on it.
	it("parses the settings path of each mailbox back to the settings view of that mailbox", () => {
		for (const mailboxId of [null, TEAM, AGENT]) {
			expect(parseRoute(mailSettingsPath(mailboxId))).toEqual({ page: "mail-settings", mailboxId });
		}
		expect(mailSettingsPath()).toBe("/mail/settings");
		expect(mailSettingsPath(TEAM)).toBe(`/mail/team/${TEAM}/settings`);
		expect(parseRoute("/mail/settings/more")).toEqual({ page: "not-found" });
		// The own id of the person in an agent path is the own mailbox, also for its settings.
		expect(ownMailboxPath(parseRoute(mailSettingsPath(AGENT)), AGENT)).toBe("/mail/settings");
		expect(ownMailboxPath(parseRoute(mailSettingsPath(AGENT)), "prn_01JD0000000000000000OTHER0")).toBeNull();
	});

	// The Screener view of a mailbox has its own paths under the mailbox: one for each tab.
	it("parses the Screener paths of each mailbox back to the Screener view and its tab", () => {
		for (const mailboxId of [null, TEAM, AGENT]) {
			for (const tab of ["waiting", "history"] as const) {
				expect(parseRoute(screenerPath(mailboxId, tab))).toEqual({ page: "mail-screener", mailboxId, tab });
			}
		}
		expect(screenerPath()).toBe("/mail/screener");
		expect(screenerPath(TEAM, "history")).toBe(`/mail/team/${TEAM}/screener/history`);
		expect(parseRoute("/mail/screener/other")).toEqual({ page: "not-found" });
		expect(parseRoute("/mail/screener/history/more")).toEqual({ page: "not-found" });
		// The own id of the person in an agent path is the own mailbox, also for its Screener.
		expect(ownMailboxPath(parseRoute(screenerPath(AGENT, "history")), AGENT)).toBe("/mail/screener/history");
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
		expect(drivePath({ kind: "folder", spaceId: SHARED_DRIVE, folderId: null })).toBe(
			`/drive/shared-drives/${SHARED_DRIVE}`,
		);
		expect(drivePath({ kind: "trash", spaceId: SHARED_DRIVE })).toBe(`/drive/shared-drives/${SHARED_DRIVE}/trash`);
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
		// The drive of an item can be a shared drive.
		expect(parseRoute(itemPath({ space_id: SHARED_DRIVE, id: ITEM, kind: "doc" }) ?? "")).toEqual({
			page: "doc",
			spaceId: SHARED_DRIVE,
			itemId: ITEM,
		});
	});

	// A room and a direct message have different id prefixes. The two are rooms of Chat.
	it("parses the path of Chat and of each room back to that room", () => {
		expect(parseRoute(chatPath())).toEqual({ page: "chat", roomId: null, seq: null });
		for (const roomId of ["rm_01JD0000000000000000000000", "dm_01JD0000000000000000000000"]) {
			expect(parseRoute(chatPath(roomId))).toEqual({ page: "chat", roomId, seq: null });
			// A link to one message has the seq of the message.
			expect(chatPath(roomId, 42)).toBe(`${chatPath(roomId)}/42`);
			expect(parseRoute(chatPath(roomId, 42))).toEqual({ page: "chat", roomId, seq: 42 });
			// A link to a reply has the seq of the first message of the thread, then the seq of the reply.
			expect(chatPath(roomId, 42, 57)).toBe(`${chatPath(roomId)}/42/57`);
			expect(parseRoute(chatPath(roomId, 42, 57))).toEqual({ page: "chat", roomId, seq: 42, replySeq: 57 });
		}
		for (const path of ["/chat/itm_01JD0000000000000000000000", "/chat/rm_1/extra"]) {
			expect(parseRoute(path), path).toEqual({ page: "not-found" });
		}
	});

	// The seq goes into a call to the server. A path with a different value is not a link to a message.
	it("takes only a whole number from 1 as the message of a link", () => {
		const room = chatPath("rm_01JD0000000000000000000000");
		for (const seq of [
			"0",
			"-1",
			"1.5",
			"1e3",
			"abc",
			"12345678901234567890",
			"7/extra",
			"7/0",
			"7/7",
			"7/3",
			"7/8/9",
		]) {
			expect(parseRoute(`${room}/${seq}`), seq).toEqual({ page: "not-found" });
		}
	});

	// A mention in a message and the account menu link to the profile, so the link must open that profile
	// after a reload. The profile is a page of the workspace, so the old path in Chat opens no page.
	it("parses the path of a profile back to that principal, and the old path in Chat to not-found", () => {
		const principalId = "prn_01JD0000000000000000000000";
		expect(parseRoute(`/people/${principalId}`)).toEqual({ page: "profile", principalId });
		expect(parseRoute(profilePath(principalId))).toEqual({ page: "profile", principalId });
		for (const path of [
			"/people",
			"/people/rm_01JD0000000000000000000000",
			`/people/${principalId}/x`,
			`/chat/people/${principalId}`,
		]) {
			expect(parseRoute(path), path).toEqual({ page: "not-found" });
		}
	});

	// The sidebar links to the Threads view, so a reload of it must open the same view.
	it("parses the path of the Threads view, and no longer path", () => {
		expect(parseRoute(chatThreadsPath())).toEqual({ page: "chat", roomId: null, seq: null, threads: true });
		expect(parseRoute(`${chatThreadsPath()}/x`)).toEqual({ page: "not-found" });
	});

	it("parses the paths of the Activity, Saved, and Drafts views, and no longer paths", () => {
		expect(parseRoute(chatActivityPath())).toEqual({ page: "chat", roomId: null, seq: null, view: "activity" });
		expect(parseRoute(chatSavedPath())).toEqual({ page: "chat", roomId: null, seq: null, view: "saved" });
		expect(parseRoute(chatDraftsPath())).toEqual({ page: "chat", roomId: null, seq: null, view: "drafts" });
		for (const path of [`${chatActivityPath()}/x`, `${chatSavedPath()}/x`, `${chatDraftsPath()}/x`]) {
			expect(parseRoute(path), path).toEqual({ page: "not-found" });
		}
	});

	// A search has a link: the path has the query, and the room of a search in one room.
	it("round-trips the Search view of Chat, with a query and a room", () => {
		const roomId = "rm_01JD0000000000000000000000";
		const chat = { page: "chat", roomId: null, seq: null };
		expect(chatSearchPath()).toBe("/chat/search");
		expect(parseRoute(chatSearchPath())).toEqual({ ...chat, search: { query: "", roomId: null } });
		const query = 'from:ada "release plan" a&b=c#d';
		expect(parseRoute(chatSearchPath(query))).toEqual({ ...chat, search: { query, roomId: null } });
		expect(parseRoute(chatSearchPath(query, roomId))).toEqual({ ...chat, search: { query, roomId } });
		expect(parseRoute(chatSearchPath("", roomId))).toEqual({ ...chat, search: { query: "", roomId } });
		// A room parameter that is no room id is not a room, and a longer path is no view.
		expect(parseRoute("/chat/search?q=x&room=itm_1")).toEqual({ ...chat, search: { query: "x", roomId: null } });
		expect(parseRoute("/chat/search/x")).toEqual({ page: "not-found" });
	});

	// A deep link and a reload of a section open the same section.
	it("parses the path of each admin section back to that section", () => {
		expect(parseRoute("/admin")).toEqual({ page: "admin", section: null });
		for (const section of ADMIN_SECTIONS) {
			expect(parseRoute(adminPath(section))).toEqual({ page: "admin", section });
		}
		// People and agents share Members. The old Agents path opens that section.
		expect(parseRoute("/admin/agents")).toEqual({ page: "redirect", to: "/admin/members" });
	});

	// Each member has its own page in Members, so a deep link and a reload open the same member.
	it("parses the path of the page of a member back to that member", () => {
		expect(memberPath(SPACE)).toBe(`/admin/members/${SPACE}`);
		expect(parseRoute(memberPath(SPACE))).toEqual({ page: "admin", section: "members", memberId: SPACE });
		// Only Members has a page for each item, and only a principal id names one.
		for (const path of [
			`/admin/shared-drives/${SPACE}`,
			`/admin/members/${SHARED_DRIVE}`,
			`/admin/members/${SPACE}/extra`,
		]) {
			expect(parseRoute(path), path).toEqual({ page: "not-found" });
		}
	});

	// Settings has the same side navigation as Admin. A deep link and a reload open the same section.
	it("parses the path of each settings section back to that section", () => {
		expect(parseRoute("/settings")).toEqual({ page: "settings", section: null });
		for (const section of SETTINGS_SECTIONS) {
			expect(parseRoute(settingsPath(section))).toEqual({ page: "settings", section });
		}
	});

	it("sends / and /mail to the inbox, and gives not-found for other paths", () => {
		expect(parseRoute("/")).toEqual({ page: "redirect", to: "/mail/inbox" });
		expect(parseRoute("/mail")).toEqual({ page: "redirect", to: "/mail/inbox" });
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
			`/drive/shared-drives/${SPACE}`,
			`/drive/shared-drives/${SHARED_DRIVE}/outbox`,
			`/drive/shared-drives/${SHARED_DRIVE}/trash/extra`,
			`/docs/${SPACE}`,
			`/docs/${SPACE}/${ITEM}/extra`,
			`/sheets/${ITEM}/${SPACE}`,
			"/admin/extra",
			"/admin/members/extra",
			"/settings/extra",
			"/settings/account/extra",
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
