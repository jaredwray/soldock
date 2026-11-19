import type { ChatFollowedThread, ChatMessage } from "@asterra/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.ts";
import { fullDate, plural, shortDate } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { PageHeader } from "../../shell/PageHeader.tsx";
import { useSession } from "../auth/session.tsx";
import type { MessageWatch } from "./data.ts";
import { canMentionGroups, type MentionContext, type MentionDirectory } from "./mentions.ts";
import { roomTitle } from "./model.ts";
import { ThreadPanel } from "./ThreadPanel.tsx";

/** The threads of one page of the view. */
const PAGE = 20;
/** The most parts of the first fill of the server that one read of the view asks for. */
const FILL_PARTS = 10;

type ListState =
	| { status: "loading" }
	| { status: "ready"; threads: ChatFollowedThread[]; nextCursor: string | null }
	| { status: "error"; error: string };

/**
 * One page of `chat.list_threads`. While the first fill of the server continues, a page has no threads
 * and a cursor for the next part of the fill, so the read asks again (at most `FILL_PARTS` times).
 */
async function readThreads(input: { limit: number; cursor?: string }) {
	let page = await api.call("chat.list_threads", input);
	for (let part = 0; page.threads.length === 0 && page.next_cursor !== null && part < FILL_PARTS; part++) {
		page = await api.call("chat.list_threads", { ...input, cursor: page.next_cursor });
	}
	return page;
}

/**
 * The first threads of the list, at least `count` (and at least one page), in pages of at most 100. A new
 * read of the list keeps each thread that shows, also after many "Show more".
 */
async function readFirstThreads(count: number) {
	const first = await readThreads({ limit: Math.min(100, Math.max(PAGE, count)) });
	const threads = [...first.threads];
	let cursor = first.next_cursor;
	while (cursor !== null && threads.length < count) {
		const page = await readThreads({ limit: Math.min(100, count - threads.length), cursor });
		threads.push(...page.threads);
		cursor = page.next_cursor;
	}
	return { threads, next_cursor: cursor };
}

/** The key of a thread in the view: the room and the first message. */
function threadKey(thread: Pick<ChatFollowedThread, "room" | "message_id">): string {
	return `${thread.room.id}/${thread.message_id}`;
}

/**
 * The Threads view: the threads that the person follows in all rooms, with the newest reply first
 * (`chat.list_threads`). A click opens the thread in the view of a thread at the right, which moves the
 * read marker of the thread. Each `chat.threads` event of the events socket (`tick`) reads the list again,
 * and tells the open thread to read its changes.
 */
export function ThreadsView({ tick, directory }: { tick: number; directory: MentionDirectory }) {
	const ownId = useSession().whoami.principal.id;
	const [state, setState] = useState<ListState>({ status: "loading" });
	const [open, setOpen] = useState<ChatFollowedThread | null>(null);
	const [loadingMore, setLoadingMore] = useState(false);
	/** The threads that show, so a new read of the first page keeps as many. */
	const shown = state.status === "ready" ? state.threads.length : 0;
	const shownRef = useRef(shown);
	shownRef.current = shown;
	/** The number of the newest read. An older answer does not replace a newer one. */
	const reads = useRef(0);
	/** The button that opened the thread, for the focus after the close. */
	const opener = useRef<HTMLButtonElement | null>(null);
	const listeners = useRef(new Set<(event: MessageWatch) => void>());

	useEffect(() => {
		document.title = "Threads – Asterra";
	}, []);

	// Each tick reads the list again, with at least the threads that show.
	useEffect(() => {
		void tick;
		const read = ++reads.current;
		readFirstThreads(shownRef.current)
			.then((page) => {
				if (read === reads.current) setState({ status: "ready", threads: page.threads, nextCursor: page.next_cursor });
			})
			.catch((error: unknown) => {
				if (read !== reads.current) return;
				// A list that shows stays. The next tick tries again.
				setState((current) => (current.status === "ready" ? current : { status: "error", error: errorMessage(error) }));
			});
		// The open thread reads what changed. A tick has no version of the room, so it always reads.
		for (const listener of listeners.current) listener({ type: "catch-up" });
	}, [tick]);

	async function showMore() {
		if (state.status !== "ready" || state.nextCursor === null || loadingMore) return;
		setLoadingMore(true);
		const read = reads.current;
		try {
			const page = await readThreads({ limit: PAGE, cursor: state.nextCursor });
			if (read !== reads.current) return;
			setState((current) =>
				current.status === "ready"
					? { status: "ready", threads: [...current.threads, ...page.threads], nextCursor: page.next_cursor }
					: current,
			);
		} catch (error) {
			setState({ status: "error", error: errorMessage(error) });
		} finally {
			setLoadingMore(false);
		}
	}

	/** The socket of the view: the ticks of the events socket, as catch-ups. */
	const watch = useCallback((listener: (event: MessageWatch) => void) => {
		listeners.current.add(listener);
		return () => {
			listeners.current.delete(listener);
		};
	}, []);

	const mentions = useMemo<MentionContext | null>(
		() =>
			open && {
				directory,
				// The view has no members of the room. The server checks each mention.
				memberIds: new Set<string>(),
				ownId,
				groups: canMentionGroups(open.room.role, open.room.member_count),
			},
		[open, directory, ownId],
	);

	function close() {
		setOpen(null);
		opener.current?.focus();
	}

	return (
		<>
			<PageHeader title="Threads" icon="chat" />
			{state.status === "loading" && (
				<p className="list-state" role="status">
					Loading your threads…
				</p>
			)}
			{state.status === "error" && (
				<p className="list-state" role="alert">
					{state.error}
				</p>
			)}
			{state.status === "ready" && state.threads.length === 0 && (
				<div className="chat-empty chat-empty-page">
					<h2 className="chat-empty-title">No threads yet</h2>
					<p>A thread that you start, reply to, follow or get a mention in shows here.</p>
				</div>
			)}
			{state.status === "ready" && state.threads.length > 0 && (
				<div className="chat-threads">
					<ul className="chat-threads-list" aria-label="Threads that you follow">
						{state.threads.map((thread) => (
							<li key={threadKey(thread)}>
								<ThreadCard
									thread={thread}
									active={open !== null && threadKey(open) === threadKey(thread)}
									onOpen={(button) => {
										opener.current = button;
										setOpen(thread);
									}}
								/>
							</li>
						))}
					</ul>
					{state.nextCursor !== null && (
						<p className="chat-threads-more">
							<button type="button" className="button" disabled={loadingMore} onClick={() => void showMore()}>
								{loadingMore ? "Loading…" : "Show more"}
							</button>
						</p>
					)}
				</div>
			)}
			{open && mentions && (
				<ThreadPanel
					key={threadKey(open)}
					roomId={open.room.id}
					roomTitle={roomTitle(open.room)}
					parentId={open.message_id}
					mentions={mentions}
					canDeleteAll={open.room.role === "owner"}
					watch={watch}
					// The view has no list of the room: the room shows the reply when it opens.
					onSentToRoom={() => {}}
					onClose={close}
				/>
			)}
		</>
	);
}

