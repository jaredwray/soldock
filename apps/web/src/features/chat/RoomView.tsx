import { CHAT_LIMITS, type ChatBody, type ChatMessage, type ChatRoom, type Principal } from "@soldock/contracts";
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { accountChangeCount } from "../../lib/account.ts";
import { api, errorMessage } from "../../lib/api.ts";
import { ConfirmDialog } from "../../lib/ConfirmDialog.tsx";
import { fullDate, initials, plural, shortDate } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { Link, navigate } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { chatPath, profilePath } from "../../routes.ts";
import { isOrgAdmin, useSession } from "../auth/session.tsx";
import { ChatComposer, type ChatComposerHandle } from "./ChatComposer.tsx";
import { createCallLine } from "./callLine.ts";
import { bodyText, sameInBox, textToBody } from "./composerSchema.ts";
import { useOutbox, usePageVisible, useRoom } from "./data.ts";
import { MembersDialog, RoomSettingsDialog } from "./dialogs.tsx";
import { createDraftStore, draftStorage } from "./drafts.ts";
import { EditHistoryDialog } from "./EditHistoryDialog.tsx";
import { emojiName } from "./emoji.ts";
import { countEmoji, frequentEmoji } from "./frequentEmoji.ts";
import { MessageBody } from "./MessageBody.tsx";
import { canMentionGroups, type MentionContext, type MentionDirectory } from "./mentions.ts";
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
	timeLabel,
	unseenSendsNote,
} from "./model.ts";
import type { PendingMessage } from "./outbox.ts";
import { ReactionPicker, Reactions } from "./Reactions.tsx";
import { createSendSettler } from "./settle.ts";

