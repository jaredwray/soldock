import type { Label, Message, ThreadSummary } from "@asterra/contracts";
import { type AnimationEvent, type FocusEvent, useEffect, useRef, useState } from "react";
import { errorMessage } from "../../lib/api.ts";
import { participantsLabel } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { addNavigationGuard } from "../../lib/navigationGuard.ts";
import { Link, navigate } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { useOnChange } from "../../lib/useOnChange.ts";
import { REPLY_LATER_VIEW, threadPath, viewPath } from "../../routes.ts";
import { SEARCH_INPUT_ID } from "../../shell/nav.ts";
import { SearchBox } from "../../shell/SearchBox.tsx";
import { actionChange, actionNotice, modifyThreads, type Undo, undoChanges } from "./actions.ts";
import type { SendResult } from "./Composer.tsx";
import { Composer } from "./ComposerLoader.tsx";
import { type Draft, forwardDraft, replyDraft } from "./compose.ts";
import { useThread, useThreadList } from "./data.ts";
import {
	type Cleared,
	finishSummary,
	leftQueue,
	mergeQueue,
	moveActive,
	nextActive,
	replyTarget,
	restoreAt,
	sessionProgress,
} from "./focusReply.ts";
import { MailboxNotice } from "./MailboxNotice.tsx";
import { MessageCard, type ReplyMode } from "./MessageCard.tsx";
import { useMailboxId, useMailboxRights } from "./mailbox.tsx";
import type { FromOption } from "./mailboxNav.ts";
import { useShortcuts } from "./useShortcuts.ts";

/** The query of Focus & Reply: the threads in Reply later, newest first, as in the Reply later list. */
const QUERY = "in:reply_later";

/** A card loads its thread when it comes this near to the visible part of the list. */
const PRELOAD_MARGIN = "600px 0px";

/** The time of the exit motion of a card in CSS, and a little more: the card goes then, also with no animationend. */
const LEAVE_MS = 400;

/** The session list of the finish state shows this many conversations, then a count of the others. */
const FINISH_LIST_MAX = 8;

/** Cmd on a Mac, Ctrl on other systems, for the key hints. */
const MOD_KEY = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl";

interface FocusReplyProps {
	/** The name of the team mailbox or the agent mailbox, or null in the own mailbox. */
	mailboxName: string | null;
	labelsById: ReadonlyMap<string, Label>;
	myAddress: string;
	/** Grows when the mailbox version changes. The page then gets the list and the threads again. */
	refreshKey: number;
	onChanged: () => void;
	/** Opens the composer of Mail in its dialog: a new message, or a forward, which does not answer the thread. */
	onCompose: (draft?: Draft) => void;
	onShowHelp: () => void;
	/**
	 * The values of the composer in a card. A reply comes from the mailbox of its conversation. A null signature
	 * did not load yet: the composer then reads it.
	 */
	composer: { mailDomains: readonly string[] | null; fromOptions: readonly FromOption[]; signature: string | null };
}

/** A request to a card: open its reply, its reply to all or its forward, or give the focus to its reply. */
interface CardRequest {
	threadId: string;
	mode: ReplyMode;
	token: number;
}

/** How a card leaves the page: after a sent reply, or after Done. Each has its own exit motion. */
type LeaveKind = "sent" | "done";

