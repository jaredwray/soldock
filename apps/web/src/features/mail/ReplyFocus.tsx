import type { Label, Message, ThreadSummary } from "@asterra/contracts";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../../lib/api.ts";
import { Icon } from "../../lib/icons.tsx";
import { addNavigationGuard } from "../../lib/navigationGuard.ts";
import { Link, navigate } from "../../lib/router.tsx";
import { useToast } from "../../lib/toast.tsx";
import { useOnChange } from "../../lib/useOnChange.ts";
import { viewPath } from "../../routes.ts";
import { actionChange, invertChange, modifyThreads } from "./actions.ts";
import type { SendResult } from "./Composer.tsx";
import { Composer } from "./ComposerLoader.tsx";
import { type Draft, forwardDraft, replyDraft } from "./compose.ts";
import { useThread, useThreadList } from "./data.ts";
import type { ReplyMode } from "./MessageCard.tsx";
import { MailboxNotice, useMailboxId, useMailboxRights } from "./mailbox.tsx";
import type { FromOption } from "./mailboxNav.ts";
import { leftQueue, mergeQueue, nextActive, REPLY_LATER, REPLY_LATER_VIEW, replyTarget } from "./replyLater.ts";
import { ThreadView } from "./ThreadView.tsx";
import { useShortcuts } from "./useShortcuts.ts";

const QUEUE_QUERY = "label:REPLY_LATER";

interface ReplyFocusProps {
	/** The name of the team mailbox or the agent mailbox, or null in the own mailbox. */
	mailboxName: string | null;
	labelsById: ReadonlyMap<string, Label>;
	myAddress: string;
	/** Grows when the mailbox version changes. The view then gets the queue again. */
	refreshKey: number;
	/** Call after a change, so the labels and counts update. */
	onChanged: () => void;
	/** Opens the composer of Mail in its dialog, for a forward. A forward does not answer the thread. */
	onCompose: (draft?: Draft) => void;
	onShowHelp: () => void;
	/** The values of the inline composer. A reply comes from the mailbox of its conversation. */
	composer: { mailDomains: readonly string[] | null; fromOptions: readonly FromOption[]; signature: string };
}

/** A request to open the reply of an item, for example of the next item after a send. */
interface OpenRequest {
	threadId: string;
	token: number;
}

/**
 * The focus view of Reply later: only the conversations that wait for a reply, one after the other, each
 * with its reply in the page. A sent reply takes its conversation out of the queue (the server removes the
 * label), and the reply of the next conversation opens. Done takes a conversation out without a reply.
 */
