import { createContext, useContext } from "react";

/**
 * The mailbox of the mail views: the id of a team mailbox, or null for the own mailbox of the person.
 * Each mail call and each mail link below `MailApp` reads it, so a view never mixes two mailboxes.
 */
const MailboxContext = createContext<string | null>(null);

export const MailboxProvider = MailboxContext.Provider;

export function useMailboxId(): string | null {
	return useContext(MailboxContext);
}

/** The `mailbox_id` field of a mail operation. Without it, the operation uses the own mailbox. */
export function mailboxInput(mailboxId: string | null): { mailbox_id?: string } {
	return mailboxId ? { mailbox_id: mailboxId } : {};
}
