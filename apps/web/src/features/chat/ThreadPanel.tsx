import { ApiError, CHAT_LIMITS, type ChatBody, type ChatMessage, type ChatThreadFollow } from "@asterra/contracts";
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { fullDate, initials, plural, shortDate } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { useToast } from "../../lib/toast.tsx";
import { useSession } from "../auth/session.tsx";
import { canSendWith, filesNote } from "./attachments.ts";
import { ChatComposer, type ChatComposerHandle } from "./ChatComposer.tsx";
import { AttachButton, AttachmentChips } from "./ComposerFiles.tsx";
import { bodyText } from "./composerSchema.ts";
import { type MessageWatch, newAttachments, useAttachments, usePageVisible } from "./data.ts";
import { useFileDrop } from "./fileDrop.ts";
import { MessageBody } from "./MessageBody.tsx";
import { LinkPreviews, MessageFiles } from "./MessageFiles.tsx";
import type { MentionContext } from "./mentions.ts";
import {
	createFollowKeeper,
	createThreadView,
	type FollowKeeper,
	firstUnread,
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
 *
 * The header has the follow of the person (`chat.follow_thread`). While the view shows and the page is
 * visible, the view moves the read marker of the thread to the newest reply (`chat.mark_thread_read`). A
 * "New" line marks the first reply that was new when the view opened.
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
	/**
	 * The files of the reply sends whose answer did not come: the room can have stored a reply with them. A
	 * later refusal, also of a send with a different key, never puts them in the trash.
	 */
	const uncertainFiles = useRef(new Set<string>());
	const composer = useRef<ChatComposerHandle>(null);
	const body = useRef<HTMLDivElement>(null);
	/** True when the list shows its end, or after an own send: the next reply then moves the list to its end. */
	const stick = useRef(true);
	const view = useRef<ThreadView | null>(null);
	const retry = useRef<HTMLButtonElement>(null);
	const boxId = useId();
	const headingId = useId();
	const ownId = useSession().whoami.principal.id;
	const visible = usePageVisible();
	const toast = useToast();
	// The files of the reply. They go away with the view: an upload that runs stops, and a file that is in
	// the drive goes to the trash, as for a reply that the person did not send. A file of a send never goes
	// to the trash (`take`): the room can have the reply, also when its answer did not arrive.
	const attachments = useMemo(() => newAttachments(roomId), [roomId]);
	const files = useAttachments(attachments);
	useEffect(
		() => () => {
			attachments.removeAll();
		},
		[attachments],
	);
	const addFiles = useCallback(
		(added: File[], folders: readonly string[] = []) => {
			if (folders.length > 0) {
				toast({ message: "A folder cannot go into a message. Drop the files that are in it.", tone: "error" });
			}
			attachments.add(added);
		},
		[attachments, toast],
	);
	/** True while the person drags files over the view of the thread. */
	const dropping = useFileDrop("thread", addFiles);
	/** The state of the thread for the person, as the keeper has it. Null before the first read. */
	const [follow, setFollow] = useState<ChatThreadFollow | null>(null);
	/** Keeps the follow and the marker apart, so an older answer never hides an own change (`createFollowKeeper`). */
	const keeper = useRef<FollowKeeper | null>(null);
	const [followBusy, setFollowBusy] = useState(false);
	const [followError, setFollowError] = useState<string | null>(null);
	/** The seq of the first new reply when the view opened, for the "New" line. Undefined before the first read. */
	const [newFrom, setNewFrom] = useState<number | null | undefined>(undefined);
	/** True while a call of `chat.mark_thread_read` runs. */
	const marking = useRef(false);

	const load = useCallback(() => {
		const current = view.current;
		if (!current) return;
		setState({ status: "loading" });
		current.load().catch((error: unknown) => {
			if (view.current === current) setState({ status: "error", error: errorMessage(error) });
		});
	}, []);

	useEffect(() => {
		const follows = createFollowKeeper((next) => {
			if (keeper.current === follows) setFollow(next);
		});
		keeper.current = follows;
		const thread = createThreadView(
			(range) => {
				const ticket = follows.ticket();
				return api.call("chat.list_replies", { room_id: roomId, message_id: parentId, ...range }).then((page) => {
					follows.apply(ticket, page.follow);
					return page;
				});
			},
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
			keeper.current = null;
			stop();
		};
	}, [roomId, parentId, watch, load]);

	/**
	 * Reads the state of the thread again, after an own call whose answer lost its part to an own reply. The
	 * read starts after both, so it has the order of the server.
	 */
	const readFollowAgain = useCallback(() => {
		const follows = keeper.current;
		if (!follows) return;
		const ticket = follows.ticket();
		api
			.call("chat.list_replies", { room_id: roomId, message_id: parentId, limit: 1 })
			.then((page) => follows.apply(ticket, page.follow))
			// The next read of the thread brings the state.
			.catch(() => {});
	}, [roomId, parentId]);

	// The read marker: the first state of the thread fixes the "New" line. Then, while the view shows on a
	// visible page, each new reply of a different principal moves the marker to the newest reply.
	const shownThread = state.status === "ready" ? state.thread : null;
	useEffect(() => {
		if (!shownThread || !follow) return;
		const unread = firstUnread(shownThread.replies, follow.last_read_seq, ownId);
		if (newFrom === undefined) {
			setNewFrom(unread);
			return;
		}
		const follows = keeper.current;
		const newest = shownThread.replies[shownThread.replies.length - 1];
		if (unread === null || !newest || !follows || !visible || marking.current) return;
		marking.current = true;
		const ticket = follows.begin("marker");
		// The marker goes to the newest reply that shows, not to the newest reply of the server: a reply whose
		// socket event is late stays new.
		api
			.call("chat.mark_thread_read", { room_id: roomId, message_id: parentId, seq: newest.seq })
			.then((result) => {
				if (follows.finish(ticket, "marker", result.follow)) readFollowAgain();
			})
			// The marker stays where it was. The next reply, or the next visible moment, tries again.
			.catch(() => follows.finish(ticket, "marker", null))
			.finally(() => {
				marking.current = false;
			});
	}, [shownThread, follow, newFrom, visible, ownId, roomId, parentId, readFollowAgain]);

	async function toggleFollow() {
		const follows = keeper.current;
		if (!follow || !follows || followBusy) return;
		setFollowBusy(true);
		setFollowError(null);
		const ticket = follows.begin("following");
		try {
			const result = await api.call("chat.follow_thread", {
				room_id: roomId,
				message_id: parentId,
				following: !follow.following,
			});
			if (follows.finish(ticket, "following", result.follow)) readFollowAgain();
		} catch (error) {
			follows.finish(ticket, "following", null);
			setFollowError(errorMessage(error));
		} finally {
			setFollowBusy(false);
		}
	}

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

	/** Gives the focus to the box of the reply. */
	const focusBox = useCallback(() => composer.current?.focus(), []);

	/** Keeps the list at its end when a picture or a video gets its size, if the list showed its end. */
	const keepEnd = useCallback(() => {
		const element = body.current;
		if (element && stick.current) element.scrollTop = element.scrollHeight;
	}, []);

	/** Closes the view, unless the box has a reply or files: one key must not delete a reply. */
	const closeUnlessTyped = () => {
		if (draft === null && files.list.length === 0) onClose();
	};

	/** The characters of the reply above the limit of a message, or 0. */
	const replyOver = draft ? Math.max(0, bodyText(draft).length - CHAT_LIMITS.messageChars) : 0;
	/** True when the reply has text or files, and each file is in the drive. */
	const canSend = canSendWith(draft !== null, files.list) && replyOver === 0;

	/** Removes the preview of a link of an own reply. The link stays in the text. */
	function removePreview(id: string, url: string) {
		api.call("chat.remove_link_preview", { room_id: roomId, message_id: id, url }).then(
			({ message }) => view.current?.receive(message),
			(error: unknown) => toast({ message: errorMessage(error), tone: "error" }),
		);
	}

	async function send() {
		const thread = view.current?.current();
		if (!canSend || sending || !thread || thread.parent.deleted) return;
		const sent = draft;
		// Each file is in the drive. The files stay in the box until the room has the reply, and from now on
		// nothing puts them in the trash.
		const sentFiles = attachments.take() ?? [];
		const fileIds = sentFiles.map((file) => file.item_id);
		const attempt = replyAttempt(lastAttempt.current, JSON.stringify({ body: sent, alsoInRoom, fileIds }), () =>
			crypto.randomUUID(),
		);
		lastAttempt.current = attempt;
		setSending(true);
		setSendError(null);
		try {
			const { message } = await api.call("chat.post_message", {
				room_id: roomId,
				parent_id: parentId,
				...(sent ? { body: sent } : {}),
				...(fileIds.length > 0 ? { file_ids: fileIds } : {}),
				idempotency_key: attempt.key,
				...(alsoInRoom ? { also_in_room: true } : {}),
			});
			view.current?.receive(message);
			if (message.also_in_room) onSentToRoom(message);
			// The room makes the author of a reply follow the thread, with its marker at its reply.
			keeper.current?.local((current) => ({
				following: true,
				last_read_seq: Math.max(current.last_read_seq, message.seq),
				unread_count: 0,
			}));
			lastAttempt.current = null;
			stick.current = true;
			setAlsoInRoom(false);
			attachments.release(sentFiles);
			// Text that the person typed during the send stays in the box.
			if (draftNow.current === sent) {
				composer.current?.clear();
				changeDraft(null);
			}
		} catch (error) {
			// The box keeps the reply. A second send of the same reply keeps the key, so it posts one time.
			// A refusal is an answer: that attempt stored nothing. A file that no send with a lost answer took is
			// surely in no reply, so it is part of no send, and a close puts it in the trash. A file of a send
			// with a lost answer stays protected, also after a refusal of a later send with a different key.
			const refused = error instanceof ApiError && error.status < 500;
			if (refused) attachments.unmark(sentFiles.filter((file) => !uncertainFiles.current.has(file.item_id)));
			else for (const file of sentFiles) uncertainFiles.current.add(file.item_id);
			setSendError(errorMessage(error));
		} finally {
			setSending(false);
		}
	}

	const thread = state.status === "ready" ? state.thread : null;
	return (
		<aside
			className={dropping ? "chat-thread chat-thread-drop" : "chat-thread"}
			data-file-drop="thread"
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
				{follow && (
					<button
						type="button"
						className={follow.following ? "button button-small chat-thread-following" : "button button-small"}
						aria-pressed={follow.following}
						title={
							follow.following
								? "You get the new replies of this thread. Click to stop."
								: "Get the new replies of this thread"
						}
						disabled={followBusy}
						onClick={() => void toggleFollow()}
					>
						{follow.following ? "Following" : "Follow"}
					</button>
				)}
				<button type="button" className="icon-button" aria-label="Close the thread" title="Close" onClick={onClose}>
					<Icon name="close" size={18} />
				</button>
			</header>
			{followError && (
				<p className="chat-thread-follow-error" role="alert">
					The follow did not change. {followError}
				</p>
			)}
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
						<ThreadMessage
							message={thread.parent}
							mentions={mentions}
							ownId={ownId}
							onRemovePreview={removePreview}
							onFocusBox={focusBox}
							onMediaLoad={keepEnd}
						/>
						<p className="chat-thread-count">
							{thread.replies.length === 0 ? "No replies yet" : plural(thread.replies.length, "reply", "replies")}
						</p>
						<div role="log" aria-label="Replies">
							<ol className="chat-thread-replies">
								{thread.replies.map((reply) => (
									<Fragment key={reply.id}>
										{reply.seq === newFrom && (
											<li className="chat-new">
												<span>New</span>
											</li>
										)}
										<li className="chat-thread-reply">
											<ThreadMessage
												message={reply}
												mentions={mentions}
												ownId={ownId}
												onRemovePreview={removePreview}
												onFocusBox={focusBox}
												onMediaLoad={keepEnd}
											/>
										</li>
									</Fragment>
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
									onFiles={addFiles}
									mentions={mentions}
									placement="above"
									autofocus
									files={
										<AttachmentChips
											files={files.list}
											notice={files.notice}
											busy={sending}
											onRetry={attachments.retry}
											onRemove={attachments.remove}
											onFocusAway={focusBox}
										/>
									}
								>
									<span className="chat-composer-actions">
										<AttachButton count={files.list.length} onFiles={addFiles} />
										<button
											type="submit"
											className="chat-send"
											aria-label="Send the reply"
											title="Send (Enter)"
											disabled={!canSend || sending}
										>
											<Icon name="arrowUp" size={18} />
										</button>
									</span>
								</ChatComposer>
							</div>
							{filesNote(files.list) !== null && (
								<p className="chat-composer-files-note" role="status">
									{filesNote(files.list)}
								</p>
							)}
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

/**
 * One message of the thread: its author, its time, its body, its files and its link previews. The author
 * removes a link preview with `onRemovePreview` (`linkPreviewCards` decides who sees the X).
 */
function ThreadMessage({
	message,
	mentions,
	ownId,
	onRemovePreview,
	onFocusBox,
	onMediaLoad,
}: {
	message: ChatMessage;
	mentions: MentionContext;
	ownId: string;
	onRemovePreview: (id: string, url: string) => void;
	/** Gives the focus to the box of the reply, after the X of the last link preview. */
	onFocusBox: () => void;
	/** Runs when a picture or a video of the message gets its size. */
	onMediaLoad: () => void;
}) {
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
					<>
						{(message.text !== "" || message.files.length === 0 || message.edited_at) && (
							<div className="chat-text">
								<MessageBody body={message.body} text={message.text} mentions={mentions} />
								{message.edited_at && (
									<span className="chat-edited" title={fullDate(message.edited_at)}>
										(edited)
									</span>
								)}
							</div>
						)}
						<MessageFiles
							files={message.files}
							roomId={message.room_id}
							messageId={message.id}
							pending={false}
							onMediaLoad={onMediaLoad}
						/>
						<LinkPreviews
							message={message}
							ownId={ownId}
							pending={false}
							onRemove={(url) => onRemovePreview(message.id, url)}
							onFocusAway={onFocusBox}
							onMediaLoad={onMediaLoad}
						/>
					</>
				)}
			</div>
		</article>
	);
}
