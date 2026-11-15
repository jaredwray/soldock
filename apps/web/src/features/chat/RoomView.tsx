import { CHAT_LIMITS, type ChatMessage, type ChatRoom } from "@soldock/contracts";
import { Fragment, type KeyboardEvent, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { fullDate, initials, plural, shortDate } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { Link, navigate } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { chatPath } from "../../routes.ts";
import { useSession } from "../auth/session.tsx";
import { useOutbox, usePageVisible, useRoom } from "./data.ts";
import { MembersDialog, RoomSettingsDialog } from "./dialogs.tsx";
import {
	chatRows,
	dayLabel,
	draftPlaceholder,
	type LocalChange,
	roomTitle,
	startsDay,
	startsGroup,
	storedSends,
	timeLabel,
} from "./model.ts";
import type { PendingMessage } from "./outbox.ts";

export interface RoomViewProps {
	roomId: string;
	/** The room in the room list of the person, or null when the list does not have it. */
	listed: ChatRoom | null;
	/** True after the room list loaded. */
	listReady: boolean;
	/** The number of room lists that arrived. */
	listTick: number;
	/** Gets the room list again, after a change that this view made. */
	onRoomsChanged: () => Promise<void>;
}

type RoomDialog = { type: "members" } | { type: "settings" } | { type: "delete"; message: ChatMessage } | null;

/** The distance from the end of the list, in pixels, under which a new message moves the list to its end. */
const STICK_PX = 80;

/** One room: its header, its messages and the box for a new message. */
export function RoomView({ roomId, listed, listReady, listTick, onRoomsChanged }: RoomViewProps) {
	const self = useSession().whoami.principal;
	const ownId = self.id;
	const toast = useToast();
	const view = useRoom(roomId, { version: listed?.version ?? null, tick: listTick }, onRoomsChanged);
	// A message shows in the list at once, and goes out behind it. The list then gets the stored message.
	const loaded = view.messages[view.messages.length - 1];
	const outbox = useOutbox(roomId, ownId, view.status === "ready" ? (loaded?.seq ?? 0) : null, (message) => {
		view.apply(message);
		void onRoomsChanged();
	});
	const visible = usePageVisible();
	const [dialog, setDialog] = useState<RoomDialog>(null);
	const [draft, setDraft] = useState("");
	const [joining, setJoining] = useState(false);
	const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const heightBefore = useRef<number | null>(null);
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

	// A room that shows is read, up to the last message that the page shows. The marker never goes past
	// a message that did not arrive. After a failed call, the next room list tries again.
	const messages = view.messages;
	const lastShown = messages[messages.length - 1];
	const unreadSeq =
		room?.role != null && lastShown && lastShown.author.principal_id !== ownId && lastShown.seq > room.last_read_seq
			? lastShown.seq
			: 0;
	// biome-ignore lint/correctness/useExhaustiveDependencies: listTick starts a new attempt after a failed call.
	useEffect(() => {
		if (view.status !== "ready" || !visible || unreadSeq <= markedSeq.current) return;
		markedSeq.current = unreadSeq;
		api.call("chat.mark_read", { room_id: roomId, seq: unreadSeq }).catch(() => {
			markedSeq.current = 0;
		});
	}, [view.status, visible, unreadSeq, roomId, listTick]);

	const own = useMemo(
		() => ({ principal_id: ownId, kind: self.kind, display_name: self.display_name }),
		[ownId, self.kind, self.display_name],
	);
	// An edit and a delete show at once, before the answer of the server. `latest` has the newest
	// change of each message at each moment. `changes` is its copy for the list.
	const latest = useRef(new Map<string, LocalChange>());
	const [changes, setChanges] = useState<ReadonlyMap<string, LocalChange>>(() => new Map());
	// The end of the calls for each message. The calls for one message run one at a time, in the order
	// of the changes, so the room gets the newest change last.
	const calls = useRef(new Map<string, Promise<void>>());
	const rows = useMemo(
		() => chatRows(messages, outbox.state, own, roomId, changes),
		[messages, outbox.state, own, roomId, changes],
	);

	// The answers of a send can fail after the server stored the message. When the list has that
	// message, the send did not fail: the row of the send becomes the row of the stored message.
	const settle = outbox.settle;
	useLayoutEffect(() => {
		for (const { key, id } of storedSends(messages, outbox.state, own)) settle(key, id);
	}, [messages, outbox.state, own, settle]);

	// After older messages come in, the list stays at the same message. After a new message, it moves
	// to the end, if it was at the end.
	useLayoutEffect(() => {
		const list = scrollRef.current;
		if (!list || rows.length === 0) return;
		if (heightBefore.current !== null) {
			list.scrollTop += list.scrollHeight - heightBefore.current;
			heightBefore.current = null;
		} else if (stick.current) {
			list.scrollTop = list.scrollHeight;
		}
	}, [rows]);

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

	function send() {
		if (!draft.trim()) return;
		// The message shows in the list at once. The outbox sends it, and tries again after a failure.
		outbox.send(draft);
		setDraft("");
		stick.current = true;
	}

	function onDraftKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		// Enter sends. Shift+Enter makes a new line. Enter during text composition belongs to the input method.
		if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
		event.preventDefault();
		send();
	}

	/** Shows a change of a message before the answer of the server. */
	function showChange(id: string, change: LocalChange) {
		latest.current.set(id, change);
		setChanges(new Map(latest.current));
	}

	/** Removes a change after its call failed or ended. False when a newer change of the message replaced it. */
	function endChange(id: string, change: LocalChange): boolean {
		if (latest.current.get(id) !== change) return false;
		latest.current.delete(id);
		setChanges(new Map(latest.current));
		return true;
	}

	/** Runs the call of a change after each earlier call for the same message. */
	function afterEarlierCalls(id: string, call: () => Promise<void>) {
		const next = (calls.current.get(id) ?? Promise.resolve()).then(call);
		calls.current.set(id, next);
	}

	function saveEdit() {
		if (!editing?.text.trim()) return;
		const { id, text } = editing;
		setEditing(null);
		// The text that shows: the text of an edit that waits, or the text that the room has.
		const waiting = latest.current.get(id);
		const shown = waiting?.kind === "edit" ? waiting.text : messages.find((message) => message.id === id)?.text;
		if (shown === text) return;
		// The new text shows at once.
		const change: LocalChange = { kind: "edit", text, at: new Date().toISOString() };
		showChange(id, change);
		afterEarlierCalls(id, async () => {
			// A newer change replaced this one before its call started. Only the newest change goes.
			if (latest.current.get(id) !== change) return;
			try {
				const { message } = await api.call("chat.edit_message", { room_id: roomId, message_id: id, text });
				view.apply(message);
				endChange(id, change);
			} catch (caught) {
				// After a refusal, the old text shows again, and the edit box opens with the new text, so the
				// person does not write it again. A newer change of the message stays as it is.
				if (!endChange(id, change)) return;
				setEditing((current) => current ?? { id, text });
				fail(caught);
			}
		});
	}

	function deleteMessage(id: string) {
		// The message shows as deleted at once. After a refusal, it shows again.
		const change: LocalChange = { kind: "delete" };
		showChange(id, change);
		afterEarlierCalls(id, async () => {
			try {
				await api.call("chat.delete_message", { room_id: roomId, message_id: id });
				// The answer has no message. The change stays: the message shows as deleted also while the
				// list does not have the deleted message from the room.
				void view.sync();
			} catch (caught) {
				if (endChange(id, change)) fail(caught);
			}
		});
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
				{room.kind === "dm" ? (
					<span className="avatar avatar-small chat-header-avatar" aria-hidden="true">
						{initials(title)}
					</span>
				) : (
					<Icon name={room.kind === "private" ? "lock" : "hash"} size={22} />
				)}
				<h1 className="chat-title">
					{room.kind === "dm" && <span className="visually-hidden">Direct message with </span>}
					{title}
				</h1>
				{room.kind === "dm" && room.peer?.kind === "agent" && <span className="kind kind-agent">agent</span>}
				{room.topic && <p className="chat-topic">{room.topic}</p>}
				<span className="chat-header-actions">
					<button
						type="button"
						className="chat-header-button"
						onClick={() => setDialog({ type: "members" })}
						aria-label={`Members: ${plural(room.member_count, "member")}`}
						title="Members"
					>
						<Icon name="team" />
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
				</span>
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
						{rows.length === 0 && (
							<div className="chat-empty">
								<span className="chat-empty-tile" aria-hidden="true">
									<Icon name={room.kind === "dm" ? "chat" : room.kind === "private" ? "lock" : "hash"} size={24} />
								</span>
								<p className="chat-empty-title">{room.kind === "dm" ? title : `#${title}`}</p>
								<p>
									{room.kind === "dm"
										? `This is the start of your direct messages with ${title}.`
										: "This room has no messages yet. Write the first one."}
								</p>
							</div>
						)}
						<ol className="chat-messages" role="log" aria-label={`Messages of ${title}`}>
							{rows.map(({ key, message, pending }, index) => (
								<Fragment key={key}>
									{startsDay(rows[index - 1]?.message, message) && (
										<li className="chat-day">
											<h2 className="chat-day-heading">
												<time dateTime={message.created_at}>{dayLabel(message.created_at)}</time>
											</h2>
										</li>
									)}
									<MessageItem
										message={message}
										pending={pending}
										head={startsGroup(rows[index - 1]?.message, message)}
										own={message.author.principal_id === ownId}
										canDelete={message.author.principal_id === ownId || room.role === "owner"}
										editing={editing?.id === message.id ? editing.text : null}
										onEditStart={() => setEditing({ id: message.id, text: message.text })}
										onEditChange={(text) => setEditing({ id: message.id, text })}
										onEditSave={saveEdit}
										onEditCancel={() => setEditing(null)}
										onDelete={() => setDialog({ type: "delete", message })}
										onSendAgain={() => outbox.retry(key)}
										onSendCancel={() => outbox.discard(key)}
									/>
								</Fragment>
							))}
						</ol>
					</div>
					<form
						className="chat-composer"
						onSubmit={(event) => {
							event.preventDefault();
							send();
						}}
					>
						<label htmlFor={draftId} className="visually-hidden">
							Message to {title}
						</label>
						<div className="chat-composer-box">
							<textarea
								id={draftId}
								className="chat-draft"
								rows={1}
								placeholder={draftPlaceholder(room)}
								value={draft}
								maxLength={CHAT_LIMITS.messageChars}
								onChange={(event) => setDraft(event.target.value)}
								onKeyDown={onDraftKeyDown}
							/>
							<span className="chat-composer-bar">
								<button
									type="submit"
									className="chat-send"
									aria-label="Send the message"
									title="Send (Enter)"
									disabled={!draft.trim()}
								>
									<Icon name="arrowUp" size={18} />
								</button>
							</span>
						</div>
					</form>
				</>
			) : (
				<div className="chat-empty chat-empty-page">
					<span className="chat-empty-tile" aria-hidden="true">
						<Icon name="hash" size={24} />
					</span>
					<p className="chat-empty-title">#{title}</p>
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
					onConfirm={async () => deleteMessage(dialog.message.id)}
				>
					<p>The text of the message is deleted for each member. This cannot be undone.</p>
				</ConfirmDialog>
			)}
		</>
	);
}