export interface RoomViewProps {
	roomId: string;
	/** The seq of the message that the path links to, or null. The list goes to that message and marks it. */
	focusSeq: number | null;
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

type RoomDialog =
	| { type: "members" }
	| { type: "settings" }
	| { type: "delete"; message: ChatMessage }
	| { type: "edits"; message: ChatMessage }
	| null;

/** The distance from the end of the list, in pixels, under which a new message moves the list to its end. */
const STICK_PX = 80;

/** One room: its header, its messages and the box for a new message. */
export function RoomView({ roomId, focusSeq, listed, listReady, listTick, onRoomsChanged, directory }: RoomViewProps) {
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
	// The message in the box stays for the room when the person opens a different room, and after a reload.
	const drafts = useMemo(() => createDraftStore(draftStorage(), ownId), [ownId]);
	// The emoji that the person uses most, for the quick reactions of each message. The list is the list
	// of the time that the room opened, so a button does not move after a click on it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new room reads the counts again.
	const quickEmoji = useMemo(() => frequentEmoji(draftStorage(), ownId), [ownId, roomId]);
	/** The reaction calls that run, as "message id" and "emoji". */
	const reacting = useRef(new Set<string>());
	const [draft, setDraftBody] = useState<ChatBody | null>(() => drafts.get(roomId));
	function setDraft(body: ChatBody | null) {
		setDraftBody(body);
		drafts.set(roomId, body);
	}
	const composer = useRef<ChatComposerHandle>(null);
	/** The characters of the draft above the limit of the plain text, or 0. */
	const draftOver = draft ? Math.max(0, bodyText(draft).length - CHAT_LIMITS.messageChars) : 0;
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
	/** The message in edit: the body that the edit box opened with, and the body in it now (null without text). */
	const [editing, setEditing] = useState<{ id: string; initial: ChatBody; body: ChatBody | null } | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	// A path with a message opens the list at that message, not at its end.
	const stick = useRef(focusSeq === null);
	/** True while the list is at its end. It is `stick` for the page: the read state and the button to the end use it. */
	const [atEnd, setAtEnd] = useState(focusSeq === null);
	/** The seq of the message that a link marked, or null. */
	const [marked, setMarked] = useState<number | null>(null);
	/** The seq of the message that the list must go to at the next change of the rows, or null. */
	const scrollTarget = useRef<number | null>(null);
	/** The seq of the link that the view went to. A view goes to a link one time. */
	const wentTo = useRef<number | null>(null);
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
	// The socket brings a change of the members. Without a socket, for example after the room replaced
	// it, the room list shows the change: its number of members is not the number that the page has.
	const listedCount = listed?.member_count;
	const fresh = view.status === "ready" && view.fresh;
	const loadMembers = view.loadMembers;
	useEffect(() => {
		if (fresh && listedCount !== undefined && listedCount !== members.length) void loadMembers();
	}, [fresh, listedCount, members.length, loadMembers]);
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
		if (!draft || draftOver > 0) return;
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
		outbox.send(bodyText(draft), draft);
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
		if (!canFocus || wentTo.current === focusSeq) return;
		// The path changed to a different message, or to the room without a message. A read for the
		// link from before must not put the list at that message.
		cancelReads();
		wentTo.current = focusSeq;
		if (focusSeq === null) return;
		const show = () => {
			setStick(false);
			scrollTarget.current = focusSeq;
			setMarked(focusSeq);
			// The list goes to the message at the next change of this number, also when the rows are the same.
			setFocusTick((tick) => tick + 1);
		};
		if (messages.some((message) => message.seq === focusSeq)) show();
		else {
			toMessage(focusSeq).then((applied) => {
				if (applied && wentTo.current === focusSeq) show();
			}, fail);
		}
	}, [focusSeq, canFocus]);

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
		if (!editing?.body || bodyText(editing.body).length > CHAT_LIMITS.messageChars) return;
		const { id, body } = editing;
		setEditing(null);
		// The body that shows: the body of an edit that waits, or the body that the room has.
		const waiting = latest.current.get(id);
		const stored = messages.find((message) => message.id === id);
		const shown = waiting?.kind === "edit" ? waiting.body : stored && (stored.body ?? textToBody(stored.text));
		if (shown && sameInBox(shown, body)) return;
		// The new body shows at once.
		const change: LocalChange = { kind: "edit", body, text: bodyText(body), at: new Date().toISOString() };
		showChange(id, change);
		afterEarlierCalls(id, async () => {
			// A newer change replaced this one before its call started. Only the newest change goes.
			if (latest.current.get(id) !== change) return;
			try {
				const { message } = await api.call("chat.edit_message", { room_id: roomId, message_id: id, body });
				view.apply(message);
				endChange(id, change);
			} catch (caught) {
				// After a refusal, the old message shows again, and the edit box opens with the new body, so the
				// person does not write it again. A newer change of the message stays as it is.
				if (!endChange(id, change)) return;
				setEditing((current) => current ?? { id, initial: body, body });
				fail(caught);
			}
		});
	}

	/**
	 * Adds or removes a reaction of the person. The message shows the answer of the room. A second click
	 * on the same emoji of a message while its call runs does nothing, so one reaction counts one time.
	 */
	function react(id: string, emoji: string, add: boolean) {
		const call = `${id} ${emoji}`;
		if (reacting.current.has(call)) return;
		reacting.current.add(call);
		const signedIn = accountChangeCount();
		void (async () => {
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
			} finally {
				reacting.current.delete(call);
			}
		})();
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
					<Icon name={room.kind === "private" ? "lock" : "hash"} size={22} />
				)}
				<h1 className="chat-title">
					{room.kind === "dm" && <span className="visually-hidden">Direct message with </span>}
					{title}
				</h1>
				{room.kind === "dm" && room.peer?.kind === "agent" && <span className="kind kind-agent">agent</span>}
				{room.role !== null && (
					<StarButton starred={starring ?? listed?.starred ?? answeredStar ?? room.starred} onChange={setStar} />
				)}
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
													setEditing({ id: message.id, initial, body: initial });
												}}
												onEditChange={(body) => setEditing((current) => current && { ...current, body })}
												onEditSave={saveEdit}
												onEditCancel={() => setEditing(null)}
												onDelete={() => setDialog({ type: "delete", message })}
												onShowEdits={readsEdits ? () => setDialog({ type: "edits", message }) : null}
												onSendAgain={() => outbox.retry(key)}
												onSendCancel={() => outbox.discard(key)}
												ownId={ownId}
												quickEmoji={quickEmoji}
												onReact={(emoji, add) => react(message.id, emoji, add)}
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
						<div className="chat-composer-box">
							<ChatComposer
								ref={composer}
								id={draftId}
								label={`Message to ${title}`}
								placeholder={draftPlaceholder(room)}
								initial={draft}
								onChange={setDraft}
								onSubmit={send}
								mentions={mentions}
								placement="above"
							>
								<button
									type="submit"
									className="chat-send"
									aria-label="Send the message"
									title="Send (Enter)"
									disabled={!draft || draftOver > 0}
								>
									<Icon name="arrowUp" size={18} />
								</button>
							</ChatComposer>
						</div>
						{draftOver > 0 && (
							<p className="chat-composer-limit" role="status">
								The message has {plural(draftOver, "character")} more than the limit of{" "}
								{CHAT_LIMITS.messageChars.toLocaleString()}.
							</p>
						)}
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
	/** True for the message that a link marked. */
	marked: boolean;
	/** Puts a link to the message on the clipboard. */
	onCopyLink: () => void;
	/** The state of the send, for a message that the server does not have yet. */
	pending: PendingMessage | null;
	/** The handles for the mentions in the text, and the suggestions of the edit box. */
	mentions: MentionContext;
	/** True when the message shows its author and its time. */
	head: boolean;
	own: boolean;
	canDelete: boolean;
	/** The bodies of the edit box, or null when the message is not in edit. */
	editing: { initial: ChatBody; body: ChatBody | null } | null;
	onEditStart: () => void;
	onEditChange: (body: ChatBody | null) => void;
	onEditSave: () => void;
	onEditCancel: () => void;
	onDelete: () => void;
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

function MessageItem({
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
	onEditSave,
	onEditCancel,
	onDelete,
	onShowEdits,
	onSendAgain,
	onSendCancel,
	ownId,
	quickEmoji,
	onReact,
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
						<span className="chat-edit-actions">
							<button type="button" className="button button-small" onClick={onEditCancel}>
								Cancel
							</button>
							<button
								type="submit"
								className="button button-small button-primary"
								disabled={!editing.body || bodyText(editing.body).length > CHAT_LIMITS.messageChars}
							>
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
				{pending === null && !message.deleted && (
					<Reactions reactions={message.reactions} ownId={ownId} nameOf={nameOf} onToggle={onReact} />
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
					<button
						type="button"
						className="icon-button icon-button-small"
						aria-label={`Copy a link to the message of ${author} from ${shortDate(message.created_at)}`}
						title="Copy a link"
						onClick={onCopyLink}
					>
						<Icon name="link" size={16} />
					</button>
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
