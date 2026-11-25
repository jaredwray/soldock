import type { Label, Message, Thread, ThreadSummary } from "@asterra/contracts";
import { useEffect, useId, useRef, useState } from "react";
import { errorMessage } from "../../lib/api.ts";
import { participantsLabel } from "../../lib/format.ts";
import { Icon, type IconName } from "../../lib/icons.tsx";
import { addNavigationGuard } from "../../lib/navigationGuard.ts";
import { Link, navigate } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { useOnChange } from "../../lib/useOnChange.ts";
import { type MailView, REPLY_LATER_VIEW, threadPath, viewPath } from "../../routes.ts";
import { SEARCH_INPUT_ID } from "../../shell/nav.ts";
import { SearchBox } from "../../shell/SearchBox.tsx";
import { actionChange, actionNotice, type LabelChange, modifyThreads, type Undo, undoChanges } from "./actions.ts";
import type { SendResult } from "./Composer.tsx";
import { Composer } from "./ComposerLoader.tsx";
import { type Draft, forwardDraft, replyDraft } from "./compose.ts";
import { useThread, useThreadList } from "./data.ts";
import {
	type Cleared,
	type ClearKind,
	type FocusMode,
	finishSummary,
	isGone,
	leftQueue,
	mergeQueue,
	moveActive,
	nextActive,
	positionText,
	primaryAction,
	progressFraction,
	queueView,
	replySource,
	replyTarget,
	restoreAt,
	showsArchive,
	waitingCount,
} from "./focusReply.ts";
import { MailboxNotice } from "./MailboxNotice.tsx";
import { MessageCard, type ReplyMode } from "./MessageCard.tsx";
import { useMailboxId, useMailboxRights } from "./mailbox.tsx";
import type { FromOption } from "./mailboxNav.ts";
import { useShortcuts } from "./useShortcuts.ts";
import type { ViewQuery } from "./views.ts";

/** The session list of the finish state shows this many conversations, then a count of the others. */
const FINISH_LIST_MAX = 8;

/** The page gets the next page when the conversation on screen is one of this many last loaded ones. */
const PRELOAD_FROM_END = 5;

/** The page keeps the threads of this many conversations that it got before they showed. */
const CACHE_SIZE = 10;

interface FocusReplyProps {
	/** The view of the conversations. The query gives its threads, newest first, as in its list. */
	view: MailView;
	query: ViewQuery;
	/** The title of the view, for example "Inbox" or the name of a label. */
	viewTitle: string;
	/** What Done, Later and a reply do in the view (`focusMode`). */
	mode: FocusMode;
	/** The name of the team mailbox or the agent mailbox, or null in the own mailbox. */
	mailboxName: string | null;
	labelsById: ReadonlyMap<string, Label>;
	myAddress: string;
	/** Grows when the mailbox version changes. The page then gets the list and the conversation again. */
	refreshKey: number;
	onChanged: () => void;
	/** Opens the composer of Mail in its dialog: a new message, or a forward, which does not answer the thread. */
	onCompose: (draft?: Draft) => void;
	onShowHelp: () => void;
	/**
	 * The values of the inline composer. A reply comes from the mailbox of its conversation. A null signature did
	 * not load yet: the composer then reads it.
	 */
	composer: { mailDomains: readonly string[] | null; fromOptions: readonly FromOption[]; signature: string | null };
}

/** A request to the conversation on screen: open its reply, its reply to all or its forward. */
interface ReplyRequest {
	threadId: string;
	mode: ReplyMode;
	token: number;
}

/** Where the focus goes after a move: the subject heading of the new conversation, or it stays where it is. */
type FocusAfter = "heading" | "keep";

/** A key or a button. A key never discards text, and after a key the focus goes to the subject heading. */
type Source = "key" | "button";

/** An action on the conversation on screen. "primary" is Archive or Done (`primaryAction`). */
type Action = "primary" | "archive" | "spam" | "later";

/** The text of a cleared conversation in the list of the finish state. */
const CLEARED_TEXT: Record<ClearKind, string> = {
	answered: "Answered",
	archived: "Archived",
	done: "Done",
	later: "Reply later",
	spam: "Spam",
};

/** The toast when older conversations did not load. */
function olderFailed(error: unknown) {
	return { message: `Older conversations did not load. ${errorMessage(error)}`, tone: "error" as const };
}

/**
 * Focus: the conversations of a view, one at a time. Previous and Next move between them. Archive, Spam, Later
 * and Done take the conversation out of the view and show the next one (`focusMode`). Reply opens the composer in
 * the page. After a send, the next conversation shows with its reply open, so the person answers one
 * conversation after the other with no click. In Reply later, the server then removes the conversation from Reply
 * later. In the inbox, the page archives it. When no conversation stays, the page shows what the person cleared
 * in this visit.
 */
