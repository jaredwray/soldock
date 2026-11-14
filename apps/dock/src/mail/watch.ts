import { type CallContext, isTeamMailboxId, teamMailboxesOf } from "../identity/index.ts";
import type { ResourceWatcher, WatcherMap } from "../platform/index.ts";
import { mailboxStub } from "./delivery.ts";
import { INBOX_SIGNAL } from "./mailbox.ts";

/**
 * The change feed of the `mail.inbox` resource. The access rule is the rule of each mail operation:
 * the own mailbox of the caller, or a team mailbox that the caller is a member of. One query reads
 * all team mailboxes of the caller. The feed is a watch socket to the `MailboxDO`, which sends a
 * signal for each new message in its inbox and can sleep while the socket waits.
 */
const inboxWatcher: ResourceWatcher<CallContext> = {
	async allowed(call, resources) {
		const ids = resources.map((vars) => vars.mailbox_id);
		const own = (id: string | undefined) => id === call.caller.id;
		const teams = ids.some((id) => id !== undefined && !own(id) && isTeamMailboxId(id))
			? new Set((await teamMailboxesOf(call.env.DIRECTORY, call.caller.id)).map((mailbox) => mailbox.id))
			: new Set<string>();
		return ids.map((id) => id !== undefined && (own(id) || teams.has(id)));
	},

	async open(call, vars, listener) {
		const response = await mailboxStub(call.env, vars.mailbox_id as string).fetch("https://mailbox.internal/watch", {
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
