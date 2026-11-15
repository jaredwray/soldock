import {
	type KeyboardEvent,
	type TextareaHTMLAttributes,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { initials, plural } from "../../lib/format.ts";
import { recipientKeyAction } from "../mail/compose.ts";
import {
	insertMention,
	type MentionDirectory,
	type MentionSuggestion,
	type MentionToken,
	mentionAt,
	mentionSuggestions,
} from "./mentions.ts";

/** What the suggestions of a mention need: the handles of the directory, the members of the room, and the writer. */
export interface MentionContext {
	directory: MentionDirectory;
	memberIds: ReadonlySet<string>;
	ownId: string;
}

type MentionTextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
	value: string;
	onValueChange: (value: string) => void;
	mentions: MentionContext;
	/**
	 * Where the list opens: above the field and over the page (the box for a new message), or under the
	 * field and in the flow of the page (the edit box of a message).
	 */
	placement: "above" | "below";
};

/**
 * A text field that suggests people and agents while the person types a mention ("@" and a name).
 * The arrow keys move in the list, Enter and Tab take the selected suggestion, and Escape closes the
 * list. While the list is open, these keys do not reach `onKeyDown`, so Enter does not send.
 */
export function MentionTextarea({
	value,
	onValueChange,
	mentions,
	placement,
	onKeyDown,
	onBlur,
	maxLength,
	...props
}: MentionTextareaProps) {
	const fieldRef = useRef<HTMLTextAreaElement>(null);
	const listId = useId();
	// The mention at the caret. Null when the list is closed.
	const [token, setToken] = useState<MentionToken | null>(null);
	// The selected suggestion, for one typed text.
	const [selected, setSelected] = useState<{ query: string; index: number } | null>(null);
	const pendingCaret = useRef<number | null>(null);

	const { directory, memberIds, ownId } = mentions;
	// The parent can replace the text without a key in the field, for example after a send. A mention
	// that is not in the text now has no list.
	const live = token && value[token.start] === "@" && token.end <= value.length ? token : null;
	const suggestions = useMemo(
		() => (live ? mentionSuggestions(directory, live.query, { memberIds, ownId }) : []),
		[live, directory, memberIds, ownId],
	);
	const open = suggestions.length > 0;
	// A new typed text selects the first suggestion again.
	const active = selected && selected.query === live?.query ? Math.min(selected.index, suggestions.length - 1) : 0;
	const optionId = (index: number) => `${listId}-${index}`;

	// After a suggestion, the caret goes after the mention, also when the mention is not at the end.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the caret moves after React writes each new value to the field.
	useLayoutEffect(() => {
		if (pendingCaret.current === null) return;
		fieldRef.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
		pendingCaret.current = null;
	}, [value]);

	// The focus stays in the field, so the list scrolls to show the selected suggestion.
	useEffect(() => {
		if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
	}, [open, active, listId]);

	function choose(suggestion: MentionSuggestion) {
		if (!live) return;
		const next = insertMention(value, live, suggestion.handle);
		setToken(null);
		// The field keeps its limit: a mention that does not fit is not inserted.
		if (maxLength !== undefined && next.value.length > maxLength) return;
		pendingCaret.current = next.caret;
		onValueChange(next.value);
	}

	function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		// A key during text composition belongs to the input method.
		if (!event.nativeEvent.isComposing) {
			const action = recipientKeyAction(event.key, event.shiftKey, { open, active, count: suggestions.length });
			// Tab takes a suggestion and keeps the focus in the field, so the person can write on.
			if (action.preventDefault || action.kind === "take") event.preventDefault();
			if (action.kind === "select") setSelected({ query: live?.query ?? "", index: action.index });
			else if (action.kind === "take") choose(suggestions[action.index] as MentionSuggestion);
			else if (action.kind === "close") setToken(null);
			if (action.kind !== "none") return;
		}
		onKeyDown?.(event);
	}

	return (
		<>
			<textarea
				{...props}
				ref={fieldRef}
				value={value}
				maxLength={maxLength}
				aria-autocomplete="list"
				aria-controls={open ? listId : undefined}
				aria-activedescendant={open ? optionId(active) : undefined}
				onChange={(event) => {
					const field = event.currentTarget;
					onValueChange(field.value);
					setToken(field.selectionStart === field.selectionEnd ? mentionAt(field.value, field.selectionStart) : null);
				}}
				onSelect={(event) => {
					// A caret that leaves the mention closes the list. The next character that the person types opens it again.
					const { selectionStart: start, selectionEnd: end } = event.currentTarget;
					setToken((current) =>
						current && (start !== end || start <= current.start || start > current.end) ? null : current,
					);
				}}
				onKeyDown={keyDown}
				onBlur={(event) => {
					setToken(null);
					onBlur?.(event);
				}}
			/>
			<span className="visually-hidden" role="status">
				{open ? `${plural(suggestions.length, "suggestion")}. Use the arrow keys, and Enter to take one.` : ""}
			</span>
			{open && (
				<div
					id={listId}
					role="listbox"
					className={`mention-list mention-list-${placement}`}
					aria-label="People and agents to mention"
				>
					{suggestions.map((suggestion, index) => (
						// The field has the focus and the keys. A pointer selects and takes a suggestion.
						// biome-ignore lint/a11y/useKeyWithClickEvents: the keys go to the field, as the ARIA combobox pattern asks.
						<div
							key={suggestion.person.id}
							id={optionId(index)}
							role="option"
							tabIndex={-1}
							aria-selected={index === active}
							className="mention-option"
							onMouseDown={(event) => event.preventDefault()}
							onMouseMove={() => {
								if (index !== active) setSelected({ query: live?.query ?? "", index });
							}}
							onClick={() => choose(suggestion)}
						>
							<span
								className={
									suggestion.person.kind === "agent" ? "mention-avatar mention-avatar-agent" : "mention-avatar"
								}
								aria-hidden="true"
							>
								{initials(suggestion.person.display_name)}
							</span>
							<span className="mention-name">{suggestion.person.display_name}</span>
							{suggestion.person.kind === "agent" && <span className="kind kind-agent">agent</span>}
							<span className="mention-handle">@{suggestion.handle}</span>
							{!suggestion.member && <span className="mention-note">Not in this room</span>}
						</div>
					))}
				</div>
			)}
		</>
	);
}
