import type { Label, Message, ThreadSummary } from "@soldock/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { errorMessage } from "../../lib/api.ts";
import { navigate } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { useOnChange } from "../../lib/useOnChange.ts";
import { type MailView, threadPath, viewPath } from "../../routes.ts";
import { SEARCH_INPUT_ID } from "../../shell/TopBar.tsx";
import {
	actionChange,
	actionNotice,
	belongsInView,
	changeLabels,
	changesLabels,
	invertChange,
	type MailAction,
	modifyThreads,
} from "./actions.ts";
import { type Draft, forwardDraft, replyDraft } from "./compose.ts";
import { useThread, useThreadList } from "./data.ts";
import type { ReplyMode } from "./MessageCard.tsx";
import { ThreadList } from "./ThreadList.tsx";
import { ThreadView } from "./ThreadView.tsx";
import { Toolbar } from "./Toolbar.tsx";
import { useShortcuts } from "./useShortcuts.ts";
import type { ViewQuery } from "./views.ts";

/** Actions that send the open thread back to the list. */
const LEAVE_THREAD: readonly MailAction[] = ["archive", "trash", "spam", "notSpam", "restore", "unread"];

interface MailPaneProps {
	view: MailView;
	threadId: string | null;
	query: ViewQuery;
	title: string;
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
	const list = useThreadList(query.status === "ready" ? query.query : null);
	const thread = useThread(threadId);
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
	// a new set is marked again, and the same set is not sent twice.
	const openThread = thread.thread;
	const patchThread = thread.patch;
	const patchList = list.patch;
	useEffect(() => {
		if (!openThread) return;
		const unreadIds = openThread.messages.filter((m) => m.label_ids.includes("UNREAD")).map((m) => m.id);
		if (unreadIds.length === 0 && !openThread.label_ids.includes("UNREAD")) return;
		const key = `${openThread.id} ${unreadIds.sort().join(" ")}`;
		if (markedRef.current === key) return;
		markedRef.current = key;
		const change = actionChange("read");
		patchThread(change);
		patchList([openThread.id], change, view);
		modifyThreads([openThread.id], change).then(onChanged, (error: unknown) =>
			toast({ message: `The conversation was not marked as read. ${errorMessage(error)}`, tone: "error" }),
		);
	}, [openThread, patchThread, patchList, view, onChanged, toast]);

	const labelsOf = useCallback(
		(id: string): readonly string[] | null =>
			threads.find((item) => item.id === id)?.label_ids ?? (openThread?.id === id ? openThread.label_ids : null),
		[threads, openThread],
	);

	async function run(action: MailAction, ids: readonly string[]) {
		if (ids.length === 0) return;
		const change = actionChange(action);
		// Undo reverts the change only on the threads that it changed.
		const changed = ids.filter((id) => {
			const labelIds = labelsOf(id);
			return labelIds === null || changesLabels(labelIds, change);
		});
		const openLabels = threadId && ids.includes(threadId) ? labelsOf(threadId) : null;
		list.patch(ids, change, view);
		if (openThread && ids.includes(openThread.id)) thread.patch(change);
		if (threadId && ids.includes(threadId)) {
			const leaves = LEAVE_THREAD.includes(action) || !belongsInView(changeLabels(openLabels ?? [], change), view);
			if (leaves) navigate(viewPath(view));
		}
		if (actionNotice(action, ids.length)) {
			setSelected((current) => new Set([...current].filter((id) => !ids.includes(id))));
		}
		try {
			await modifyThreads(ids, change);
			const notice = actionNotice(action, ids.length);
			if (notice) {
				toast(
					changed.length > 0
						? { message: notice, action: { label: "Undo", run: () => void undo(changed, change) } }
						: { message: notice },
				);
			}
		} catch (error) {
			toast({ message: `The change failed. ${errorMessage(error)}`, tone: "error" });
		}
		onChanged();
	}

	async function undo(ids: readonly string[], change: ReturnType<typeof actionChange>) {
		try {
			await modifyThreads(ids, invertChange(change));
			toast({ message: "Action undone." });
		} catch (error) {
			toast({ message: `The undo failed. ${errorMessage(error)}`, tone: "error" });
		}
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
	const inSpamOrTrash = view.kind === "system" && (view.view === "spam" || view.view === "trash");

	useShortcuts((event) => {
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
					if (next) navigate(threadPath(view, next.id));
				}
				break;
			}
			case "Enter":
				// A focused link or button handles Enter itself.
				if (event.target instanceof HTMLElement && event.target.closest("a, button, summary, label")) return;
				if (listMode && current) navigate(threadPath(view, current.id));
				break;
			case "o":
				if (listMode && current) navigate(threadPath(view, current.id));
				break;
			case "u":
				if (!listMode) navigate(viewPath(view));
				break;
			case "e":
				if (!inSpamOrTrash) void run("archive", keyTargets);
				break;
			case "#":
				if (!inSpamOrTrash) void run("trash", keyTargets);
				break;
			case "s": {
				if (inSpamOrTrash) break;
				const starTargets = listMode ? (current ? [current] : []) : targetSummaries;
				const starred = listMode ? (current?.starred ?? false) : allStarred;
				const ids = listMode ? starTargets.map((item) => item.id) : targets;
				void run(starred ? "unstar" : "star", ids);
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
				title={title}
				mode={listMode ? "list" : "thread"}
				targetCount={targets.length}
				selection={selection}
				anyUnread={anyUnread}
				allStarred={allStarred}
				userLabels={userLabels}
				listEmpty={threads.length === 0}
				onToggleAll={() => setSelected(selection === "all" ? new Set() : new Set(threads.map((item) => item.id)))}
				onAction={(action) => void run(action, targets)}
				onBack={() => navigate(viewPath(view))}
				onRefresh={() => {
					void list.refresh();
					onChanged();
				}}
			/>
			<div className="mail-scroll" ref={scrollRef}>
				{query.status === "missing" ? (
					<div className="list-state" role="alert">
						This label does not exist.
					</div>
				) : listMode ? (
					<ThreadList
						view={view}
						title={title}
						list={list}
						myAddress={myAddress}
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
				) : (
					<ThreadView
						state={thread}
						myAddress={myAddress}
						labelsById={labelsById}
						onReply={reply}
						onRetry={() => void thread.retry()}
					/>
				)}
			</div>
		</main>
	);
}
