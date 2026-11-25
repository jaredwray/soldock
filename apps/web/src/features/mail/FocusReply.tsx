import type { Label, Message, ThreadSummary } from "@asterra/contracts";
import { type FocusEvent, useEffect, useRef, useState } from "react";
import { errorMessage } from "../../lib/api.ts";
import { participantsLabel } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { Link, navigate } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { useOnChange } from "../../lib/useOnChange.ts";
import { REPLY_LATER_VIEW, threadPath, viewPath } from "../../routes.ts";
import { SEARCH_INPUT_ID } from "../../shell/nav.ts";
import { SearchBox } from "../../shell/SearchBox.tsx";
import { actionChange, actionNotice, modifyThreads, type Undo, undoChanges, undoNow } from "./actions.ts";
import { type Draft, forwardDraft, replyDraft } from "./compose.ts";
import { useThread, useThreadList } from "./data.ts";
import { MailboxNotice } from "./MailboxNotice.tsx";
import { MessageCard, type ReplyMode } from "./MessageCard.tsx";
import { useMailboxId, useMailboxRights } from "./mailbox.tsx";
import { useShortcuts } from "./useShortcuts.ts";

/** The query of Focus & Reply: the threads in Reply later, newest first, as in the Reply later list. */
const QUERY = "in:reply_later";

/** A card loads its thread when it comes this near to the visible part of the list. */
const PRELOAD_MARGIN = "600px 0px";

interface FocusReplyProps {
	/** The name of the team mailbox or the agent mailbox, or null in the own mailbox. */
	mailboxName: string | null;
	labelsById: ReadonlyMap<string, Label>;
	myAddress: string;
	/** Grows when the mailbox version changes. The page then gets the list and the threads again. */
	refreshKey: number;
	onChanged: () => void;
	onCompose: (draft?: Draft) => void;
	onShowHelp: () => void;
}

/**
 * Focus & Reply: each conversation in Reply later, one after the other, with its newest message and the
 * buttons to answer it. A reply removes the conversation from Reply later on the server, so it leaves the
 * page after the send. Done takes a conversation out without a reply.
 */
