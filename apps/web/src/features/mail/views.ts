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

/** One row of the label tree in the sidebar. */
export interface LabelRow {
	/** The label id, or `group:` and the path for a group row. */
	key: string;
	/** The last part of the path, for example `Northwind` for `Clients/Northwind`. */
	name: string;
	/** The path before the name, for example `Clients/`. It is empty at the top level. */
	parent: string;
	depth: number;
	/** The label of the row. It is null for a group row: a parent path that is not a label. */
	label: Label | null;
}

interface LabelNode {
	key: string;
	name: string;
	path: string[];
	label: Label | null;
	children: LabelNode[];
}

/**
 * The user labels as a tree, in display order. A slash in a name makes a nested label. A parent
 * path that is not a label gets a group row, so `Clients/Northwind` always shows under `Clients`.
 */
export function labelRows(labels: readonly Label[]): LabelRow[] {
	const roots: LabelNode[] = [];
	const nodes = new Map<string, LabelNode>();
	for (const label of labels) {
		if (label.type !== "user") continue;
		const parts = label.name
			.split("/")
			.map((part) => part.trim())
			.filter(Boolean);
		const path = parts.length > 0 ? parts : [label.name];
		let siblings = roots;
		for (let depth = 0; depth < path.length; depth += 1) {
			const key = path.slice(0, depth + 1).join("/");
			let node = nodes.get(key);
			if (!node) {
				node = { key, name: path[depth] ?? "", path: path.slice(0, depth), label: null, children: [] };
				nodes.set(key, node);
				siblings.push(node);
			}
			if (depth === path.length - 1) {
				// Two names can give the same path, for example `A/B` and `A//B`. Each label keeps its own row.
				if (node.label) siblings.push({ ...node, label, children: [] });
				else node.label = label;
			}
			siblings = node.children;
		}
	}
	const rows: LabelRow[] = [];
	const visit = (level: readonly LabelNode[], depth: number) => {
		for (const node of [...level].sort((a, b) => a.name.localeCompare(b.name))) {
			const parent = node.path.length > 0 ? `${node.path.join("/")}/` : "";
			const key = node.label ? node.label.id : `group:${node.key}`;
			rows.push({ key, name: node.name, parent, depth, label: node.label });
			visit(node.children, depth + 1);
		}
	};
	visit(roots, 0);
	return rows;
}
