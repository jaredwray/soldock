import { CHAT_LIMITS, type ChatBody, type ChatMessage } from "@asterra/contracts";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { fullDate, initials, plural, shortDate } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { ChatComposer, type ChatComposerHandle } from "./ChatComposer.tsx";
import { bodyText } from "./composerSchema.ts";
import type { MessageWatch } from "./data.ts";
import { MessageBody } from "./MessageBody.tsx";
import type { MentionContext } from "./mentions.ts";
import {
	createThreadView,
	inThread,
	type ReplyAttempt,
	replyAttempt,
	type ThreadState,
	type ThreadView,
} from "./thread.ts";

type LoadState = { status: "loading" } | { status: "ready"; thread: ThreadState } | { status: "error"; error: string };

/** The distance from the end of the replies, in pixels, under which a new reply moves the list to its end. */
const STICK_PX = 80;

/**
 * The view of one thread, beside the messages of the room: the message that starts it, its replies, and
 * a box for a reply. The socket of the room brings each change (`watch`), and `createThreadView` keeps
 * the thread: a change during the load, and the changes of a gap after a new connect, show too.
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
	/** The body in the box now, for the end of a send: text typed during the send stays. */
	const draftNow = useRef<ChatBody | null>(null);
	const changeDraft = useCallback((next: ChatBody | null) => {
		draftNow.current = next;
		setDraft(next);
	}, []);
	const [alsoInRoom, setAlsoInRoom] = useState(false);
	const [sending, setSending] = useState(false);
	const [sendError, setSendError] = useState<string | null>(null);
	/** The last send that got no answer: a second send of the same reply posts it one time. */
	const lastAttempt = useRef<ReplyAttempt | null>(null);
	const composer = useRef<ChatComposerHandle>(null);
	const body = useRef<HTMLDivElement>(null);
	/** True when the list shows its end, or after an own send: the next reply then moves the list to its end. */
	const stick = useRef(true);
	const view = useRef<ThreadView | null>(null);
	const retry = useRef<HTMLButtonElement>(null);
	const boxId = useId();
	const headingId = useId();

	const load = useCallback(() => {
		const current = view.current;
		if (!current) return;
		setState({ status: "loading" });
		current.load().catch((error: unknown) => {
			if (view.current === current) setState({ status: "error", error: errorMessage(error) });
		});
	}, []);

	useEffect(() => {
		const thread = createThreadView(
			(range) => api.call("chat.list_replies", { room_id: roomId, message_id: parentId, ...range }),
			(next) => {
				if (view.current === thread) setState({ status: "ready", thread: next });
			},
		);
		view.current = thread;
		// The watch starts before the load, so a change during the load waits in the view and is not lost.
		const stop = watch((event) => {
			if (event.type === "catch-up") thread.catchUp(event.roomVersion);
			else if (inThread(event.message, parentId)) thread.receive(event.message);
		});
		load();
		return () => {
			view.current = null;
			stop();
		};
	}, [roomId, parentId, watch, load]);

	// The focus goes to the one action of an error, so a keyboard can try again at once.
	useEffect(() => {
		if (state.status === "error") retry.current?.focus();
	}, [state.status]);

	// A new reply moves the list to its end when the list showed its end.
	const replyCount = state.status === "ready" ? state.thread.replies.length : 0;
	useLayoutEffect(() => {
		const element = body.current;
		if (element && replyCount > 0 && stick.current) element.scrollTop = element.scrollHeight;
	}, [replyCount]);

	/** Closes the view, unless the box has a reply: one key must not delete a reply. */
	const closeUnlessTyped = () => {
		if (draft === null) onClose();
	};

	/** The characters of the reply above the limit of a message, or 0. */
	const replyOver = draft ? Math.max(0, bodyText(draft).length - CHAT_LIMITS.messageChars) : 0;

	async function send() {
		const thread = view.current?.current();
		if (!draft || sending || !thread || thread.parent.deleted || replyOver > 0) return;
		const sent = draft;
		const attempt = replyAttempt(lastAttempt.current, JSON.stringify({ body: sent, alsoInRoom }), () =>
			crypto.randomUUID(),
		);
		lastAttempt.current = attempt;
		setSending(true);
		setSendError(null);
		try {
			const { message } = await api.call("chat.post_message", {
				room_id: roomId,
				parent_id: parentId,
				body: sent,
				idempotency_key: attempt.key,
				...(alsoInRoom ? { also_in_room: true } : {}),
			});
			view.current?.receive(message);
			if (message.also_in_room) onSentToRoom(message);
			lastAttempt.current = null;
			stick.current = true;
			setAlsoInRoom(false);
			// Text that the person typed during the send stays in the box.
			if (draftNow.current === sent) {
				composer.current?.clear();
				changeDraft(null);
			}
		} catch (error) {
			// The box keeps the reply. A second send of the same reply keeps the key, so it posts one time.
			setSendError(errorMessage(error));
		} finally {
			setSending(false);
		}
	}

	const thread = state.status === "ready" ? state.thread : null;
	return (
		<aside
			className="chat-thread"
			aria-labelledby={headingId}
			onKeyDown={(event) => {
				if (event.key === "Escape" && !event.defaultPrevented) {
					event.preventDefault();
					closeUnlessTyped();
				}
			}}
		>
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
				<div className="list-state" role="alert">
					<p>{state.error}</p>
					<button type="button" className="button" onClick={load} ref={retry}>
						Try again
					</button>
				</div>
			)}
			{thread && (
				<>
					<div
						className="chat-thread-body"
						ref={body}
						onScroll={(event) => {
							const element = event.currentTarget;
							stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_PX;
						}}
					>
						<ThreadMessage message={thread.parent} mentions={mentions} />
						<p className="chat-thread-count">
							{thread.replies.length === 0 ? "No replies yet" : plural(thread.replies.length, "reply", "replies")}
						</p>
						<div role="log" aria-label="Replies">
							<ol className="chat-thread-replies">
								{thread.replies.map((reply) => (
									<li key={reply.id}>
										<ThreadMessage message={reply} mentions={mentions} />
									</li>
								))}
							</ol>
						</div>
					</div>
					{thread.parent.deleted ? (
						<p className="chat-thread-closed">The message was deleted, so the thread takes no new reply.</p>
					) : (
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
									onChange={changeDraft}
									onSubmit={() => void send()}
									onCancel={closeUnlessTyped}
									mentions={mentions}
									placement="above"
									autofocus
								>
									<button
										type="submit"
										className="chat-send"
										aria-label="Send the reply"
										title="Send (Enter)"
										disabled={!draft || sending || replyOver > 0}
									>
										<Icon name="arrowUp" size={18} />
									</button>
								</ChatComposer>
							</div>
							{replyOver > 0 && (
								<p className="chat-composer-limit" role="status">
									The reply has {plural(replyOver, "character")} more than the limit of{" "}
									{CHAT_LIMITS.messageChars.toLocaleString()}.
								</p>
							)}
							<label className="chat-thread-also">
								<input type="checkbox" checked={alsoInRoom} onChange={(event) => setAlsoInRoom(event.target.checked)} />
								Also send to {roomTitle}
							</label>
							{sendError && (
								<p className="chat-send-failed" role="alert">
									Not sent. {sendError} Press Enter to send it again.
								</p>
							)}
						</form>
					)}
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