export function FocusReply(props: FocusReplyProps) {
	const { view, mode, labelsById, myAddress, onChanged, onCompose } = props;
	const toast = useToast();
	const mailboxId = useMailboxId();
	const rights = useMailboxRights();
	const list = useThreadList(mailboxId, props.query.status === "ready" ? props.query.query : null);
	const mainRef = useRef<HTMLElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	/** The conversations in their order. The order changes only when the person acts, or when new ones come. */
	const [items, setItems] = useState<ThreadSummary[]>([]);
	const [activeId, setActiveId] = useState<string | null>(null);
	/** The reply of the conversation on screen. */
	const [draft, setDraft] = useState<Draft | null>(null);
	/** True while the reply has text that a close discards. */
	const [dirty, setDirty] = useState(false);
	const [request, setRequest] = useState<ReplyRequest | null>(null);
	/** The token of the last request. It only grows. */
	const requestTokens = useRef(0);
	/** A request to give the focus to the subject heading of a conversation after a move. */
	const [headingFocus, setHeadingFocus] = useState<{ threadId: string; token: number } | null>(null);
	/** The motion of the conversation that comes in: after Next or an action, or after Previous or Undo. */
	const [enter, setEnter] = useState<"next" | "previous" | null>(null);
	/** Grows with each move. The live region then says where the person is, after `movePrefix`. */
	const [moveToken, setMoveToken] = useState(0);
	const movePrefix = useRef("");
	/** The conversations that the person cleared in this visit, in order. */
	const [log, setLog] = useState<readonly Cleared[]>([]);
	/** The text of the polite live region. */
	const [announce, setAnnounce] = useState("");
	/** The conversations that came back with Undo. They stay until the queue from the server has them again. */
	const restoringRef = useRef(new Set<string>());
	/** The number of messages that the page showed for each conversation, from its own thread. */
	const seenRef = useRef(new Map<string, number>());
	/** The threads that the page got before they show, so Next shows the conversation at once. */
	const [cache, setCache] = useState<ReadonlyMap<string, Thread>>(() => new Map());
	/**
	 * The cursor of the page that the page gets by itself, while the request runs and after it fails. A failed
	 * request is not sent again: the page shows Older.
	 */
	const [olderFrom, setOlderFrom] = useState<string | null>(null);
	/** Next at the last loaded conversation while the next page loads: the move waits for the page. */
	const [pendingNext, setPendingNext] = useState<Source | null>(null);

	/**
	 * The conversations that the person cleared in this visit, with their number of messages. A refresh does not
	 * put them back until a new message comes: it can start before the change, and some views keep the
	 * conversation, for example Starred after a reply.
	 */
	const gone: ReadonlyMap<string, number> = new Map(log.map((item) => [item.id, item.count]));
	const goneRef = useRef(gone);
	goneRef.current = gone;
	const title = props.mailboxName ? `${props.mailboxName}: Focus` : "Focus";
	const isInbox = view.kind === "system" && view.view === "inbox";
	const isReplyLater = view.kind === "system" && view.view === "reply-later";
	/** The view in a sentence, for example "the inbox" or "Starred". */
	const place = isInbox ? "the inbox" : props.viewTitle;
	const listPath = viewPath(view, mailboxId);
	const inboxPath = viewPath({ kind: "system", view: "inbox" }, mailboxId);
	const replyLaterPath = viewPath(REPLY_LATER_VIEW, mailboxId);

	const ids = items.map((item) => item.id);
	const active = activeId !== null && ids.includes(activeId) ? activeId : (ids[0] ?? null);
	const index = active === null ? -1 : ids.indexOf(active);
	const current = index < 0 ? null : (items[index] ?? null);
	const nextId = index < 0 ? null : (ids[index + 1] ?? null);
	const complete = list.nextCursor === null;
	const loadedIds = new Set(ids);
	// Threads that the list has and the order does not have yet, for example a page that came in this render.
	const unmerged = list.threads.filter((thread) => !loadedIds.has(thread.id) && !isGone(thread, gone)).length;
	/**
	 * The values of the last render, for code that runs after its own render: Undo, the end of a request, and a
	 * move that waits for a page. Their closure can hold old values.
	 */
	const latest = useRef({ draft, dirty, current, ids, threads: list.threads, complete });
	latest.current = { draft, dirty, current, ids, threads: list.threads, complete };
	const keepRef = useRef<ReadonlySet<string>>(new Set());
	keepRef.current = new Set([...(active === null ? [] : [active]), ...restoringRef.current]);

	useOnChange(props.refreshKey, () => void list.refresh());

	// The conversations keep their order. The conversation on screen and one that came back with Undo stay, also
	// when they are not in the fresh queue.
	useEffect(() => {
		if (list.status !== "ready") return;
		setItems((now) => mergeQueue(now, list.threads, keepRef.current, list.nextCursor === null, goneRef.current));
		for (const id of restoringRef.current) {
			if (list.threads.some((thread) => thread.id === id)) restoringRef.current.delete(id);
		}
	}, [list.status, list.threads, list.nextCursor]);

	// The reply goes away with the page. So the app asks before it leaves the page, and the browser asks before
	// it closes or reloads the tab.
	const unsent = draft !== null && dirty;
	useEffect(() => {
		if (!unsent) return;
		const warn = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", warn);
		const removeGuard = addNavigationGuard(() => window.confirm("Discard your reply?"));
		return () => {
			window.removeEventListener("beforeunload", warn);
			removeGuard();
		};
	}, [unsent]);

	// The list has rows that the page does not have yet: the conversations come one render after the list.
	const merging = list.status === "ready" && items.length === 0 && list.threads.some((thread) => !isGone(thread, gone));
	// The conversation on screen can stay after it left the queue. It does not count as waiting.
	const queued = items.filter((item) => !leftQueue(item, list.threads, complete)).length;
	const { left, more } = waitingCount({
		complete,
		queued,
		total: mode.countLabel === null ? null : (labelsById.get(mode.countLabel)?.threads_total ?? null),
		staying: log.filter((item) => item.stays).length,
	});
	const total = Math.max(left, ids.length);
	const shown = list.status === "ready" && !merging ? queueView(ids.length, log.length, complete) : null;
	const atEnd = index === ids.length - 1 && complete;
	const people = (summary: ThreadSummary) => participantsLabel(summary.participants, mailboxId ? "" : myAddress);

	// The live region says where the person is after each move. When no conversation stays, it says the finish text.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the text is for the move of this token only.
	useEffect(() => {
		if (moveToken === 0) return;
		const where = current
			? `Conversation ${positionText(index + 1, total, more)}: ${current.subject.trim() || "(no subject)"}, from ${people(current)}.`
			: shown === "finished"
				? `All caught up. ${finishSummary(log)}`
				: "";
		setAnnounce(`${movePrefix.current}${where}`);
	}, [moveToken]);

	// Each move starts the new conversation at the top of the page.
	useEffect(() => {
		if (scrollRef.current && active !== null) scrollRef.current.scrollTop = 0;
	}, [active]);

	// The page gets the thread of the next conversation before it shows.
	const preload = useThread(mailboxId, nextId);
	useEffect(() => {
		const thread = preload.thread;
		if (!thread) return;
		setCache((now) => {
			// The cache keeps the threads of the last few conversations only.
			const next = new Map(now);
			next.delete(thread.id);
			next.set(thread.id, thread);
			for (const id of next.keys()) {
				if (next.size <= CACHE_SIZE) break;
				next.delete(id);
			}
			return next;
		});
	}, [preload.thread]);

	// The page gets the next page when the person is near the end of the loaded conversations, or when each loaded
	// one is cleared. A refresh that starts later discards the result with no error, so the page then asks again.
	// If the request fails, the page shows a toast, and Older when no conversation stays.
	const { loadOlder, nextCursor, loadingOlder } = list;
	const nearEnd = shown === "conversation" && index >= ids.length + unmerged - PRELOAD_FROM_END;
	useEffect(() => {
		if (!(nearEnd || shown === "older") || loadingOlder || nextCursor === null || olderFrom === nextCursor) return;
		setOlderFrom(nextCursor);
		loadOlder().then(
			() => setOlderFrom(null),
			(error: unknown) => toast(olderFailed(error)),
		);
	}, [nearEnd, shown, loadingOlder, nextCursor, olderFrom, loadOlder, toast]);

	// Next at the last loaded conversation waits for the next page, and moves when it comes. A reply that opened in
	// the meantime stays: the move does not happen. A different move, an action or a reply ends the wait too.
	// biome-ignore lint/correctness/useExhaustiveDependencies: show() reads the current values of this render.
	useEffect(() => {
		if (pendingNext === null) return;
		if (latest.current.draft) setPendingNext(null);
		else if (nextId !== null) show(nextId, "next", pendingNext === "key" ? "heading" : "keep");
		else if (unmerged === 0 && (complete || (olderFrom === nextCursor && !loadingOlder))) setPendingNext(null);
	}, [pendingNext, nextId, unmerged, complete, olderFrom, nextCursor, loadingOlder]);

	function ask(threadId: string, replyMode: ReplyMode) {
		// The conversation remembers the last token that it handled. So each request gets a new token.
		requestTokens.current += 1;
		setRequest({ threadId, mode: replyMode, token: requestTokens.current });
	}

	function closeDraft() {
		setDraft(null);
		setDirty(false);
	}

	/**
	 * Closes the reply before a move. A reply with text stays when a key asks, and a button asks the person
	 * first. Returns false when the move must not happen.
	 */
	function leaveDraft(source: Source): boolean {
		if (draft && dirty) {
			if (source === "key" || !window.confirm("Discard your reply?")) return false;
		}
		closeDraft();
		return true;
	}

	/**
	 * Shows a different conversation. The one that was on screen leaves the order when it left the queue, for
	 * example after a reply by a different member. The live region then says where the person is.
	 */
	function show(threadId: string | null, motion: "next" | "previous", focus: FocusAfter, prefix = "") {
		const { current: previous, threads, complete: full } = latest.current;
		if (
			previous &&
			previous.id !== threadId &&
			!restoringRef.current.has(previous.id) &&
			leftQueue(previous, threads, full)
		) {
			setItems((now) => now.filter((item) => item.id !== previous.id));
		}
		setActiveId(threadId);
		setEnter(motion);
		setPendingNext(null);
		setRequest((now) => (now && now.threadId !== threadId ? null : now));
		// With no conversation left, the finish state or the empty state gets the focus. A button that stays keeps
		// it, so an old request for the heading must not act when its conversation shows again.
		if (threadId === null) mainRef.current?.focus();
		else if (focus === "heading") {
			requestTokens.current += 1;
			setHeadingFocus({ threadId, token: requestTokens.current });
		} else setHeadingFocus(null);
		movePrefix.current = prefix;
		setMoveToken((token) => token + 1);
	}

	function go(step: 1 | -1, source: Source) {
		if (active === null) return;
		const target = moveActive(ids, active, step);
		if (target === active) {
			// At the last loaded conversation, Next waits for the next page. After a failed request, Next asks again.
			if (step === 1 && !complete && leaveDraft(source)) {
				if (olderFrom === nextCursor && !loadingOlder) setOlderFrom(null);
				setPendingNext(source);
			}
			return;
		}
		if (!leaveDraft(source)) return;
		show(target, step === 1 ? "next" : "previous", source === "key" ? "heading" : "keep");
	}

	/** The log entry of a clear. The count has the messages that the page showed, so a later one is new. */
	function cleared(thread: ThreadSummary, how: ClearKind, stays: boolean): Cleared {
		const count = Math.max(thread.message_count, seenRef.current.get(thread.id) ?? 0) + (how === "answered" ? 1 : 0);
		return { id: thread.id, subject: thread.subject.trim() || "(no subject)", how, count, stays };
	}

	/**
	 * Takes a conversation out of the order and shows the next one, or the previous one at the end. `change` is
	 * the label change on the server, or null: the list gets it at once. The log keeps the conversation away until
	 * a new message comes (`gone`). Returns the conversation that shows.
	 */
	function leave(
		thread: ThreadSummary,
		how: ClearKind,
		change: LabelChange | null,
		stays: boolean,
		focus: FocusAfter,
		prefix = "",
	): string | null {
		const next = nextActive(ids, thread.id);
		closeDraft();
		if (change) list.patch([thread.id], change, view);
		setLog((now) => [...now.filter((item) => item.id !== thread.id), cleared(thread, how, stays)]);
		setItems((now) => now.filter((item) => item.id !== thread.id));
		show(next, "next", focus, prefix);
		return next;
	}

	function reply(threadId: string, message: Message, replyMode: ReplyMode) {
		if (!rights.send) return;
		if (replyMode === "forward") {
			onCompose(forwardDraft(message));
			return;
		}
		// A new draft would mount a new composer and lose the text of the open one. The open one gets the focus.
		if (draft) {
			ask(threadId, replyMode);
			return;
		}
		// A Next that waits for a page does not move away from the reply.
		setPendingNext(null);
		setDraft(replyDraft(message, myAddress, replyMode === "replyAll"));
		setDirty(false);
	}

	function sent(thread: ThreadSummary, result: SendResult) {
		const archive = mode.archiveOnReply && rights.modify;
		// In Reply later, the server took the conversation out of the view. In the inbox, the archive below does.
		const leavesView = mode.archiveOnReply ? archive : mode.leaves.answered;
		const next = leave(thread, "answered", leavesView ? mode.done : null, !leavesView, "heading", "Reply sent. ");
		// The reply of the next conversation opens: the person continues with no click.
		if (next && rights.send) ask(next, "reply");
		if (archive) {
			modifyThreads(mailboxId, [thread.id], actionChange("archive")).then(onChanged, (error: unknown) =>
				toast({
					message: `Reply sent, but the conversation is still in the inbox. ${errorMessage(error)}`,
					tone: "error",
				}),
			);
		}
		const failed = result.recipients.filter((recipient) => recipient.status === "failed");
		if (failed.length > 0) {
			toast({
				message: `Reply sent, but delivery failed for ${failed.map((recipient) => recipient.address).join(", ")}.`,
				tone: "error",
			});
		}
		onChanged();
	}

	/** Archive, Spam, Later or Done on the conversation on screen. Each change has Undo. */
	async function act(action: Action, source: Source) {
		const thread = current;
		if (!rights.modify || !thread || (action === "later" && !mode.later)) return;
		if (draft && dirty && (source === "key" || !window.confirm("Discard your reply?"))) return;
		const primary = primaryAction(mode, thread.label_ids);
		const kind: Action | "none" = action === "primary" ? (primary === "done" ? "primary" : primary) : action;
		const plan: { how: ClearKind; change: LabelChange | null; notice: string; leaves: boolean } =
			kind === "archive"
				? { how: "archived", change: actionChange("archive"), notice: "", leaves: mode.leaves.archived }
				: kind === "spam"
					? { how: "spam", change: actionChange("spam"), notice: "", leaves: mode.leaves.spam }
					: kind === "later"
						? { how: "later", change: actionChange("replyLater"), notice: "", leaves: mode.leaves.later }
						: kind === "none"
							? { how: "done", change: null, notice: "Conversation marked as done.", leaves: false }
							: { how: "done", change: mode.done, notice: mode.doneNotice, leaves: mode.leaves.done };
		const notice =
			plan.notice || (actionNotice(kind === "archive" ? "archive" : kind === "spam" ? "spam" : "replyLater", 1) ?? "");
		const position = ids.indexOf(thread.id);
		const undos = plan.change ? undoChanges([{ id: thread.id, labelIds: thread.label_ids }], plan.change) : [];
		// A button that stays keeps the focus. The second Archive can go with the move, so its focus goes on.
		const focus: FocusAfter = source === "key" || action === "archive" ? "heading" : "keep";
		leave(thread, plan.how, plan.change, !plan.leaves, focus);
		if (!plan.change) {
			toast({ message: notice });
			return;
		}
		try {
			await modifyThreads(mailboxId, [thread.id], plan.change);
			// A refresh that started before the change can come later, with the conversation. A new refresh
			// replaces it.
			void list.refresh();
			toast(
				undos.length > 0
					? { message: notice, action: { label: "Undo", run: () => void undoClear(thread, plan.how, position, undos) } }
					: { message: notice },
			);
		} catch (error) {
			toast({ message: `The change failed. ${errorMessage(error)}`, tone: "error" });
			restore(thread, position);
		}
		onChanged();
	}

	/**
	 * Puts a conversation back at its old place and shows it, for example after Undo. A reply with text on screen
	 * stays: the conversation then only goes back into the order.
	 */
	function restore(thread: ThreadSummary, position: number) {
		restoringRef.current.add(thread.id);
		setItems((now) => restoreAt(now, thread, position));
		setLog((now) => now.filter((item) => item.id !== thread.id));
		// Undo and a failed request come after their render. The reply on screen now can have text.
		const { draft: open, dirty: typed } = latest.current;
		if (open && typed) return;
		closeDraft();
		show(thread.id, "previous", "heading");
	}

	async function undoClear(thread: ThreadSummary, how: ClearKind, position: number, undos: readonly Undo[]) {
		restore(thread, position);
		try {
			for (const undo of undos) await modifyThreads(mailboxId, undo.ids, undo.change);
			toast({ message: "Action undone." });
		} catch (error) {
			// The change stays, so the conversation goes again, and the next one shows. A reply with text on it keeps
			// it on screen: it leaves the order when the person moves away.
			restoringRef.current.delete(thread.id);
			setLog((now) => [...now, cleared(thread, how, !mode.leaves[how])]);
			const { current: onScreen, draft: open, dirty: typed, ids: order } = latest.current;
			if (onScreen?.id !== thread.id) setItems((now) => now.filter((item) => item.id !== thread.id));
			else if (!(open && typed)) {
				const next = nextActive(order, thread.id);
				closeDraft();
				setItems((now) => now.filter((item) => item.id !== thread.id));
				show(next, "next", "heading");
			}
			toast({ message: `The undo failed. ${errorMessage(error)}`, tone: "error" });
		}
		onChanged();
	}

	useShortcuts((event) => {
		// Shift and an arrow select text in the message.
		if (event.shiftKey && event.key.startsWith("Arrow")) return;
		switch (event.key) {
			case "j":
			case "ArrowRight":
				go(1, "key");
				break;
			case "k":
			case "ArrowLeft":
				go(-1, "key");
				break;
			case "r":
			case "a":
			case "f":
				if (!rights.send || active === null) return;
				ask(active, event.key === "r" ? "reply" : event.key === "a" ? "replyAll" : "forward");
				break;
			case "e":
				void act("primary", "key");
				break;
			case "l":
				// l is Reply later, as in the list. In Reply later, it is Done.
				void act(mode.later ? "later" : "primary", "key");
				break;
			case "!":
				void act("spam", "key");
				break;
			case "o":
				if (active === null) return;
				navigate(threadPath(view, active, mailboxId));
				break;
			case "u":
				navigate(listPath);
				break;
			case "c":
				if (!rights.send) return;
				onCompose();
				break;
			case "/":
				document.getElementById(SEARCH_INPUT_ID)?.focus();
				break;
			case "?":
				props.onShowHelp();
				break;
			default:
				return;
		}
		event.preventDefault();
	});

	const subject = current ? current.subject.trim() || "(no subject)" : "";
	const primary = current ? primaryAction(mode, current.label_ids) : "done";
	const actions =
		rights.modify && current ? (
			<>
				<ActionButton
					icon="spam"
					text="Spam"
					label={`Report spam: “${subject}”`}
					title="Report spam (!)"
					keys="Shift+1"
					onClick={() => void act("spam", "button")}
				/>
				{showsArchive(mode, current.label_ids) && (
					<ActionButton
						icon="archive"
						text="Archive"
						label={`Archive “${subject}”`}
						title="Archive"
						onClick={() => void act("archive", "button")}
					/>
				)}
				{mode.later && (
					<ActionButton
						icon="clock"
						text="Later"
						label={`Later: move “${subject}” to Reply later`}
						title="Reply later (l)"
						keys="l"
						onClick={() => void act("later", "button")}
					/>
				)}
				<ActionButton
					primary
					icon={primary === "archive" ? "archive" : "check"}
					text={primary === "archive" ? "Archive" : "Done"}
					label={
						primary === "archive"
							? `Archive “${subject}”`
							: primary === "none"
								? "Done: go to the next conversation"
								: `Done: ${mode.doneText(subject)}`
					}
					title={
						primary !== "archive" && isReplyLater
							? "Done (e or l)"
							: `${primary === "archive" ? "Archive" : "Done"} (e)`
					}
					keys={primary !== "archive" && isReplyLater ? "e l" : "e"}
					onClick={() => void act("primary", "button")}
				/>
			</>
		) : null;

	return (
		<main id="main" className={draft ? "mail-main focus-replying" : "mail-main"} tabIndex={-1} ref={mainRef}>
			<div className="toolbar">
				<Link
					to={listPath}
					className="icon-button"
					aria-label={`Back to ${place}`}
					title={`Back to ${place} (u)`}
					aria-keyshortcuts="u"
				>
					<Icon name="back" />
				</Link>
				<div className="page-title">
					<Icon name="focus" />
					<h1 className="toolbar-title">{title}</h1>
					<span className="focus-view-name">{props.viewTitle}</span>
				</div>
				<span className="toolbar-spacer" />
				<SearchBox product="mail" query={view.kind === "search" ? view.query : ""} mailboxId={mailboxId} />
			</div>
			<MailboxNotice />
			{current && (
				<div className="focus-status">
					<fieldset className="focus-nav" aria-label="Move between conversations">
						<button
							type="button"
							className="button button-small button-ghost focus-nav-button"
							aria-label="Previous conversation"
							title="Previous conversation (k)"
							aria-keyshortcuts="k ArrowLeft"
							aria-disabled={index <= 0 ? true : undefined}
							onClick={() => go(-1, "button")}
						>
							<Icon name="chevronLeft" size={16} />
							<span className="focus-nav-text">Previous</span>
						</button>
						<p className="focus-status-count">{positionText(index + 1, total, more)}</p>
						<button
							type="button"
							className="button button-small button-ghost focus-nav-button"
							aria-label="Next conversation"
							title="Next conversation (j)"
							aria-keyshortcuts="j ArrowRight"
							aria-disabled={atEnd ? true : undefined}
							aria-busy={pendingNext !== null ? true : undefined}
							onClick={() => go(1, "button")}
						>
							<span className="focus-nav-text">Next</span>
							<Icon name="chevronRight" size={16} />
						</button>
						{log.length > 0 && <span className="focus-done-count">{log.length} done</span>}
					</fieldset>
					{actions && (
						<fieldset className="focus-actions focus-actions-strip" aria-label="Actions on the conversation">
							{actions}
						</fieldset>
					)}
					<span
						className="focus-progress"
						style={{ width: `${progressFraction(log.length, left) * 100}%` }}
						aria-hidden="true"
					/>
				</div>
			)}
			<p className="visually-hidden" aria-live="polite">
				{announce}
			</p>
			<div className="mail-scroll" ref={scrollRef}>
				{props.query.status === "missing" ? (
					<div className="list-state" role="alert">
						This label does not exist.
					</div>
				) : list.status === "loading" || merging ? (
					<div className="list-state mail-state" aria-live="polite">
						<span className="spinner" aria-hidden="true" />
						Loading conversations…
					</div>
				) : list.status === "error" && items.length === 0 ? (
					<div className="list-state mail-state" role="alert">
						<span className="mail-state-icon">
							<Icon name="warning" size={22} />
						</span>
						<p className="mail-state-title">The conversations did not load.</p>
						<p className="mail-state-text">{list.error}</p>
						<button type="button" className="button" onClick={() => void list.retry()}>
							Try again
						</button>
					</div>
				) : shown === "finished" ? (
					<FinishState
						log={log}
						mailboxId={mailboxId}
						inboxPath={inboxPath}
						// After the inbox and Reply later, the next pile is Reply later. Else the person goes back to the view.
						next={
							isInbox || isReplyLater
								? { path: replyLaterPath, text: "Reply later list" }
								: { path: listPath, text: `Back to ${place}` }
						}
					/>
				) : shown === "older" ? (
					loadingOlder || olderFrom !== nextCursor ? (
						<div className="list-state mail-state" aria-live="polite">
							<span className="spinner" aria-hidden="true" />
							Loading older conversations…
						</div>
					) : (
						<div className="list-state mail-state">
							<p className="mail-state-title">More conversations wait in {place}.</p>
							<button type="button" className="button" onClick={() => setOlderFrom(null)}>
								Older
							</button>
						</div>
					)
				) : shown === "empty" ? (
					<div className="list-state mail-state">
						<span className="mail-state-icon">
							<Icon name="check" size={22} />
						</span>
						{isReplyLater ? (
							<>
								<p className="mail-state-title">No conversation waits for an answer.</p>
								<p className="mail-state-text">Use Reply later on a conversation to put it here.</p>
							</>
						) : (
							<p className="mail-state-title">
								{view.kind === "search" ? `No conversations match “${view.query}”.` : `No conversations in ${place}.`}
							</p>
						)}
						<Link to={isReplyLater ? inboxPath : listPath} className="button">
							{isReplyLater ? "Go to the inbox" : `Back to ${place}`}
						</Link>
					</div>
				) : current ? (
					<div className="focus-list">
						<FocusConversation
							key={current.id}
							summary={current}
							cached={cache.get(current.id) ?? null}
							people={people(current)}
							myAddress={myAddress}
							labelsById={labelsById}
							view={view}
							place={place}
							queued={restoringRef.current.has(current.id) || !leftQueue(current, list.threads, complete)}
							enter={enter}
							headingFocus={headingFocus?.threadId === current.id ? headingFocus.token : null}
							request={request?.threadId === current.id ? request : null}
							draft={draft}
							composer={props.composer}
							onReply={(message, replyMode) => reply(current.id, message, replyMode)}
							onCloseDraft={() => {
								closeDraft();
								requestTokens.current += 1;
								setHeadingFocus({ threadId: current.id, token: requestTokens.current });
							}}
							onDirtyChange={setDirty}
							onSent={(result) => sent(current, result)}
							onSeen={(count) => seenRef.current.set(current.id, count)}
						/>
					</div>
				) : null}
			</div>
			{actions && (
				<fieldset className="focus-actions focus-actions-bar" aria-label="Actions on the conversation">
					{actions}
				</fieldset>
			)}
		</main>
	);
}