/** True when the person asked for less motion. A browser without matchMedia gets no motion. */
function reducedMotion(): boolean {
	return typeof window.matchMedia !== "function" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Focus & Reply: each conversation in Reply later, one after the other. One card is active. Reply opens the
 * composer in the card, and a send removes the conversation from Reply later on the server. The card then goes,
 * and the reply of the next card opens with the focus in its editor, so the person answers one conversation
 * after the other with no click. Done takes a conversation out without a reply. When the last card goes, the
 * page shows what the person cleared in this visit.
 */
export function FocusReply(props: FocusReplyProps) {
	const { labelsById, myAddress, onChanged, onCompose } = props;
	const toast = useToast();
	const mailboxId = useMailboxId();
	const rights = useMailboxRights();
	const list = useThreadList(mailboxId, QUERY);
	const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
	const mainRef = useRef<HTMLElement>(null);
	const [items, setItems] = useState<ThreadSummary[]>([]);
	const [drafts, setDrafts] = useState<ReadonlyMap<string, Draft>>(() => new Map());
	/** The cards whose reply has text that a close discards. */
	const [dirtyIds, setDirtyIds] = useState<ReadonlySet<string>>(() => new Set());
	const [activeId, setActiveId] = useState<string | null>(null);
	const [request, setRequest] = useState<CardRequest | null>(null);
	/** Grows each time a key, a send or Done changes the active card. That card then gets the focus. */
	const [scrollToken, setScrollToken] = useState(0);
	/** The cards in their exit motion. They stay on the page, inert, until the motion ends. */
	const [leaving, setLeaving] = useState<ReadonlyMap<string, LeaveKind>>(() => new Map());
	// The same map, changed at once: a timer that comes late must see that Undo put its card back.
	const leavingRef = useRef<ReadonlyMap<string, LeaveKind>>(new Map());
	/** The timer that ends the exit motion of each card, so Undo can stop it. */
	const leaveTimers = useRef(new Map<string, number>());
	/** The conversations that the person cleared in this visit, in order. */
	const [log, setLog] = useState<readonly Cleared[]>([]);
	/** The text of the polite live region, for example after a send. */
	const [announce, setAnnounce] = useState("");
	/** True while the focus is in a reply, so the hints show the keys of the composer. */
	const [typing, setTyping] = useState(false);
	/** The cards that came back with Undo. They stay until the queue from the server has them again. */
	const restoringRef = useRef(new Set<string>());
	const keepRef = useRef<ReadonlySet<string>>(new Set());
	keepRef.current = new Set([...drafts.keys(), ...leavingRef.current.keys(), ...restoringRef.current]);
	const title = props.mailboxName ? `${props.mailboxName}: Focus & Reply` : "Focus & Reply";
	const listPath = viewPath(REPLY_LATER_VIEW, mailboxId);
	const inboxPath = viewPath({ kind: "system", view: "inbox" }, mailboxId);
	const doneChange = actionChange("replyLaterDone");

	useOnChange(props.refreshKey, () => void list.refresh());

	useEffect(() => {
		const timers = leaveTimers.current;
		return () => {
			for (const timer of timers.values()) window.clearTimeout(timer);
		};
	}, []);

	// The cards keep their order on screen. A card with an open reply, a card in its exit motion and a card that
	// came back with Undo stay, also when the conversation is not in the fresh queue.
	useEffect(() => {
		if (list.status !== "ready") return;
		setItems((current) => mergeQueue(current, list.threads, keepRef.current, list.nextCursor === null));
		for (const id of restoringRef.current) {
			if (list.threads.some((thread) => thread.id === id)) restoringRef.current.delete(id);
		}
	}, [list.status, list.threads, list.nextCursor]);

	// A reply in a card goes away with the page, and the page is not inert as it is under a dialog. So the app
	// asks before it leaves the page, and the browser asks before it closes or reloads the tab.
	const unsent = dirtyIds.size > 0;
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

	const complete = list.nextCursor === null;
	/** The cards that a key can reach: each card that is not in its exit motion. */
	const ids = items.filter((item) => !leaving.has(item.id)).map((item) => item.id);
	const active = activeId !== null && ids.includes(activeId) ? activeId : (ids[0] ?? null);
	// The list has rows that the cards do not have yet: the cards come one render after the list.
	const merging = list.status === "ready" && items.length === 0 && list.threads.length > 0;
	// A card can stay for its open reply after its conversation left the queue. It does not count as waiting.
	const queuedIds = ids.filter((id) => {
		const item = items.find((candidate) => candidate.id === id);
		return item !== undefined && !leftQueue(item, list.threads, complete);
	});
	// With more pages, the count of the label is the size of the queue. Else the cards on screen are the queue: the
	// count of the label comes a moment later after a change.
	const left = complete
		? queuedIds.length
		: Math.max(labelsById.get("REPLY_LATER")?.threads_total ?? 0, queuedIds.length);
	const progress = sessionProgress(log.length, left);

	/** Starts or stops the exit motion of a card, in the ref and in the state. */
	function markLeaving(threadId: string, how: LeaveKind | null) {
		const next = new Map(leavingRef.current);
		if (how) next.set(threadId, how);
		else next.delete(threadId);
		leavingRef.current = next;
		setLeaving(next);
		const timer = leaveTimers.current.get(threadId);
		if (timer !== undefined) window.clearTimeout(timer);
		leaveTimers.current.delete(threadId);
		if (how)
			leaveTimers.current.set(
				threadId,
				window.setTimeout(() => finishLeave(threadId), LEAVE_MS),
			);
	}

	function setDraft(threadId: string, draft: Draft | null) {
		setDrafts((current) => {
			const next = new Map(current);
			if (draft) next.set(threadId, draft);
			else next.delete(threadId);
			return next;
		});
		if (!draft) setDirty(threadId, false);
	}

	function setDirty(threadId: string, dirty: boolean) {
		setDirtyIds((current) => {
			if (current.has(threadId) === dirty) return current;
			const next = new Set(current);
			if (dirty) next.add(threadId);
			else next.delete(threadId);
			return next;
		});
	}

	/** Makes a card active and gives it the focus. With no card left, the page gets the focus. */
	function moveTo(threadId: string | null) {
		setActiveId(threadId);
		setScrollToken((token) => token + 1);
		if (threadId === null) mainRef.current?.focus();
	}

	function ask(threadId: string, mode: ReplyMode) {
		setRequest((current) => ({ threadId, mode, token: (current?.token ?? 0) + 1 }));
	}

	/**
	 * Takes a card off the page. The list drops it at once, so a refresh does not bring it back. The card plays
	 * its exit motion, and the next card becomes active at the start of the motion. Returns the next card.
	 */
	function leave(thread: ThreadSummary, how: LeaveKind): string | null {
		const next = nextActive(ids, thread.id);
		setDraft(thread.id, null);
		list.patch([thread.id], doneChange, REPLY_LATER_VIEW);
		setLog((current) => [
			...current.filter((item) => item.id !== thread.id),
			{ id: thread.id, subject: thread.subject.trim() || "(no subject)", how: how === "sent" ? "answered" : "done" },
		]);
		if (reducedMotion()) setItems((current) => current.filter((item) => item.id !== thread.id));
		else markLeaving(thread.id, how);
		if (active === thread.id || active === null) moveTo(next);
		return next;
	}

	/**
	 * Ends the exit motion of a card: the card goes. A second call, or a call for a card that Undo put back,
	 * changes nothing.
	 */
	function finishLeave(threadId: string) {
		if (!leavingRef.current.has(threadId)) return;
		markLeaving(threadId, null);
		setItems((current) => current.filter((item) => item.id !== threadId));
	}

	/** Closes the reply of a card. A card that left the queue while its reply was open goes too. */
	function closeDraft(threadId: string) {
		setDraft(threadId, null);
		setItems((current) => current.filter((item) => item.id !== threadId || !leftQueue(item, list.threads, complete)));
		// The composer had the focus. It goes back to the card, so the keys of the page work again.
		moveTo(threadId);
	}

	function reply(threadId: string, message: Message, mode: ReplyMode) {
		if (!rights.send) return;
		if (mode === "forward") {
			onCompose(forwardDraft(message));
			return;
		}
		setActiveId(threadId);
		// A new draft would mount a new composer and lose the text of the open one. The open one gets the focus.
		if (drafts.has(threadId)) {
			ask(threadId, mode);
			return;
		}
		setDraft(threadId, replyDraft(message, myAddress, mode === "replyAll"));
	}

	function sent(thread: ThreadSummary, result: SendResult) {
		const next = leave(thread, "sent");
		// The reply of the next card opens: the person continues with no click.
		if (next && rights.send) ask(next, "reply");
		setAnnounce(`Reply sent. ${sessionProgress(log.length + 1, Math.max(0, left - 1)).label}.`);
		const failed = result.recipients.filter((recipient) => recipient.status === "failed");
		if (failed.length > 0) {
			toast({
				message: `Reply sent, but delivery failed for ${failed.map((recipient) => recipient.address).join(", ")}.`,
				tone: "error",
			});
		}
		onChanged();
	}

	async function done(thread: ThreadSummary) {
		if (!rights.modify) return;
		const index = items.findIndex((item) => item.id === thread.id);
		const undos = undoChanges([{ id: thread.id, labelIds: thread.label_ids }], doneChange);
		leave(thread, "done");
		try {
			await modifyThreads(mailboxId, [thread.id], doneChange);
			const notice = actionNotice("replyLaterDone", 1) ?? "";
			toast(
				undos.length > 0
					? { message: notice, action: { label: "Undo", run: () => void undoDone(thread, index, undos) } }
					: { message: notice },
			);
		} catch (error) {
			toast({ message: `The change failed. ${errorMessage(error)}`, tone: "error" });
			restore(thread, index);
		}
		onChanged();
	}

	/** Puts a card back at its old place, for example after Undo of Done. */
	function restore(thread: ThreadSummary, index: number) {
		restoringRef.current.add(thread.id);
		if (leavingRef.current.has(thread.id)) markLeaving(thread.id, null);
		setItems((current) => restoreAt(current, thread, index));
		setLog((current) => current.filter((item) => item.id !== thread.id));
	}

	async function undoDone(thread: ThreadSummary, index: number, undos: readonly Undo[]) {
		restore(thread, index);
		try {
			for (const undo of undos) await modifyThreads(mailboxId, undo.ids, undo.change);
			toast({ message: "Action undone." });
		} catch (error) {
			// The conversation is not in Reply later, so its card goes again.
			restoringRef.current.delete(thread.id);
			setItems((current) => current.filter((item) => item.id !== thread.id));
			setLog((current) => [
				...current,
				{ id: thread.id, subject: thread.subject.trim() || "(no subject)", how: "done" },
			]);
			toast({ message: `The undo failed. ${errorMessage(error)}`, tone: "error" });
		}
		onChanged();
	}

	useShortcuts((event) => {
		const activeThread = items.find((item) => item.id === active);
		switch (event.key) {
			case "j":
			case "k": {
				const next = moveActive(ids, active, event.key === "j" ? 1 : -1);
				if (next) moveTo(next);
				break;
			}
			case "r":
			case "a":
			case "f":
				if (!rights.send || active === null) return;
				ask(active, event.key === "r" ? "reply" : event.key === "a" ? "replyAll" : "forward");
				break;
			case "l":
				// An open reply can hold text. Close it first, so a key press never discards it.
				if (!rights.modify || !activeThread || drafts.has(activeThread.id)) return;
				void done(activeThread);
				break;
			case "o":
				if (active === null) return;
				navigate(threadPath(REPLY_LATER_VIEW, active, mailboxId));
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

	function trackTyping(event: FocusEvent<HTMLElement>) {
		setTyping(
			event.type === "focus" && event.target instanceof HTMLElement && !!event.target.closest(".compose-inline"),
		);
	}

	const finished = list.status === "ready" && !merging && items.length === 0 && log.length > 0;
	const showStatus = list.status === "ready" && (ids.length > 0 || log.length > 0);

	return (
		<main
			id="main"
			className="mail-main"
			tabIndex={-1}
			ref={mainRef}
			onFocusCapture={trackTyping}
			onBlurCapture={(event) => {
				if (!event.relatedTarget || !mainRef.current?.contains(event.relatedTarget as Node)) setTyping(false);
			}}
		>
			<div className="toolbar">
				<Link to={listPath} className="icon-button" aria-label="Back to Reply later" title="Back to Reply later (u)">
					<Icon name="back" />
				</Link>
				<div className="page-title">
					<Icon name="reply" />
					<h1 className="toolbar-title">{title}</h1>
				</div>
				<span className="toolbar-spacer" />
				<SearchBox product="mail" query="" mailboxId={mailboxId} />
			</div>
			<MailboxNotice />
			{showStatus && (
				<div className="focus-status">
					<p className="focus-status-count">{progress.label}</p>
					<p className="focus-hints" aria-hidden="true" hidden={ids.length === 0}>
						{typing ? (
							<>
								<span>
									<kbd>{MOD_KEY}</kbd> <kbd>Enter</kbd> Send
								</span>
								<span>
									<kbd>Esc</kbd> Close
								</span>
							</>
						) : (
							<>
								<span>
									<kbd>j</kbd> <kbd>k</kbd> Move
								</span>
								{rights.send && (
									<span>
										<kbd>r</kbd> Reply
									</span>
								)}
								{rights.modify && (
									<span>
										<kbd>l</kbd> Done
									</span>
								)}
								<span>
									<kbd>?</kbd> Shortcuts
								</span>
							</>
						)}
					</p>
					<span className="focus-progress" style={{ width: `${progress.fraction * 100}%` }} aria-hidden="true" />
				</div>
			)}
			<p className="visually-hidden" aria-live="polite">
				{announce}
			</p>
			<div className="mail-scroll" ref={setScroller}>
				{list.status === "loading" || merging ? (
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
				) : finished ? (
					<FinishState log={log} mailboxId={mailboxId} inboxPath={inboxPath} listPath={listPath} />
				) : items.length === 0 ? (
					<div className="list-state mail-state">
						<span className="mail-state-icon">
							<Icon name="check" size={22} />
						</span>
						<p className="mail-state-title">No conversation waits for an answer.</p>
						<p className="mail-state-text">Use Reply later on a conversation to put it here.</p>
						<Link to={inboxPath} className="button">
							Go to the inbox
						</Link>
					</div>
				) : (
					<>
						<ol className="focus-list" aria-label="Conversations in Reply later">
							{items.map((thread) => (
								<FocusCard
									key={thread.id}
									summary={thread}
									scroller={scroller}
									myAddress={myAddress}
									labelsById={labelsById}
									canModify={rights.modify}
									active={thread.id === active}
									leaving={leaving.get(thread.id) ?? null}
									queued={queuedIds.includes(thread.id)}
									canSkip={thread.id === active && ids.indexOf(thread.id) < ids.length - 1}
									scrollToken={scrollToken}
									request={request?.threadId === thread.id ? request : null}
									draft={drafts.get(thread.id) ?? null}
									composer={props.composer}
									onActivate={() => setActiveId(thread.id)}
									onReply={(message, mode) => reply(thread.id, message, mode)}
									onCloseDraft={() => closeDraft(thread.id)}
									onDirtyChange={(dirty) => setDirty(thread.id, dirty)}
									onSent={(result) => sent(thread, result)}
									onDone={() => void done(thread)}
									onSkip={() => moveTo(moveActive(ids, thread.id, 1))}
									onLeft={() => finishLeave(thread.id)}
								/>
							))}
						</ol>
						{list.nextCursor !== null && (
							<div className="list-footer">
								<button
									type="button"
									className="button"
									disabled={list.loadingOlder}
									onClick={() =>
										void list
											.loadOlder()
											.catch((error: unknown) =>
												toast({ message: `Older conversations did not load. ${errorMessage(error)}`, tone: "error" }),
											)
									}
								>
									{list.loadingOlder ? "Loading…" : "Older"}
								</button>
							</div>
						)}
					</>
				)}
			</div>
		</main>
	);
}

/** The page after the last card goes: what the person answered and marked as done in this visit. */
function FinishState({
	log,
	mailboxId,
	inboxPath,
	listPath,
}: {
	log: readonly Cleared[];
	mailboxId: string | null;
	inboxPath: string;
	listPath: string;
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
							<span className="focus-finish-how">{item.how === "answered" ? "Answered" : "Done"}</span>
						</li>
					))}
					{log.length > shown.length && <li className="focus-finish-more">and {log.length - shown.length} more</li>}
				</ul>
			</section>
			<div className="focus-finish-actions">
				<Link to={inboxPath} className="button button-primary">
					Go to the inbox
				</Link>
				<Link to={listPath} className="button">
					Reply later list
				</Link>
			</div>
		</div>
	);
}

/**
 * True after the element comes near the visible part of `root`. It stays true. Without
 * IntersectionObserver, it is true at once.
 */
function useNearView(ref: { current: Element | null }, root: Element | null): boolean {
	const [near, setNear] = useState(false);
	useEffect(() => {
		const element = ref.current;
		if (near || !element || !root) return;
		if (typeof IntersectionObserver === "undefined") {
			setNear(true);
			return;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					setNear(true);
					observer.disconnect();
				}
			},
			{ root, rootMargin: PRELOAD_MARGIN },
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref, root, near]);
	return near;
}

