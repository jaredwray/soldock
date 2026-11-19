import type { Label, ThreadSummary } from "@asterra/contracts";
import { useEffect, useRef } from "react";
import { participantsLabel, shortDate } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { Link } from "../../lib/router.tsx";
import { type MailView, threadPath } from "../../routes.ts";
import type { ListState } from "./data.ts";
import { useMailboxId, useReadOnlyMailbox } from "./mailbox.tsx";
import { isUserLabelId } from "./views.ts";

interface ThreadListProps {
	view: MailView;
	title: string;
	list: ListState;
	myAddress: string;
	labelsById: ReadonlyMap<string, Label>;
	selected: ReadonlySet<string>;
	cursor: number;
	/** Grows each time a j or k key moves the cursor. The row at the cursor then gets the focus. */
	focusToken: number;
	onToggleSelect: (threadId: string) => void;
	onToggleStar: (thread: ThreadSummary) => void;
	/** A row link got the focus, for example from Tab. The cursor moves to it. */
	onFocusRow: (index: number) => void;
	onLoadOlder: () => void;
	onRetry: () => void;
}

export function ThreadList(props: ThreadListProps) {
	const { list, view } = props;
	const mailboxId = useMailboxId();
	const readOnly = useReadOnlyMailbox();
	const owner = mailboxId === null ? "own" : readOnly ? "agent" : "team";

	if (list.status === "loading") {
		return (
			<div className="list-state mail-state" aria-live="polite">
				<span className="spinner" aria-hidden="true" />
				Loading conversations…
			</div>
		);
	}
	if (list.status === "error") {
		return (
			<div className="list-state mail-state" role="alert">
				<span className="mail-state-icon">
					<Icon name="warning" size={22} />
				</span>
				<p className="mail-state-title">The conversations did not load.</p>
				<p className="mail-state-text">{list.error}</p>
				<button type="button" className="button" onClick={props.onRetry}>
					Try again
				</button>
			</div>
		);
	}
	if (list.threads.length === 0) {
		return (
			<div className="list-state mail-state">
				<span className="mail-state-icon">
					<Icon name={view.kind === "search" ? "search" : "inbox"} size={22} />
				</span>
				<p className="mail-state-text">{emptyText(view, props.title, owner)}</p>
			</div>
		);
	}

	return (
		<>
			<ul className="thread-list" aria-label={props.title}>
				{list.threads.map((thread, index) => (
					<ThreadRow
						key={thread.id}
						thread={thread}
						view={view}
						myAddress={props.myAddress}
						labelsById={props.labelsById}
						selected={props.selected.has(thread.id)}
						isCursor={index === props.cursor}
						focusToken={props.focusToken}
						onToggleSelect={props.onToggleSelect}
						onToggleStar={props.onToggleStar}
						onFocus={() => props.onFocusRow(index)}
					/>
				))}
			</ul>
			<div className="list-footer">
				{list.nextCursor !== null && (
					<button type="button" className="button" onClick={props.onLoadOlder} disabled={list.loadingOlder}>
						{list.loadingOlder ? "Loading…" : "Older"}
					</button>
				)}
				<span className="muted">
					{list.threads.length} {list.threads.length === 1 ? "conversation" : "conversations"}
					{list.nextCursor !== null ? " shown" : ""}
				</span>
			</div>
		</>
	);
}

function emptyText(view: MailView, title: string, owner: "own" | "team" | "agent"): string {
	if (view.kind === "search") return `No conversations match “${view.query}”.`;
	if (view.kind === "system" && view.view === "inbox") {
		if (owner === "team") return "The inbox of this team mailbox is empty.";
		return owner === "agent" ? "The inbox of this agent is empty." : "Your inbox is empty.";
	}
	return `No conversations in ${title}.`;
}

interface ThreadRowProps {
	thread: ThreadSummary;
	view: MailView;
	myAddress: string;
	labelsById: ReadonlyMap<string, Label>;
	selected: boolean;
	isCursor: boolean;
	focusToken: number;
	onToggleSelect: (threadId: string) => void;
	onToggleStar: (thread: ThreadSummary) => void;
	onFocus: () => void;
}

