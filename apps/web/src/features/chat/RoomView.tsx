import {
	CHAT_LIMITS,
	type ChatBody,
	type ChatMessage,
	type ChatRoom,
	type ChatSection,
	type ChatSlashCommand,
	type Principal,
} from "@asterra/contracts";
import {
	Fragment,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { accountChangeCount } from "../../lib/account.ts";
import { api, errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { initials, plural } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { setPageTitle } from "../../lib/pageTitle.ts";
import { Link, navigate } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { useViewedRoom } from "../../lib/usePrincipalActivity.ts";
import { chatPath, chatSearchPath } from "../../routes.ts";
import { SEARCH_INPUT_ID } from "../../shell/nav.ts";
import { isOrgAdmin, useSession } from "../auth/session.tsx";
import { canSendWith, filesNote } from "./attachments.ts";
import { ChatComposer, type ChatComposerHandle } from "./ChatComposer.tsx";
import { AttachButton, AttachmentChips } from "./ComposerFiles.tsx";
import { createCallLine, createToggleLine } from "./callLine.ts";
import { bodyText, sameInBox, textToBody } from "./composerSchema.ts";
import { attachmentsOf, useAttachments, useOutbox, usePageVisible, useRoom } from "./data.ts";
import { MembersDialog, RoomSettingsDialog } from "./dialogs.tsx";
import { createDraftStore, draftStorage } from "./drafts.ts";
import { EditHistoryDialog } from "./EditHistoryDialog.tsx";
import { useFileDrop } from "./fileDrop.ts";
import { countEmoji, frequentEmoji } from "./frequentEmoji.ts";
import { ForwardDialog, ReminderDialog, ScheduleDialog } from "./Layer8Dialogs.tsx";
import { type Editing, editedBody, editSavable, MessageItem } from "./MessageItem.tsx";
import { canMentionGroups, type MentionContext, type MentionDirectory } from "./mentions.ts";
import {
	chatRows,
	dayLabel,
	draftPlaceholder,
	editCallFields,
	type LocalChange,
	newMessages,
	nextReading,
	type Reading,
	roomTitle,
	sameFileIds,
	startReading,
	startsDay,
	startsGroup,
	startsNew,
	unseenSendsNote,
} from "./model.ts";
import { PinsPanel } from "./PinsPanel.tsx";
import { Presence } from "./Presence.tsx";
import { useSearchKeys } from "./searchKeys.ts";
import { createSendSettler } from "./settle.ts";
import { ThreadPanel } from "./ThreadPanel.tsx";
import { useWantPeople } from "./usePeople.ts";

export interface RoomViewProps {
	roomId: string;
	/** The seq of the message that the path links to, or null. The list goes to that message and marks it. */
	focusSeq: number | null;
	/** The seq of a reply in the thread of that message, for a link to a reply, or null. The thread opens at it. */
	focusReplySeq: number | null;
	/** The room in the room list of the person, or null when the list does not have it. */
	listed: ChatRoom | null;
	/** True after the room list loaded. */
	listReady: boolean;
	/** The number of room lists that arrived. */
	listTick: number;
	/** Gets the room list again, after a change that this view made. */
	onRoomsChanged: () => Promise<void>;
	/** All joined rooms of the person, for forwarding messages. */
	rooms: readonly ChatRoom[];
	/** Custom sidebar sections of the person, for room settings. */
	sections: readonly ChatSection[];
	/** Reloads sidebar sections after a room is assigned to one. */
	onSectionsChanged: () => void;
	/** The people and the agents that the page asked for, with their handles, for the mentions. */
	directory: MentionDirectory<Principal>;
}

type RoomDialog =
	| { type: "members" }
	| { type: "settings" }
	| { type: "delete"; message: ChatMessage }
	| { type: "edits"; message: ChatMessage }
	| { type: "forward"; message: ChatMessage }
	| { type: "remind"; message: ChatMessage }
	| { type: "schedule"; body: ChatBody }
	| { type: "slash"; command: ChatSlashCommand; text: string }
	| { type: "slashResult"; command: string; operation: string; result: unknown }
	| null;

function renderSlashPreview(template: Record<string, unknown>, vars: Record<string, string>): string {
	const apply = (value: unknown): unknown => {
		if (typeof value === "string") {
			return value.replace(/\{\{(text|room_id|caller_id)\}\}/g, (_, key: string) => vars[key] ?? "");
		}
		if (Array.isArray(value)) return value.map(apply);
		if (value !== null && typeof value === "object") {
			return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, apply(v)]));
		}
		return value;
	};
	return JSON.stringify(apply(template), null, 2);
}

/** The width under which the view of a thread takes the width of the room and hides it. */
const THREAD_HIDES_ROOM = "(max-width: 899px)";

/** True while the media query matches. */
function useMediaQuery(query: string): boolean {
	return useSyncExternalStore(
		(change) => {
			const list = window.matchMedia(query);
			list.addEventListener("change", change);
			return () => list.removeEventListener("change", change);
		},
		() => window.matchMedia(query).matches,
	);
}

/** The distance from the end of the list, in pixels, under which a new message moves the list to its end. */
const STICK_PX = 80;

