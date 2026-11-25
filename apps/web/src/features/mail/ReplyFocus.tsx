import type { Label, Message, ThreadSummary } from "@asterra/contracts";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../../lib/api.ts";
import { Icon } from "../../lib/icons.tsx";
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
import { useMailboxId, useMailboxRights } from "./mailbox.tsx";
import { type FromOption, rightsNotice } from "./mailboxNav.ts";
import { mergeQueue, nextActive, REPLY_LATER_VIEW, replyTarget } from "./replyLater.ts";
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
	const notice = rightsNotice(rights);
	const list = useThreadList(mailboxId, QUEUE_QUERY);
	const [items, setItems] = useState<ThreadSummary[]>([]);
	const [drafts, setDrafts] = useState<ReadonlyMap<string, Draft>>(() => new Map());
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
		setItems((current) => mergeQueue(current, list.threads, new Set(draftsRef.current.keys())));
	}, [list.status, list.threads]);

	const ids = items.map((item) => item.id);
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
		if (!list.threads.some((thread) => thread.id === threadId)) {
			setItems((current) => current.filter((item) => item.id !== threadId));
		}
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
				{items.length > 0 && <span className="focus-count">{items.length} left</span>}
			</div>
			{notice && (
				<p className="notice read-only-notice">
					<Icon name="eye" size={18} />
					<span>{notice} An owner or an admin sets what each member can do.</span>
				</p>
			)}
			<div className="mail-scroll">
				{list.status === "loading" && items.length === 0 ? (
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
	/** The last open request that this item handled, so one request opens one reply. */
	const handledRef = useRef<number | null>(null);
	/** The unread messages that the item marked as read last. */
	const markedRef = useRef<string | null>(null);
	const loaded = thread.thread;
	const patchThread = thread.patch;

	// The queue refreshes when the mailbox changes. Each item gets its thread again only when a message
	// arrives in it, so a refresh does not read each thread of the queue.
	useOnChange(props.messageCount, () => void thread.refresh());

	// A key or a send makes this item active: it scrolls to the top of the view.
	useEffect(() => {
		if (active && props.scrollToken > 0) ref.current?.scrollIntoView({ block: "start", behavior: "smooth" });
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
			onFocusCapture={props.onActivate}
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
