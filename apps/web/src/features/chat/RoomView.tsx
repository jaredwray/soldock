import { CHAT_LIMITS, type ChatMessage, type ChatRoom } from "@soldock/contracts";
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { fullDate, initials, plural, shortDate } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { Link, navigate } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { chatPath } from "../../routes.ts";
import { useSession } from "../auth/session.tsx";
import { usePageVisible, useRoom } from "./data.ts";
import { MembersDialog, RoomSettingsDialog } from "./dialogs.tsx";
import { roomTitle, startsGroup } from "./model.ts";

export interface RoomViewProps {
	roomId: string;
	/** The room in the room list of the person, or null when the list does not have it. */
	listed: ChatRoom | null;
	/** True after the room list loaded. */
	listReady: boolean;
	/** Gets the room list again, after a change that this view made. */
	onRoomsChanged: () => Promise<void>;
}

type RoomDialog = { type: "members" } | { type: "settings" } | { type: "delete"; message: ChatMessage } | null;

/** The distance from the end of the list, in pixels, under which a new message moves the list to its end. */
const STICK_PX = 80;

/** One room: its header, its messages and the box for a new message. */
export function RoomView({ roomId, listed, listReady, onRoomsChanged }: RoomViewProps) {
	const ownId = useSession().whoami.principal.id;
	const toast = useToast();
	const view = useRoom(roomId, listed?.version ?? null);
	const visible = usePageVisible();
	const [dialog, setDialog] = useState<RoomDialog>(null);
	const [draft, setDraft] = useState("");
	const [sending, setSending] = useState(false);
	const [joining, setJoining] = useState(false);
	const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const heightBefore = useRef<number | null>(null);
	const sendKey = useRef<string | null>(null);
	const markedSeq = useRef(0);
	const draftId = useId();

	// The room list follows each change, so its room is newer than the room of the first load.
	const room = listed ?? view.room;
	const title = room ? roomTitle(room) : "Chat";
	const fail = (caught: unknown) => toast({ message: errorMessage(caught), tone: "error" });

	useEffect(() => {
		document.title = `${title} – Soldock Chat`;
	}, [title]);

	// The membership changed in a different tab, or a different member changed it: load the room again.
	// A removed member then sees that the room is gone, and a new member sees the messages.
	const loadedAsMember = view.status === "ready" && view.room?.role !== null;
	const stale = view.status === "ready" && listReady && (listed !== null) !== loadedAsMember;
	const reload = view.reload;
	useEffect(() => {
		if (stale) void reload();
	}, [stale, reload]);

	// A room that shows is read. The marker goes to the newest message one time for each new message.
	const unreadSeq = room?.unread ? room.last_seq : 0;
	useEffect(() => {
		if (view.status !== "ready" || !visible || unreadSeq <= markedSeq.current) return;
		markedSeq.current = unreadSeq;
		api.call("chat.mark_read", { room_id: roomId }).then(
			() => void onRoomsChanged(),
			() => {
				markedSeq.current = 0;
			},
		);
	}, [view.status, visible, unreadSeq, roomId, onRoomsChanged]);

	// After older messages come in, the list stays at the same message. After a new message, it moves
	// to the end, if it was at the end.
	const messages = view.messages;
	useLayoutEffect(() => {
		const list = scrollRef.current;
		if (!list || messages.length === 0) return;
		if (heightBefore.current !== null) {
			list.scrollTop += list.scrollHeight - heightBefore.current;
			heightBefore.current = null;
		} else if (stick.current) {
			list.scrollTop = list.scrollHeight;
		}
	}, [messages]);

	function onScroll() {
		const list = scrollRef.current;
		if (list) stick.current = list.scrollHeight - list.scrollTop - list.clientHeight < STICK_PX;
	}

	async function loadOlder() {
		heightBefore.current = scrollRef.current?.scrollHeight ?? null;
		try {
			await view.loadOlder();
		} catch (caught) {
			heightBefore.current = null;
			fail(caught);
		}
	}

	async function send() {
		if (!draft.trim() || sending) return;
		setSending(true);
		// One key for one text, so a retry after a lost answer does not post the text two times.
		sendKey.current ??= crypto.randomUUID();
		try {
			const { message } = await api.call("chat.post_message", {
				room_id: roomId,
				text: draft,
				idempotency_key: sendKey.current,
			});
			sendKey.current = null;
			setDraft("");
			stick.current = true;
			view.apply(message);
			void onRoomsChanged();
		} catch (caught) {
			fail(caught);
		}
		setSending(false);
	}

	function onDraftKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		// Enter sends. Shift+Enter makes a new line. Enter during text composition belongs to the input method.
		if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
		event.preventDefault();
		void send();
	}

	async function saveEdit() {
		if (!editing?.text.trim()) return;
		try {
			const { message } = await api.call("chat.edit_message", {
				room_id: roomId,
				message_id: editing.id,
				text: editing.text,
			});
			setEditing(null);
			view.apply(message);
		} catch (caught) {
			fail(caught);
		}
	}

	async function join() {
		setJoining(true);
		try {
			await api.call("chat.join_room", { room_id: roomId });
			await onRoomsChanged();
			await view.reload();
		} catch (caught) {
			fail(caught);
		}
		setJoining(false);
	}

	if (view.status === "loading") {
		return (
			<p className="list-state" role="status">
				<span className="spinner" aria-hidden="true" />
				Loading…
			</p>
		);
	}
	if (view.status === "error" || !room) {
		return (
			<div className="list-state">
				<p role="alert">{view.error ?? "The room did not load."}</p>
				<Link to={chatPath()} className="button">
					Go to your rooms
				</Link>
			</div>
		);
	}

	const isMember = room.role !== null;
	return (
		<>
			<header className="chat-header">
				<Icon name={room.kind === "dm" ? "chat" : room.kind === "private" ? "lock" : "hash"} />
				<div className="chat-header-text">
					<h1 className="chat-title">{title}</h1>
					{room.topic && <p className="chat-topic muted">{room.topic}</p>}
				</div>
				<button
					type="button"
					className="button button-small"
					onClick={() => setDialog({ type: "members" })}
					aria-label={`Members: ${plural(room.member_count, "member")}`}
				>
					<Icon name="team" size={16} />
					{room.member_count}
				</button>
				{room.role === "owner" && (
					<button
						type="button"
						className="icon-button"
						aria-label="Change the name and the topic"
						title="Change the name and the topic"
						onClick={() => setDialog({ type: "settings" })}
					>
						<Icon name="pencil" />
					</button>
				)}
			</header>

			{isMember ? (
				<>
					<div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
						{view.hasOlder && (
							<p className="chat-more">
								<button
									type="button"
									className="button button-small"
									disabled={view.loadingOlder}
									onClick={() => void loadOlder()}
								>
									{view.loadingOlder ? "Loading…" : "Show older messages"}
								</button>
							</p>
						)}
						{messages.length === 0 && (
							<p className="list-state">
								{room.kind === "dm"
									? `This is the start of your direct messages with ${title}.`
									: "This room has no messages yet. Write the first one."}
							</p>
						)}
						<ol className="chat-messages" role="log" aria-label={`Messages of ${title}`}>
							{messages.map((message, index) => (
								<MessageItem
									key={message.id}
									message={message}
									head={startsGroup(messages[index - 1], message)}
									own={message.author.principal_id === ownId}
									canDelete={message.author.principal_id === ownId || room.role === "owner"}
									editing={editing?.id === message.id ? editing.text : null}
									onEditStart={() => setEditing({ id: message.id, text: message.text })}
									onEditChange={(text) => setEditing({ id: message.id, text })}
									onEditSave={() => void saveEdit()}
									onEditCancel={() => setEditing(null)}
									onDelete={() => setDialog({ type: "delete", message })}
								/>
							))}
						</ol>
					</div>
					<form
						className="chat-composer"
						onSubmit={(event) => {
							event.preventDefault();
							void send();
						}}
					>
						<label htmlFor={draftId} className="visually-hidden">
							Message to {title}
						</label>
						<textarea
							id={draftId}
							className="input chat-draft"
							rows={1}
							placeholder={`Message ${title}`}
							value={draft}
							maxLength={CHAT_LIMITS.messageChars}
							onChange={(event) => {
								sendKey.current = null;
								setDraft(event.target.value);
							}}
							onKeyDown={onDraftKeyDown}
						/>
						<button
							type="submit"
							className="icon-button chat-send"
							aria-label="Send the message"
							title="Send (Enter)"
							disabled={sending || !draft.trim()}
						>
							<Icon name="send" />
						</button>
					</form>
				</>
			) : (
				<div className="list-state">
					<p>You are not a member of this public room. Join it to read and write messages.</p>
					<button type="button" className="button button-primary" disabled={joining} onClick={() => void join()}>
						{joining ? "Joining…" : "Join the room"}
					</button>
				</div>
			)}

			{dialog?.type === "members" && (
				<MembersDialog
					room={room}
					onClose={() => setDialog(null)}
					onChanged={() => void onRoomsChanged()}
					onLeft={() => {
						setDialog(null);
						void onRoomsChanged();
						navigate(chatPath());
					}}
				/>
			)}
			{dialog?.type === "settings" && (
				<RoomSettingsDialog
					room={room}
					onClose={() => setDialog(null)}
					onSaved={() => {
						setDialog(null);
						void onRoomsChanged();
					}}
				/>
			)}
			{dialog?.type === "delete" && (
				<ConfirmDialog
					title="Delete this message?"
					confirmLabel="Delete"
					danger
					onClose={() => setDialog(null)}
					onConfirm={async () => {
						await api.call("chat.delete_message", { room_id: roomId, message_id: dialog.message.id });
						await view.sync();
					}}
				>
					<p>The text of the message is deleted for each member. This cannot be undone.</p>
				</ConfirmDialog>
			)}
		</>
	);
}