/** One room: its header, its messages and the box for a new message. */
export function RoomView({
	roomId,
	focusSeq,
	focusReplySeq,
	listed,
	listReady,
	listTick,
	onRoomsChanged,
	rooms,
	sections,
	onSectionsChanged,
	directory,
}: RoomViewProps) {
	const self = useSession().whoami.principal;
	const ownId = self.id;
	// An owner or an admin of the organization can read the earlier versions of a message.
	const readsEdits = isOrgAdmin(self);
	const toast = useToast();
	/** Takes each message from the socket and from a sync. It is set below, after the outbox. */
	const onChanges = useRef<(messages: readonly ChatMessage[]) => void>(() => {});
	const view = useRoom(
		roomId,
		{ version: listed?.version ?? null, tick: listTick },
		onRoomsChanged,
		useCallback((messages: readonly ChatMessage[]) => onChanges.current(messages), []),
	);
	/** The number of messages that the room stored for the person while the list was not at the newest messages. */
	const [sentUnseen, setSentUnseen] = useState(0);
	// A message shows in the list at once, and goes out behind it. The list then gets the stored message.
	const outbox = useOutbox(roomId, ownId, (message) => {
		view.apply(message);
		// The list does not take the message now. A line below the list tells that the room has it.
		if (view.hasNewer) setSentUnseen((count) => count + 1);
		void onRoomsChanged();
	});
	const visible = usePageVisible();
	const [dialog, setDialog] = useState<RoomDialog>(null);
	const [pinsOpen, setPinsOpen] = useState(false);
	const [slashCommands, setSlashCommands] = useState<readonly ChatSlashCommand[]>([]);
	useEffect(() => {
		let stopped = false;
		api
			.call("chat.list_slash_commands")
			.then((res) => {
				if (!stopped) setSlashCommands(res.commands);
			})
			.catch(() => {});
		return () => {
			stopped = true;
		};
	}, []);
	// The message in the box stays for the room when the person opens a different room, and after a reload.
	const drafts = useMemo(() => createDraftStore(draftStorage(), ownId), [ownId]);
	// The emoji that the person uses most, for the quick reactions of each message. The list is the list
	// of the time that the room opened, so a button does not move after a click on it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new room reads the counts again.
	const quickEmoji = useMemo(() => frequentEmoji(draftStorage(), ownId), [ownId, roomId]);
	/** The reaction calls of each "message id" and "emoji": see `createToggleLine`. */
	const reactions = useMemo(() => createToggleLine(), []);
	const [draft, setDraftBody] = useState<ChatBody | null>(() => drafts.get(roomId));
	const draftRef = useRef<ChatBody | null>(draft);
	draftRef.current = draft;
	const [composerVersion, setComposerVersion] = useState(0);
	const serverDraftTimer = useRef<number | null>(null);
	useEffect(() => {
		if (drafts.get(roomId) !== null) return;
		let stopped = false;
		api
			.call("chat.list_drafts")
			.then((res) => {
				if (stopped || draftRef.current !== null) return;
				const match = res.drafts.find((d) => d.room_id === roomId && d.parent_id === null);
				if (!match?.text.trim()) return;
				const hydrated = match.body ?? textToBody(match.text);
				drafts.set(roomId, hydrated);
				setDraftBody(hydrated);
				setComposerVersion((v) => v + 1);
			})
			.catch(() => {});
		return () => {
			stopped = true;
		};
	}, [drafts, roomId]);
	function setDraft(body: ChatBody | null) {
		if (body !== null) view.typing();
		setDraftBody(body);
		drafts.set(roomId, body);
		if (serverDraftTimer.current !== null) window.clearTimeout(serverDraftTimer.current);
		serverDraftTimer.current = window.setTimeout(() => {
			if (body && bodyText(body).trim() !== "") {
				void api.call("chat.save_draft", { room_id: roomId, body }).catch(() => {});
			} else {
				void api.call("chat.delete_draft", { room_id: roomId }).catch(() => {});
			}
		}, 1500);
	}
	useEffect(
		() => () => {
			if (serverDraftTimer.current !== null) window.clearTimeout(serverDraftTimer.current);
		},
		[],
	);
	const composer = useRef<ChatComposerHandle>(null);
	/** The characters of the draft above the limit of the plain text, or 0. */
	const draftOver = draft ? Math.max(0, bodyText(draft).length - CHAT_LIMITS.messageChars) : 0;
	// The files of the new message upload at once, to the drive of the person. They stay for the room when
	// the person opens a different room, until a reload.
	const attachments = useMemo(() => attachmentsOf(ownId, roomId), [ownId, roomId]);
	const files = useAttachments(attachments);
	/** True when the message has text or files, and each file is in the drive. */
	const canSend = canSendWith(draft !== null, files.list) && draftOver === 0;
	const addFiles = useCallback(
		(added: File[], folders: readonly string[] = []) => {
			if (folders.length > 0) {
				toast({ message: "A folder cannot go into a message. Drop the files that are in it.", tone: "error" });
			}
			attachments.add(added);
		},
		[attachments, toast],
	);
	/** True while the person drags files over the list or the box. */
	const dropping = useFileDrop("room", addFiles);
	const [joining, setJoining] = useState(false);
	/** The star that the person set, until the room list has it. Null when no call runs. */
	const [starring, setStarring] = useState<boolean | null>(null);
	/**
	 * The star of the last answer of `chat.star_room`, until the room loads again. A room that is not in
	 * the list shows it: it is newer than the room of the load.
	 */
	const [answeredStar, setAnsweredStar] = useState<boolean | null>(null);
	/** The end of the line of star calls. Each call starts after the call before it ends. */
	const starCalls = useRef<Promise<void>>(Promise.resolve());
	/** The number of star clicks. Only the last click clears the star of the button. */
	const starClicks = useRef(0);
	/** True while a read of the newest messages runs for this view. */
	const [goingToLatest, setGoingToLatest] = useState(false);
	/** True after the person used a button of the list. The focus then stays in the list when the button goes. */
	const refocus = useRef(false);
	const [editing, setEditing] = useState<Editing | null>(null);
	/** The id of the message whose thread shows beside the room, or null. */
	const [threadId, setThreadId] = useState<string | null>(null);
	/**
	 * The reply that the open thread goes to and marks, for a link to a reply, or null. Each visit of a link
	 * gives a new object, so the thread goes to the reply again, also for the same seq.
	 */
	const [threadFocus, setThreadFocus] = useState<{ seq: number } | null>(null);
	/** A link to a reply that waits for the first message of its thread in the list. */
	const [threadLink, setThreadLink] = useState<{ seq: number; replySeq: number } | null>(null);
	/** The element that opened the thread. It gets the focus back when the thread closes. */
	const threadOpener = useRef<HTMLElement | null>(null);
	/** True from the close of a thread until the focus is back, after the room shows again. */
	const focusAfterThread = useRef(false);
	/** True on a narrow screen, where the view of a thread hides the room (see `.chat-thread` in chat.css). */
	const narrow = useMediaQuery(THREAD_HIDES_ROOM);
	const threadHidesRoom = threadId !== null && narrow;
	const openThread = useCallback((id: string, replySeq: number | null = null) => {
		threadOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		setThreadId(id);
		setThreadFocus(replySeq === null ? null : { seq: replySeq });
	}, []);
	const scrollRef = useRef<HTMLDivElement>(null);
	// A path with a message opens the list at that message, not at its end.
	const stick = useRef(focusSeq === null);
	/** True while the list is at its end. It is `stick` for the page: the read state and the button to the end use it. */
	const [atEnd, setAtEnd] = useState(focusSeq === null);
	/** The seq of the message that a link marked, or null. */
	const [marked, setMarked] = useState<number | null>(null);
	/** The seq of the message that the list must go to at the next change of the rows, or null. */
	const scrollTarget = useRef<number | null>(null);
	/** The link that the view went to ("<seq>" or "<seq>/<reply seq>"). A view goes to a link one time. */
	const wentTo = useRef<string | null>(null);
	/** The number of times that the view went to a link. The list moves to the message at each one. */
	const [focusTick, setFocusTick] = useState(0);
	/** What the person saw of the room, for the "New messages" line. Null until the room loads. */
	const [reading, setReading] = useState<Reading | null>(null);
	/** The first row that shows, with its distance from the top of the list, before the rows change. */
	const place = useRef<{ key: string; top: number } | null>(null);
	const markedSeq = useRef(0);
	const draftId = useId();

	// The room list follows each change, so its room is newer than the room of the first load.
	const room = listed ?? view.room;
	// A new load of the room is newer than the answer of a star call from before it.
	const loadedForStar = view.room;
	useEffect(() => {
		if (loadedForStar) setAnsweredStar(null);
	}, [loadedForStar]);
	const title = room ? roomTitle(room) : "Chat";
	const fail = (caught: unknown) => toast({ message: errorMessage(caught), tone: "error" });

	useEffect(() => {
		setPageTitle(`${title} – Asterra Chat`);
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
	/** The messages as the room has them now, for a call that starts after earlier calls. */
	const messagesNow = useRef(messages);
	messagesNow.current = messages;
	// A list from the cache is not the room of now: the person reads the room after its load.
	// On a narrow screen, the view of a thread hides the room, so the person does not read it.
	const looking = view.status === "ready" && view.fresh && visible && atEnd && !view.hasNewer && !threadHidesRoom;

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
	// The socket brings a change of the members. Without a socket, for example after the room replaced
	// it, the room list shows the change: its number of members is not the number that the page has.
	const listedCount = listed?.member_count;
	const fresh = view.status === "ready" && view.fresh;
	const loadMembers = view.loadMembers;
	useEffect(() => {
		if (fresh && listedCount !== undefined && listedCount !== members.length) void loadMembers();
	}, [fresh, listedCount, members.length, loadMembers]);
	// The `@` list puts the members first, with their handles. The members are at most 500, so this read
	// follows the room, not the directory. The page does not read again a member that a message asked for.
	const wantPeople = useWantPeople();
	useEffect(() => {
		wantPeople({ ids: members.map((member) => member.principal_id) });
	}, [wantPeople, members]);
	const ownRole = (listed ?? view.room)?.role ?? null;
	const mentions = useMemo<MentionContext>(
		() => ({
			directory,
			memberIds: new Set(members.map((member) => member.principal_id)),
			ownId,
			groups: canMentionGroups(ownRole, members.length),
		}),
		[directory, members, ownId, ownRole],
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

	// The answers of a send can fail after the server stored the message. When the room has a message
	// with the key of the send, the send did not fail: the row of the send becomes the row of the
	// stored message (`settle.ts`). The room can tell of the message through the socket or a sync
	// while the list does not take it, for example a list at older messages. A message of a send is
	// always after the newest message of the room, so the line below such a list tells of it.
	const listAtOlder = useRef(hasNewer);
	listAtOlder.current = hasNewer;
	const settler = useMemo(
		() =>
			createSendSettler({
				own: { principal_id: ownId, kind: self.kind, display_name: self.display_name },
				state: outbox.getState,
				settle: outbox.settle,
				onSettled: (count) => {
					if (listAtOlder.current) setSentUnseen((unseen) => unseen + count);
				},
			}),
		[ownId, self.kind, self.display_name, outbox.getState, outbox.settle],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a change of the outbox can make a send settle.
	useLayoutEffect(() => {
		settler.check(messages);
	}, [messages, outbox.state, settler]);
	onChanges.current = (incoming) => settler.fromRoom(incoming);

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
		// A link to a message: the message goes to the middle of the list. A room that does not have
		// the message shows its newest messages.
		const target = scrollTarget.current;
		if (target !== null) {
			scrollTarget.current = null;
			const row = list.querySelector<HTMLElement>(`[data-seq="${target}"]`);
			if (row) {
				row.scrollIntoView({ block: "center" });
				onScroll();
				return;
			}
			setStick(!hasNewer);
		}
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
	}, [rows, view.hasOlder, hasNewer, reading?.newAfter, focusTick]);

	// The list also stays at the same message when its size changes: the window gets a different
	// width, or the keyboard of a phone opens.
	const isMember = view.status === "ready" && (listed ?? view.room)?.role != null;
	useViewedRoom(isMember ? roomId : null);
	// Ctrl+F and ⌘F search this room. Only a member can search a room: for each other person, and while the
	// room loads, the search is in all rooms.
	useSearchKeys(() => navigate(chatSearchPath("", isMember ? roomId : null)));
	// After a close, the focus goes back to the button that opened the thread, or to the box of the room. It
	// waits for the commit: on a narrow screen the room is hidden while the view of the thread shows.
	useEffect(() => {
		if (threadId !== null || !focusAfterThread.current) return;
		focusAfterThread.current = false;
		const opener = threadOpener.current;
		if (opener?.isConnected) opener.focus();
		else composer.current?.focus();
	}, [threadId]);

	// A person who is no longer a member sees no thread, and a later join does not open it again.
	useEffect(() => {
		if (!isMember) setThreadId(null);
	}, [isMember]);
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

	// A send from a list that cannot take its stored message yet: a list from the cache before the load
	// of the room (the sync has no version), or a list at older messages. The outbox has the message,
	// and starts no call until the list can take it. Without the hold, the answer of the send can come
	// first: the message leaves the outbox, the list drops it, and the person sees it go away.
	const holding = useRef(false);
	const resumeOutbox = outbox.resume;
	const release = useCallback(() => {
		if (!holding.current) return;
		holding.current = false;
		resumeOutbox();
	}, [resumeOutbox]);
	const listWaits = view.status === "ready" && (!view.fresh || hasNewer);
	useEffect(() => {
		if (!listWaits) release();
	}, [listWaits, release]);
	// The page leaves the room. The message still goes out.
	useEffect(() => release, [release]);
	useEffect(() => {
		if (!hasNewer) setSentUnseen(0);
	}, [hasNewer]);

	function send() {
		if (!canSend) return;
		const plain = draft ? bodyText(draft).trim() : "";
		if (plain.startsWith("/") && files.list.length === 0) {
			const match = /^\/([a-z0-9][a-z0-9_-]*)(?:\s+(.*))?$/s.exec(plain);
			const cmdName = match?.[1];
			const matchedCmd = cmdName ? slashCommands.find((c) => c.command === cmdName) : undefined;
			if (matchedCmd) {
				const argText = (match?.[2] ?? "").trim();
				setDialog({ type: "slash", command: matchedCmd, text: argText });
				return;
			}
		}
		// Each file is in the drive, so the outbox carries only the files. They leave the box at once.
		const sentFiles = attachments.take() ?? [];
		// A new message goes after the newest message of the room. When the list is not there, it goes
		// there. The outbox takes the message now, so the text is the text of this moment, and it stays
		// after a reload and after a different room opens.
		if (listWaits && !holding.current) {
			holding.current = true;
			outbox.pause();
			// A list from the cache waits for the load of the room, which runs. A list at older messages
			// must go to the newest messages.
			if (hasNewer) {
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
		}
		// The message shows in the list at once. The outbox sends it, and tries again after a failure.
		outbox.send(draft ? bodyText(draft) : "", draft ?? undefined, sentFiles);
		attachments.release(sentFiles);
		setDraft(null);
		composer.current?.clear();
		setStick(true);
		// The person answers: the messages above are not new for the person now.
		setReading((current) => current && { ...current, newAfter: null, lineSeen: false });
	}

	// A link to one message. The list goes there after the load of the room, one time for each link.
	// A message that the list does not have comes with the page around it.
	const toMessage = view.toMessage;
	const cancelReads = view.cancelReads;
	const canFocus = view.status === "ready" && view.fresh && isMember;
	// biome-ignore lint/correctness/useExhaustiveDependencies: the view goes to a link one time, when the room is ready.
	useEffect(() => {
		const link = focusSeq === null ? null : focusReplySeq === null ? `${focusSeq}` : `${focusSeq}/${focusReplySeq}`;
		if (!canFocus || wentTo.current === link) return;
		// The path changed to a different message, or to the room without a message. A read for the
		// link from before must not put the list at that message.
		cancelReads();
		wentTo.current = link;
		setThreadLink(null);
		if (focusSeq === null) return;
		const show = () => {
			setStick(false);
			scrollTarget.current = focusSeq;
			setMarked(focusSeq);
			// The list goes to the message at the next change of this number, also when the rows are the same.
			setFocusTick((tick) => tick + 1);
			// A link to a reply opens the thread of the message when the list has it.
			if (focusReplySeq !== null) setThreadLink({ seq: focusSeq, replySeq: focusReplySeq });
		};
		if (messages.some((message) => message.seq === focusSeq)) show();
		else {
			toMessage(focusSeq).then((applied) => {
				if (applied && wentTo.current === link) show();
			}, fail);
		}
	}, [focusSeq, focusReplySeq, canFocus]);

	// A link to a reply: the thread of the first message opens at the reply, when the list has that message.
	useEffect(() => {
		if (!threadLink) return;
		const parent = messages.find((message) => message.seq === threadLink.seq);
		if (!parent) return;
		setThreadLink(null);
		openThread(parent.parent_id ?? parent.id, threadLink.replySeq);
	}, [threadLink, messages, openThread]);

	/** Puts a link to a message on the clipboard. */
	function copyLink(seq: number) {
		const link = new URL(chatPath(roomId, seq), window.location.origin).href;
		navigator.clipboard.writeText(link).then(
			() => toast({ message: "The link to the message is on the clipboard.", tone: "info" }),
			() => toast({ message: "The browser did not permit a copy to the clipboard.", tone: "error" }),
		);
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
		if (!editing || !editSavable(editing)) return;
		const opened = editing;
		const { id, files: keptFiles } = opened;
		const body = editedBody(opened);
		setEditing(null);
		// The body that shows: the body of an edit that waits, or the body that the room has.
		const waiting = latest.current.get(id);
		const stored = messages.find((message) => message.id === id);
		const shown = waiting?.kind === "edit" ? waiting.body : stored && (stored.body ?? textToBody(stored.text));
		// A part changed when it differs from the part that the edit box opened with. The message can change on a
		// different device while the box is open: a part that the person did not touch must not go back.
		const textChanged = body !== null && !sameInBox(opened.base, body);
		const filesChanged = !sameFileIds(keptFiles, opened.initialFiles);
		if (!textChanged && !filesChanged) return;
		// The new body and files show at once. An edit without a new text keeps the text.
		const newBody = textChanged && body ? body : (shown ?? opened.base);
		// A newer change replaces an earlier one that did not go, so it takes the parts that the earlier one
		// changed. An edit of one part leaves the other part as the server has it.
		const earlier = waiting?.kind === "edit" ? waiting : undefined;
		const bodySet = textChanged || earlier?.bodySet === true;
		const wantedFiles = filesChanged ? keptFiles : earlier?.files;
		const change: LocalChange = {
			kind: "edit",
			body: newBody,
			text: bodyText(newBody),
			at: new Date().toISOString(),
			...(wantedFiles ? { files: wantedFiles } : {}),
			...(bodySet ? { bodySet: true } : {}),
		};
		showChange(id, change);
		afterEarlierCalls(id, async () => {
			// A newer change replaced this one before its call started. Only the newest change goes.
			if (latest.current.get(id) !== change) return;
			// The call sends each changed part that differs from the message that the room has now.
			const fields = editCallFields(
				change,
				messagesNow.current.find((message) => message.id === id),
			);
			if (fields === null) {
				endChange(id, change);
				return;
			}
			try {
				const { message } = await api.call("chat.edit_message", { room_id: roomId, message_id: id, ...fields });
				view.apply(message);
				// The next queued call of the message can start before the next render. It must compare with this
				// answer, not with the message before it. A socket event with a newer version of the message stays.
				messagesNow.current = messagesNow.current.map((current) =>
					current.id === message.id && message.version >= current.version ? message : current,
				);
				endChange(id, change);
			} catch (caught) {
				// After a refusal, the old message shows again, and the edit box opens with the new body and files,
				// so the person does not do the edit again. A newer change of the message stays as it is.
				if (!endChange(id, change)) return;
				// The box shows the text of the edit: the new text, or the text that the room had when the person did not
				// change it. A changed text keeps the text from before the edit as its base, so a second save sends it
				// again. An unchanged text takes the text of the room as its base, so a second save does not send it.
				setEditing(
					(current) =>
						current ?? {
							id,
							initial: newBody,
							base: textChanged ? opened.base : newBody,
							body: newBody,
							initialFiles: opened.initialFiles,
							files: keptFiles,
						},
				);
				fail(caught);
			}
		});
	}

	/** Removes the preview of a link of an own message. The link stays in the text. */
	function removePreview(id: string, url: string) {
		api.call("chat.remove_link_preview", { room_id: roomId, message_id: id, url }).then(({ message }) => {
			view.apply(message);
		}, fail);
	}

	/**
	 * Adds or removes a reaction of the person. The message shows the answer of the room. A second click
	 * of the same kind while its call runs does nothing, so one reaction counts one time. A click of the other
	 * kind waits for that call: the socket can show the reaction before the answer, and the click must not get
	 * lost.
	 */
	function react(id: string, emoji: string, add: boolean) {
		const signedIn = accountChangeCount();
		reactions(`${id} ${emoji}`, add, async () => {
			// A click that waited does not go out after a sign-out: the next sign-in is a different session.
			if (accountChangeCount() !== signedIn) return;
			try {
				const { message } = await api.call(add ? "chat.add_reaction" : "chat.remove_reaction", {
					room_id: roomId,
					message_id: id,
					emoji,
				});
				view.apply(message);
				// A reaction that the room took counts for the quick reactions of the person. After a sign-out,
				// the counts of the person are gone, and a late answer must not write them again.
				if (add && accountChangeCount() === signedIn) countEmoji(draftStorage(), ownId, emoji);
			} catch (caught) {
				fail(caught);
			}
		});
	}

	function togglePin(message: ChatMessage) {
		const call = message.pinned
			? api.call("chat.unpin_message", { room_id: roomId, message_id: message.id })
			: api.call("chat.pin_message", { room_id: roomId, message_id: message.id });
		call.then(() => {
			toast({ message: message.pinned ? "Message unpinned." : "Message pinned.", tone: "info" });
			void view.reload();
		}, fail);
	}

	function saveMessage(message: ChatMessage) {
		api.call("chat.save_message", { room_id: roomId, message_id: message.id }).then(() => {
			toast({ message: "Message saved.", tone: "info" });
		}, fail);
	}

	function triggerCardAction(messageId: string, cardId: string, actionId: string) {
		api
			.call("chat.trigger_card_action", {
				room_id: roomId,
				message_id: messageId,
				card_id: cardId,
				action_id: actionId,
				idempotency_key: crypto.randomUUID(),
			})
			.then(() => {
				toast({ message: "Action recorded.", tone: "info" });
			}, fail);
	}

	function onListKeyDown(event: React.KeyboardEvent<HTMLOListElement>) {
		if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
		const target = event.target as HTMLElement | null;
		if (!target || target.closest("input, textarea, [contenteditable='true']")) return;
		const items = [...event.currentTarget.querySelectorAll<HTMLElement>(":scope > li[data-row]")];
		if (items.length === 0) return;
		const currentRow = target.closest<HTMLElement>("li[data-row]");
		const idx = currentRow ? items.indexOf(currentRow) : -1;
		const nextIdx =
			event.key === "ArrowUp"
				? idx <= 0
					? items.length - 1
					: idx - 1
				: idx < 0 || idx >= items.length - 1
					? 0
					: idx + 1;
		event.preventDefault();
		items[nextIdx]?.focus();
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

	/**
	 * Sets or removes the star of the person. The button changes at once, and goes back after a refusal.
	 * A click while a call runs waits in a line: two calls at the same time can reach the room in the
	 * other order, and a click must not get lost.
	 */
	function setStar(starred: boolean) {
		const click = ++starClicks.current;
		setStarring(starred);
		starCalls.current = starCalls.current.then(async () => {
			try {
				const answer = await api.call("chat.star_room", { room_id: roomId, starred });
				setAnsweredStar(answer.room.starred);
				// The list puts the room in its part of the sidebar. The events socket brings it too.
				await onRoomsChanged();
			} catch (caught) {
				fail(caught);
			}
			// A later click keeps its own star on the button until its call ends.
			if (click === starClicks.current) setStarring(null);
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
					<Icon name={room.kind === "group_dm" ? "team" : room.kind === "private" ? "lock" : "hash"} size={22} />
				)}
				<div className="chat-room-heading">
					<h1 className="chat-title">
						{room.kind === "dm" && <span className="visually-hidden">Direct message with </span>}
						{title}
					</h1>
					{room.archived_at !== null && <span className="kind">archived</span>}
					{room.role !== null && (
						<StarButton starred={starring ?? listed?.starred ?? answeredStar ?? room.starred} onChange={setStar} />
					)}
				</div>
				{room.peer && (
					<span className="chat-peer-detail">
						<Presence id={room.peer.principal_id} agent={room.peer.kind === "agent"} compact />
						{room.peer.kind === "agent" && <span className="kind kind-agent">agent</span>}
					</span>
				)}
				{room.topic && <p className="chat-topic">{room.topic}</p>}
				<span className="chat-header-actions">
					{isMember && <RoomSearch roomId={roomId} title={title} />}
					{isMember && (
						<button
							type="button"
							className={pinsOpen ? "chat-header-button chat-header-button-active" : "chat-header-button"}
							onClick={() => setPinsOpen((open) => !open)}
							aria-label={`Pinned messages: ${view.pinCount}`}
							aria-pressed={pinsOpen}
							title="Pinned messages"
						>
							<Icon name="tag" />
							{view.pinCount > 0 && view.pinCount}
						</button>
					)}
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
					{isMember && (
						<button
							type="button"
							className="icon-button"
							aria-label="Room settings"
							title="Room settings"
							onClick={() => setDialog({ type: "settings" })}
						>
							<Icon name="settings" />
						</button>
					)}
				</span>
			</header>

			{isMember ? (
				<>
					{/* The list and the box take the files of a drop (`useFileDrop`). */}
					<div className="chat-list" data-file-drop="room">
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
							<ol className="chat-messages" role="log" aria-label={`Messages of ${title}`} onKeyDown={onListKeyDown}>
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
												marked={pending === null && message.seq === marked}
												onCopyLink={() => copyLink(message.seq)}
												message={message}
												pending={pending}
												mentions={mentions}
												head={isNew || startsGroup(previous, message)}
												own={message.author.principal_id === ownId}
												canDelete={message.author.principal_id === ownId || room.role === "owner"}
												editing={editing?.id === message.id ? editing : null}
												onEditStart={() => {
													const initial = message.body ?? textToBody(message.text);
													setEditing({
														id: message.id,
														initial,
														base: initial,
														body: initial,
														initialFiles: message.files,
														files: message.files,
													});
												}}
												onEditChange={(body) => setEditing((current) => current && { ...current, body })}
												onEditRemoveFile={(itemId) =>
													setEditing(
														(current) =>
															current && { ...current, files: current.files.filter((file) => file.item_id !== itemId) },
													)
												}
												onEditSave={saveEdit}
												onEditCancel={() => setEditing(null)}
												onDelete={() => setDialog({ type: "delete", message })}
												onShowEdits={readsEdits ? () => setDialog({ type: "edits", message }) : null}
												// A reply that also went to the room opens the thread of its parent.
												onOpenThread={pending === null ? () => openThread(message.parent_id ?? message.id) : null}
												onRemovePreview={(url) => removePreview(message.id, url)}
												onFocusBox={() => composer.current?.focus()}
												onMediaLoad={holdPlace}
												onSendAgain={() => outbox.retry(key)}
												onSendCancel={() => outbox.discard(key)}
												ownId={ownId}
												quickEmoji={quickEmoji}
												onReact={(emoji, add) => react(message.id, emoji, add)}
												onTogglePin={room.archived_at === null ? () => togglePin(message) : undefined}
												onSave={() => saveMessage(message)}
												onRemind={() => setDialog({ type: "remind", message })}
												onForward={() => setDialog({ type: "forward", message })}
												onCardAction={(cardId, actionId) => triggerCardAction(message.id, cardId, actionId)}
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
						{dropping && (
							<div className="chat-drop" aria-hidden="true">
								<Icon name="paperclip" size={18} />
								<span>Drop the files to add them to your message</span>
							</div>
						)}
					</div>
					{room.archived_at !== null || !room.can_post ? (
						<p className="chat-readonly-banner" role="status">
							{room.archived_at !== null
								? "This room is archived. Messages are read-only."
								: "Posting in this room is restricted by its posting rules."}
						</p>
					) : (
						<form
							className="chat-composer"
							data-file-drop="room"
							onSubmit={(event) => {
								event.preventDefault();
								send();
							}}
						>
							<p className="chat-typing" role="status">
								{typingLabel(view.members, view.typists)}
							</p>
							{(() => {
								const raw = draft ? bodyText(draft) : "";
								if (!raw.startsWith("/") || slashCommands.length === 0) return null;
								const prefix = raw.slice(1).split(/\s+/)[0]?.toLowerCase() ?? "";
								const matching = slashCommands.filter((c) => c.command.startsWith(prefix)).slice(0, 6);
								if (matching.length === 0) return null;
								return (
									<ul className="chat-slash-hints" aria-label="Slash commands">
										{matching.map((cmd) => (
											<li key={cmd.id}>
												<code>/{cmd.command}</code>
												{cmd.usage_hint && <span className="muted"> {cmd.usage_hint}</span>}
												<span className="chat-slash-desc"> — {cmd.description}</span>
											</li>
										))}
									</ul>
								);
							})()}
							<div className={dropping ? "chat-composer-box chat-composer-box-drop" : "chat-composer-box"}>
								<ChatComposer
									key={composerVersion}
									ref={composer}
									id={draftId}
									label={`Message to ${title}`}
									placeholder={draftPlaceholder(room)}
									initial={draft}
									onChange={setDraft}
									onSubmit={send}
									onFiles={addFiles}
									mentions={mentions}
									placement="above"
									files={
										<AttachmentChips
											files={files.list}
											notice={files.notice}
											onRetry={attachments.retry}
											onRemove={attachments.remove}
											onFocusAway={() => composer.current?.focus()}
										/>
									}
								>
									<span className="chat-composer-actions">
										<AttachButton count={files.list.length} onFiles={addFiles} />
										{draft && bodyText(draft).trim() !== "" && files.list.length === 0 && (
											<button
												type="button"
												className="icon-button icon-button-small"
												aria-label="Schedule message"
												title="Schedule message"
												onClick={() => setDialog({ type: "schedule", body: draft })}
											>
												<Icon name="clock" size={16} />
											</button>
										)}
										<button
											type="submit"
											className="chat-send"
											aria-label="Send the message"
											title="Send (Enter)"
											disabled={!canSend}
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
							{draftOver > 0 && (
								<p className="chat-composer-limit" role="status">
									The message has {plural(draftOver, "character")} more than the limit of{" "}
									{CHAT_LIMITS.messageChars.toLocaleString()}.
								</p>
							)}
						</form>
					)}
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

			{threadId !== null && room.role !== null && (
				<ThreadPanel
					key={threadId}
					roomId={roomId}
					roomTitle={title}
					parentId={threadId}
					focus={threadFocus}
					mentions={mentions}
					canDeleteAll={room.role === "owner"}
					watch={view.watchMessages}
					onSentToRoom={view.apply}
					onClose={() => {
						focusAfterThread.current = true;
						setThreadId(null);
					}}
				/>
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
			{pinsOpen && isMember && (
				<PinsPanel
					roomId={roomId}
					canUnpin={room.archived_at === null}
					onClose={() => setPinsOpen(false)}
					onJump={(seq) => {
						setPinsOpen(false);
						navigate(chatPath(roomId, seq));
					}}
					onChanged={() => void view.reload()}
				/>
			)}
			{dialog?.type === "settings" && isMember && (
				<RoomSettingsDialog
					room={room}
					members={view.members}
					postAllowedIds={view.postAllowedIds}
					sections={sections}
					onClose={() => setDialog(null)}
					onDetailsSaved={() => {
						void onRoomsChanged();
						onSectionsChanged();
						void view.reload();
					}}
					onDeleted={() => {
						void onRoomsChanged();
					}}
				/>
			)}
			{dialog?.type === "forward" && (
				<ForwardDialog roomId={roomId} message={dialog.message} rooms={rooms} onClose={() => setDialog(null)} />
			)}
			{dialog?.type === "remind" && (
				<ReminderDialog roomId={roomId} message={dialog.message} onClose={() => setDialog(null)} />
			)}
			{dialog?.type === "schedule" && (
				<ScheduleDialog
					roomId={roomId}
					body={dialog.body}
					onClose={() => setDialog(null)}
					onScheduled={() => {
						setDraft(null);
						composer.current?.clear();
					}}
				/>
			)}
			{dialog?.type === "edits" &&
				(() => {
					// The newest copy of the message: the author can change it while the dialog is open. A delete
					// removes the earlier versions, so the dialog closes and shows none of them.
					const current = messages.find((one) => one.id === dialog.message.id) ?? dialog.message;
					if (current.deleted) return null;
					return (
						<EditHistoryDialog
							key={current.edited_at ?? ""}
							roomId={roomId}
							message={current}
							mentions={mentions}
							onClose={() => setDialog(null)}
						/>
					);
				})()}
			{dialog?.type === "slash" && (
				<ConfirmDialog
					title={`Run /${dialog.command.command}?`}
					confirmLabel="Run command"
					onClose={() => setDialog((current) => (current?.type === "slash" ? null : current))}
					onConfirm={async () => {
						const { command, text } = dialog;
						const res = await api.call("chat.invoke_slash_command", {
							room_id: roomId,
							command: command.command,
							...(text ? { text } : {}),
						});
						setDraft(null);
						composer.current?.clear();
						if (command.operation === "chat.post_message") {
							toast({ message: `Ran /${command.command}.`, tone: "info" });
							void view.sync();
						} else {
							setDialog({
								type: "slashResult",
								command: command.command,
								operation: res.operation,
								result: res.result,
							});
						}
					}}
				>
					<p>
						This command runs <code>{dialog.command.operation}</code> with your permissions.
					</p>
					{Object.keys(dialog.command.input_template).length > 0 ? (
						<pre className="chat-slash-preview">
							{renderSlashPreview(dialog.command.input_template, {
								text: dialog.text,
								room_id: roomId,
								caller_id: ownId,
							})}
						</pre>
					) : (
						<p>
							{dialog.command.description}
							{dialog.text ? ` Input: ${dialog.text}` : ""}
						</p>
					)}
				</ConfirmDialog>
			)}
			{dialog?.type === "slashResult" && (
				<ConfirmDialog
					title={`/${dialog.command} result`}
					confirmLabel="Done"
					onClose={() => setDialog(null)}
					onConfirm={async () => {
						setDialog(null);
					}}
				>
					<p>
						Output from <code>{dialog.operation}</code>:
					</p>
					<pre className="chat-slash-preview">{JSON.stringify(dialog.result, null, 2)}</pre>
				</ConfirmDialog>
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

/** The star of the person on the room, as in the header of a Drive item. A set star is solid. */
function StarButton({ starred, onChange }: { starred: boolean; onChange: (starred: boolean) => void }) {
	const label = starred ? "Remove star" : "Star";
	return (
		<button
			type="button"
			className={starred ? "icon-button icon-button-star" : "icon-button"}
			aria-label={label}
			aria-pressed={starred}
			title={label}
			onClick={() => onChange(!starred)}
		>
			<Icon name="star" filled={starred} />
		</button>
	);
}

/**
 * The search of the room, in its header: a box for the query. The Search view shows the results, for
 * this room only. At a small width, the header has a button that opens that view.
 */
function RoomSearch({ roomId, title }: { roomId: string; title: string }) {
	const [query, setQuery] = useState("");
	const label = `Search in ${title}`;
	return (
		<>
			<search className="search chat-header-search">
				<form
					onSubmit={(event) => {
						event.preventDefault();
						if (query.trim() !== "") navigate(chatSearchPath(query.trim(), roomId));
					}}
				>
					<label htmlFor={SEARCH_INPUT_ID} className="visually-hidden">
						{label}
					</label>
					<Icon name="search" size={16} className="search-icon" />
					<input
						id={SEARCH_INPUT_ID}
						className="search-input"
						type="search"
						placeholder="Search in this room"
						autoComplete="off"
						spellCheck={false}
						maxLength={500}
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
				</form>
			</search>
			<Link
				to={chatSearchPath("", roomId)}
				className="icon-button chat-header-search-link"
				aria-label={label}
				title={label}
			>
				<Icon name="search" />
			</Link>
		</>
	);
}

function typingLabel(
	members: readonly { principal_id: string; display_name: string }[],
	typists: ReadonlyMap<string, number>,
): string {
	if (typists.size === 0) return "";
	const names = members.filter((member) => typists.has(member.principal_id)).map((member) => member.display_name);
	if (typists.size === 1) return `${names[0] ?? "Someone"} is typing…`;
	if (typists.size === 2 && names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
	return `${typists.size} people are typing…`;
}
