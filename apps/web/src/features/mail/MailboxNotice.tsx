import { Icon } from "../../lib/icons.tsx";
import { isAgentMailbox } from "../../routes.ts";
import { useMailboxId, useMailboxRights } from "./mailbox.tsx";
import { rightsNotice } from "./mailboxNav.ts";

/**
 * The notice above the conversations of a mailbox that the person cannot fully use: the mailbox of an agent,
 * which an owner or an admin can only read, or a shared mailbox whose membership lacks a scope. Nothing in a
 * mailbox that the person can fully use.
 */
export function MailboxNotice() {
	const mailboxId = useMailboxId();
	const notice = rightsNotice(useMailboxRights());
	if (isAgentMailbox(mailboxId)) {
		return (
			<p className="notice read-only-notice">
				<Icon name="eye" size={18} />
				<span>
					<strong>Read only.</strong> This is the mailbox of an agent. As an owner or an admin, you can read it. You
					cannot change it or send from it, and the conversations that you open stay unread for the agent. The audit log
					records the lists and the conversations that you open.
				</span>
			</p>
		);
	}
	if (!notice) return null;
	return (
		<p className="notice read-only-notice">
			<Icon name="eye" size={18} />
			<span>{notice} An owner or an admin sets what each member can do.</span>
		</p>
	);
}