interface FocusCardProps {
	summary: ThreadSummary;
	/** The scroll container of the page. A card loads its thread when it comes near the visible part. */
	scroller: HTMLElement | null;
	myAddress: string;
	labelsById: ReadonlyMap<string, Label>;
	canModify: boolean;
	active: boolean;
	/** The exit motion of the card, or null for a card that stays. */
	leaving: LeaveKind | null;
	/** False when the conversation left the queue and the card stays for its open reply. */
	queued: boolean;
	/** True for the active card when a card comes after it. */
	canSkip: boolean;
	scrollToken: number;
	/** A request to this card, or null. */
	request: CardRequest | null;
	draft: Draft | null;
	composer: FocusReplyProps["composer"];
	onActivate: () => void;
	onReply: (message: Message, mode: ReplyMode) => void;
	onCloseDraft: () => void;
	onDirtyChange: (dirty: boolean) => void;
	onSent: (result: SendResult) => void;
	onDone: () => void;
	onSkip: () => void;
	/** The exit motion ended. */
	onLeft: () => void;
}

/**
 * One conversation of Focus & Reply: the subject, the people, Done and Skip, the newest message with its reply
 * buttons, and the reply in the card when it is open.
 */
function FocusCard(props: FocusCardProps) {
	const { summary, active, draft, request, onReply } = props;
	const ref = useRef<HTMLLIElement>(null);
	const mailboxId = useMailboxId();
	const near = useNearView(ref, props.scroller);
	// The active card and a card with a reply load their thread also when they are not near the visible part.
	// A card that loaded its thread keeps it.
	const [wanted, setWanted] = useState(false);
	if (!wanted && (near || active || draft !== null)) setWanted(true);
	const thread = useThread(mailboxId, wanted ? summary.id : null);
	const subject = summary.subject.trim() || "(no subject)";
	const messages = thread.thread?.messages ?? [];
	const newest = replyTarget(messages);
	const earlier = (thread.thread ? messages.length : summary.message_count) - 1;
	/** The scroll token that this card saw last. A card that mounts later starts at the current token. */
	const scrolledRef = useRef(props.scrollToken);
	/** The last request that this card handled, so one request acts one time. */
	const handledRef = useRef<number | null>(null);
	/** The time when this card last came to the top of the view, from `performance.now()`. */
	const scrolledAtRef = useRef(0);
	const draftKey = draft?.key ?? null;

	// The list refreshes after each change in the mailbox. A card gets its thread again only when the thread
	// changed, so one Done does not get each card again.
	useOnChange(`${summary.last_message_at} ${summary.message_count}`, () => void thread.refresh());
	// A conversation leaves the queue under an open reply when a different member answers it. The card gets the
	// thread again, so the person sees that answer before the send.
	useOnChange(props.queued, () => void thread.refresh());

	useEffect(() => {
		if (!active) scrolledRef.current = props.scrollToken;
	}, [active, props.scrollToken]);

	// A key, a send or Done makes this card active: it gets the focus and comes to the top of the view. A click in
	// a card also makes it active. That must not move the view, so the effect acts one time for each token.
	useEffect(() => {
		if (!active || props.scrollToken === scrolledRef.current) return;
		scrolledRef.current = props.scrollToken;
		scrolledAtRef.current = performance.now();
		const card = ref.current;
		card?.querySelector<HTMLElement>(".focus-card-subject a")?.focus({ preventScroll: true });
		card?.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
	}, [active, props.scrollToken]);

	// A reply that opens comes into view: the person clicked Reply, and the editor can be under the visible part.
	// After a send, the card itself just came to the top, and a second scroll would stop that motion.
	useEffect(() => {
		if (draftKey === null || performance.now() - scrolledAtRef.current < 800) return;
		ref.current
			?.querySelector(".compose-inline .ProseMirror")
			?.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
	}, [draftKey]);

	// A request opens the reply when the thread is ready. A reply that is open gets the focus, and keeps its text.
	useEffect(() => {
		if (request === null || request.token === handledRef.current || !newest) return;
		handledRef.current = request.token;
		if (draft && request.mode !== "forward") {
			ref.current
				?.querySelector<HTMLElement>(".compose-inline [data-autofocus], .compose-inline .ProseMirror")
				?.focus();
			return;
		}
		onReply(newest, request.mode);
	}, [request, newest, draft, onReply]);

	function ended(event: AnimationEvent<HTMLLIElement>) {
		if (event.target === event.currentTarget && props.leaving) props.onLeft();
	}

	const className = [
		"focus-card",
		active && !props.leaving ? "focus-card-active" : "",
		props.leaving ? `focus-card-${props.leaving}` : "",
	]
		.filter(Boolean)
		.join(" ");

	return (
		<li
			ref={ref}
			className={className}
			aria-current={active && !props.leaving ? "true" : undefined}
			aria-hidden={props.leaving ? true : undefined}
			inert={props.leaving !== null}
			onFocusCapture={props.onActivate}
			onPointerDownCapture={props.onActivate}
			onAnimationEnd={ended}
		>
			<div className="focus-card-body">
				<div className="focus-card-header">
					<div className="focus-card-title">
						<h2 className="focus-card-subject">
							<Link to={threadPath(REPLY_LATER_VIEW, summary.id, mailboxId)}>{subject}</Link>
						</h2>
						<p className="focus-card-people">
							{participantsLabel(summary.participants, mailboxId ? "" : props.myAddress)}
							{earlier > 0 && ` · ${earlier} more ${earlier === 1 ? "message" : "messages"} in the conversation`}
						</p>
					</div>
					<div className="focus-card-actions">
						{props.canSkip && (
							<button
								type="button"
								className="button button-small button-ghost"
								onClick={props.onSkip}
								title="Skip (j)"
							>
								Skip
								<span className="visually-hidden">: go to the next conversation</span>
							</button>
						)}
						{props.canModify && (
							<button type="button" className="button button-small" onClick={props.onDone} title="Done (l)">
								<Icon name="check" size={16} />
								Done
								<span className="visually-hidden">: remove “{subject}” from Reply later</span>
							</button>
						)}
					</div>
				</div>
				{newest ? (
					<div className="messages">
						<MessageCard
							key={newest.id}
							message={newest}
							myAddress={props.myAddress}
							labelsById={props.labelsById}
							defaultExpanded
							heading="h3"
							onReply={onReply}
						/>
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
				{draft && !props.queued && (
					<p className="focus-card-note" role="status">
						This conversation left Reply later. Your reply is still here.
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
		</li>
	);
}
