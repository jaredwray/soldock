import type { Label, ThreadSummary } from "@soldock/contracts";
import { useEffect, useRef } from "react";
import { participantsLabel, shortDate } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { Link } from "../../lib/router.tsx";
import { type MailView, threadPath } from "../../routes.ts";
import type { ListState } from "./data.ts";
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

	if (list.status === "loading") {
		return (
			<div className="list-state" aria-live="polite">
				<span className="spinner" aria-hidden="true" />
				Loading conversations…
			</div>
		);
	}
	if (list.status === "error") {
		return (
			<div className="list-state" role="alert">
				<p>The conversations did not load. {list.error}</p>
				<button type="button" className="button" onClick={props.onRetry}>
					Try again
				</button>
			</div>
		);
	}
	if (list.threads.length === 0) {
		return (
			<div className="list-state list-empty">
				<Icon name={view.kind === "search" ? "search" : "inbox"} size={40} />
				<p>{emptyText(view, props.title)}</p>
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

function emptyText(view: MailView, title: string): string {
	if (view.kind === "search") return `No conversations match “${view.query}”.`;
	if (view.kind === "system" && view.view === "inbox") return "Your inbox is empty.";
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
		<li className={classes.join(" ")}>
			<input
				type="checkbox"
				className="checkbox thread-check"
				checked={selected}
				onChange={() => onToggleSelect(thread.id)}
				aria-label={`Select: ${subject}`}
			/>
			<button
				type="button"
				className={thread.starred ? "icon-button icon-button-small star star-on" : "icon-button icon-button-small star"}
				aria-label="Star"
				aria-pressed={thread.starred}
				title={thread.starred ? "Starred" : "Not starred"}
				onClick={() => onToggleStar(thread)}
			>
				<Icon name="star" size={18} filled={thread.starred} />
			</button>
			<Link ref={linkRef} to={threadPath(view, thread.id)} className="thread-link" onFocus={onFocus}>
				<span className="thread-from">
					{thread.unread && <span className="visually-hidden">Unread, </span>}
					<span className="thread-from-names">{participantsLabel(thread.participants, myAddress)}</span>
					{thread.message_count > 1 && <span className="thread-count">{thread.message_count}</span>}
				</span>
				<span className="thread-main">
					<span className="thread-subject-line">
						{userLabels.slice(0, 3).map((label) => (
							<span key={label.id} className="chip chip-small">
								{label.name}
							</span>
						))}
						<span className="thread-subject">{subject}</span>
					</span>
					{thread.snippet && (
						<>
							<span className="thread-dash"> – </span>
							<span className="thread-snippet">{thread.snippet}</span>
						</>
					)}
				</span>
				<span className="thread-meta">
					{thread.has_attachments && (
						<span className="thread-attachment" title="Has attachments">
							<Icon name="paperclip" size={16} />
							<span className="visually-hidden">Has attachments, </span>
						</span>
					)}
					<time dateTime={thread.last_message_at}>{shortDate(thread.last_message_at)}</time>
				</span>
			</Link>
		</li>
	);
}