export function FocusReply(props: FocusReplyProps) {
	const { labelsById, myAddress, onChanged, onCompose } = props;
	const toast = useToast();
	const mailboxId = useMailboxId();
	const rights = useMailboxRights();
	const list = useThreadList(mailboxId, QUERY);
	const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
	const mainRef = useRef<HTMLElement>(null);
	const listRef = useRef<HTMLOListElement>(null);
	/** The position of the card that has the focus, or null when the focus is not in a card. */
	const focusedCard = useRef<number | null>(null);
	const title = props.mailboxName ? `${props.mailboxName}: Focus & Reply` : "Focus & Reply";
	const listPath = viewPath(REPLY_LATER_VIEW, mailboxId);

	useOnChange(props.refreshKey, () => void list.refresh());

	// Done and a reply remove the card that had the focus, and the browser puts the focus on the body. The focus
	// then goes to the card that takes its place, or to the page when no card stays.
	useOnChange(list.threads, () => {
		const position = focusedCard.current;
		if (position === null || (document.activeElement && document.activeElement !== document.body)) return;
		const links = listRef.current?.querySelectorAll<HTMLElement>(":scope > li .focus-card-subject a") ?? [];
		const next = links[Math.min(position, links.length - 1)] ?? mainRef.current;
		next?.focus();
		focusedCard.current = links.length > 0 ? Math.min(position, links.length - 1) : null;
	});

	function trackFocus(event: FocusEvent<HTMLOListElement>) {
		const card = (event.target as HTMLElement).closest(".focus-list > li");
		focusedCard.current = card ? [...(listRef.current?.children ?? [])].indexOf(card) : null;
	}

	function untrackFocus(event: FocusEvent<HTMLOListElement>) {
		// A card that leaves the page can send a blur with no new target. Keep its position then.
		const next = event.relatedTarget as Node | null;
		if (next && !listRef.current?.contains(next)) focusedCard.current = null;
	}

	useShortcuts((event) => {
		switch (event.key) {
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

	function reply(message: Message, mode: ReplyMode) {
		onCompose(mode === "forward" ? forwardDraft(message) : replyDraft(message, myAddress, mode === "replyAll"));
	}

	async function done(thread: ThreadSummary) {
		const change = actionChange("replyLaterDone");
		const undos = undoChanges([{ id: thread.id, labelIds: thread.label_ids }], change);
		list.patch([thread.id], change, REPLY_LATER_VIEW);
		try {
			await modifyThreads(mailboxId, [thread.id], change);
			const notice = actionNotice("replyLaterDone", 1) ?? "";
			toast(
				undos.length > 0
					? { message: notice, action: { label: "Undo", run: () => void undo(undos) } }
					: { message: notice },
			);
		} catch (error) {
			toast({ message: `The change failed. ${errorMessage(error)}`, tone: "error" });
		}
		onChanged();
	}

	async function undo(undos: readonly Undo[]) {
		await undoNow(mailboxId, undos, toast);
		onChanged();
	}

	// The label counts each waiting thread. The list has only its first pages.
	const count = Math.max(labelsById.get("REPLY_LATER")?.threads_total ?? 0, list.threads.length);

	return (
		<main id="main" className="mail-main" tabIndex={-1} ref={mainRef}>
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
			<div className="mail-scroll" ref={setScroller}>
				{list.status === "loading" ? (
					<div className="list-state mail-state" aria-live="polite">
						<span className="spinner" aria-hidden="true" />
						Loading conversations…
					</div>
				) : list.status === "error" ? (
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
				) : list.threads.length === 0 ? (
					<div className="list-state mail-state">
						<span className="mail-state-icon">
							<Icon name="check" size={22} />
						</span>
						<p className="mail-state-title">No conversation waits for an answer.</p>
						<p className="mail-state-text">Use Reply later on a conversation to put it here.</p>
						<Link to={viewPath({ kind: "system", view: "inbox" }, mailboxId)} className="button">
							Go to the inbox
						</Link>
					</div>
				) : (
					<>
						<p className="focus-intro" aria-live="polite">
							{count === 1 ? "1 conversation waits" : `${count} conversations wait`} for an answer.
							{rights.send ? " Send a reply, and the conversation leaves Reply later." : ""}
							{rights.modify ? " Done takes it out without a reply." : ""}
						</p>
						<ol
							ref={listRef}
							className="focus-list"
							aria-label="Conversations in Reply later"
							onFocus={trackFocus}
							onBlur={untrackFocus}
						>
							{list.threads.map((thread) => (
								<FocusCard
									key={thread.id}
									summary={thread}
									scroller={scroller}
									myAddress={myAddress}
									labelsById={labelsById}
									canModify={rights.modify}
									onReply={reply}
									onDone={() => void done(thread)}
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
	onReply: (message: Message, mode: ReplyMode) => void;
	onDone: () => void;
}

/** One conversation of Focus & Reply: the subject, the people, and the newest message with its reply buttons. */
function FocusCard({ summary, scroller, myAddress, labelsById, canModify, onReply, onDone }: FocusCardProps) {
	const ref = useRef<HTMLLIElement>(null);
	const mailboxId = useMailboxId();
	const near = useNearView(ref, scroller);
	const thread = useThread(mailboxId, near ? summary.id : null);
	const subject = summary.subject.trim() || "(no subject)";
	const messages = thread.thread?.messages ?? [];
	// The newest message that the mailbox got, so Reply answers the person who waits. A forward can join the
	// thread and stay in Reply later, and a reply to the forward would go to its recipients.
	const newest = messages.findLast((message) => message.origin !== "sent") ?? messages.at(-1) ?? null;
	const earlier = (thread.thread ? messages.length : summary.message_count) - 1;

	// The list refreshes after each change in the mailbox. A card gets its thread again only when the thread
	// changed, so one Done does not get each card again.
	useOnChange(`${summary.last_message_at} ${summary.message_count}`, () => void thread.refresh());

	return (
		<li ref={ref} className="focus-card">
			<div className="focus-card-header">
				<div className="focus-card-title">
					<h2 className="focus-card-subject">
						<Link to={threadPath(REPLY_LATER_VIEW, summary.id, mailboxId)}>{subject}</Link>
					</h2>
					<p className="focus-card-people">
						{participantsLabel(summary.participants, mailboxId ? "" : myAddress)}
						{earlier > 0 && ` · ${earlier} more ${earlier === 1 ? "message" : "messages"} in the conversation`}
					</p>
				</div>
				{canModify && (
					<button type="button" className="button button-small" onClick={onDone}>
						<Icon name="check" size={16} />
						Done
						<span className="visually-hidden">: remove “{subject}” from Reply later</span>
					</button>
				)}
			</div>
			{newest ? (
				<div className="messages">
					<MessageCard
						key={newest.id}
						message={newest}
						myAddress={myAddress}
						labelsById={labelsById}
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
		</li>
	);
}
