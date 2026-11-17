import type { ChatReaction } from "@soldock/contracts";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { emojiName, findEmoji } from "./emoji.ts";

/** The names in the title of a reaction. More names than this show as "and N more". */
const TITLE_NAMES = 10;

function countText(count: number): string {
	return count === 1 ? "1 reaction" : `${count} reactions`;
}

/**
 * The reactions of a message: one button for each emoji, with its count. A button of an emoji that
 * the person used shows as pressed. A click adds or removes the reaction of the person.
 */
export function Reactions({
	reactions,
	ownId,
	nameOf,
	onToggle,
}: {
	reactions: readonly ChatReaction[];
	ownId: string;
	/** The name of a principal, for the title of a button. */
	nameOf: (principalId: string) => string;
	onToggle: (emoji: string, add: boolean) => void;
}) {
	if (reactions.length === 0) return null;
	return (
		<ul className="chat-reactions">
			{reactions.map((reaction) => {
				const mine = reaction.principal_ids.includes(ownId);
				const names = reaction.principal_ids.slice(0, TITLE_NAMES).map(nameOf);
				const more = reaction.principal_ids.length - names.length;
				return (
					<li key={reaction.emoji}>
						<button
							type="button"
							className={mine ? "chat-reaction chat-reaction-mine" : "chat-reaction"}
							aria-pressed={mine}
							aria-label={`${emojiName(reaction.emoji)}: ${countText(reaction.count)}${mine ? ", with yours" : ""}`}
							title={more > 0 ? `${names.join(", ")} and ${more} more` : names.join(", ")}
							onClick={() => onToggle(reaction.emoji, !mine)}
						>
							<span aria-hidden="true">{reaction.emoji}</span>
							<span aria-hidden="true" className="chat-reaction-count">
								{reaction.count}
							</span>
						</button>
					</li>
				);
			})}
		</ul>
	);
}

/**
 * A small list of emoji with a search box. A choice calls `onPick`. Escape, and a click outside the
 * list, call `onClose`.
 */
export function ReactionPicker({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
	const [query, setQuery] = useState("");
	const searchId = useId();
	const root = useRef<HTMLDivElement>(null);
	const choices = useMemo(() => findEmoji(query), [query]);

	useEffect(() => {
		const outside = (event: PointerEvent) => {
			if (root.current && !root.current.contains(event.target as Node)) onClose();
		};
		document.addEventListener("pointerdown", outside);
		return () => document.removeEventListener("pointerdown", outside);
	}, [onClose]);

	return (
		<div
			ref={root}
			className="chat-picker"
			role="dialog"
			aria-label="Add a reaction"
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.stopPropagation();
					onClose();
				}
			}}
		>
			<label htmlFor={searchId} className="visually-hidden">
				Find an emoji
			</label>
			<input
				id={searchId}
				className="input chat-picker-search"
				type="search"
				placeholder="Find an emoji"
				value={query}
				onChange={(event) => setQuery(event.target.value)}
				onKeyDown={(event) => {
					// Enter takes the first emoji of the search.
					if (event.key === "Enter" && choices[0]) {
						event.preventDefault();
						onPick(choices[0].emoji);
					}
				}}
				// The person opened the list to find an emoji, so the focus goes to the search.
				// biome-ignore lint/a11y/noAutofocus: the focus follows the request of the person.
				autoFocus
			/>
			{choices.length === 0 ? (
				<p className="chat-picker-empty">No emoji has that name.</p>
			) : (
				<ul className="chat-picker-list">
					{choices.map((choice) => (
						<li key={choice.emoji}>
							<button
								type="button"
								className="chat-picker-emoji"
								aria-label={choice.name}
								title={choice.name}
								onClick={() => onPick(choice.emoji)}
							>
								{choice.emoji}
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