/**
 * One thread of the list: its room, the start of its first message, the time of its newest reply and its
 * new replies. The first message comes from `chat.list_replies`, again after each change of the room: a new
 * version of the room in a new read of the list comes with an edit or a delete of the message too.
 */
function ThreadCard({
	thread,
	active,
	onOpen,
}: {
	thread: ChatFollowedThread;
	active: boolean;
	onOpen: (button: HTMLButtonElement) => void;
}) {
	const [parent, setParent] = useState<ChatMessage | null>(null);
	const roomId = thread.room.id;
	const messageId = thread.message_id;
	const lastReplyAt = thread.last_reply_at;
	const roomVersion = thread.room.version;
	useEffect(() => {
		void lastReplyAt;
		void roomVersion;
		let stopped = false;
		api
			.call("chat.list_replies", { room_id: roomId, message_id: messageId, limit: 1 })
			.then((page) => {
				if (!stopped) setParent(page.parent);
			})
			// The card shows the room and the time without the message.
			.catch(() => {});
		return () => {
			stopped = true;
		};
	}, [roomId, messageId, lastReplyAt, roomVersion]);

	const title = roomTitle(thread.room);
	const unread = thread.unread_count;
	const replies = parent?.thread?.reply_count ?? 0;
	return (
		<button
			type="button"
			className={active ? "chat-thread-card chat-thread-card-active" : "chat-thread-card"}
			aria-current={active ? "true" : undefined}
			onClick={(event) => onOpen(event.currentTarget)}
		>
			<span className="chat-thread-card-room">
				<Icon name={thread.room.kind === "private" ? "lock" : thread.room.kind === "dm" ? "chat" : "hash"} size={14} />
				{title}
			</span>
			<span className="chat-thread-card-text">
				{parent === null ? (
					"…"
				) : parent.deleted ? (
					<em>This message was deleted.</em>
				) : (
					<>
						<strong>{parent.author.display_name}</strong> {parent.text}
					</>
				)}
			</span>
			<span className="chat-thread-card-meta">
				{replies > 0 && <span>{plural(replies, "reply", "replies")}</span>}
				<time dateTime={lastReplyAt} title={fullDate(lastReplyAt)}>
					Last reply {shortDate(lastReplyAt)}
				</time>
				{unread > 0 && (
					<span className="chat-nav-count">
						<span aria-hidden="true">{unread > 99 ? "99+" : unread}</span>
						<span className="visually-hidden">{unread === 1 ? "1 new reply" : `${unread} new replies`}</span>
					</span>
				)}
			</span>
		</button>
	);
}
