import { CHAT_LIMITS, type ChatBody, type ChatFile, type ChatMessage } from "@asterra/contracts";
import { useCallback, useId, useRef, useState } from "react";
import { fullDate, initials, plural, shortDate } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { Link } from "../../lib/router.tsx";
import { profilePath } from "../../routes.ts";
import { ChatComposer } from "./ChatComposer.tsx";
import { bodyText } from "./composerSchema.ts";
import { emojiName } from "./emoji.ts";
import { MessageBody } from "./MessageBody.tsx";
import { EditFiles, LinkPreviews, MessageFiles } from "./MessageFiles.tsx";
import type { MentionContext } from "./mentions.ts";
import { sameFileIds, timeLabel } from "./model.ts";
import type { PendingMessage } from "./outbox.ts";
import { ReactionPicker, Reactions } from "./Reactions.tsx";

// One message with its actions: the rows of the room list, and the messages of the view of a thread.

/** The message in edit: the body and the files that the edit box opened with, and the body and the files in it now. */
export interface Editing {
	id: string;
	/** The body that the box shows when it opens. */
	initial: ChatBody;
	/**
	 * The body before the edit: a text changed when it differs from this body. It is `initial`, except when the
	 * box opens again after a refusal: the box then shows the refused text, and this body stays the old one.
	 */
	base: ChatBody;
	/** The body in the box now, or null without text. */
	body: ChatBody | null;
	initialFiles: readonly ChatFile[];
	files: readonly ChatFile[];
}

/** The edit state of a message when its edit box opens. */
export function startEditing(message: ChatMessage, initial: ChatBody): Editing {
	return { id: message.id, initial, base: initial, body: initial, initialFiles: message.files, files: message.files };
}

/** The body of the edit box, or null when it has no text: a body of only spaces counts as no text. */
export function editedBody(editing: Editing): ChatBody | null {
	return editing.body !== null && bodyText(editing.body).trim() !== "" ? editing.body : null;
}

/**
 * True when the edit box can save. The text keeps its limit. A message with text needs text: an edit
 * without text keeps the old text on the server. A message with only files can remove some of them, and
 * keeps at least one.
 */
export function editSavable(editing: Editing): boolean {
	const body = editedBody(editing);
	if (body !== null) return bodyText(body).length <= CHAT_LIMITS.messageChars;
	return (
		bodyText(editing.base).trim() === "" &&
		editing.files.length > 0 &&
		!sameFileIds(editing.files, editing.initialFiles)
	);
}

export interface MessageItemProps {
	message: ChatMessage;
	/** The key of the row. The list finds the row with it, to stay at the same message. */
	rowKey: string;
	/** True for the message that a link marked. */
	marked: boolean;
	/** Puts a link to the message on the clipboard, or null for a message with no link (a reply in a thread). */
	onCopyLink: (() => void) | null;
	/** The state of the send, for a message that the server does not have yet. */
	pending: PendingMessage | null;
	/** The handles for the mentions in the text, and the suggestions of the edit box. */
	mentions: MentionContext;
	/** True when the message shows its author and its time. */
	head: boolean;
	own: boolean;
	canDelete: boolean;
	/** The bodies and the files of the edit box, or null when the message is not in edit. */
	editing: Editing | null;
	onEditStart: () => void;
	onEditChange: (body: ChatBody | null) => void;
	/** Removes a file from the message in the edit box. */
	onEditRemoveFile: (itemId: string) => void;
	/** Removes the preview of a link of an own message. */
	onRemovePreview: (url: string) => void;
	/** Gives the focus to the box for a new message, after the X of the last link preview. */
	onFocusBox: () => void;
	/** Runs when a picture or a video of the message gets its size, so the list keeps its place. */
	onMediaLoad: () => void;
	onEditSave: () => void;
	onEditCancel: () => void;
	onDelete: () => void;
	/** Opens the thread of the message (of its parent, for a reply), or null for a message that waits. */
	onOpenThread: (() => void) | null;
	/** Opens the earlier versions of the message, or null for a person who cannot read them. */
	onShowEdits: (() => void) | null;
	/** Sends a message again after its send failed. */
	onSendAgain: () => void;
	/** Removes a message whose send failed. */
	onSendCancel: () => void;
	/** The id of the person, to show the reactions of the person. */
	ownId: string;
	/** The emoji of the quick reactions: the emoji that the person uses most. */
	quickEmoji: readonly string[];
	/** Adds or removes the reaction of the person with one emoji. */
	onReact: (emoji: string, add: boolean) => void;
	/** One more class of the row, for a list that has rows of other kinds too. */
	className?: string | undefined;
	/** True for a list with no line for each day (the view of a thread): the time shows its day too. */
	fullDates?: boolean | undefined;
}

