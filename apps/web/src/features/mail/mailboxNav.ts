import type { Mailbox } from "@asterra/contracts";
import { isAgentMailbox } from "../../routes.ts";

/** One mailbox in the sidebar. Under it, the sidebar shows its folders and labels when it is expanded. */
export interface MailboxEntry {
	/** The id of the mailbox in the paths, or null for the own mailbox of the person. */
	id: string | null;
	/** The key of the expanded state: the id, or "own" for the own mailbox. */
	key: string;
	name: string;
	address: string | null;
	kind: Mailbox["kind"];
}

const OWN_KEY = "own";

/** The key of the expanded state of a mailbox. */
export function mailboxKey(mailboxId: string | null): string {
	return mailboxId ?? OWN_KEY;
}

/**
 * True when the sidebar shows the folders and labels of the mailbox. The person can expand or collapse
 * each mailbox. Until they do, only the open mailbox is expanded.
 */
export function isExpanded(
	entry: MailboxEntry,
	current: string | null,
	expanded: Readonly<Record<string, boolean>>,
): boolean {
	return expanded[entry.key] ?? entry.id === current;
}

/**
 * The mailboxes of the sidebar: "My mailbox" first, then the shared (team) mailboxes, then the agent
 * mailboxes. Each one is a row that the person can expand to show its folders and labels.
 *
 * Null when the person has only their own mailbox: the sidebar then shows the folders and labels with
 * no mailbox rows. A deep link can open a different mailbox before the list loads, or after the access
 * ended. That mailbox then gets a row with `currentName`, so its folders show, and "My mailbox" is the
 * way back.
 */
export function mailboxNav(
	mailboxes: readonly Mailbox[] | null,
	current: string | null,
	currentName: string | null,
): MailboxEntry[] | null {
	const list = mailboxes ?? [];
	const own = list.find((mailbox) => mailbox.kind === "personal");
	const others = [...list.filter((mailbox) => mailbox.kind === "team"), ...list.filter((m) => m.kind === "agent")];
	if (others.length === 0 && current === null) return null;
	const entries: MailboxEntry[] = [
		{ id: null, key: OWN_KEY, name: "My mailbox", address: own?.address ?? null, kind: "personal" },
		...others.map((mailbox) => ({
			id: mailbox.id,
			key: mailbox.id,
			name: mailbox.display_name,
			address: mailbox.address,
			kind: mailbox.kind,
		})),
	];
	if (current !== null && !others.some((mailbox) => mailbox.id === current)) {
		const agent = isAgentMailbox(current);
		entries.push({
			id: current,
			key: current,
			name: currentName ?? (agent ? "Agent mailbox" : "Team mailbox"),
			address: null,
			kind: agent ? "agent" : "team",
		});
	}
	return entries;
}
