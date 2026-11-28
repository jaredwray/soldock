// The app routes. Each path is a deep link: the dock Worker serves index.html for it.
import { CALENDAR_LIMITS, isRealDate } from "@asterra/contracts";

export const SYSTEM_VIEWS = ["inbox", "snoozed", "starred", "sent", "spam", "trash", "all"] as const;
export type SystemView = (typeof SYSTEM_VIEWS)[number];

export type MailView =
	| { kind: "system"; view: SystemView }
	| { kind: "label"; labelId: string }
	| { kind: "search"; query: string };

/** The views of Drive that are not a folder. Each has one path under `/drive`. */
export const DRIVE_LISTS = ["shared", "recent", "starred", "trash"] as const;
export type DriveList = (typeof DRIVE_LISTS)[number];

export type DriveView =
	/**
	 * A folder of a drive. `spaceId` and `folderId` are null for the root of the own drive of the person.
	 * The root of a shared drive has the id of the drive (`drv_`) and no folder.
	 */
	| { kind: "folder"; spaceId: string | null; folderId: string | null }
	| { kind: Exclude<DriveList, "trash"> }
	/** The trash of the own drive, or of the shared drive `spaceId`. */
	| { kind: "trash"; spaceId?: string }
	/** The list of the shared drives of the person. */
	| { kind: "shared-drives" }
	/** A search in the own drive, or in the shared drive `spaceId`. */
	| { kind: "search"; query: string; spaceId?: string };

/**
 * The sections of the admin page. Each has one path under `/admin`. People and agents share `members`.
 * The old `/admin/agents` path redirects there. Each member has its own page under `/admin/members`.
 */
export const ADMIN_SECTIONS = [
	"general",
	"members",
	"shared-mailboxes",
	"shared-drives",
	"chat",
	"mail",
	"domains",
	"ai",
	"meet",
] as const;
export type AdminSection = (typeof ADMIN_SECTIONS)[number];

