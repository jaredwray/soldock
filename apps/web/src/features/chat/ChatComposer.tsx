import "prosemirror-view/style/prosemirror.css";
import type { ChatBody } from "@soldock/contracts";
import { baseKeymap, toggleMark } from "prosemirror-commands";
import { history } from "prosemirror-history";
import { inputRules } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import { type Command, EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import {
	type ReactNode,
	type Ref,
	useEffect,
	useId,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { initials, plural } from "../../lib/format.ts";
import { FormatToolbar, LinkDialog, placeholderPlugin, shortcut, type Tool } from "../mail/RichTextEditor.tsx";
import { isMarkActive, type LinkTarget } from "../mail/richTextCommands.ts";
import {
	composerKeys,
	insertTypedMention,
	isCodeBlockActive,
	markdownRules,
	rich,
	toggleCodeBlock,
	typedMention,
} from "./composerCommands.ts";
import { bodyToDoc, chatSchema, docToBody, plainTextSlice } from "./composerSchema.ts";
import { type MentionContext, type MentionSuggestion, mentionKeyAction, mentionSuggestions } from "./mentions.ts";

// Security rules for the box, as for the mail editor:
// - The editor DOM holds only the nodes and marks of the schema in composerSchema.ts. ProseMirror
//   parses pasted and dropped HTML in a detached document, which loads nothing and runs nothing, and
//   keeps only what the parse rules of the schema accept.
// - Each link is http, https or mailto (safeHref), from the parse rules or from the link dialog.
// - The app writes no HTML into the page. The editor makes its DOM with createElement.

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
const { marks, nodes } = chatSchema;

const TOOLS: readonly Tool[] = [
	{
		name: "Bold",
		icon: "bold",
		...shortcut("B"),
		run: toggleMark(marks.strong),
		pressed: (s) => isMarkActive(s, marks.strong),
	},
	{
		name: "Italic",
		icon: "italic",
		...shortcut("I"),
		run: toggleMark(marks.em),
		pressed: (s) => isMarkActive(s, marks.em),
	},
	{
		name: "Strikethrough",
		icon: "strikethrough",
		...shortcut("X", true),
		run: toggleMark(marks.strike),
		pressed: (s) => isMarkActive(s, marks.strike),
	},
	{
		name: "Code",
		icon: "code",
		...shortcut("E"),
		run: toggleMark(marks.code),
		pressed: (s) => isMarkActive(s, marks.code),
	},
	{ name: "Link", icon: "link", ...shortcut("K"), run: "link", groupStart: true },
	{
		name: "Bulleted list",
		icon: "listBulleted",
		...shortcut("8", true),
		run: rich.toggleList(nodes.bullet_list),
		pressed: (s) => rich.listTypeAt(s) === nodes.bullet_list,
		groupStart: true,
	},
	{
		name: "Numbered list",
		icon: "listNumbered",
		...shortcut("7", true),
		run: rich.toggleList(nodes.ordered_list),
		pressed: (s) => rich.listTypeAt(s) === nodes.ordered_list,
	},
	{ name: "Quote", icon: "quote", ...shortcut("9", true), run: rich.toggleQuote, pressed: rich.isQuoteActive },
	{
		name: "Code block",
		icon: "codeBlock",
		keys: MAC ? "Meta+Alt+C" : "Control+Alt+C",
		hint: MAC ? "⌥⌘C" : "Ctrl+Alt+C",
		run: toggleCodeBlock,
		pressed: isCodeBlockActive,
	},
];

export interface ChatComposerHandle {
	/** Empties the box. */
	clear(): void;
	focus(): void;
}

interface ChatComposerProps {
	ref?: Ref<ChatComposerHandle>;
	/** The id of the editable element. */
	id: string;
	/** The accessible name of the box. */
	label: string;
	placeholder: string;
	/** The body in the box when it opens: a draft, or the message of an edit. */
	initial: ChatBody | null;
	/** Gets the body after each change, or null when the box has no text. */
	onChange: (body: ChatBody | null) => void;
	/** Enter: send the message, or save the edit. */
	onSubmit: () => void;
	/** Escape, when no list is open. */
	onCancel?: () => void;
	mentions: MentionContext;
	/**
	 * Where the list of a mention opens: above the box and over the page (the box for a new message),
	 * or under the box and in the flow of the page (the edit box of a message).
	 */
	placement: "above" | "below";
	autofocus?: boolean;
	className?: string;
	/** More controls at the end of the bar under the text, such as the send button. */
	children?: ReactNode;
}

/**
 * The box for the text of a message, on ProseMirror. It has a formatting toolbar, Markdown shortcuts,
 * and suggestions while the person types a mention. Enter sends, and Shift+Enter makes a new line.
 * While the list of a mention is open, the arrow keys move in it, Enter and Tab take the selected
 * suggestion, and Escape closes it.
 */
export function ChatComposer({
	ref,
	id,
	label,
	placeholder,
	initial,
	onChange,
	onSubmit,
	onCancel,
	mentions,
	placement,
	autofocus = false,
	className,
	children,
}: ChatComposerProps) {
	const mountRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	const listId = useId();
	const [linkTarget, setLinkTarget] = useState<LinkTarget | null>(null);
	const [refocus, setRefocus] = useState(0);
	// The callbacks of the newest render, for the keys and the changes of the view.
	const callbacks = useRef({ onChange, onSubmit, onCancel });
	useEffect(() => {
		callbacks.current = { onChange, onSubmit, onCancel };
	});

	// The first props make the view once. Later changes to them do not make a new view.
	const [config] = useState(() => ({ id, label, placeholder, autofocus }));
	const [initialState] = useState(() =>
		EditorState.create({
			doc: bodyToDoc(initial),
			plugins: [
				history(),
				inputRules({ rules: [...markdownRules] }),
				keymap(
					composerKeys(
						() => {
							callbacks.current.onSubmit();
							return true;
						},
						(state) => {
							setLinkTarget(rich.linkTargetAt(state));
							return true;
						},
					),
				),
				keymap(baseKeymap),
				placeholderPlugin(placeholder),
			],
		}),
	);
	const [editorState, setEditorState] = useState(initialState);
	// The newest state. React runs an effect twice in development, and the second view starts from it.
	const stateRef = useRef(initialState);

	// The mention at the caret. Null when the list is closed: a change of the text opens it, and a
	// caret that leaves the mention, Escape and a blur close it.
	const [mentionOpen, setMentionOpen] = useState(false);
	const [selected, setSelected] = useState<{ query: string; index: number } | null>(null);
	const typed = mentionOpen ? typedMention(editorState) : null;
	const { directory, memberIds, ownId } = mentions;
	const suggestions = typed ? mentionSuggestions(directory, typed.query, { memberIds, ownId }) : [];
	const open = suggestions.length > 0;
	const active = selected && selected.query === typed?.query ? Math.min(selected.index, suggestions.length - 1) : 0;
	const optionId = (index: number) => `${listId}-${index}`;

	function choose(suggestion: MentionSuggestion) {
		const view = viewRef.current;
		setMentionOpen(false);
		const tr = view ? insertTypedMention(view.state, suggestion.handle) : null;
		if (view && tr) view.dispatch(tr);
	}

	// The keys of the list, for the handler of the view, which the first render makes.
	const list = useRef({
		open,
		active,
		count: suggestions.length,
		query: typed?.query ?? "",
		choose: (_index: number) => {},
	});
	list.current = {
		open,
		active,
		count: suggestions.length,
		query: typed?.query ?? "",
		choose: (index) => choose(suggestions[index] as MentionSuggestion),
	};

	// A layout effect makes the view before a dialog or a page looks for its focus.
	useLayoutEffect(() => {
		const mount = mountRef.current;
		if (!mount) return;
		const view: EditorView = new EditorView(mount, {
			state: stateRef.current,
			attributes: {
				id: config.id,
				class: "chat-composer-text",
				role: "textbox",
				"aria-multiline": "true",
				"aria-label": config.label,
				"aria-placeholder": config.placeholder,
				"aria-autocomplete": "list",
				spellcheck: "true",
			},
			clipboardTextParser: (text, $context) => plainTextSlice(text, $context.marks()),
			// A paste with nothing to parse (only an image, for example) would go to the fallback of
			// ProseMirror, which lets the browser paste into a live element. Nothing can be inserted, so stop it.
			handlePaste: (_view, _event, slice) => slice.content.size === 0,
			handleKeyDown(_view, event) {
				// Safari gives the key that ends a text composition the code 229, without `isComposing`.
				const composing = event.isComposing || event.keyCode === 229;
				const current = list.current;
				// Ctrl+Enter (⌘Enter) always sends, also while the list is open.
				const sends = event.key === "Enter" && (event.ctrlKey || event.metaKey);
				const action = sends
					? ({ kind: "none" } as const)
					: mentionKeyAction(event.key, event.shiftKey, composing, current);
				if (action.kind === "select") setSelected({ query: current.query, index: action.index });
				else if (action.kind === "take") current.choose(action.index);
				else if (action.kind === "close") setMentionOpen(false);
				else if (event.key === "Escape" && !composing && callbacks.current.onCancel) {
					callbacks.current.onCancel();
					return true;
				}
				// ProseMirror sends no key of a text composition here. If one comes, the input method has
				// it, so the keys of the box (Enter sends) do not run.
				return composing || action.kind !== "none";
			},
			handleDOMEvents: {
				blur: () => {
					setMentionOpen(false);
					return false;
				},
			},
			dispatchTransaction(tr) {
				const next = view.state.apply(tr);
				view.updateState(next);
				stateRef.current = next;
				setEditorState(next);
				if (tr.docChanged) {
					// A change of the text opens the list for the mention at the caret.
					setMentionOpen(typedMention(next) !== null);
					callbacks.current.onChange(docToBody(next.doc));
				} else if (tr.selectionSet) {
					// A caret that leaves the mention closes the list. The next character opens it again.
					setMentionOpen((was) => was && typedMention(next) !== null);
				}
			},
		});
		viewRef.current = view;
		if (config.autofocus) view.focus();
		return () => {
			view.destroy();
			viewRef.current = null;
		};
	}, [config]);

	// The editable element is not a React element, so the attributes of the list go on it here.
	useEffect(() => {
		const dom = viewRef.current?.dom;
		if (!dom) return;
		if (open) {
			dom.setAttribute("aria-controls", listId);
			dom.setAttribute("aria-activedescendant", optionId(active));
			document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
		} else {
			dom.removeAttribute("aria-controls");
			dom.removeAttribute("aria-activedescendant");
		}
	});

	// After the link dialog closes, the editor gets the focus and its selection back.
	useEffect(() => {
		if (refocus > 0) viewRef.current?.focus();
	}, [refocus]);

	useImperativeHandle(ref, () => ({
		clear() {
			const view = viewRef.current;
			if (!view) return;
			const empty = EditorState.create({ doc: bodyToDoc(null), plugins: view.state.plugins });
			view.updateState(empty);
			stateRef.current = empty;
			setEditorState(empty);
			setMentionOpen(false);
		},
		focus() {
			viewRef.current?.focus();
		},
	}));

	function run(tool: Tool) {
		const view = viewRef.current;
		if (!view) return;
		if (tool.run === "link") {
			setLinkTarget(rich.linkTargetAt(view.state));
			return;
		}
		tool.run(view.state, view.dispatch, view);
		view.focus();
	}

	function closeLink() {
		setLinkTarget(null);
		setRefocus((count) => count + 1);
	}

	function editLink(command: Command) {
		const view = viewRef.current;
		if (view) command(view.state, view.dispatch, view);
		closeLink();
	}

	return (
		<div className={className ? `chat-composer-editor ${className}` : "chat-composer-editor"}>
			<div ref={mountRef} className="chat-composer-mount" />
			<div className="chat-composer-bar">
				<FormatToolbar
					tools={TOOLS}
					state={editorState}
					editorId={id}
					disabled={false}
					onRun={run}
					className="chat-format-toolbar"
				/>
				{children}
			</div>
			<span className="visually-hidden" role="status">
				{open
					? `${plural(suggestions.length, "suggestion")}. Use the arrow keys, Enter to take one, and Escape to close the list.`
					: ""}
			</span>
			{open && (
				<div
					id={listId}
					role="listbox"
					className={`mention-list mention-list-${placement}`}
					aria-label="People and agents to mention"
				>
					{suggestions.map((suggestion, index) => (
						// The box has the focus and the keys. A pointer selects and takes a suggestion.
						// biome-ignore lint/a11y/useKeyWithClickEvents: the keys go to the box, as the ARIA combobox pattern asks.
						<div
							key={suggestion.person.id}
							id={optionId(index)}
							role="option"
							tabIndex={-1}
							aria-selected={index === active}
							className="mention-option"
							onMouseDown={(event) => event.preventDefault()}
							onMouseMove={() => {
								if (index !== active) setSelected({ query: typed?.query ?? "", index });
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
			{linkTarget &&
				createPortal(
					<LinkDialog
						target={linkTarget}
						onApply={(href, text) => editLink(rich.setLink(href, text))}
						onRemove={() => editLink(rich.removeLink)}
						onClose={closeLink}
					/>,
					document.body,
				)}
		</div>
	);
}
