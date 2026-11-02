// The app routes. Each path is a deep link: the dock Worker serves index.html for it.

export const SYSTEM_VIEWS = ["inbox", "starred", "sent", "spam", "trash", "all"] as const;
export type SystemView = (typeof SYSTEM_VIEWS)[number];

export type MailView =
	| { kind: "system"; view: SystemView }
	| { kind: "label"; labelId: string }
	| { kind: "search"; query: string };

export type Route =
	| { page: "mail"; view: MailView; threadId: string | null }
	| { page: "admin" }
	| { page: "settings" }
	| { page: "redirect"; to: string }
	| { page: "not-found" };

export const INBOX_PATH = "/mail/inbox";

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
	if (isSystemView(second) && parts.length <= 3) {
		return { page: "mail", view: { kind: "system", view: second }, threadId: third ?? null };
	}
	if (second === "label" && third !== undefined && parts.length <= 4) {
		return { page: "mail", view: { kind: "label", labelId: third }, threadId: fourth ?? null };
	}
	if (second === "search" && parts.length <= 3) {
		const query = url.searchParams.get("q") ?? "";
		return { page: "mail", view: { kind: "search", query }, threadId: third ?? null };
	}
	return { page: "not-found" };
}

/** The path of the thread list of a view. */
export function viewPath(view: MailView): string {
	switch (view.kind) {
		case "system":
			return `/mail/${view.view}`;
		case "label":
			return `/mail/label/${encodeURIComponent(view.labelId)}`;
		case "search":
			return `/mail/search?q=${encodeURIComponent(view.query)}`;
	}
}

/** The path of one thread, opened from a view. */
export function threadPath(view: MailView, threadId: string): string {
	const id = encodeURIComponent(threadId);
	if (view.kind === "search") return `/mail/search/${id}?q=${encodeURIComponent(view.query)}`;
	return `${viewPath(view)}/${id}`;
}
