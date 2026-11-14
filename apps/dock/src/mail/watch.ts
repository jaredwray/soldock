import type { CallContext } from "../identity/index.ts";
import { OperationError, type ResourceWatcher, type WatcherMap } from "../platform/index.ts";
import { mailboxStub } from "./delivery.ts";
import { openMailbox } from "./handlers.ts";
import { INBOX_SIGNAL } from "./mailbox.ts";

/** True when the caller can use the mailbox: the same check as each mail operation. */
async function canUse(call: CallContext, mailboxId: string | undefined): Promise<boolean> {
	if (mailboxId === undefined) return false;
	try {
		await openMailbox(call, mailboxId);
		return true;
	} catch (error) {
		if (error instanceof OperationError) return false;
		throw error;
	}
}

/**
 * The change feed of the `mail.inbox` resource. It opens a watch socket to the `MailboxDO`, after
 * the same access check as each mail operation. The mailbox sends a signal for each new message in
 * its inbox, and it can sleep while the socket waits.
 */
const inboxWatcher: ResourceWatcher<CallContext> = {
	allowed: (call, vars) => canUse(call, vars.mailbox_id),

	async open(call, vars, listener) {
		const mailboxId = vars.mailbox_id;
		if (mailboxId === undefined || !(await canUse(call, mailboxId))) return null;
		const response = await mailboxStub(call.env, mailboxId).fetch("https://mailbox.internal/watch", {
			headers: { upgrade: "websocket" },
		});
		const socket = response.webSocket;
		if (!socket) throw new Error(`The mailbox refused the watch socket with status ${response.status}.`);
		socket.accept();
		let closed = false;
		const ended = () => {
			if (closed) return;
			closed = true;
			listener.end();
		};
		socket.addEventListener("message", (event) => {
			if (!closed && event.data === INBOX_SIGNAL) listener.change();
		});
		socket.addEventListener("close", ended);
		socket.addEventListener("error", ended);
		return {
			close() {
				if (closed) return;
				closed = true;
				try {
					socket.close(1000, "The subscription ended.");
				} catch {
					// Closed already.
				}
			},
		};
	},
};

export const mailWatchers: Pick<WatcherMap<CallContext>, "mail.inbox"> = { "mail.inbox": inboxWatcher };