function ThreadRow({
	thread,
	view,
	myAddress,
	labelsById,
	selected,
	isCursor,
	focusToken,
	onToggleSelect,
	onToggleStar,
	onFocus,
}: ThreadRowProps) {
	const linkRef = useRef<HTMLAnchorElement>(null);
	const mailboxId = useMailboxId();
	const readOnly = useReadOnlyMailbox();
	const subject = thread.subject.trim() || "(no subject)";
	const userLabels = thread.label_ids.filter(isUserLabelId).flatMap((id) => {
		const label = labelsById.get(id);
		return label ? [label] : [];
	});

	useEffect(() => {
		if (isCursor && focusToken > 0) linkRef.current?.focus();
	}, [isCursor, focusToken]);

	const classes = ["thread-row"];
	if (thread.unread) classes.push("thread-unread");
	if (selected) classes.push("thread-selected");
	if (isCursor) classes.push("thread-cursor");

	return (
		<li className={readOnly ? `${classes.join(" ")} thread-row-read-only` : classes.join(" ")}>
			{readOnly ? (
				// The star shows the state of the agent's mail. A reader cannot change it.
				<span
					className={thread.starred ? "star star-static star-on" : "star star-static"}
					title={thread.starred ? "Starred" : "Not starred"}
				>
					<Icon name="star" size={18} filled={thread.starred} />
					{thread.starred && <span className="visually-hidden">Starred, </span>}
				</span>
			) : (
				<>
					{/* The label is the touch target of the box: 44px on a touch screen. */}
					<label className="thread-check">
						<input
							type="checkbox"
							className="checkbox"
							checked={selected}
							onChange={() => onToggleSelect(thread.id)}
							aria-label={`Select: ${subject}`}
						/>
					</label>
					<button
						type="button"
						className={
							thread.starred ? "icon-button icon-button-small star star-on" : "icon-button icon-button-small star"
						}
						aria-label="Star"
						aria-pressed={thread.starred}
						title={thread.starred ? "Starred" : "Not starred"}
						onClick={() => onToggleStar(thread)}
					>
						<Icon name="star" size={18} filled={thread.starred} />
					</button>
				</>
			)}
			<Link ref={linkRef} to={threadPath(view, thread.id, mailboxId)} className="thread-link" onFocus={onFocus}>
				<span className="thread-from">
					{thread.unread && <span className="visually-hidden">Unread, </span>}
					<span className="thread-from-names">{participantsLabel(thread.participants, myAddress)}</span>
					{thread.message_count > 1 && <span className="thread-count">{thread.message_count}</span>}
				</span>
				<span className="thread-main">
					<span className="thread-subject">{subject}</span>
					{thread.snippet && (
						<>
							<span className="thread-dash"> – </span>
							<span className="thread-snippet">{thread.snippet}</span>
						</>
					)}
				</span>
				<span className="thread-meta">
					{userLabels.length > 0 && (
						<span className="thread-labels">
							<span className="visually-hidden">Labels: </span>
							{userLabels.slice(0, 2).map((label) => (
								<span key={label.id} className="thread-label" title={label.name}>
									{label.name}
								</span>
							))}
							{userLabels.length > 2 && (
								<span
									className="thread-label"
									title={userLabels
										.slice(2)
										.map((label) => label.name)
										.join(", ")}
								>
									<span className="visually-hidden">and </span>+{userLabels.length - 2}
									<span className="visually-hidden"> more</span>
								</span>
							)}
						</span>
					)}
					{thread.has_attachments && (
						<span className="thread-attachment" title="Has attachments">
							<Icon name="paperclip" size={16} />
							<span className="visually-hidden">Has attachments, </span>
						</span>
					)}
					<time className="thread-date" dateTime={thread.last_message_at}>
						{shortDate(thread.last_message_at)}
					</time>
				</span>
			</Link>
		</li>
	);
}
