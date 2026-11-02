import type { Label, Message } from "@soldock/contracts";
import { useEffect, useRef } from "react";
import type { ThreadState } from "./data.ts";
import { MessageCard, type ReplyMode } from "./MessageCard.tsx";
import { labelChipName } from "./views.ts";

interface ThreadViewProps {
	state: ThreadState;
	myAddress: string;
	labelsById: ReadonlyMap<string, Label>;
	onReply: (message: Message, mode: ReplyMode) => void;
	onRetry: () => void;
}

export function ThreadView({ state, myAddress, labelsById, onReply, onRetry }: ThreadViewProps) {
	const headingRef = useRef<HTMLHeadingElement>(null);
	const threadId = state.thread?.id ?? null;

	// Move the focus to the subject when a new thread opens, so a screen reader starts there.
	useEffect(() => {
		if (threadId) headingRef.current?.focus();
	}, [threadId]);

	if (state.status === "loading" || state.status === "idle") {
		return (
			<div className="list-state" aria-live="polite">
				<span className="spinner" aria-hidden="true" />
				Loading the conversation…
			</div>
		);
	}
	if (state.status === "error" || !state.thread) {
		return (
			<div className="list-state" role="alert">
				<p>The conversation did not load. {state.error}</p>
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
		return name ? [{ id, name }] : [];
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
							<li key={chip.id} className="chip">
								{chip.name}
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
