import type { Mailbox } from "@asterra/contracts";
import { INBOX_PATH, isAgentMailbox, viewPath } from "../../routes.ts";

/** One mailbox in the sidebar. Under it, the sidebar shows its folders and labels when it is expanded. */
export interface MailboxEntry {
	/** The id of the mailbox in the paths, or null for the own mailbox of the person. */
	id: string | null;
	/** The key of the expanded state: the id, or "own" for the own mailbox. */
	key: string;
	name: string;
	address: string | null;
	kind: Mailbox["kind"];
	/** True for the mailbox of a service account. Its kind is `agent`. */
	service: boolean;
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
	// The views of a mailbox read it. A shared mailbox that the person can only send from has no row.
	const readable = list.filter((mailbox) => mailbox.scopes.includes("mail.read"));
	const others = [
		...readable.filter((mailbox) => mailbox.kind === "team"),
		...readable.filter((m) => m.kind === "agent"),
	];
	if (others.length === 0 && current === null) return null;
	const entries: MailboxEntry[] = [
		{
			id: null,
			key: OWN_KEY,
			name: "My mailbox",
			address: own?.address ?? null,
			kind: "personal",
			service: own?.service ?? false,
		},
		...others.map((mailbox) => ({
			id: mailbox.id,
			key: mailbox.id,
			name: mailbox.display_name,
			address: mailbox.address,
			kind: mailbox.kind,
			service: mailbox.service,
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
			service: false,
		});
	}
	return entries;
}

/** What the person can do in the open mailbox, other than read it. */
export interface MailboxRights {
	/** Change the mailbox: labels, the read state, archive, trash and stars (`mail.modify`). */
	modify: boolean;
	/** Send from the address of the mailbox (`mail.send`). */
	send: boolean;
}

/**
 * The rights of the person in a mailbox of the mail views. `mailboxId` is null for the own mailbox, where
 * the person has each right. In the mailbox of an agent, an owner or an admin has none. In a shared (team)
 * mailbox, the scopes of the membership decide. A mailbox that is not in the list yet has each right, so
 * the views do not hide an action while the list loads: the server refuses a call without its scope.
 */
export function mailboxRights(mailboxes: readonly Mailbox[] | null, mailboxId: string | null): MailboxRights {
	if (mailboxId === null) return { modify: true, send: true };
	if (isAgentMailbox(mailboxId)) return { modify: false, send: false };
	const listed = mailboxes?.find((mailbox) => mailbox.id === mailboxId);
	if (!listed) return { modify: true, send: true };
	return { modify: listed.scopes.includes("mail.modify"), send: listed.scopes.includes("mail.send") };
}

/**
 * The text of the notice above the list of a mailbox with fewer rights, or null with each right. The
 * mailbox of an agent has its own notice.
 */
export function rightsNotice(rights: MailboxRights): string | null {
	if (rights.modify && rights.send) return null;
	if (rights.modify) return "You can read and change this shared mailbox. You cannot send from it.";
	if (rights.send) {
		return "You can read this shared mailbox and send from it. You cannot change it, and the conversations that you open stay unread.";
	}
	return "You can read this shared mailbox. You cannot change it or send from it, and the conversations that you open stay unread.";
}

/**
 * The default mailbox of the person, from the saved `default_mailbox_id`: the id of a team mailbox, or
 * null for the own mailbox. A saved team mailbox is the default only while the person can read it: a
 * removed membership, or a membership without `mail.read`, gives the own mailbox. The mailbox of an agent
 * is never a default.
 */
export function defaultMailboxId(saved: string | null, mailboxes: readonly Mailbox[]): string | null {
	const listed = mailboxes.find((mailbox) => mailbox.id === saved);
	return listed?.kind === "team" && listed.scopes.includes("mail.read") ? listed.id : null;
}

/** The path that Mail opens first: the inbox of the default mailbox of the person (`defaultMailboxId`). */
export function mailHomePath(saved: string | null, mailboxes: readonly Mailbox[]): string {
	const id = defaultMailboxId(saved, mailboxes);
	return id === null ? INBOX_PATH : viewPath({ kind: "system", view: "inbox" }, id);
}