interface MessageItemProps {
	message: ChatMessage;
	/** The state of the send, for a message that the server does not have yet. */
	pending: PendingMessage | null;
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
	/** Sends a message again after its send failed. */
	onSendAgain: () => void;
	/** Removes a message whose send failed. */
	onSendCancel: () => void;
}

function MessageItem({
	message,
	pending,
	head,
	own,
	canDelete,
	editing,
	onEditStart,
	onEditChange,
	onEditSave,
	onEditCancel,
	onDelete,
	onSendAgain,
	onSendCancel,
}: MessageItemProps) {
	const editId = useId();
	const author = message.author.display_name;
	const failed = pending?.state === "failed";
	// A message that the server does not have yet cannot change, and it has no id to delete.
	const hasActions = pending === null && !message.deleted && editing === null && (own || canDelete);
	return (
		// On a touch screen, a tap gives the focus to a row with actions. The row then shows its buttons.
		<li
			className={[
				"chat-message",
				head ? "chat-message-head" : "",
				pending ? (failed ? "chat-message-failed" : "chat-message-pending") : "",
			]
				.filter(Boolean)
				.join(" ")}
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
					<strong className="chat-author">{author}</strong>
					{message.author.kind === "agent" && <span className="kind kind-agent">agent</span>}
					<time className="chat-time" dateTime={message.created_at} title={fullDate(message.created_at)}>
						{timeLabel(message.created_at)}
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
							className="input chat-edit-draft"
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
					<p className="chat-text chat-text-deleted">This message was deleted.</p>
				) : (
					<p className="chat-text">
						{message.text}
						{message.edited_at && (
							<span className="chat-edited" title={fullDate(message.edited_at)}>
								{" "}
								(edited)
							</span>
						)}
					</p>
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
			{hasActions && (
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