export function ReplyFocus(props: ReplyFocusProps) {
	const { labelsById, myAddress, onChanged } = props;
	const toast = useToast();
	const mailboxId = useMailboxId();
	const rights = useMailboxRights();
	const list = useThreadList(mailboxId, QUEUE_QUERY);
	const [items, setItems] = useState<ThreadSummary[]>([]);
	const [drafts, setDrafts] = useState<ReadonlyMap<string, Draft>>(() => new Map());
	/** The items whose reply has text that a close discards. */
	const [dirtyIds, setDirtyIds] = useState<ReadonlySet<string>>(() => new Set());
	const [activeId, setActiveId] = useState<string | null>(null);
	const [openRequest, setOpenRequest] = useState<OpenRequest | null>(null);
	/** Grows each time the active item changes from a key or a send. The active item then scrolls into view. */
	const [scrollToken, setScrollToken] = useState(0);
	const draftsRef = useRef(drafts);
	draftsRef.current = drafts;

	useOnChange(props.refreshKey, () => void list.refresh());

	// The items keep their order on screen. A conversation with an open reply stays, also when it left the queue.
	useEffect(() => {
		if (list.status !== "ready") return;
		setItems((current) =>
			mergeQueue(current, list.threads, new Set(draftsRef.current.keys()), list.nextCursor === null),
		);
	}, [list.status, list.threads, list.nextCursor]);

	// A reply in the page goes away with the view, and the page is not inert as it is under a dialog. So the
	// app asks before it leaves the view, and the browser asks before it closes or reloads the tab.
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

	const ids = items.map((item) => item.id);
	const complete = list.nextCursor === null;
	// The list has rows that the items do not have yet: the items come one render after the list.
	const merging = list.status === "ready" && items.length === 0 && list.threads.length > 0;
	// With more pages, the count of the label is the size of the queue. The items are only the pages on screen.
	const left = list.nextCursor ? Math.max(labelsById.get(REPLY_LATER)?.threads_total ?? 0, items.length) : items.length;
	const active = activeId !== null && ids.includes(activeId) ? activeId : (ids[0] ?? null);
	const removeChange = actionChange("replyLaterOff");
	const backPath = viewPath(REPLY_LATER_VIEW, mailboxId);

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

	function moveTo(threadId: string | null) {
		setActiveId(threadId);
		setScrollToken((token) => token + 1);
	}

	/** Takes an item off the screen. The list drops it at once, so the next refresh does not bring it back. */
	function leave(threadId: string) {
		setDraft(threadId, null);
		list.patch([threadId], removeChange, REPLY_LATER_VIEW);
		setItems((current) => current.filter((item) => item.id !== threadId));
		if (active === threadId) moveTo(nextActive(ids, threadId));
	}

	/** Closes the reply of an item. An item that left the queue while its reply was open goes too. */
	function closeDraft(threadId: string) {
		setDraft(threadId, null);
		setItems((current) => current.filter((item) => item.id !== threadId || !leftQueue(item, list.threads, complete)));
	}

	function reply(threadId: string, message: Message, mode: ReplyMode) {
		if (!rights.send) return;
		if (mode === "forward") {
			props.onCompose(forwardDraft(message));
			return;
		}
		// A new draft would mount a new composer and lose the text of the open one. Discard it first.
		if (drafts.has(threadId)) return;
		setActiveId(threadId);
		setDraft(threadId, replyDraft(message, myAddress, mode === "replyAll"));
	}

	function sent(threadId: string, result: SendResult) {
		const next = nextActive(ids, threadId);
		leave(threadId);
		// The next conversation becomes active, and its reply opens: the person continues without a click.
		moveTo(next);
		if (next) setOpenRequest((current) => ({ threadId: next, token: (current?.token ?? 0) + 1 }));
		const failed = result.recipients.filter((recipient) => recipient.status === "failed");
		toast(
			failed.length > 0
				? {
						message: `Reply sent, but delivery failed for ${failed.map((r) => r.address).join(", ")}.`,
						tone: "error",
					}
				: { message: "Reply sent. The conversation left Reply later." },
		);
		onChanged();
	}

	async function done(threadId: string) {
		if (!rights.modify) return;
		leave(threadId);
		try {
			await modifyThreads(mailboxId, [threadId], removeChange);
			toast({
				message: "Conversation removed from Reply later.",
				action: { label: "Undo", run: () => void undo(threadId) },
			});
		} catch (error) {
			toast({ message: `The change failed. ${errorMessage(error)}`, tone: "error" });
		}
		onChanged();
	}

	async function undo(threadId: string) {
		try {
			await modifyThreads(mailboxId, [threadId], invertChange(removeChange));
			toast({ message: "Action undone." });
		} catch (error) {
			toast({ message: `The undo failed. ${errorMessage(error)}`, tone: "error" });
		}
		onChanged();
	}

	useShortcuts((event) => {
		const index = active === null ? -1 : ids.indexOf(active);
		switch (event.key) {
			case "j":
			case "k": {
				const next = ids[index + (event.key === "j" ? 1 : -1)];
				if (next) moveTo(next);
				break;
			}
			case "r":
				if (!rights.send || active === null) return;
				setOpenRequest((current) => ({ threadId: active, token: (current?.token ?? 0) + 1 }));
				break;
			case "b":
				// An open reply can hold text. Discard it first, so a key press never loses it.
				if (!rights.modify || active === null || drafts.has(active)) return;
				void done(active);
				break;
			case "u":
				navigate(backPath);
				break;
			case "c":
				if (!rights.send) return;
				props.onCompose();
				break;
			case "?":
				props.onShowHelp();
				break;
			default:
				return;
		}
		event.preventDefault();
	});

	const title = props.mailboxName ? `${props.mailboxName}: Reply later` : "Reply later";

	return (
		<main id="main" className="mail-main" tabIndex={-1}>
			<div className="toolbar">
				<Link to={backPath} className="icon-button" aria-label="Back to Reply later" title="Back to Reply later (u)">
					<Icon name="back" />
				</Link>
				<div className="page-title">
					<Icon name="clock" />
					<h1 className="toolbar-title">{title}</h1>
				</div>
				{items.length > 0 && <span className="focus-count">{left} left</span>}
			</div>
			<MailboxNotice />
			<div className="mail-scroll">
				{(list.status === "loading" && items.length === 0) || merging ? (
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
				) : items.length === 0 ? (
					<div className="list-state mail-state">
						<span className="mail-state-icon">
							<Icon name="check" size={22} />
						</span>
						<p className="mail-state-title">No conversation waits for a reply.</p>
						<p className="mail-state-text">
							Press <kbd>b</kbd> on a conversation, or use the Reply later button, to put it here.
						</p>
						<Link className="button" to={viewPath({ kind: "system", view: "inbox" }, mailboxId)}>
							Go to the inbox
						</Link>
					</div>
				) : (
					<ol className="focus-list" aria-label="Conversations that wait for a reply">
						{items.map((item) => (
							<FocusItem
								key={item.id}
								threadId={item.id}
								messageCount={item.message_count}
								queued={!leftQueue(item, list.threads, complete)}
								active={item.id === active}
								scrollToken={scrollToken}
								openRequest={openRequest?.threadId === item.id ? openRequest.token : null}
								draft={drafts.get(item.id) ?? null}
								labelsById={labelsById}
								myAddress={myAddress}
								composer={props.composer}
								onActivate={() => setActiveId(item.id)}
								onReply={(message, mode) => reply(item.id, message, mode)}
								onCloseDraft={() => closeDraft(item.id)}
								onDirtyChange={(dirty) => setDirty(item.id, dirty)}
								onSent={(result) => sent(item.id, result)}
								onDone={() => void done(item.id)}
								onChanged={onChanged}
							/>
						))}
					</ol>
				)}
				{list.nextCursor && items.length > 0 && (
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
			</div>
		</main>
	);
}

interface FocusItemProps {
	threadId: string;
	/** The number of messages in the queue entry. A new message gets the thread again. */
	messageCount: number;
	/** False when the thread left the queue and the item stays for its open reply. */
	queued: boolean;
	active: boolean;
	scrollToken: number;
	/** The token of a request to open the reply of this item, or null. */
	openRequest: number | null;
	draft: Draft | null;
	labelsById: ReadonlyMap<string, Label>;
	myAddress: string;
	composer: ReplyFocusProps["composer"];
	onActivate: () => void;
	onReply: (message: Message, mode: ReplyMode) => void;
	onCloseDraft: () => void;
	onDirtyChange: (dirty: boolean) => void;
	onSent: (result: SendResult) => void;
	onDone: () => void;
	onChanged: () => void;
}

/** One conversation of the focus view: the thread, then its reply or the actions Reply and Done. */
function FocusItem(props: FocusItemProps) {
	const { threadId, active, draft, onReply, onChanged } = props;
	const toast = useToast();
	const mailboxId = useMailboxId();
	const rights = useMailboxRights();
	const thread = useThread(mailboxId, threadId);
	const ref = useRef<HTMLLIElement>(null);
	/** The scroll token that this item saw last. An item that mounts later starts at the current token. */
	const scrolledRef = useRef(props.scrollToken);
	useEffect(() => {
		if (!active) scrolledRef.current = props.scrollToken;
	}, [active, props.scrollToken]);
	/** The last open request that this item handled, so one request opens one reply. */
	const handledRef = useRef<number | null>(null);
	/** The unread messages that the item marked as read last. */
	const markedRef = useRef<string | null>(null);
	const loaded = thread.thread;
	const patchThread = thread.patch;

	// The queue refreshes when the mailbox changes. Each item gets its thread again only when a message
	// arrives in it, so a refresh does not read each thread of the queue.
	useOnChange(props.messageCount, () => void thread.refresh());
	// A thread leaves the queue under an open reply when a different member answers it. The item gets the
	// thread again, so the person sees that answer before the send.
	useOnChange(props.queued, () => void thread.refresh());

	// A key, a send or Done makes this item active: it scrolls to the top of the view and gets the focus.
	// Done removes the button that had the focus, and Tab must continue from the active item.
	// A click or the focus in a different item also makes it active. That must not move the view or the focus,
	// so the effect acts one time for each token.
	useEffect(() => {
		if (!active || props.scrollToken === scrolledRef.current) return;
		scrolledRef.current = props.scrollToken;
		ref.current?.focus({ preventScroll: true });
		ref.current?.scrollIntoView({ block: "start", behavior: "smooth" });
	}, [active, props.scrollToken]);

	// Open the reply when a request names this item and the thread is ready. A reply that is open stays.
	useEffect(() => {
		if (props.openRequest === null || props.openRequest === handledRef.current || !loaded) return;
		handledRef.current = props.openRequest;
		const message = replyTarget(loaded);
		if (message && !draft) onReply(message, "reply");
	}, [props.openRequest, loaded, draft, onReply]);

	// The active conversation is read, as an open thread is in the list view. A person who cannot change the
	// mailbox leaves it unread.
	useEffect(() => {
		if (!active || !loaded || !rights.modify) return;
		const unread = loaded.messages.filter((m) => m.label_ids.includes("UNREAD")).map((m) => m.id);
		if (unread.length === 0 && !loaded.label_ids.includes("UNREAD")) return;
		const key = unread.sort().join(" ");
		if (markedRef.current === key) return;
		markedRef.current = key;
		const change = actionChange("read");
		patchThread(change);
		modifyThreads(mailboxId, [loaded.id], change).then(onChanged, (error: unknown) =>
			toast({ message: `The conversation was not marked as read. ${errorMessage(error)}`, tone: "error" }),
		);
	}, [active, loaded, rights.modify, mailboxId, patchThread, onChanged, toast]);

	return (
		<li
			ref={ref}
			className={active ? "focus-item focus-item-active" : "focus-item"}
			aria-current={active ? "true" : undefined}
			tabIndex={-1}
			onFocusCapture={props.onActivate}
			// A click on text gives no focus, and a browser can keep the focus off a button that a person clicks.
			onPointerDownCapture={props.onActivate}
		>
			<ThreadView
				state={thread}
				myAddress={props.myAddress}
				labelsById={props.labelsById}
				headingLevel="h2"
				onReply={onReply}
				onRetry={() => void thread.retry()}
			/>
			{draft ? (
				<Composer
					key={draft.key}
					frame="inline"
					draft={draft}
					mailDomains={props.composer.mailDomains}
					fromOptions={props.composer.fromOptions}
					initialFrom={mailboxId}
					signature={props.composer.signature}
					onDirtyChange={props.onDirtyChange}
					onClose={props.onCloseDraft}
					onSent={props.onSent}
				/>
			) : (
				// Reply, Reply all and Forward are under each open message of the thread. Done is for the queue.
				rights.modify && (
					<div className="focus-item-actions">
						<button type="button" className="button" onClick={props.onDone} title="Remove from Reply later (b)">
							<Icon name="check" size={16} />
							Done
						</button>
					</div>
				)
			)}
		</li>
	);
}
