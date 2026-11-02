import type { Label } from "@soldock/contracts";
import type { IconName } from "../../lib/icons.tsx";
import type { MailView, SystemView } from "../../routes.ts";

export interface SystemNavItem {
	view: SystemView;
	title: string;
	icon: IconName;
	/** The label whose unread count shows next to the view. */
	countLabel: string | null;
}

export const SYSTEM_NAV: readonly SystemNavItem[] = [
	{ view: "inbox", title: "Inbox", icon: "inbox", countLabel: "INBOX" },
	{ view: "starred", title: "Starred", icon: "star", countLabel: null },
	{ view: "sent", title: "Sent", icon: "send", countLabel: null },
	{ view: "all", title: "All mail", icon: "allMail", countLabel: null },
	{ view: "spam", title: "Spam", icon: "spam", countLabel: "SPAM" },
	{ view: "trash", title: "Trash", icon: "trash", countLabel: null },
];

const SYSTEM_QUERIES: Record<SystemView, string> = {
	inbox: "in:inbox",
	starred: "is:starred",
	sent: "in:sent",
	spam: "in:spam",
	trash: "in:trash",
	// An empty query string means all mail. The operation uses in:inbox only when the query is absent.
	all: "",
};

/** Names for the system labels, as chips show them. UNREAD has no chip. */
const SYSTEM_LABEL_NAMES: Record<string, string | null> = {
	INBOX: "Inbox",
	STARRED: "Starred",
	IMPORTANT: "Important",
	SENT: "Sent",
	SPAM: "Spam",
	TRASH: "Trash",
	UNREAD: null,
};

export type ViewQuery = { status: "ready"; query: string } | { status: "pending" } | { status: "missing" };

/** The search query of a view. A label view waits for the labels, because the query uses the name. */
export function viewQuery(view: MailView, labels: readonly Label[] | null): ViewQuery {
	switch (view.kind) {
		case "system":
			return { status: "ready", query: SYSTEM_QUERIES[view.view] };
		case "search":
			return { status: "ready", query: view.query };
		case "label": {
			if (labels === null) return { status: "pending" };
			const label = labels.find((item) => item.id === view.labelId);
			if (!label) return { status: "missing" };
			return { status: "ready", query: `label:"${label.name.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"` };
		}
	}
}

export function viewTitle(view: MailView, labels: readonly Label[] | null): string {
	switch (view.kind) {
		case "system":
			return SYSTEM_NAV.find((item) => item.view === view.view)?.title ?? "Mail";
		case "search":
			return `Search results for “${view.query}”`;
		case "label":
			return labels?.find((item) => item.id === view.labelId)?.name ?? "Label";
	}
}

/** The chip text of a label id, or null for a label that has no chip. */
export function labelChipName(id: string, labelsById: ReadonlyMap<string, Label>): string | null {
	if (id in SYSTEM_LABEL_NAMES) return SYSTEM_LABEL_NAMES[id] ?? null;
	return labelsById.get(id)?.name ?? null;
}

export function isUserLabelId(id: string): boolean {
	return id.startsWith("lbl_");
}
