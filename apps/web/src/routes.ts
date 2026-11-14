// The app routes. Each path is a deep link: the dock Worker serves index.html for it.

export const SYSTEM_VIEWS = ["inbox", "starred", "sent", "spam", "trash", "all"] as const;
export type SystemView = (typeof SYSTEM_VIEWS)[number];

export type MailView =
	| { kind: "system"; view: SystemView }
	| { kind: "label"; labelId: string }
	| { kind: "search"; query: string };

/** The views of Drive that are not a folder. Each has one path under `/drive`. */
export const DRIVE_LISTS = ["shared", "recent", "starred", "trash"] as const;
export type DriveList = (typeof DRIVE_LISTS)[number];

export type DriveView =
	/** A folder of a drive. `spaceId` and `folderId` are null for the root of the own drive of the person. */
	| { kind: "folder"; spaceId: string | null; folderId: string | null }
	| { kind: DriveList }
	| { kind: "search"; query: string };

/** The sections of the admin page. Each has one path under `/admin`. */
export const ADMIN_SECTIONS = ["members", "agents", "shared-mailboxes", "domains"] as const;
export type AdminSection = (typeof ADMIN_SECTIONS)[number];

export type Route =
	/** `mailboxId` is the id of a team mailbox, or null for the own mailbox of the person. */
	| { page: "mail"; mailboxId: string | null; view: MailView; threadId: string | null }
	| { page: "drive"; view: DriveView }
	/** A doc or a sheet in its editor. `spaceId` is the drive that holds the item. */
	| { page: "doc"; spaceId: string; itemId: string }
	| { page: "sheet"; spaceId: string; itemId: string }
	/** Chat. `roomId` is null for the page without an open room. */
	| { page: "chat"; roomId: string | null }
	/** `section` is null for `/admin`. The page then shows the first section that the person can use. */
	| { page: "admin"; section: AdminSection | null }
	/** The approval page of an OAuth request from an MCP client. `/oauth/authorize` sends the browser here. */
	| { page: "connect"; requestId: string }
	| { page: "settings" }
	| { page: "redirect"; to: string }
	| { page: "not-found" };

export const INBOX_PATH = "/mail/inbox";
export const DRIVE_PATH = "/drive";
export const CHAT_PATH = "/chat";
export const ADMIN_PATH = "/admin";

/** The path part before the view. A team mailbox has its own paths: `/mail/team/<id>/inbox`. */
function mailBase(mailboxId: string | null): string {
	return mailboxId ? `/mail/team/${encodeURIComponent(mailboxId)}` : "/mail";
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
	const url = new URL(location, "http://soldock.invalid");
	const parts = segments(url.pathname);
	if (parts === null) return { page: "not-found" };
	const [first, second, third, fourth] = parts;
	if (parts.length === 0) return { page: "redirect", to: INBOX_PATH };
	if (first === "admin" && parts.length === 1) return { page: "admin", section: null };
	if (first === "admin" && parts.length === 2 && isAdminSection(second)) return { page: "admin", section: second };
	if (first === "settings" && parts.length === 1) return { page: "settings" };
	if (first === "connect" && parts.length === 2 && second?.startsWith("oar_"))
		return { page: "connect", requestId: second };
	if (first === "drive") return parseDriveView(parts.slice(1), url);
	if (first === "chat") {
		if (parts.length === 1) return { page: "chat", roomId: null };
		return parts.length === 2 && isRoomId(second) ? { page: "chat", roomId: second } : { page: "not-found" };
	}
	if ((first === "docs" || first === "sheets") && parts.length === 3 && isSpaceId(second) && isItemId(third)) {
		return { page: first === "docs" ? "doc" : "sheet", spaceId: second, itemId: third };
	}
	if (first !== "mail") return { page: "not-found" };
	if (second === undefined) return { page: "redirect", to: INBOX_PATH };
	if (second !== "team") return parseMailView(null, parts.slice(1), url);
	if (third === undefined || !third.startsWith("tmb_")) return { page: "not-found" };
	if (fourth === undefined) return { page: "redirect", to: viewPath({ kind: "system", view: "inbox" }, third) };
	return parseMailView(third, parts.slice(3), url);
}

/** The view and the thread of a mail path, from the parts after the mailbox. */
function parseMailView(mailboxId: string | null, parts: string[], url: URL): Route {
	const [first, second, third] = parts;
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

function isSpaceId(value: string | undefined): value is string {
	return value?.startsWith("prn_") === true;
}

function isItemId(value: string | undefined): value is string {
	return value?.startsWith("itm_") === true;
}

/** A room has an id that starts with `rm_`. A direct message has an id that starts with `dm_`. */
function isRoomId(value: string | undefined): value is string {
	return value?.startsWith("rm_") === true || value?.startsWith("dm_") === true;
}

function isAdminSection(value: string | undefined): value is AdminSection {
	return (ADMIN_SECTIONS as readonly string[]).includes(value ?? "");
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
	return { page: "not-found" };
}

/** The path of a view of Drive. */
export function drivePath(view: DriveView): string {
	switch (view.kind) {
		case "folder":
			return view.spaceId && view.folderId
				? `${DRIVE_PATH}/folders/${encodeURIComponent(view.spaceId)}/${encodeURIComponent(view.folderId)}`
				: DRIVE_PATH;
		case "search":
			return `${DRIVE_PATH}/search?q=${encodeURIComponent(view.query)}`;
		default:
			return `${DRIVE_PATH}/${view.kind}`;
	}
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

/** The path of a section of the admin page. */
export function adminPath(section: AdminSection): string {
	return `${ADMIN_PATH}/${section}`;
}

/** The path of a room of Chat, or of the Chat page without an open room. */
export function chatPath(roomId: string | null = null): string {
	return roomId ? `${CHAT_PATH}/${encodeURIComponent(roomId)}` : CHAT_PATH;
}

/** The path of the thread list of a view, in the own mailbox or in a team mailbox. */
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

/** The path of one thread, opened from a view. */
export function threadPath(view: MailView, threadId: string, mailboxId: string | null = null): string {
	const id = encodeURIComponent(threadId);
	if (view.kind === "search") return `${mailBase(mailboxId)}/search/${id}?q=${encodeURIComponent(view.query)}`;
	return `${viewPath(view, mailboxId)}/${id}`;
}
