import type { Label, Message } from "@asterra/contracts";
import { useEffect, useRef } from "react";
import { Icon } from "../../lib/icons.tsx";
import { AUTO_MARK_TEXT, AUTO_MARK_TITLE } from "./autoLabels.ts";
import type { ThreadState } from "./data.ts";
import { MessageCard, type ReplyMode } from "./MessageCard.tsx";
import { isUserLabelId, labelChipName } from "./views.ts";

interface ThreadViewProps {
	state: ThreadState;
	myAddress: string;
	labelsById: ReadonlyMap<string, Label>;
	onReply: (message: Message, mode: ReplyMode) => void;
	onRetry: () => void;
	/** Removes a user label from the thread. Absent in a mailbox that the person can only read. */
	onRemoveLabel?: ((labelId: string) => void) | undefined;
}

export function ThreadView({ state, myAddress, labelsById, onReply, onRetry, onRemoveLabel }: ThreadViewProps) {
	const headingRef = useRef<HTMLHeadingElement>(null);
	const threadId = state.thread?.id ?? null;

	// Move the focus to the subject when a new thread opens, so a screen reader starts there.
	useEffect(() => {
		if (threadId) headingRef.current?.focus();
	}, [threadId]);

	if (state.status === "loading" || state.status === "idle") {
		return (
			<div className="list-state mail-state" aria-live="polite">
				<span className="spinner" aria-hidden="true" />
				Loading the conversation…
			</div>
		);
	}
	if (state.status === "error" || !state.thread) {
		return (
			<div className="list-state mail-state" role="alert">
				<span className="mail-state-icon">
					<Icon name="warning" size={22} />
				</span>
				<p className="mail-state-title">The conversation did not load.</p>
				<p className="mail-state-text">{state.error}</p>
				<button type="button" className="button" onClick={onRetry}>
					Try again
				</button>
			</div>
		);
	}

	const thread = state.thread;
	const lastIndex = thread.messages.length - 1;
	const chips = thread.label_ids.flatMap((id) => {
		const name = labelChipName(id, labelsById);
		return name ? [{ id, name, auto: thread.auto_label_ids.includes(id) }] : [];
	});

	return (
		<div className="thread-view">
			<div className="thread-header">
				<h1 className="thread-subject-heading" ref={headingRef} tabIndex={-1}>
					{thread.subject.trim() || "(no subject)"}
				</h1>
				{chips.length > 0 && (
					<ul className="chips" aria-label="Labels">
						{chips.map((chip) => (
							<li
								key={chip.id}
								className={chip.auto ? "chip mail-chip chip-auto" : "chip mail-chip"}
								title={chip.auto ? AUTO_MARK_TITLE : undefined}
							>
								{chip.auto && <Icon name="sparks" size={12} className="auto-mark" />}
								{chip.name}
								{chip.auto && <span className="visually-hidden">{AUTO_MARK_TEXT}</span>}
								{onRemoveLabel && isUserLabelId(chip.id) && (
									<button
										type="button"
										className="chip-remove"
										aria-label={`Remove the label ${chip.name}`}
										title="Remove the label"
										onClick={() => onRemoveLabel(chip.id)}
									>
										<Icon name="close" size={12} />
									</button>
								)}
							</li>
						))}
					</ul>
				)}
			</div>
			<div className="messages">
				{thread.messages.map((message, index) => (
					<MessageCard
						key={message.id}
						message={message}
						myAddress={myAddress}
						labelsById={labelsById}
						defaultExpanded={index === lastIndex || message.label_ids.includes("UNREAD")}
						onReply={onReply}
					/>
				))}
			</div>
		</div>
	);
}