/** The sections of the settings page. Each has one path under `/settings`. */
export const SETTINGS_SECTIONS = ["account", "notifications", "security", "api-keys"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** The tabs of the Screener view of a mailbox: the senders that wait, and the decisions. */
export type ScreenerTab = "waiting" | "history";

export const CHAT_VIEWS = ["activity", "saved", "drafts"] as const;
export type ChatView = (typeof CHAT_VIEWS)[number];

/** The views of Calendar. Each has one path under `/calendar`. */
export const CALENDAR_VIEWS = ["week", "month"] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

export type Route =
	/**
	 * `mailboxId` is the id of a team mailbox (`tmb_`), the id of an agent (`prn_`) whose mailbox an owner
	 * or an admin reads, the id of a person (`prn_`) who lets the person use their mailbox, or null for the
	 * own mailbox of the person.
	 */
	/**
	 * `focus` is true for Focus: the conversations of the view, one after the other, each with its
	 * newest message. It has no thread.
	 */
	| { page: "mail"; mailboxId: string | null; view: MailView; threadId: string | null; focus?: true }
	/** The settings view of a mailbox, in the main pane of Mail. `mailboxId` is as for `mail`. */
	| { page: "mail-settings"; mailboxId: string | null }
	/** The Screener view of a mailbox, in the main pane of Mail. `mailboxId` is as for `mail`. */
	| { page: "mail-screener"; mailboxId: string | null; tab: ScreenerTab }
	| { page: "drive"; view: DriveView }
	/** A doc or a sheet in its editor. `spaceId` is the drive that holds the item. */
	| { page: "doc"; spaceId: string; itemId: string }
	| { page: "sheet"; spaceId: string; itemId: string }
	/**
	 * Chat. `roomId` is null for the page without an open room. `seq` is the message that a link
	 * points to. `replySeq` is a reply in the thread of that message, for a link to a reply. `threads`
	 * is true for the Threads view: the threads that the person follows. `search` is the Search view: the query, and the
	 * room of a search in one room, or null for a search in each room of the person.
	 */
	| {
			page: "chat";
			roomId: string | null;
			seq: number | null;
			replySeq?: number;
			threads?: true;
			view?: ChatView;
			search?: { query: string; roomId: string | null };
	  }
	/**
	 * Calendar. `date` is a day of the period to show, in YYYY-MM-DD form, or null for today. The week view
	 * shows the week of the day, and the month view the month of the day.
	 */
	| {
			page: "calendar";
			view: CalendarView;
			date: string | null;
			/** The id of the person whose calendar the page shows: a person who lets the person schedule. Null: own. */
			calendarId: string | null;
	  }
	/** The Meet page of the app: a new meeting link, and a field to open a link. A meeting has its own page outside the app. */
	| { page: "meet" }
	/** The profile of a person or an agent. It is a page of the workspace, not a part of a product. */
	| { page: "profile"; principalId: string }
	/**
	 * `section` is null for `/admin`. The page then shows the first section that the person can use.
	 * `memberId` is the person, agent or service account whose page shows in the Members section.
	 */
	| { page: "admin"; section: AdminSection | null; memberId?: string }
	/** The approval page of an OAuth request from an MCP client. `/oauth/authorize` sends the browser here. */
	| { page: "connect"; requestId: string }
	/** `section` is null for `/settings`. The page then shows the first section. */
	| { page: "settings"; section: SettingsSection | null }
	| { page: "redirect"; to: string }
	| { page: "not-found" };

export const INBOX_PATH = "/mail/inbox";
export const DRIVE_PATH = "/drive";
export const SHARED_DRIVES_PATH = "/drive/shared-drives";
export const CHAT_PATH = "/chat";
export const CALENDAR_PATH = "/calendar";
/** The Meet page of the app. `/meet/<code>` is the page of one meeting, which `App` opens outside the app. */
export const MEET_PATH = "/meet";
export const PEOPLE_PATH = "/people";
export const ADMIN_PATH = "/admin";
export const SETTINGS_PATH = "/settings";

/**
 * The ids of the people whose mailbox the person can use as a delegate. A person and an agent both have a
 * `prn_` id, so the id alone does not tell the mailbox of a person from the mailbox of an agent. The id of a
 * principal never changes its kind, so an id stays here. The list of the mailboxes adds the ids
 * (`markPersonMailboxes`), and so does a path of such a mailbox (`parseRoute`). The list knows the kind, so
 * it also removes an id that a wrong path added for an agent (`agentIds`).
 */
const personMailboxes = new Set<string>();

/**
 * Records the ids of people whose mailbox the person can use: the `delegated` mailboxes of
 * `mail.list_mailboxes`. `agentIds` are the ids that the list shows as the mailbox of an agent. They are never
 * the mailbox of a person, also after a `/mail/person/…` path named one of them.
 */
export function markPersonMailboxes(ids: Iterable<string>, agentIds: Iterable<string> = []): void {
	for (const id of ids) personMailboxes.add(id);
	for (const id of agentIds) personMailboxes.delete(id);
}

/** True for the mailbox of a different person, which that person lets the person use (the kind `delegated`). */
export function isDelegatedMailbox(mailboxId: string | null): boolean {
	return mailboxId !== null && personMailboxes.has(mailboxId);
}

/**
 * True for the mailbox of an agent, which an owner or an admin can only read. In the routes, a mailbox
 * id is the id of a team mailbox (`tmb_`), the id of an agent (`prn_`) or the id of a person whose mailbox
 * the person can use (`prn_`, `isDelegatedMailbox`). The own mailbox has no id.
 */
export function isAgentMailbox(mailboxId: string | null): boolean {
	return mailboxId?.startsWith("prn_") === true && !isDelegatedMailbox(mailboxId);
}

/** The kind of the mailbox of the mail views, from its id. Null is the own mailbox of the person. */
export function mailboxKindOf(mailboxId: string | null): "personal" | "team" | "delegated" | "agent" {
	if (mailboxId === null) return "personal";
	if (isDelegatedMailbox(mailboxId)) return "delegated";
	return isAgentMailbox(mailboxId) ? "agent" : "team";
}

/** The path part that names the kind of a mailbox with an id. */
const MAILBOX_SEGMENTS = { team: "team", delegated: "person", agent: "agent" } as const;

/**
 * The path part before the view. A team mailbox has its own paths (`/mail/team/<id>/inbox`), and so do
 * the mailbox of an agent (`/mail/agent/<id>/inbox`) and the mailbox of a person who lets the person use
 * it (`/mail/person/<id>/inbox`).
 */
function mailBase(mailboxId: string | null): string {
	const kind = mailboxKindOf(mailboxId);
	if (mailboxId === null || kind === "personal") return "/mail";
	return `/mail/${MAILBOX_SEGMENTS[kind]}/${encodeURIComponent(mailboxId)}`;
}

function isSystemView(value: string | undefined): value is SystemView {
	return (SYSTEM_VIEWS as readonly string[]).includes(value ?? "");
}

function segments(pathname: string): string[] | null {
	try {
		return pathname.split("/").filter(Boolean).map(decodeURIComponent);
	} catch {
		return null;
	}
}

export function parseRoute(location: string): Route {
	const url = new URL(location, "http://asterra.invalid");
	const parts = segments(url.pathname);
	if (parts === null) return { page: "not-found" };
	const [first, second, third, fourth] = parts;
	if (parts.length === 0) return { page: "redirect", to: INBOX_PATH };
	if (first === "admin" && parts.length === 1) return { page: "admin", section: null };
	if (first === "admin" && parts.length === 2 && second === "agents")
		return { page: "redirect", to: adminPath("members") };
	if (first === "admin" && parts.length === 2 && isAdminSection(second)) return { page: "admin", section: second };
	if (first === "admin" && parts.length === 3 && second === "members" && isPrincipalId(third))
		return { page: "admin", section: "members", memberId: third };
	if (first === "settings" && parts.length === 1) return { page: "settings", section: null };
	if (first === "settings" && parts.length === 2 && isSettingsSection(second))
		return { page: "settings", section: second };
	if (first === "connect" && parts.length === 2 && second?.startsWith("oar_"))
		return { page: "connect", requestId: second };
	if (first === "drive") return parseDriveView(parts.slice(1), url);
	if (first === "people") {
		return parts.length === 2 && isPrincipalId(second)
			? { page: "profile", principalId: second }
			: { page: "not-found" };
	}
	if (first === "chat") {
		if (parts.length === 1) return { page: "chat", roomId: null, seq: null };
		if (second === "threads") {
			return parts.length === 2 ? { page: "chat", roomId: null, seq: null, threads: true } : { page: "not-found" };
		}
		if (second === "activity" || second === "saved" || second === "drafts") {
			return parts.length === 2 ? { page: "chat", roomId: null, seq: null, view: second } : { page: "not-found" };
		}
		if (second === "search") {
			if (parts.length !== 2) return { page: "not-found" };
			const room = url.searchParams.get("room") ?? undefined;
			const search = { query: url.searchParams.get("q") ?? "", roomId: isRoomId(room) ? room : null };
			return { page: "chat", roomId: null, seq: null, search };
		}
		if (!isRoomId(second)) return { page: "not-found" };
		if (parts.length === 2) return { page: "chat", roomId: second, seq: null };
		// A link to one message has the seq of the message after the room. A link to a reply has the seq of
		// the first message of its thread, then the seq of the reply, which always comes after it.
		if (third === undefined || !MESSAGE_SEQ.test(third)) return { page: "not-found" };
		if (parts.length === 3) return { page: "chat", roomId: second, seq: Number(third) };
		const fourth = parts[3];
		return parts.length === 4 && fourth !== undefined && MESSAGE_SEQ.test(fourth) && Number(fourth) > Number(third)
			? { page: "chat", roomId: second, seq: Number(third), replySeq: Number(fourth) }
			: { page: "not-found" };
	}
	if (first === "calendar") {
		// The calendar of a person who lets the person schedule: /calendar/person/<id>[/<view>/<date>].
		let calendarId: string | null = null;
		let rest = parts.slice(1);
		if (second === "person") {
			if (!isPrincipalId(third)) return { page: "not-found" };
			calendarId = third;
			rest = parts.slice(3);
		}
		const [view, date] = rest;
		if (rest.length === 0) return { page: "calendar", view: "week", date: null, calendarId };
		if (rest.length === 2 && isCalendarView(view) && isCalendarDate(date)) {
			return { page: "calendar", view, date, calendarId };
		}
		return { page: "not-found" };
	}
	if (first === "meet" && parts.length === 1) return { page: "meet" };
	if ((first === "docs" || first === "sheets") && parts.length === 3 && isSpaceId(second) && isItemId(third)) {
		return { page: first === "docs" ? "doc" : "sheet", spaceId: second, itemId: third };
	}
	if (first !== "mail") return { page: "not-found" };
	if (second === undefined) return { page: "redirect", to: INBOX_PATH };
	if (second !== "team" && second !== "agent" && second !== "person") return parseMailView(null, parts.slice(1), url);
	if (third === undefined || !third.startsWith(second === "team" ? "tmb_" : "prn_")) return { page: "not-found" };
	// A path of the mailbox of a person tells the kind of its id, so the links of the page keep that path.
	if (second === "person" && isPrincipalId(third)) markPersonMailboxes([third]);
	if (fourth === undefined) return { page: "redirect", to: viewPath({ kind: "system", view: "inbox" }, third) };
	return parseMailView(third, parts.slice(3), url);
}

/** The view and the thread of a mail path, from the parts after the mailbox. */
function parseMailView(mailboxId: string | null, parts: string[], url: URL): Route {
	const [first, second, third] = parts;
	if (first === "settings" && parts.length === 1) return { page: "mail-settings", mailboxId };
	// Focus has its own path under each view. A thread id has a prefix, so it is never "focus".
	if (isSystemView(first) && second === "focus" && parts.length === 2) {
		return { page: "mail", mailboxId, view: { kind: "system", view: first }, threadId: null, focus: true };
	}
	if (first === "label" && second !== undefined && third === "focus" && parts.length === 3) {
		return { page: "mail", mailboxId, view: { kind: "label", labelId: second }, threadId: null, focus: true };
	}
	if (first === "search" && second === "focus" && parts.length === 2) {
		const query = url.searchParams.get("q") ?? "";
		return { page: "mail", mailboxId, view: { kind: "search", query }, threadId: null, focus: true };
	}
	if (first === "screener" && parts.length === 1) return { page: "mail-screener", mailboxId, tab: "waiting" };
	if (first === "screener" && second === "history" && parts.length === 2) {
		return { page: "mail-screener", mailboxId, tab: "history" };
	}
	if (isSystemView(first) && parts.length <= 2) {
		return { page: "mail", mailboxId, view: { kind: "system", view: first }, threadId: second ?? null };
	}
	if (first === "label" && second !== undefined && parts.length <= 3) {
		return { page: "mail", mailboxId, view: { kind: "label", labelId: second }, threadId: third ?? null };
	}
	if (first === "search" && parts.length <= 2) {
		const query = url.searchParams.get("q") ?? "";
		return { page: "mail", mailboxId, view: { kind: "search", query }, threadId: second ?? null };
	}
	return { page: "not-found" };
}

/** True for the id of a shared drive. The drive of a person or of an agent has the id of its owner (`prn_`). */
export function isSharedDriveId(value: string | null | undefined): value is string {
	return value?.startsWith("drv_") === true;
}

function isSpaceId(value: string | undefined): value is string {
	return isPrincipalId(value) || isSharedDriveId(value);
}

/** A person and an agent have an id that starts with `prn_`. */
function isPrincipalId(value: string | undefined): value is string {
	return value?.startsWith("prn_") === true;
}

function isItemId(value: string | undefined): value is string {
	return value?.startsWith("itm_") === true;
}

/** A room has an id that starts with `rm_`. A direct message has an id that starts with `dm_`. */
function isRoomId(value: string | undefined): value is string {
	return value?.startsWith("rm_") === true || value?.startsWith("dm_") === true;
}

function isCalendarView(value: string | undefined): value is CalendarView {
	return (CALENDAR_VIEWS as readonly string[]).includes(value ?? "");
}

/** A real date in YYYY-MM-DD form, from 1970 to 2100: the days that an event can use. */
export function isCalendarDate(value: string | undefined): value is string {
	return (
		value !== undefined && isRealDate(value) && value >= CALENDAR_LIMITS.firstDate && value <= CALENDAR_LIMITS.lastDate
	);
}

function isAdminSection(value: string | undefined): value is AdminSection {
	return (ADMIN_SECTIONS as readonly string[]).includes(value ?? "");
}

function isSettingsSection(value: string | undefined): value is SettingsSection {
	return (SETTINGS_SECTIONS as readonly string[]).includes(value ?? "");
}

function isDriveList(value: string | undefined): value is DriveList {
	return (DRIVE_LISTS as readonly string[]).includes(value ?? "");
}

/** The view of a Drive path, from the parts after `/drive`. */
function parseDriveView(parts: string[], url: URL): Route {
	const [first, second, third] = parts;
	if (first === undefined) return { page: "drive", view: { kind: "folder", spaceId: null, folderId: null } };
	if (isDriveList(first) && parts.length === 1) return { page: "drive", view: { kind: first } };
	if (first === "search" && parts.length === 1) {
		return { page: "drive", view: { kind: "search", query: url.searchParams.get("q") ?? "" } };
	}
	if (first === "folders" && parts.length === 3 && isSpaceId(second) && isItemId(third)) {
		return { page: "drive", view: { kind: "folder", spaceId: second, folderId: third } };
	}
	if (first !== "shared-drives") return { page: "not-found" };
	if (second === undefined) return { page: "drive", view: { kind: "shared-drives" } };
	if (!isSharedDriveId(second) || parts.length > 3) return { page: "not-found" };
	if (third === undefined) return { page: "drive", view: { kind: "folder", spaceId: second, folderId: null } };
	if (third === "trash") return { page: "drive", view: { kind: "trash", spaceId: second } };
	if (third === "search") {
		return { page: "drive", view: { kind: "search", query: url.searchParams.get("q") ?? "", spaceId: second } };
	}
	return { page: "not-found" };
}

/**
 * The path of a view of Drive. A shared drive has its own paths for its root, its trash and its
 * search (`/drive/shared-drives/<drv_id>/…`). A folder of each drive has the same form of path.
 */
export function drivePath(view: DriveView): string {
	const shared = "spaceId" in view && isSharedDriveId(view.spaceId) ? sharedDrivePath(view.spaceId) : null;
	switch (view.kind) {
		case "folder":
			if (view.spaceId && view.folderId) {
				return `${DRIVE_PATH}/folders/${encodeURIComponent(view.spaceId)}/${encodeURIComponent(view.folderId)}`;
			}
			return shared ?? DRIVE_PATH;
		case "search":
			return `${shared ?? DRIVE_PATH}/search?q=${encodeURIComponent(view.query)}`;
		case "trash":
			return `${shared ?? DRIVE_PATH}/trash`;
		case "shared-drives":
			return SHARED_DRIVES_PATH;
		default:
			return `${DRIVE_PATH}/${view.kind}`;
	}
}

/** The path of the root of a shared drive. */
export function sharedDrivePath(driveId: string): string {
	return `${SHARED_DRIVES_PATH}/${encodeURIComponent(driveId)}`;
}

/**
 * The path that opens an item: the folder view for a folder, and the editor for a doc or a sheet. A
 * file has no page of its own, so the result is null. The path has the drive of the item, so the same
 * link works for the owner and for each person that the item is shared with.
 */
export function itemPath(item: {
	kind: "folder" | "file" | "doc" | "sheet";
	space_id: string;
	id: string;
}): string | null {
	const tail = `${encodeURIComponent(item.space_id)}/${encodeURIComponent(item.id)}`;
	switch (item.kind) {
		case "folder":
			return `${DRIVE_PATH}/folders/${tail}`;
		case "doc":
			return `/docs/${tail}`;
		case "sheet":
			return `/sheets/${tail}`;
		case "file":
			return null;
	}
}

/** The path of a view of Calendar, for the period that holds `date` (YYYY-MM-DD). */
/** The path of a period of Calendar: of the own calendar, or with `calendarId` of the calendar of that person. */
export function calendarPath(view: CalendarView, date: string, calendarId: string | null = null): string {
	return calendarId === null
		? `${CALENDAR_PATH}/${view}/${date}`
		: `${CALENDAR_PATH}/person/${calendarId}/${view}/${date}`;
}

/** The path of a section of the admin page. */
export function adminPath(section: AdminSection): string {
	return `${ADMIN_PATH}/${section}`;
}

/** The path of the page of one person, agent or service account in Admin › Members. */
export function memberPath(principalId: string): string {
	return `${adminPath("members")}/${encodeURIComponent(principalId)}`;
}

/** The path of a section of the settings page. */
export function settingsPath(section: SettingsSection): string {
	return `${SETTINGS_PATH}/${section}`;
}

/** The seq of a message in a path: a whole number from 1, in the range that a number keeps exactly. */
const MESSAGE_SEQ = /^[1-9]\d{0,14}$/;

/**
 * The path of a room of Chat, or of the Chat page without an open room. With `seq`, the path is a link
 * to one message of the room. With `replySeq` too, it is a link to a reply in the thread of that message.
 */
export function chatPath(
	roomId: string | null = null,
	seq: number | null = null,
	replySeq: number | null = null,
): string {
	if (!roomId) return CHAT_PATH;
	const room = `${CHAT_PATH}/${encodeURIComponent(roomId)}`;
	if (seq === null) return room;
	return replySeq === null ? `${room}/${seq}` : `${room}/${seq}/${replySeq}`;
}

/** The path of the Threads view of Chat: the threads that the person follows. */
export function chatThreadsPath(): string {
	return `${CHAT_PATH}/threads`;
}

/** The path of the Activity view of Chat. */
export function chatActivityPath(): string {
	return `${CHAT_PATH}/activity`;
}

/** The path of the Saved messages and reminders view of Chat. */
export function chatSavedPath(): string {
	return `${CHAT_PATH}/saved`;
}

/** The path of the Drafts and scheduled messages view of Chat. */
export function chatDraftsPath(): string {
	return `${CHAT_PATH}/drafts`;
}

/**
 * The path of the Search view of Chat, with a query or without one. With `roomId`, the search is in that
 * room only.
 */
export function chatSearchPath(query = "", roomId: string | null = null): string {
	const params = new URLSearchParams();
	if (query !== "") params.set("q", query);
	if (roomId !== null) params.set("room", roomId);
	const text = params.toString();
	return text === "" ? `${CHAT_PATH}/search` : `${CHAT_PATH}/search?${text}`;
}

/**
 * The path of the profile of a person or an agent. The profile is a page of the workspace, not of Chat.
 * A mention in a message, the name of an author and the account menu link to it.
 */
export function profilePath(principalId: string): string {
	return `${PEOPLE_PATH}/${encodeURIComponent(principalId)}`;
}

/** The path of the thread list of a view, in the own mailbox, in a team mailbox or in the mailbox of an agent. */
export function viewPath(view: MailView, mailboxId: string | null = null): string {
	const base = mailBase(mailboxId);
	switch (view.kind) {
		case "system":
			return `${base}/${view.view}`;
		case "label":
			return `${base}/label/${encodeURIComponent(view.labelId)}`;
		case "search":
			return `${base}/search?q=${encodeURIComponent(view.query)}`;
	}
}

/**
 * The same view in the own mailbox, for a mail route that names the person's own id as an agent mailbox,
 * or null for each other route. The server treats that id as the own mailbox, so the app goes to the
 * own mailbox, with all its controls, and not to a read-only view of it.
 */
export function ownMailboxPath(route: Route, selfId: string): string | null {
	if (route.page === "mail-settings" && route.mailboxId === selfId) return mailSettingsPath(null);
	if (route.page === "mail-screener" && route.mailboxId === selfId) return screenerPath(null, route.tab);
	if (route.page !== "mail" || route.mailboxId !== selfId) return null;
	if (route.focus) return focusPath(route.view);
	return route.threadId ? threadPath(route.view, route.threadId) : viewPath(route.view);
}

/**
 * The path of Focus in a view: `/mail/inbox/focus`, `/mail/label/<id>/focus` or
 * `/mail/search/focus?q=…`, or under the path of a team or agent mailbox.
 */
export function focusPath(view: MailView, mailboxId: string | null = null): string {
	if (view.kind === "search") return `${mailBase(mailboxId)}/search/focus?q=${encodeURIComponent(view.query)}`;
	return `${viewPath(view, mailboxId)}/focus`;
}

/** The path of the settings view of a mailbox: `/mail/settings`, or under the path of a team or agent mailbox. */
export function mailSettingsPath(mailboxId: string | null = null): string {
	return `${mailBase(mailboxId)}/settings`;
}

/** The path of the Screener view of a mailbox: `/mail/screener`, or `/mail/screener/history` for the decisions. */
export function screenerPath(mailboxId: string | null = null, tab: ScreenerTab = "waiting"): string {
	return `${mailBase(mailboxId)}/screener${tab === "history" ? "/history" : ""}`;
}

/** The path of one thread, opened from a view. */
export function threadPath(view: MailView, threadId: string, mailboxId: string | null = null): string {
	const id = encodeURIComponent(threadId);
	if (view.kind === "search") return `${mailBase(mailboxId)}/search/${id}?q=${encodeURIComponent(view.query)}`;
	return `${viewPath(view, mailboxId)}/${id}`;
}