interface MessageItemProps {
	message: ChatMessage;
	/** True when the message shows its author and its time. */
	head: boolean;
	own: boolean;
	canDelete: boolean;
	/** The text in the edit box, or null when the message is not in edit. */
	editing: string | null;
	onEditStart: () => void;
	onEditChange: (text: string) => void;
	onEditSave: () => void;
	onEditCancel: () => void;
	onDelete: () => void;
}

function MessageItem({
	message,
	head,
	own,
	canDelete,
	editing,
	onEditStart,
	onEditChange,
	onEditSave,
	onEditCancel,
	onDelete,
}: MessageItemProps) {
	const editId = useId();
	const author = message.author.display_name;
	return (
		<li className={head ? "chat-message chat-message-head" : "chat-message"}>
			{head ? (
				<span className="avatar avatar-small chat-avatar" aria-hidden="true">
					{initials(author)}
				</span>
			) : (
				<span className="chat-avatar" aria-hidden="true" />
			)}
			<div className="chat-message-body">
				{/* A message that continues a group keeps its author and time for a screen reader. */}
				<p className={head ? "chat-message-meta" : "visually-hidden"}>
					<strong>{author}</strong>
					{message.author.kind === "agent" && <span className="kind kind-agent">agent</span>}
					<time className="muted" dateTime={message.created_at} title={fullDate(message.created_at)}>
						{shortDate(message.created_at)}
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
						<label htmlFor={editId} className="visually-hidden">
							New text of the message
						</label>
						<textarea
							id={editId}
							className="input chat-draft"
							value={editing}
							maxLength={CHAT_LIMITS.messageChars}
							onChange={(event) => onEditChange(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Escape") onEditCancel();
							}}
							// biome-ignore lint/a11y/noAutofocus: the person asked for the edit box, so the focus goes to it.
							autoFocus
						/>
						<span className="chat-edit-actions">
							<button type="button" className="button button-small" onClick={onEditCancel}>
								Cancel
							</button>
							<button type="submit" className="button button-small button-primary" disabled={!editing.trim()}>
								Save
							</button>
						</span>
					</form>
				) : message.deleted ? (
					<p className="chat-text muted">This message was deleted.</p>
				) : (
					<p className="chat-text">
						{message.text}
						{message.edited_at && (
							<span className="chat-edited muted" title={fullDate(message.edited_at)}>
								{" "}
								(edited)
							</span>
						)}
					</p>
				)}
			</div>
			{!message.deleted && editing === null && (own || canDelete) && (
				<span className="chat-message-actions">
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
