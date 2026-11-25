import type { Label, Message, ThreadSummary } from "@asterra/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { Icon } from "../../lib/icons.tsx";
import { Link, navigate } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { useOnChange } from "../../lib/useOnChange.ts";
import { focusPath, type MailView, mailSettingsPath, REPLY_LATER_VIEW, threadPath, viewPath } from "../../routes.ts";
import { SEARCH_INPUT_ID } from "../../shell/nav.ts";
import { SearchBox } from "../../shell/SearchBox.tsx";
import {
	actionChange,
	actionNotice,
	belongsInView,
	changeLabels,
	type MailAction,
	modifyThreads,
	type Undo,
	undoChanges,
	undoNow,
} from "./actions.ts";
import { removesAutoLabel } from "./autoLabels.ts";
import { type Draft, forwardDraft, replyDraft } from "./compose.ts";
import { useThread, useThreadList } from "./data.ts";
import { focusMode } from "./focusReply.ts";
import { MailboxNotice } from "./MailboxNotice.tsx";
import type { ReplyMode } from "./MessageCard.tsx";
import { mailboxInput, useMailboxId, useMailboxRights } from "./mailbox.tsx";
import { showsHeldMail } from "./screener.ts";
import { ThreadList } from "./ThreadList.tsx";
import { ThreadView } from "./ThreadView.tsx";
import { Toolbar } from "./Toolbar.tsx";
import { useShortcuts } from "./useShortcuts.ts";
import { type ViewQuery, viewIcon } from "./views.ts";

/** Actions that send the open thread back to the list. */
const LEAVE_THREAD: readonly MailAction[] = ["archive", "trash", "spam", "notSpam", "restore", "unread"];

/** The shortcuts that change the mailbox, or select threads for a change. They need `mail.modify`. */
const CHANGE_KEYS: ReadonlySet<string> = new Set(["e", "#", "s", "x", "l"]);

/** The shortcuts that start a message. They need `mail.send`. */
const SEND_KEYS: ReadonlySet<string> = new Set(["c", "r"]);

interface MailPaneProps {
	view: MailView;
	threadId: string | null;
	query: ViewQuery;
	title: string;
	/** The name of the team mailbox or the agent mailbox of the views, or null in the own mailbox. */
	mailboxName: string | null;
	labels: readonly Label[] | null;
	labelsById: ReadonlyMap<string, Label>;
	myAddress: string;
	/** Grows when the mailbox version changes. The pane then gets the list and the thread again. */
	refreshKey: number;
	/** Call after a change, so the labels and counts update. */
	onChanged: () => void;
	onCompose: (draft?: Draft) => void;
	onShowHelp: () => void;
}

