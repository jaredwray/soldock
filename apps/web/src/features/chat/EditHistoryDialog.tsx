import type { ChatMessage, ChatMessageEdit } from "@soldock/contracts";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { Dialog } from "../../lib/Dialog.tsx";
import { fullDate } from "../../lib/format.ts";
import { MessageBody } from "./MessageBody.tsx";
import type { MentionContext } from "./mentions.ts";

type State = { status: "loading" } | { status: "ready"; edits: ChatMessageEdit[] } | { status: "error"; error: string };

/**
 * The earlier versions of a message, for an owner or an admin of the organization
 * (`chat.list_message_edits`). The oldest version comes first, and the current text comes last.
 */
export function EditHistoryDialog({
	roomId,
	message,
	mentions,
	onClose,
}: {
	roomId: string;
	message: ChatMessage;
	mentions: MentionContext;
	onClose: () => void;
}) {
	const [state, setState] = useState<State>({ status: "loading" });

	useEffect(() => {
		let active = true;
		api.call("chat.list_message_edits", { room_id: roomId, message_id: message.id }).then(
			(result) => {
				if (active) setState({ status: "ready", edits: result.edits });
			},
			(error: unknown) => {
				if (active) setState({ status: "error", error: errorMessage(error) });
			},
		);
		return () => {
			active = false;
		};
	}, [roomId, message.id]);

	return (
		<Dialog
			title="Earlier versions"
			description="Owners and admins of the organization can read the text of a message before each edit."
			onClose={onClose}
		>
			{state.status === "loading" && (
				<p className="list-state" role="status">
					Loading…
				</p>
			)}
			{state.status === "error" && <p role="alert">{state.error}</p>}
			{state.status === "ready" && (
				<ol className="chat-edit-history">
					{state.edits.length === 0 && (
						<li className="list-state">The room kept no earlier version of this message.</li>
					)}
					{state.edits.map((edit) => (
						<li key={edit.version} className="chat-edit-version">
							<p className="chat-edit-time">
								<time dateTime={edit.written_at}>{fullDate(edit.written_at)}</time>
							</p>
							<div className="chat-text">
								<MessageBody body={edit.body} text={edit.text} mentions={mentions} />
							</div>
						</li>
					))}
					<li className="chat-edit-version chat-edit-current">
						<p className="chat-edit-time">
							Now, since{" "}
							<time dateTime={message.edited_at ?? message.created_at}>
								{fullDate(message.edited_at ?? message.created_at)}
							</time>
						</p>
						<div className="chat-text">
							<MessageBody body={message.body} text={message.text} mentions={mentions} />
						</div>
					</li>
				</ol>
			)}
		</Dialog>
	);
}
