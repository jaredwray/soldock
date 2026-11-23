import { type CallContext, isTeamMailboxId, teamMailboxesOf } from "../identity/index.ts";
import type { ResourceWatcher, WatcherMap } from "../platform/index.ts";
import { mailboxStub } from "./delivery.ts";
import { INBOX_SIGNAL } from "./mailbox.ts";

/**
 * The change feed of the `mail.inbox` resource. A caller can watch its own mailbox and each team
 * mailbox that it is a member of with `mail.read`. One query reads all team mailboxes of the caller. An owner or an
 * admin can read the mailbox of an agent, but cannot watch it: a watch would tell when the agent gets
 * mail, without the audit line of a read. The feed is a watch socket to the `MailboxDO`, which sends a
 * signal for each new message in its inbox and can sleep while the socket waits.
 */
const inboxWatcher: ResourceWatcher<CallContext> = {
	async allowed(call, resources) {
		const ids = resources.map((vars) => vars.mailbox_id);
		const own = (id: string | undefined) => id === call.caller.id;
		// A watch tells when mail arrives, so the membership needs mail.read, as a read of the inbox does.
		const teams = ids.some((id) => id !== undefined && !own(id) && isTeamMailboxId(id))
			? new Set(
					(await teamMailboxesOf(call.env.DIRECTORY, call.caller.id))
						.filter((mailbox) => mailbox.scopes.includes("mail.read"))
						.map((mailbox) => mailbox.id),
				)
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