/** The main pane of one view: the toolbar, then the thread list or the open thread. */
export function MailPane(props: MailPaneProps) {
	const { view, threadId, query, title, labelsById, myAddress, onChanged, onCompose } = props;
	const toast = useToast();
	const mailboxId = useMailboxId();
	const rights = useMailboxRights();
	const readOnly = !rights.modify;
	const list = useThreadList(mailboxId, query.status === "ready" ? query.query : null);
	const thread = useThread(mailboxId, threadId);
	const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
	const [cursor, setCursor] = useState(0);
	const [focusToken, setFocusToken] = useState(0);
	/** The thread id and the unread message ids that the pane marked as read last. */
	const markedRef = useRef<string | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const listScrollRef = useRef(0);

	const listMode = threadId === null;
	const threads = list.threads;
	const cursorIndex = Math.min(cursor, Math.max(0, threads.length - 1));
	const selectedIds = threads.filter((item) => selected.has(item.id)).map((item) => item.id);
	const userLabels = (props.labels ?? []).filter((label) => label.type === "user");

	useOnChange(props.refreshKey, () => {
		void list.refresh();
		void thread.refresh();
	});

	// Keep the cursor on the thread that opened, so j and k continue from it. A thread that opens
	// again is marked as read again, for example after "Mark as unread".
	useOnChange(threadId, () => {
		markedRef.current = null;
		const index = threads.findIndex((item) => item.id === threadId);
		if (index >= 0) setCursor(index);
	});

	// The list keeps its scroll position. A thread opens at the top.
	useLayoutEffect(() => {
		const scroller = scrollRef.current;
		if (!scroller) return;
		scroller.scrollTop = listMode ? listScrollRef.current : 0;
		if (!listMode) return;
		const save = () => {
			listScrollRef.current = scroller.scrollTop;
		};
		scroller.addEventListener("scroll", save, { passive: true });
		return () => scroller.removeEventListener("scroll", save);
	}, [listMode]);

	// When an unread thread opens, the pane marks it as read. mail.get_thread does not do it. A refresh
	// can bring a new unread message into the open thread, so the guard keys on the unread message ids:
	// a new set is marked again, and the same set is not sent twice. In the mailbox of an agent, the
	// thread stays unread: the agent must still find its new mail.
	const openThread = thread.thread;
	const patchThread = thread.patch;
	const patchList = list.patch;
	useEffect(() => {
		if (!openThread || readOnly) return;
		const unreadIds = openThread.messages.filter((m) => m.label_ids.includes("UNREAD")).map((m) => m.id);
		if (unreadIds.length === 0 && !openThread.label_ids.includes("UNREAD")) return;
		const key = `${openThread.id} ${unreadIds.sort().join(" ")}`;
		if (markedRef.current === key) return;
		markedRef.current = key;
		const change = actionChange("read");
		patchThread(change);
		patchList([openThread.id], change, view);
		modifyThreads(mailboxId, [openThread.id], change).then(onChanged, (error: unknown) =>
			toast({ message: `The conversation was not marked as read. ${errorMessage(error)}`, tone: "error" }),
		);
	}, [mailboxId, readOnly, openThread, patchThread, patchList, view, onChanged, toast]);

	const labelsOf = useCallback(
		(id: string): readonly string[] | null =>
			threads.find((item) => item.id === id)?.label_ids ?? (openThread?.id === id ? openThread.label_ids : null),
		[threads, openThread],
	);

	async function run(action: MailAction, ids: readonly string[]) {
		if (ids.length === 0 || readOnly) return;
		const change = actionChange(action);
		// Undo reverts the change only on the threads that it changed, and only the labels that it changed. A
		// thread whose labels the pane does not know yet (an open thread that still loads) gets no undo: a guess
		// could add a label that the thread did not have, for example INBOX on an archived thread.
		const undos = undoChanges(
			ids.flatMap((id) => {
				const labelIds = labelsOf(id);
				return labelIds === null ? [] : [{ id, labelIds }];
			}),
			change,
		);
		const openLabels = threadId && ids.includes(threadId) ? labelsOf(threadId) : null;
		// A person who removes a label that auto labels applied corrects them. Say that they learn from it.
		const corrects = removesAutoLabel(
			[
				...threads.filter((item) => ids.includes(item.id)),
				...(openThread && ids.includes(openThread.id) ? [openThread] : []),
			],
			change.remove,
		);
		list.patch(ids, change, view);
		if (openThread && ids.includes(openThread.id)) thread.patch(change);
		if (threadId && ids.includes(threadId)) {
			const leaves = LEAVE_THREAD.includes(action) || !belongsInView(changeLabels(openLabels ?? [], change), view);
			if (leaves) navigate(viewPath(view, mailboxId));
		}
		if (actionNotice(action, ids.length)) {
			setSelected((current) => new Set([...current].filter((id) => !ids.includes(id))));
		}
		try {
			await modifyThreads(mailboxId, ids, change);
			const notice = actionNotice(action, ids.length);
			if (corrects) {
				// The mailbox learns only while its auto labels are on. The marks stay after a person turns them off.
				void api.call("mail.get_auto_labels", mailboxInput(mailboxId)).then(
					(settings) => {
						if (settings.enabled) toast({ message: "Label removed. Auto labels learn from this." });
					},
					() => {},
				);
			}
			if (notice) {
				toast(
					undos.length > 0
						? { message: notice, action: { label: "Undo", run: () => void undo(undos) } }
						: { message: notice },
				);
			}
		} catch (error) {
			toast({ message: `The change failed. ${errorMessage(error)}`, tone: "error" });
		}
		onChanged();
	}

	async function undo(undos: readonly Undo[]) {
		await undoNow(mailboxId, undos, toast);
		onChanged();
	}

	function toggleSelect(id: string) {
		setSelected((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}

	function toggleStar(item: ThreadSummary) {
		void run(item.starred ? "unstar" : "star", [item.id]);
	}

	function reply(message: Message, mode: ReplyMode) {
		onCompose(mode === "forward" ? forwardDraft(message) : replyDraft(message, myAddress, mode === "replyAll"));
	}

	const targets: readonly string[] = listMode ? selectedIds : threadId ? [threadId] : [];
	const targetSummaries = threads.filter((item) => targets.includes(item.id));
	const anyUnread = listMode && targetSummaries.some((item) => item.unread);
	const allStarred = listMode
		? targetSummaries.length > 0 && targetSummaries.every((item) => item.starred)
		: (openThread?.label_ids.includes("STARRED") ?? false);
	// In the inbox, Reply later always moves the threads out. A thread with REPLY_LATER is in the inbox only
	// because new mail came, and the person then wants it out again, not out of Reply later.
	const inInbox = view.kind === "system" && view.view === "inbox";
	const allReplyLater =
		!inInbox &&
		(listMode
			? targetSummaries.length > 0 && targetSummaries.every((item) => item.label_ids.includes("REPLY_LATER"))
			: (openThread?.label_ids.includes("REPLY_LATER") ?? false));
	const inSpamOrTrash = view.kind === "system" && (view.view === "spam" || view.view === "trash");
	const replyLaterCount = labelsById.get("REPLY_LATER")?.threads_total ?? 0;
	// The server refuses a move of the mail that the Screener holds, so the pane does not offer one.
	const held = showsHeldMail(view);

	useShortcuts((event) => {
		if (readOnly && CHANGE_KEYS.has(event.key)) return;
		if (!rights.send && SEND_KEYS.has(event.key)) return;
		const current = threads[cursorIndex];
		const keyTargets = listMode ? (selectedIds.length > 0 ? selectedIds : current ? [current.id] : []) : targets;
		switch (event.key) {
			case "j":
			case "k": {
				const step = event.key === "j" ? 1 : -1;
				if (listMode) {
					setCursor(Math.max(0, Math.min(threads.length - 1, cursorIndex + step)));
					setFocusToken((token) => token + 1);
				} else {
					const index = threads.findIndex((item) => item.id === threadId);
					const next = index >= 0 ? threads[index + step] : undefined;
					if (next) navigate(threadPath(view, next.id, mailboxId));
				}
				break;
			}
			case "Enter":
				// A focused link or button handles Enter itself.
				if (event.target instanceof HTMLElement && event.target.closest("a, button, summary, label")) return;
				if (listMode && current) navigate(threadPath(view, current.id, mailboxId));
				break;
			case "o":
				if (listMode && current) navigate(threadPath(view, current.id, mailboxId));
				break;
			case "u":
				if (!listMode) navigate(viewPath(view, mailboxId));
				break;
			case "e":
				if (!inSpamOrTrash && !held) void run("archive", keyTargets);
				break;
			case "#":
				if (!inSpamOrTrash && !held) void run("trash", keyTargets);
				break;
			case "s": {
				if (inSpamOrTrash) break;
				const starTargets = listMode ? (current ? [current] : []) : targetSummaries;
				const starred = listMode ? (current?.starred ?? false) : allStarred;
				const ids = listMode ? starTargets.map((item) => item.id) : targets;
				void run(starred ? "unstar" : "star", ids);
				break;
			}
			case "l": {
				// Reply later, or Done for threads that are in Reply later already.
				if (inSpamOrTrash || held) break;
				const inReplyLater = listMode
					? !inInbox &&
						keyTargets.length > 0 &&
						keyTargets.every((id) => labelsOf(id)?.includes("REPLY_LATER") === true)
					: allReplyLater;
				void run(inReplyLater ? "replyLaterDone" : "replyLater", keyTargets);
				break;
			}
			case "x":
				if (listMode && current) toggleSelect(current.id);
				break;
			case "c":
				onCompose();
				break;
			case "r": {
				const last = openThread?.messages[openThread.messages.length - 1];
				if (!listMode && last) reply(last, "reply");
				break;
			}
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

	const selection = selectedIds.length === 0 ? "none" : selectedIds.length === threads.length ? "all" : "some";

	return (
		<main id="main" className="mail-main" tabIndex={-1}>
			<Toolbar
				view={view}
				title={props.mailboxName ? `${props.mailboxName}: ${title}` : title}
				icon={viewIcon(view)}
				search={<SearchBox product="mail" query={view.kind === "search" ? view.query : ""} mailboxId={mailboxId} />}
				mode={listMode ? "list" : "thread"}
				targetCount={targets.length}
				selection={selection}
				anyUnread={anyUnread}
				allStarred={allStarred}
				allReplyLater={allReplyLater}
				userLabels={userLabels}
				listEmpty={threads.length === 0}
				readOnly={readOnly}
				held={held}
				onToggleAll={() => setSelected(selection === "all" ? new Set() : new Set(threads.map((item) => item.id)))}
				onAction={(action) => void run(action, targets)}
				onBack={() => navigate(viewPath(view, mailboxId))}
				onRefresh={() => {
					void list.refresh();
					onChanged();
				}}
				focusPath={focusMode(view) ? focusPath(view, mailboxId) : null}
				settingsPath={mailSettingsPath(mailboxId)}
			/>
			<MailboxNotice />
			<div className="mail-scroll" ref={scrollRef}>
				{query.status === "missing" ? (
					<div className="list-state" role="alert">
						This label does not exist.
					</div>
				) : listMode ? (
					<>
						{view.kind === "system" && view.view === "reply-later" && threads.length > 0 && (
							<FocusBanner mailboxId={mailboxId} />
						)}
						<ThreadList
							view={view}
							title={title}
							list={list}
							// In a team mailbox, more than one person sends from the address, so no sender shows as "me". In
							// the mailbox of an agent, the person who reads is not the sender.
							myAddress={mailboxId ? "" : myAddress}
							labelsById={labelsById}
							selected={selected}
							cursor={cursorIndex}
							focusToken={focusToken}
							onToggleSelect={toggleSelect}
							onToggleStar={toggleStar}
							onFocusRow={setCursor}
							onLoadOlder={() =>
								void list
									.loadOlder()
									.catch((error: unknown) =>
										toast({ message: `Older conversations did not load. ${errorMessage(error)}`, tone: "error" }),
									)
							}
							onRetry={() => void list.retry()}
						/>
						{view.kind === "system" && view.view === "inbox" && replyLaterCount > 0 && list.status === "ready" && (
							<ReplyLaterPile mailboxId={mailboxId} count={replyLaterCount} />
						)}
					</>
				) : (
					<ThreadView
						state={thread}
						myAddress={myAddress}
						labelsById={labelsById}
						onReply={reply}
						onRetry={() => void thread.retry()}
						onRemoveLabel={
							readOnly || held || !openThread ? undefined : (labelId) => void run({ unlabel: labelId }, [openThread.id])
						}
					/>
				)}
			</div>
		</main>
	);
}

/** The top of the Reply later list: the way into Focus & Reply. */
function FocusBanner({ mailboxId }: { mailboxId: string | null }) {
	return (
		<div className="reply-later-banner">
			<p>Answer these conversations one after the other, each with its newest message.</p>
			<Link to={focusPath(REPLY_LATER_VIEW, mailboxId)} className="button button-primary button-small">
				<Icon name="reply" size={16} />
				Focus &amp; Reply
			</Link>
		</div>
	);
}

/**
 * The pile of Reply later at the end of the inbox. The conversations in it are out of the inbox, so the pile
 * shows that they still wait for an answer.
 */
function ReplyLaterPile({ mailboxId, count }: { mailboxId: string | null; count: number }) {
	return (
		<section className="reply-later-pile" aria-label="Reply later">
			<Link to={viewPath(REPLY_LATER_VIEW, mailboxId)} className="reply-later-pile-link">
				<Icon name="clock" size={18} />
				<span>
					<strong>Reply later</strong> · {count} {count === 1 ? "conversation waits" : "conversations wait"} for an
					answer
				</span>
			</Link>
			<Link to={focusPath(REPLY_LATER_VIEW, mailboxId)} className="button button-small">
				Focus &amp; Reply
			</Link>
		</section>
	);
}
