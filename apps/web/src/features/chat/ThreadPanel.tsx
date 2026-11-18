import { CHAT_LIMITS, type ChatBody, type ChatMessage } from "@soldock/contracts";
import { useEffect, useId, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { fullDate, initials, plural, shortDate } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { ChatComposer, type ChatComposerHandle } from "./ChatComposer.tsx";
import { bodyText } from "./composerSchema.ts";
import type { MessageWatch } from "./data.ts";
import { MessageBody } from "./MessageBody.tsx";
import type { MentionContext } from "./mentions.ts";
import { inThread, mergeThread, type ThreadState } from "./thread.ts";

type LoadState = { status: "loading" } | { status: "ready"; thread: ThreadState } | { status: "error"; error: string };

/** The parent and each reply of a thread: all pages of `chat.list_replies`. */
async function readThread(roomId: string, parentId: string): Promise<ThreadState> {
	const input = { room_id: roomId, message_id: parentId, limit: CHAT_LIMITS.pageSize };
	let page = await api.call("chat.list_replies", input);
	// The changes after the first page come with the next catch-up, so the thread keeps its version.
	const version = page.version;
	const replies = [...page.replies];
	while (page.has_more) {
		const last = replies[replies.length - 1];
		if (!last) break;
		page = await api.call("chat.list_replies", { ...input, after: last.seq });
		replies.push(...page.replies);
	}
	return { parent: page.parent, replies, version };
}

/**
 * The messages of a thread that changed after `version`, with the parent, and the version to keep. A
 * page that is not the last one continues from the version of its last reply.
 */
async function threadChanges(
	roomId: string,
	parentId: string,
	version: number,
): Promise<{ messages: ChatMessage[]; version: number }> {
	const messages: ChatMessage[] = [];
	let after = version;
	for (;;) {
		const page = await api.call("chat.list_replies", { room_id: roomId, message_id: parentId, changed_after: after });
		messages.push(page.parent, ...page.replies);
		const last = page.replies[page.replies.length - 1];
		if (!page.has_more || !last) return { messages, version: page.version };
		after = last.version;
	}
}

/**
 * The view of one thread, beside the messages of the room: the message that starts it, its replies, and
 * a box for a reply. The socket of the room brings each change (`watch`). After a new connect, the view
 * reads what changed while it had no socket.
 */
export function ThreadPanel({
	roomId,
	roomTitle,
	parentId,
	mentions,
	watch,
	onSentToRoom,
	onClose,
}: {
	roomId: string;
	roomTitle: string;
	parentId: string;
	mentions: MentionContext;
	watch: (listener: (event: MessageWatch) => void) => () => void;
	/** Gets a reply that also went to the room, so the room list shows it at once. */
	onSentToRoom: (message: ChatMessage) => void;
	onClose: () => void;
}) {
	const [state, setState] = useState<LoadState>({ status: "loading" });
	const [draft, setDraft] = useState<ChatBody | null>(null);
	const [alsoInRoom, setAlsoInRoom] = useState(false);
	const [sending, setSending] = useState(false);
	const [sendError, setSendError] = useState<string | null>(null);
	const composer = useRef<ChatComposerHandle>(null);
	const boxId = useId();
	const headingId = useId();

	useEffect(() => {
		let alive = true;
		/** The thread of the last load or catch-up, for a catch-up that starts later. */
		let current: ThreadState | null = null;
		const merge = (messages: readonly ChatMessage[], version?: number) =>
			setState((shown) => {
				if (shown.status !== "ready") return shown;
				const merged = mergeThread(shown.thread, messages);
				const next = version !== undefined && version > merged.version ? { ...merged, version } : merged;
				current = next;
				return next === shown.thread ? shown : { status: "ready", thread: next };
			});
		setState({ status: "loading" });
		readThread(roomId, parentId).then(
			(thread) => {
				if (!alive) return;
				current = thread;
				setState({ status: "ready", thread });
			},
			(error: unknown) => {
				if (alive) setState({ status: "error", error: errorMessage(error) });
			},
		);
		const stop = watch((event) => {
			if (event.type === "message") {
				if (inThread(event.message, parentId)) merge([event.message]);
				return;
			}
			// A new connect: the socket did not bring the changes of the gap.
			const since = current?.version;
			if (since === undefined) return;
			threadChanges(roomId, parentId, since).then(
				(changes) => {
					if (alive) merge(changes.messages, changes.version);
				},
				() => {
					// The next connect tries again.
				},
			);
		});
		return () => {
			alive = false;
			stop();
		};
	}, [roomId, parentId, watch]);

	async function send() {
		if (!draft || sending || state.status !== "ready") return;
		if (bodyText(draft).length > CHAT_LIMITS.messageChars) return;
		setSending(true);
		setSendError(null);
		try {
			const { message } = await api.call("chat.post_message", {
				room_id: roomId,
				parent_id: parentId,
				body: draft,
				...(alsoInRoom ? { also_in_room: true } : {}),
			});
			setState((shown) =>
				shown.status === "ready" ? { status: "ready", thread: mergeThread(shown.thread, [message]) } : shown,
			);
			if (message.also_in_room) onSentToRoom(message);
			composer.current?.clear();
			setDraft(null);
			setAlsoInRoom(false);
		} catch (error) {
			// The box keeps the reply, so the person can send it again.
			setSendError(errorMessage(error));
		} finally {
			setSending(false);
		}
	}

	return (
		<aside className="chat-thread" aria-labelledby={headingId}>
			<header className="chat-thread-header">
				<h2 id={headingId}>Thread</h2>
				<span className="chat-thread-room">{roomTitle}</span>
				<button type="button" className="icon-button" aria-label="Close the thread" title="Close" onClick={onClose}>
					<Icon name="close" size={18} />
				</button>
			</header>
			{state.status === "loading" && (
				<p className="list-state" role="status">
					Loading the thread…
				</p>
			)}
			{state.status === "error" && (
				<p className="list-state" role="alert">
					{state.error}
				</p>
			)}
			{state.status === "ready" && (
				<>
					<div className="chat-thread-body">
						<ThreadMessage message={state.thread.parent} mentions={mentions} />
						<p className="chat-thread-count">
							{state.thread.replies.length === 0
								? "No replies yet"
								: plural(state.thread.replies.length, "reply", "replies")}
						</p>
						<ol className="chat-thread-replies" role="log" aria-label="Replies">
							{state.thread.replies.map((reply) => (
								<li key={reply.id}>
									<ThreadMessage message={reply} mentions={mentions} />
								</li>
							))}
						</ol>
					</div>
					<form
						className="chat-thread-composer"
						onSubmit={(event) => {
							event.preventDefault();
							void send();
						}}
					>
						<div className="chat-composer-box">
							<ChatComposer
								ref={composer}
								id={boxId}
								label="Reply in the thread"
								placeholder="Reply…"
								initial={null}
								onChange={setDraft}
								onSubmit={() => void send()}
								onCancel={onClose}
								mentions={mentions}
								placement="above"
								autofocus
							>
								<button
									type="submit"
									className="chat-send"
									aria-label="Send the reply"
									title="Send (Enter)"
									disabled={!draft || sending}
								>
									<Icon name="arrowUp" size={18} />
								</button>
							</ChatComposer>
						</div>
						<label className="chat-thread-also">
							<input type="checkbox" checked={alsoInRoom} onChange={(event) => setAlsoInRoom(event.target.checked)} />
							Also send to {roomTitle}
						</label>
						{sendError && (
							<p className="chat-send-failed" role="alert">
								Not sent. {sendError}
							</p>
						)}
					</form>
				</>
			)}
		</aside>
	);
}

/** One message of the thread: its author, its time and its body. */
function ThreadMessage({ message, mentions }: { message: ChatMessage; mentions: MentionContext }) {
	const author = message.author.display_name;
	return (
		<article className="chat-thread-message">
			<span
				className={message.author.kind === "agent" ? "chat-avatar chat-avatar-agent" : "chat-avatar"}
				aria-hidden="true"
			>
				{initials(author)}
			</span>
			<div>
				<p className="chat-message-meta">
					<strong className="chat-author">{author}</strong>
					{message.author.kind === "agent" && <span className="kind kind-agent">agent</span>}
					<time className="chat-time" dateTime={message.created_at} title={fullDate(message.created_at)}>
						{shortDate(message.created_at)}
					</time>
				</p>
				{message.deleted ? (
					<p className="chat-text chat-text-deleted">This message was deleted.</p>
				) : (
					<div className="chat-text">
						<MessageBody body={message.body} text={message.text} mentions={mentions} />
						{message.edited_at && (
							<span className="chat-edited" title={fullDate(message.edited_at)}>
								(edited)
							</span>
						)}
					</div>
				)}
			</div>
		</article>
	);
}
