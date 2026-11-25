import { createContext, useContext } from "react";
import type { MailboxRights } from "./mailboxNav.ts";

/**
 * The mailbox of the mail views: the id of a team mailbox, the id of an agent whose mailbox an owner or
 * an admin reads, or null for the own mailbox of the person.
 * Each mail call and each mail link below `MailApp` reads it, so a view never mixes two mailboxes.
 */
const MailboxContext = createContext<string | null>(null);

export const MailboxProvider = MailboxContext.Provider;

export function useMailboxId(): string | null {
	return useContext(MailboxContext);
}

/** The rights of the person in the mailbox of the mail views (`mailboxRights`). The own mailbox has each one. */
const MailboxRightsContext = createContext<MailboxRights>({ modify: true, send: true });

export const MailboxRightsProvider = MailboxRightsContext.Provider;

export function useMailboxRights(): MailboxRights {
	return useContext(MailboxRightsContext);
}

/**
 * True when the person cannot change the mailbox: the mailbox of an agent, which an owner or an admin can
 * only read, or a shared mailbox where the membership has no `mail.modify`. The views then show no action
 * that changes the mailbox, and an open thread stays unread.
 */
export function useReadOnlyMailbox(): boolean {
	return !useMailboxRights().modify;
}

/** The `mailbox_id` field of a mail operation. Without it, the operation uses the own mailbox. */
export function mailboxInput(mailboxId: string | null): { mailbox_id?: string } {
	return mailboxId ? { mailbox_id: mailboxId } : {};
}
