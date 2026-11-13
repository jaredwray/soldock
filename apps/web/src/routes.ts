// The app routes. Each path is a deep link: the dock Worker serves index.html for it.

export const SYSTEM_VIEWS = ["inbox", "starred", "sent", "spam", "trash", "all"] as const;
export type SystemView = (typeof SYSTEM_VIEWS)[number];

export type MailView =
	| { kind: "system"; view: SystemView }
	| { kind: "label"; labelId: string }
	| { kind: "search"; query: string };

export type Route =
	/** `mailboxId` is the id of a team mailbox, or null for the own mailbox of the person. */
	| { page: "mail"; mailboxId: string | null; view: MailView; threadId: string | null }
	| { page: "admin" }
	| { page: "settings" }
	| { page: "redirect"; to: string }
	| { page: "not-found" };

export const INBOX_PATH = "/mail/inbox";

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
	if (first === "admin" && parts.length === 1) return { page: "admin" };
	if (first === "settings" && parts.length === 1) return { page: "settings" };
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