/**
 * One action of the conversation on screen. On a phone, the actions are in a bar at the bottom, and each one
 * except the primary shows its icon only. Its name stays for a screen reader.
 */
function ActionButton(props: {
	icon: IconName;
	text: string;
	label: string;
	title: string;
	keys?: string;
	primary?: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			className={props.primary ? "button button-small focus-action-primary" : "button button-small button-ghost"}
			aria-label={props.label}
			title={props.title}
			aria-keyshortcuts={props.keys}
			onClick={props.onClick}
		>
			<Icon name={props.icon} size={16} />
			<span className="focus-action-text">{props.text}</span>
		</button>
	);
}

/**
 * The page after the last conversation goes: what the person answered, archived, marked as done, moved to Reply
 * later and marked as spam in this visit. `next` is the second link, after "Go to the inbox".
 */
function FinishState({
	log,
	mailboxId,
	inboxPath,
	next,
}: {
	log: readonly Cleared[];
	mailboxId: string | null;
	inboxPath: string;
	next: { path: string; text: string };
}) {
	const shown = log.slice(0, FINISH_LIST_MAX);
	return (
		<div className="list-state mail-state focus-finish">
			<span className="mail-state-icon focus-finish-mark">
				<Icon name="check" size={26} />
			</span>
			<p className="mail-state-title">All caught up.</p>
			<p className="mail-state-text">{finishSummary(log)}</p>
			<section className="focus-finish-session" aria-labelledby="focus-finish-heading">
				<h2 id="focus-finish-heading" className="focus-finish-heading">
					In this session
				</h2>
				<ul className="focus-finish-list">
					{shown.map((item) => (
						<li key={item.id}>
							<Link to={threadPath({ kind: "system", view: "all" }, item.id, mailboxId)}>{item.subject}</Link>
							<span className="focus-finish-how">{CLEARED_TEXT[item.how]}</span>
						</li>
					))}
					{log.length > shown.length && <li className="focus-finish-more">and {log.length - shown.length} more</li>}
				</ul>
			</section>
			<div className="focus-finish-actions">
				<Link to={inboxPath} className="button button-primary">
					Go to the inbox
				</Link>
				<Link to={next.path} className="button">
					{next.text}
				</Link>
			</div>
		</div>
	);
}

