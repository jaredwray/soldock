import { createContext, useContext } from "react";
import { isAgentMailbox } from "../../routes.ts";

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

/**
 * True in the mailbox of an agent. An owner or an admin can read it, and nothing more: the views show
 * no action that changes the mailbox or sends from it, and an open thread stays unread for the agent.
 */
export function useReadOnlyMailbox(): boolean {
	return isAgentMailbox(useMailboxId());
}

/** The `mailbox_id` field of a mail operation. Without it, the operation uses the own mailbox. */
export function mailboxInput(mailboxId: string | null): { mailbox_id?: string } {
	return mailboxId ? { mailbox_id: mailboxId } : {};
}
