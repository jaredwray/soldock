import { CHAT_LIMITS, type ChatMessage, type ChatRoom, type Principal } from "@soldock/contracts";
import {
	Fragment,
	type KeyboardEvent,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { accountChangeCount } from "../../lib/account.ts";
import { api, errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { fullDate, initials, plural, shortDate } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { Link, navigate } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { chatPath, profilePath } from "../../routes.ts";
import { useSession } from "../auth/session.tsx";
import { createCallLine } from "./callLine.ts";
import { useOutbox, usePageVisible, useRoom } from "./data.ts";
import { MembersDialog, RoomSettingsDialog } from "./dialogs.tsx";
import { createDraftStore, draftStorage } from "./drafts.ts";
import { type MentionContext, MentionTextarea } from "./MentionTextarea.tsx";
import { type MentionDirectory, textParts } from "./mentions.ts";
import {
	chatRows,
	dayLabel,
	draftPlaceholder,
	type LocalChange,
	newMessages,
	nextReading,
	type Reading,
	roomTitle,
	startReading,
	startsDay,
	startsGroup,
	startsNew,
	storedSends,
	timeLabel,
	unseenSendsNote,
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
	/** The handles of the people and the agents, for the mentions. */
	directory: MentionDirectory<Principal>;
}

type RoomDialog = { type: "members" } | { type: "settings" } | { type: "delete"; message: ChatMessage } | null;

/** The distance from the end of the list, in pixels, under which a new message moves the list to its end. */
const STICK_PX = 80;

/** One room: its header, its messages and the box for a new message. */
export function RoomView({ roomId, listed, listReady, listTick, onRoomsChanged, directory }: RoomViewProps) {
	const self = useSession().whoami.principal;
	const ownId = self.id;
	const toast = useToast();
	const view = useRoom(roomId, { version: listed?.version ?? null, tick: listTick }, onRoomsChanged);
	// A message shows in the list at once, and goes out behind it. The list then gets the stored message.
	// A list that is not at the newest messages does not know the last message of the room. A list
	// from the cache can be behind the room, so it does not know it also.
	const loaded = view.messages[view.messages.length - 1];
	const lastSeq = view.status === "ready" && view.fresh && !view.hasNewer ? (loaded?.seq ?? 0) : null;
	/** The number of messages that the room stored for the person while the list was not at the newest messages. */
	const [sentUnseen, setSentUnseen] = useState(0);
	const outbox = useOutbox(roomId, ownId, lastSeq, (message) => {
		view.apply(message);
		// The list does not take the message now. A line below the list tells that the room has it.
		if (view.hasNewer) setSentUnseen((count) => count + 1);
		void onRoomsChanged();
	});
	const visible = usePageVisible();
	const [dialog, setDialog] = useState<RoomDialog>(null);
	// The text in the box stays for the room when the person opens a different room, and after a reload.
	const drafts = useMemo(() => createDraftStore(draftStorage(), ownId), [ownId]);
	const [draft, setDraftText] = useState(() => drafts.get(roomId));
	function setDraft(text: string) {
		setDraftText(text);
		drafts.set(roomId, text);
	}
	const [joining, setJoining] = useState(false);
	/** True while a read of the newest messages runs for this view. */
	const [goingToLatest, setGoingToLatest] = useState(false);
	/** True while the outbox waits for the newest messages of the room: a send from a list that was not there. */
	const holding = useRef(false);
	/** True after the person used a button of the list. The focus then stays in the list when the button goes. */
	const refocus = useRef(false);
	const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	/** True while the list is at its end. It is `stick` for the page: the read state and the button to the end use it. */
	const [atEnd, setAtEnd] = useState(true);
	/** What the person saw of the room, for the "New messages" line. Null until the room loads. */
	const [reading, setReading] = useState<Reading | null>(null);
	/** The first row that shows, with its distance from the top of the list, before the rows change. */
	const place = useRef<{ key: string; top: number } | null>(null);
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

	// The person looks at the newest messages when the tab shows, and the list is at the end of the
	// newest messages of the room. A message below the part that shows is not read.
	const messages = view.messages;
	// A list from the cache is not the room of now: the person reads the room after its load.
	const looking = view.status === "ready" && view.fresh && visible && atEnd && !view.hasNewer;

	// The room opens with the read marker of the person. The messages after it came while the person
	// did not look, so the line goes before the first of them.
	const loadedRoom = view.status === "ready" && view.fresh ? view.room : null;
	useEffect(() => {
		if (!loadedRoom || loadedRoom.role === null) return;
		setReading((current) => current ?? nextReading(startReading(loadedRoom.last_read_seq), messages, ownId, false));
	}, [loadedRoom, messages, ownId]);
	useEffect(() => {
		setReading((current) => current && nextReading(current, messages, ownId, looking));
	}, [messages, ownId, looking]);

	// A room is read up to the last message while the person looks at it. The marker never goes past
	// a message that did not arrive. After a failed call, the next room list tries again.
	const lastShown = messages[messages.length - 1];
	const unreadSeq =
		looking &&
		room?.role != null &&
		lastShown &&
		lastShown.author.principal_id !== ownId &&
		lastShown.seq > room.last_read_seq
			? lastShown.seq
			: 0;
	// biome-ignore lint/correctness/useExhaustiveDependencies: listTick starts a new attempt after a failed call.
	useEffect(() => {
		if (unreadSeq <= markedSeq.current) return;
		markedSeq.current = unreadSeq;
		api.call("chat.mark_read", { room_id: roomId, seq: unreadSeq }).catch(() => {
			markedSeq.current = 0;
		});
	}, [unreadSeq, roomId, listTick]);

	const own = useMemo(
		() => ({ principal_id: ownId, kind: self.kind, display_name: self.display_name }),
		[ownId, self.kind, self.display_name],
	);
	const members = view.members;
	const mentions = useMemo<MentionContext>(
		() => ({ directory, memberIds: new Set(members.map((member) => member.principal_id)), ownId }),
		[directory, members, ownId],
	);
	// An edit and a delete show at once, before the answer of the server. `latest` has the newest
	// change of each message at each moment. `changes` is its copy for the list.
	const latest = useRef(new Map<string, LocalChange>());
	const [changes, setChanges] = useState<ReadonlyMap<string, LocalChange>>(() => new Map());
	// The calls for one message run one at a time, in the order of the changes, so the room gets the
	// newest change last. A call that waits does not start after a sign-out: the next sign-in is a
	// different session, also for the same person.
	const afterEarlierCalls = useMemo(() => {
		const signedIn = accountChangeCount();
		return createCallLine(() => accountChangeCount() === signedIn);
	}, []);
	// A message that waits for the server goes after the newest message of the room. A list that is
	// not at the newest messages does not show it.
	const hasNewer = view.hasNewer;
	const rows = useMemo(() => {
		const all = chatRows(messages, outbox.state, own, roomId, changes);
		return hasNewer ? all.filter((row) => row.pending === null) : all;
	}, [messages, outbox.state, own, roomId, changes, hasNewer]);

	const unseenNote = hasNewer ? unseenSendsNote(outbox.state, sentUnseen) : null;
	// The text of the button to the newest messages: the number of new messages below the part that
	// shows. A list that is not at the newest messages does not have them, and the room list only
	// tells that the room is unread.
	const newCount = reading && !hasNewer ? newMessages(messages, reading, ownId) : 0;
	const jumpLabel = hasNewer
		? listed?.unread
			? "New messages"
			: null
		: newCount > 0
			? plural(newCount, "new message")
			: null;

	// The answers of a send can fail after the server stored the message. When the list has that
	// message, the send did not fail: the row of the send becomes the row of the stored message.
	const settle = outbox.settle;
	useLayoutEffect(() => {
		for (const { key, id } of storedSends(messages, outbox.state, own)) settle(key, id);
	}, [messages, outbox.state, own, settle]);

	/** Keeps the first row that shows, and its distance from the top of the list, for the next change of the rows. */
	function keepPlace() {
		const list = scrollRef.current;
		if (!list) return;
		const top = list.getBoundingClientRect().top;
		for (const row of list.querySelectorAll<HTMLElement>("[data-row]")) {
			const box = row.getBoundingClientRect();
			if (box.bottom > top) {
				place.current = { key: row.dataset.row ?? "", top: box.top - top };
				return;
			}
		}
		place.current = null;
	}

	/** Puts the list at its end, if it was there, or at the row and the distance that `keepPlace` kept. */
	function holdPlace() {
		const list = scrollRef.current;
		if (!list) return;
		const kept = place.current;
		if (stick.current) {
			list.scrollTop = list.scrollHeight;
		} else if (kept) {
			for (const row of list.querySelectorAll<HTMLElement>("[data-row]")) {
				if (row.dataset.row !== kept.key) continue;
				list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top - kept.top;
				break;
			}
		}
		keepPlace();
	}

	// After a new message, the list moves to its end, if it was at the end. After each other change of
	// the rows, the list stays at the same message: the rows above it can come in, go out and change.
	// biome-ignore lint/correctness/useExhaustiveDependencies: holdPlace reads and moves the DOM only.
	useLayoutEffect(() => {
		if (rows.length > 0) holdPlace();
	}, [rows, view.hasOlder, hasNewer, reading?.newAfter]);

	// The list also stays at the same message when its size changes: the window gets a different
	// width, or the keyboard of a phone opens.
	const isMember = view.status === "ready" && (listed ?? view.room)?.role != null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: holdPlace reads and moves the DOM only.
	useEffect(() => {
		const list = scrollRef.current;
		if (!isMember || !list || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => holdPlace());
		observer.observe(list);
		return () => observer.disconnect();
	}, [isMember]);

	// A button of the list goes away when the list has no more messages in its direction. The focus
	// then goes to the list, so a person with a keyboard keeps the place.
	useLayoutEffect(() => {
		if (!refocus.current || document.activeElement !== document.body) return;
		refocus.current = false;
		scrollRef.current?.focus();
	});

	/** Sets if the list is at its end. The room then also knows which messages a full list can drop. */
	const follow = view.follow;
	function setStick(next: boolean) {
		stick.current = next;
		setAtEnd(next);
		follow(next);
	}

	function onScroll() {
		const list = scrollRef.current;
		if (!list) return;
		setStick(list.scrollHeight - list.scrollTop - list.clientHeight < STICK_PX);
		keepPlace();
	}

	function loadOlder() {
		refocus.current = true;
		view.loadOlder().catch(fail);
	}

	function loadNewer() {
		refocus.current = true;
		// The new rows come in after the last row. The list must not move to its new end.
		setStick(false);
		view.loadNewer().catch(fail);
	}

	/** Puts the list at the newest messages of the room. False when a different read replaced this one. */
	async function toLatest(): Promise<boolean> {
		setStick(true);
		setGoingToLatest(true);
		try {
			return await view.toLatest();
		} catch (caught) {
			// The list stays where it is. It is at its end only when the person sees that end.
			onScroll();
			throw caught;
		} finally {
			setGoingToLatest(false);
		}
	}

	// A send from a list that is not at the newest messages: the outbox has the message, and starts
	// no call until the list is there. The call then knows the last message of the room, so the list
	// finds the stored message of the send.
	const resumeOutbox = outbox.resume;
	const release = useCallback(() => {
		if (!holding.current) return;
		holding.current = false;
		resumeOutbox();
	}, [resumeOutbox]);
	useEffect(() => {
		if (hasNewer) return;
		release();
		setSentUnseen(0);
	}, [hasNewer, release]);
	// The page leaves the room. The message still goes out.
	useEffect(() => release, [release]);

	function send() {
		if (!draft.trim()) return;
		// A new message goes after the newest message of the room. When the list is not there, it goes
		// there. The outbox takes the message now, so the text is the text of this moment, and it stays
		// after a reload and after a different room opens.
		if (hasNewer && !holding.current) {
			holding.current = true;
			outbox.pause();
			toLatest().then(
				(applied) => {
					if (!applied) release();
				},
				(caught) => {
					// The list did not get to the newest messages. The message goes out all the same.
					release();
					fail(caught);
				},
			);
		}
		// The message shows in the list at once. The outbox sends it, and tries again after a failure.
		outbox.send(draft);
		setDraft("");
		setStick(true);
		// The person answers: the messages above are not new for the person now.
		setReading((current) => current && { ...current, newAfter: null, lineSeen: false });
	}

	/** Goes to the newest messages of the room: to the end of the list, or to a new list of the newest messages. */
	function jump() {
		refocus.current = true;
		if (hasNewer) {
			toLatest().catch(fail);
			return;
		}
		setStick(true);
		const list = scrollRef.current;
		if (list) list.scrollTop = list.scrollHeight;
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
					<div className="chat-list">
						<div className="chat-scroll" ref={scrollRef} onScroll={onScroll} tabIndex={-1}>
							{view.hasOlder && (
								<p className="chat-more">
									<button
										type="button"
										className="button button-small"
										disabled={view.paging !== null || !view.fresh}
										onClick={loadOlder}
									>
										{view.paging === "older" ? "Loading…" : "Show older messages"}
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
								{rows.map(({ key, message, pending }, index) => {
									const previous = rows[index - 1]?.message;
									// The first new message shows its author: the line starts a new part of the list.
									const isNew =
										pending === null && startsNew(previous, message, reading?.newAfter ?? null, view.hasOlder);
									return (
										<Fragment key={key}>
											{isNew && (
												<li className="chat-new">
													<span>New messages</span>
												</li>
											)}
											{startsDay(previous, message) && (
												<li className="chat-day">
													<h2 className="chat-day-heading">
														<time dateTime={message.created_at}>{dayLabel(message.created_at)}</time>
													</h2>
												</li>
											)}
											<MessageItem
												rowKey={key}
												message={message}
												pending={pending}
												mentions={mentions}
												head={isNew || startsGroup(previous, message)}
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
									);
								})}
							</ol>
							{view.hasNewer && (
								<p className="chat-more">
									<button
										type="button"
										className="button button-small"
										disabled={view.paging !== null}
										onClick={loadNewer}
									>
										{view.paging === "newer" ? "Loading…" : "Show newer messages"}
									</button>
								</p>
							)}
							{unseenNote !== null && (
								<p className="chat-more-note" role="status">
									{unseenNote}
								</p>
							)}
						</div>
						{(!atEnd || view.hasNewer) && (
							<button
								type="button"
								className={jumpLabel ? "chat-jump chat-jump-new" : "chat-jump"}
								aria-label={jumpLabel ? `Go to the newest messages: ${jumpLabel}` : "Go to the newest messages"}
								title="Go to the newest messages"
								disabled={goingToLatest}
								onClick={jump}
							>
								<Icon name="chevronDown" size={18} />
								{jumpLabel && <span>{jumpLabel}</span>}
							</button>
						)}
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
							<MentionTextarea
								id={draftId}
								className="chat-draft"
								rows={1}
								placeholder={draftPlaceholder(room)}
								value={draft}
								maxLength={CHAT_LIMITS.messageChars}
								onValueChange={setDraft}
								onKeyDown={onDraftKeyDown}
								mentions={mentions}
								placement="above"
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
	/** The key of the row. The list finds the row with it, to stay at the same message. */
	rowKey: string;
	/** The state of the send, for a message that the server does not have yet. */
	pending: PendingMessage | null;
	/** The handles for the mentions in the text, and the suggestions of the edit box. */
	mentions: MentionContext;
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
	rowKey,
	message,
	pending,
	mentions,
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
	const parts = useMemo(() => textParts(message.text, mentions.directory), [message.text, mentions.directory]);
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
			data-row={rowKey}
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
						<MentionTextarea
							id={editId}
							className="input chat-edit-draft"
							value={editing}
							maxLength={CHAT_LIMITS.messageChars}
							onValueChange={onEditChange}
							onKeyDown={(event) => {
								if (event.key === "Escape") onEditCancel();
							}}
							mentions={mentions}
							placement="below"
							// The person asked for the edit box, so the focus goes to it.
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
						{parts.map((part, index) =>
							part.person ? (
								<Link
									// The parts of one text keep their order, so the index is a stable key.
									// biome-ignore lint/suspicious/noArrayIndexKey: the same text always gives the same parts.
									key={index}
									to={profilePath(part.person.id)}
									className={part.person.id === mentions.ownId ? "chat-mention chat-mention-own" : "chat-mention"}
									title={part.person.display_name}
								>
									{part.text}
								</Link>
							) : (
								// biome-ignore lint/suspicious/noArrayIndexKey: the same text always gives the same parts.
								<Fragment key={index}>{part.text}</Fragment>
							),
						)}
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