interface FocusConversationProps {
	summary: ThreadSummary;
	/** The thread that the page got before this conversation showed, or null. It shows while the thread loads. */
	cached: Thread | null;
	/** The people of the conversation, as the line under the subject shows them. */
	people: string;
	myAddress: string;
	labelsById: ReadonlyMap<string, Label>;
	view: MailView;
	/** The view in a sentence, for example "the inbox". */
	place: string;
	/** False when the conversation left the queue and stays on screen until the person moves away. */
	queued: boolean;
	/** The motion when the conversation comes in. */
	enter: "next" | "previous" | null;
	/** A token when the subject heading must get the focus, or null. */
	headingFocus: number | null;
	/** A request to this conversation, or null. */
	request: ReplyRequest | null;
	draft: Draft | null;
	composer: FocusReplyProps["composer"];
	onReply: (message: Message, mode: ReplyMode) => void;
	onCloseDraft: () => void;
	onDirtyChange: (dirty: boolean) => void;
	onSent: (result: SendResult) => void;
	/** The number of messages that the conversation shows from its own thread. */
	onSeen: (count: number) => void;
}

/**
 * The conversation on screen: the subject, the people, the newest message with its reply buttons, the other
 * messages on request, and the reply in the page when it is open.
 */
function FocusConversation(props: FocusConversationProps) {
	const { summary, draft, request, onReply, onSeen } = props;
	const mailboxId = useMailboxId();
	const thread = useThread(mailboxId, summary.id);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const headingId = useId();
	const messagesId = useId();
	// A thread that the page got before has the messages of the summary. Else a newer message came, and the
	// conversation waits for its own thread.
	const cached =
		props.cached?.id === summary.id && props.cached.messages.length === summary.message_count ? props.cached : null;
	const loaded = thread.thread ?? cached;
	const messages = loaded?.messages ?? [];
	const newest = replyTarget(messages);
	/** The newest message with its full body, from the message card. */
	const [full, setFull] = useState<Message | null>(null);
	/** True while the other messages of the conversation show. */
	const [showAll, setShowAll] = useState(false);
	// A key and the step after a send start a reply from here. They wait for the own thread of the conversation,
	// not the thread that the page got before, and for a body that the server left out, as the buttons do.
	const source = thread.thread ? replySource(replyTarget(thread.thread.messages), full) : null;
	const earlier = (loaded ? messages.length : summary.message_count) - 1;
	/** The last request and the last focus token that this conversation handled, so each acts one time. */
	const handledRef = useRef<number | null>(null);
	const focusedRef = useRef<number | null>(null);
	const subject = summary.subject.trim() || "(no subject)";

	// The list refreshes after each change in the mailbox. The conversation gets its thread again only when the
	// thread changed.
	useOnChange(`${summary.last_message_at} ${summary.message_count}`, () => void thread.refresh());
	// A conversation leaves the queue when a different member answers it. It gets the thread again, so the person
	// sees that answer.
	useOnChange(props.queued, () => void thread.refresh());

	useEffect(() => {
		if (thread.thread) onSeen(thread.thread.messages.length);
	}, [thread.thread, onSeen]);

	useEffect(() => {
		if (props.headingFocus === null || props.headingFocus === focusedRef.current) return;
		focusedRef.current = props.headingFocus;
		headingRef.current?.focus({ preventScroll: true });
	}, [props.headingFocus]);

	// A request opens the reply when the message and its body are ready. A reply that is open gets the focus, and
	// keeps its text.
	useEffect(() => {
		if (request === null || request.token === handledRef.current || !source) return;
		handledRef.current = request.token;
		if (draft && request.mode !== "forward") {
			document.querySelector<HTMLElement>(".compose-inline [data-autofocus], .compose-inline .ProseMirror")?.focus();
			return;
		}
		onReply(source, request.mode);
	}, [request, source, draft, onReply]);

	const shownMessages = showAll ? messages : newest ? [newest] : [];

	return (
		<article
			className={props.enter ? `focus-conversation focus-enter-${props.enter}` : "focus-conversation"}
			aria-labelledby={headingId}
		>
			<div className="focus-card-body">
				<div className="focus-card-title">
					<h2 className="focus-card-subject" id={headingId} tabIndex={-1} ref={headingRef}>
						<Link to={threadPath(props.view, summary.id, mailboxId)}>{subject}</Link>
					</h2>
					<p className="focus-card-people">
						{props.people}
						{earlier > 0 && loaded && (
							<>
								{" · "}
								<button
									type="button"
									className="focus-more"
									aria-expanded={showAll}
									aria-controls={messagesId}
									onClick={() => setShowAll((now) => !now)}
								>
									{showAll
										? "Hide the other messages"
										: `Show ${earlier} more ${earlier === 1 ? "message" : "messages"}`}
								</button>
							</>
						)}
					</p>
				</div>
				{newest ? (
					<div className="messages" id={messagesId}>
						{shownMessages.map((message) => (
							<MessageCard
								key={message.id}
								message={message}
								myAddress={props.myAddress}
								labelsById={props.labelsById}
								defaultExpanded={message.id === newest.id}
								heading="h3"
								onReply={onReply}
								onFullBody={setFull}
							/>
						))}
					</div>
				) : thread.status === "error" ? (
					<div className="message-body-state focus-card-state" role="alert">
						<p>The conversation did not load. {thread.error}</p>
						<button type="button" className="button button-small" onClick={() => void thread.retry()}>
							Try again
						</button>
					</div>
				) : (
					<div className="message-body-state focus-card-state" aria-live="polite">
						<span className="spinner spinner-small" aria-hidden="true" />
						Loading the conversation…
					</div>
				)}
				{!props.queued && (
					<p className="focus-card-note" role="status">
						This conversation is not in {props.place} now.{draft ? " Your reply is still here." : ""}
					</p>
				)}
				{draft && (
					<Composer
						key={draft.key}
						frame="inline"
						draft={draft}
						mailDomains={props.composer.mailDomains}
						fromOptions={props.composer.fromOptions}
						initialFrom={mailboxId}
						signature={props.composer.signature}
						onClose={props.onCloseDraft}
						onDirtyChange={props.onDirtyChange}
						onSent={props.onSent}
					/>
				)}
			</div>
		</article>
	);
}