/** One message: its author, its body, its reactions and its thread, with the actions of the person. */
export function MessageItem({
	rowKey,
	marked,
	onCopyLink,
	message,
	pending,
	mentions,
	head,
	own,
	canDelete,
	editing,
	onEditStart,
	onEditChange,
	onEditRemoveFile,
	onRemovePreview,
	onFocusBox,
	onMediaLoad,
	onEditSave,
	onEditCancel,
	onDelete,
	onOpenThread,
	onShowEdits,
	onSendAgain,
	onSendCancel,
	ownId,
	quickEmoji,
	onReact,
	className,
	fullDates,
}: MessageItemProps) {
	const editId = useId();
	const [picking, setPicking] = useState(false);
	const pickerId = useId();
	const reactButton = useRef<HTMLButtonElement>(null);
	// After Escape and after a pick, the focus goes back to the button that opened the list, so a
	// keyboard keeps its place. After a click outside the list, it stays where the person clicked.
	const closePicker = useCallback((focusBack: boolean) => {
		setPicking(false);
		if (focusBack) reactButton.current?.focus();
	}, []);
	const nameOf = (principalId: string) => mentions.directory.byId.get(principalId)?.display_name ?? "A member";
	const author = message.author.display_name;
	const failed = pending?.state === "failed";
	// A message that the server does not have yet cannot change, and it has no id to delete or to link to.
	const hasActions = pending === null && !message.deleted && editing === null;
	return (
		// On a touch screen, a tap gives the focus to a row with actions. The row then shows its buttons.
		<li
			className={[
				"chat-message",
				head ? "chat-message-head" : "",
				pending ? (failed ? "chat-message-failed" : "chat-message-pending") : "",
				marked ? "chat-message-marked" : "",
				className ?? "",
			]
				.filter(Boolean)
				.join(" ")}
			data-row={rowKey}
			data-seq={pending === null ? message.seq : undefined}
			tabIndex={hasActions ? -1 : undefined}
			aria-busy={pending !== null && !failed ? true : undefined}
		>
			{/* The avatar of a person is a square with round corners. The avatar of an agent is a circle. */}
			{head && (
				<span
					className={message.author.kind === "agent" ? "chat-avatar chat-avatar-agent" : "chat-avatar"}
					aria-hidden="true"
				>
					{initials(author)}
				</span>
			)}
			<div className="chat-message-body">
				{/* A message that continues a group keeps its author and time for a screen reader. */}
				<p className={head ? "chat-message-meta" : "visually-hidden"}>
					{/* A hidden link would be a stop for the Tab key that nobody sees. A principal that is not in
					    the directory, for example a deleted one, has no profile. */}
					{head && mentions.directory.byId.has(message.author.principal_id) ? (
						<Link to={profilePath(message.author.principal_id)} className="chat-author">
							{author}
						</Link>
					) : (
						<strong className="chat-author">{author}</strong>
					)}
					{message.author.kind === "agent" && <span className="kind kind-agent">agent</span>}
					<time className="chat-time" dateTime={message.created_at} title={fullDate(message.created_at)}>
						{fullDates ? shortDate(message.created_at) : timeLabel(message.created_at)}
					</time>
				</p>
				{editing !== null ? (
					<form
						className="chat-edit"
						onSubmit={(event) => {
							event.preventDefault();
							onEditSave();
						}}
					>
						<ChatComposer
							id={editId}
							label="New text of the message"
							placeholder="Write the message"
							initial={editing.initial}
							onChange={onEditChange}
							onSubmit={onEditSave}
							onCancel={onEditCancel}
							mentions={mentions}
							placement="below"
							className="chat-edit-draft"
							// The person asked for the edit box, so the focus goes to it.
							autofocus
						/>
						<EditFiles
							files={editing.files}
							onRemove={onEditRemoveFile}
							onFocusAway={() => document.getElementById(editId)?.focus()}
						/>
						<span className="chat-edit-actions">
							<button type="button" className="button button-small" onClick={onEditCancel}>
								Cancel
							</button>
							<button type="submit" className="button button-small button-primary" disabled={!editSavable(editing)}>
								Save
							</button>
						</span>
						<p className="chat-edit-note">
							Owners and admins of the organization can read the text before an edit. To remove it, delete the message.
						</p>
					</form>
				) : message.deleted ? (
					<p className="chat-text chat-text-deleted">This message was deleted.</p>
				) : (
					<>
						{/* A message with only files has no text to show. */}
						{(message.text !== "" || message.files.length === 0 || message.edited_at) && (
							<div className="chat-text">
								<MessageBody body={message.body} text={message.text} mentions={mentions} />
								{message.edited_at &&
									(onShowEdits ? (
										<button
											type="button"
											className="chat-edited link-button"
											title={fullDate(message.edited_at)}
											aria-label="Edited. Show the earlier versions"
											onClick={onShowEdits}
										>
											(edited)
										</button>
									) : (
										<span className="chat-edited" title={fullDate(message.edited_at)}>
											(edited)
										</span>
									))}
							</div>
						)}
						<MessageFiles
							files={message.files}
							roomId={message.room_id}
							messageId={message.id}
							pending={pending !== null}
							onMediaLoad={onMediaLoad}
						/>
						<LinkPreviews
							message={message}
							ownId={ownId}
							pending={pending !== null}
							onRemove={onRemovePreview}
							onFocusAway={onFocusBox}
							onMediaLoad={onMediaLoad}
						/>
					</>
				)}
				{pending === null && !message.deleted && (
					<Reactions reactions={message.reactions} ownId={ownId} nameOf={nameOf} onToggle={onReact} />
				)}
				{message.thread && onOpenThread && (
					<button type="button" className="chat-thread-summary" onClick={onOpenThread}>
						<span className="chat-thread-authors" aria-hidden="true">
							{message.thread.authors.map((who) => (
								<span key={who.principal_id} className="chat-thread-author">
									{initials(who.display_name)}
								</span>
							))}
						</span>
						<span className="chat-thread-replies-count">{plural(message.thread.reply_count, "reply", "replies")}</span>
						<span className="chat-thread-last">Last reply {shortDate(message.thread.last_reply_at)}</span>
					</button>
				)}
				{message.parent_id !== null && onOpenThread && (
					<button type="button" className="chat-thread-note link-button" onClick={onOpenThread}>
						Replied in a thread
					</button>
				)}
				{failed && (
					<p className="chat-send-failed" role="alert">
						<span>Not sent. {pending.error}</span>
						<button type="button" className="link-button" onClick={onSendAgain}>
							Try again
						</button>
						<button type="button" className="link-button" onClick={onSendCancel}>
							Delete
						</button>
					</p>
				)}
			</div>
			{picking && (
				<ReactionPicker
					id={pickerId}
					trigger={reactButton}
					onPick={(emoji) => {
						closePicker(true);
						if (
							!message.reactions.some((reaction) => reaction.emoji === emoji && reaction.principal_ids.includes(ownId))
						) {
							onReact(emoji, true);
						}
					}}
					onClose={closePicker}
				/>
			)}
			{hasActions && (
				<span className="chat-message-actions">
					{quickEmoji.map((emoji) => {
						const mine = message.reactions.some(
							(reaction) => reaction.emoji === emoji && reaction.principal_ids.includes(ownId),
						);
						return (
							<button
								key={emoji}
								type="button"
								className="icon-button icon-button-small chat-quick-reaction"
								aria-label={`React with ${emojiName(emoji)}`}
								aria-pressed={mine}
								title={emojiName(emoji)}
								onClick={() => onReact(emoji, !mine)}
							>
								<span aria-hidden="true">{emoji}</span>
							</button>
						);
					})}
					<span className="chat-actions-divider" aria-hidden="true" />
					<button
						type="button"
						ref={reactButton}
						className="icon-button icon-button-small"
						aria-label={`Add a reaction to the message of ${author} from ${shortDate(message.created_at)}`}
						aria-haspopup="dialog"
						aria-expanded={picking}
						aria-controls={picking ? pickerId : undefined}
						title="Add a reaction"
						onClick={() => setPicking((open) => !open)}
					>
						<Icon name="emoji" size={16} />
					</button>
					{onCopyLink && (
						<button
							type="button"
							className="icon-button icon-button-small"
							aria-label={`Copy a link to the message of ${author} from ${shortDate(message.created_at)}`}
							title="Copy a link"
							onClick={onCopyLink}
						>
							<Icon name="link" size={16} />
						</button>
					)}
					{onOpenThread && message.parent_id === null && (
						<button
							type="button"
							className="icon-button icon-button-small"
							aria-label={`Reply in a thread to the message of ${author} from ${shortDate(message.created_at)}`}
							title="Reply in a thread"
							onClick={onOpenThread}
						>
							<Icon name="reply" size={16} />
						</button>
					)}
					{own && (
						<button
							type="button"
							className="icon-button icon-button-small"
							aria-label={`Change your message from ${shortDate(message.created_at)}`}
							title="Change"
							onClick={onEditStart}
						>
							<Icon name="pencil" size={16} />
						</button>
					)}
					{canDelete && (
						<button
							type="button"
							className="icon-button icon-button-small"
							aria-label={`Delete the message of ${author} from ${shortDate(message.created_at)}`}
							title="Delete"
							onClick={onDelete}
						>
							<Icon name="trash" size={16} />
						</button>
					)}
				</span>
			)}
		</li>
	);
}
