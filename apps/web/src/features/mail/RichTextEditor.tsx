import "prosemirror-view/style/prosemirror.css";
import { baseKeymap, toggleMark } from "prosemirror-commands";
import { history } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import type { Node } from "prosemirror-model";
import { type Command, EditorState, Plugin } from "prosemirror-state";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import { type FormEvent, type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Dialog } from "../../lib/Dialog.tsx";
import { Icon, type IconName } from "../../lib/icons.tsx";
import { normalizeLink, plainTextSlice, schema } from "./richText.ts";
import {
	clearFormatting,
	editorKeys,
	isMarkActive,
	isQuoteActive,
	type LinkTarget,
	linkTargetAt,
	listTypeAt,
	removeLink,
	setLink,
	toggleList,
	toggleQuote,
} from "./richTextCommands.ts";

// Security rules for the editor:
// - The editor DOM holds only the nodes and marks of the schema in richText.ts. ProseMirror parses
//   pasted and dropped HTML in a detached document, which loads nothing and runs nothing, and keeps
//   only what the parse rules of the schema accept.
// - Each link is http, https or mailto (safeHref), from the parse rules or from the link dialog.
// - The app writes no HTML into the page. The editor makes its DOM with createElement.

const MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);

interface Tool {
	name: string;
	icon: IconName;
	/** The value of aria-keyshortcuts. */
	keys: string;
	/** The shortcut in the tooltip. */
	hint: string;
	run: Command | "link";
	/** For a toggle button: true when it is on. */
	pressed?: (state: EditorState) => boolean;
	/** True for the first button of a group. */
	groupStart?: boolean;
}

function shortcut(key: string, shift = false): Pick<Tool, "keys" | "hint"> {
	return {
		keys: [MAC ? "Meta" : "Control", ...(shift ? ["Shift"] : []), key].join("+"),
		hint: MAC ? `${shift ? "⇧" : ""}⌘${key}` : `Ctrl+${shift ? "Shift+" : ""}${key}`,
	};
}

const { marks, nodes } = schema;

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
		name: "Underline",
		icon: "underline",
		...shortcut("U"),
		run: toggleMark(marks.underline),
		pressed: (s) => isMarkActive(s, marks.underline),
	},
	{
		name: "Strikethrough",
		icon: "strikethrough",
		...shortcut("X", true),
		run: toggleMark(marks.strike),
		pressed: (s) => isMarkActive(s, marks.strike),
	},
	{ name: "Link", icon: "link", ...shortcut("K"), run: "link", groupStart: true },
	{
		name: "Numbered list",
		icon: "listNumbered",
		...shortcut("7", true),
		run: toggleList(nodes.ordered_list),
		pressed: (s) => listTypeAt(s) === nodes.ordered_list,
		groupStart: true,
	},
	{
		name: "Bulleted list",
		icon: "listBulleted",
		...shortcut("8", true),
		run: toggleList(nodes.bullet_list),
		pressed: (s) => listTypeAt(s) === nodes.bullet_list,
	},
	{ name: "Quote", icon: "quote", ...shortcut("9", true), run: toggleQuote, pressed: isQuoteActive },
	{ name: "Remove formatting", icon: "clearFormat", ...shortcut("\\"), run: clearFormatting, groupStart: true },
];

/** Shows the placeholder in the first paragraph while the document is empty. */
function placeholderPlugin(text: string): Plugin {
	return new Plugin({
		props: {
			decorations(state) {
				const first = state.doc.firstChild;
				if (state.doc.childCount !== 1 || !first?.isTextblock || first.content.size > 0) return null;
				return DecorationSet.create(state.doc, [
					Decoration.node(0, first.nodeSize, { class: "rich-placeholder", "data-placeholder": text }),
				]);
			},
		},
	});
}

interface RichTextEditorProps {
	initialDoc: Node;
	onChange: (doc: Node) => void;
	disabled: boolean;
	/** The accessible name of the editor. */
	label: string;
	placeholder: string;
	/** True when the editor gets the first focus of the dialog. */
	autofocus: boolean;
}

/**
 * A rich-text editor on ProseMirror, with a formatting toolbar under it. The toolbar is one tab
 * stop: the arrow keys, Home and End move between its buttons. Each button also has a shortcut.
 */
export function RichTextEditor({ initialDoc, onChange, disabled, label, placeholder, autofocus }: RichTextEditorProps) {
	const [linkTarget, setLinkTarget] = useState<LinkTarget | null>(null);
	const [refocus, setRefocus] = useState(0);
	const [focusIndex, setFocusIndex] = useState(0);
	const editorId = useId();
	const mountRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
	const onChangeRef = useRef(onChange);
	const disabledRef = useRef(disabled);
	// The first props make the view once. Later changes to them do not make a new view.
	const [config] = useState(() => ({ label, placeholder, autofocus, editorId }));
	const [initialState] = useState(() =>
		EditorState.create({
			doc: initialDoc,
			plugins: [
				history(),
				keymap(
					editorKeys((state) => {
						if (!disabledRef.current) setLinkTarget(linkTargetAt(state));
						return true;
					}),
				),
				keymap(baseKeymap),
				placeholderPlugin(placeholder),
			],
		}),
	);
	const [editorState, setEditorState] = useState(initialState);
	// The newest state. React runs an effect twice in development, and the second view starts from it.
	const stateRef = useRef(initialState);

	useEffect(() => {
		onChangeRef.current = onChange;
	});

	// A layout effect makes the view before the dialog looks for its data-autofocus element.
	useLayoutEffect(() => {
		const mount = mountRef.current;
		if (!mount) return;
		const view: EditorView = new EditorView(mount, {
			state: stateRef.current,
			attributes: {
				id: config.editorId,
				class: "compose-body rich-body",
				role: "textbox",
				"aria-multiline": "true",
				"aria-label": config.label,
				"aria-placeholder": config.placeholder,
				spellcheck: "true",
				...(config.autofocus ? { "data-autofocus": "true" } : {}),
			},
			editable: () => !disabledRef.current,
			clipboardTextParser: (text, $context) => plainTextSlice(text, $context.marks()),
			dispatchTransaction(tr) {
				const next = view.state.apply(tr);
				view.updateState(next);
				stateRef.current = next;
				setEditorState(next);
				if (tr.docChanged) onChangeRef.current(next.doc);
			},
		});
		viewRef.current = view;
		return () => {
			view.destroy();
			viewRef.current = null;
		};
	}, [config]);

	useEffect(() => {
		disabledRef.current = disabled;
		viewRef.current?.setProps({ editable: () => !disabled });
	}, [disabled]);

	// After the link dialog closes, the editor gets the focus and its selection back.
	useEffect(() => {
		if (refocus > 0) viewRef.current?.focus();
	}, [refocus]);

	function run(tool: Tool) {
		const view = viewRef.current;
		if (!view || disabled) return;
		if (tool.run === "link") {
			setLinkTarget(linkTargetAt(view.state));
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

	function onToolbarKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		const last = TOOLS.length - 1;
		const moves: Record<string, number> = {
			ArrowRight: focusIndex === last ? 0 : focusIndex + 1,
			ArrowLeft: focusIndex === 0 ? last : focusIndex - 1,
			Home: 0,
			End: last,
		};
		const next = moves[event.key];
		if (next === undefined) return;
		event.preventDefault();
		setFocusIndex(next);
		buttonRefs.current[next]?.focus();
	}

	return (
		<div className="rich-editor">
			<div ref={mountRef} className="rich-editor-mount" />
			<div
				role="toolbar"
				aria-label="Formatting"
				aria-controls={editorId}
				className="format-toolbar"
				onKeyDown={onToolbarKeyDown}
			>
				{TOOLS.map((tool, index) => (
					<button
						key={tool.name}
						ref={(element) => {
							buttonRefs.current[index] = element;
						}}
						type="button"
						className={`icon-button icon-button-small format-button${tool.groupStart ? " format-group-start" : ""}`}
						aria-label={tool.name}
						aria-pressed={tool.pressed ? tool.pressed(editorState) : undefined}
						aria-keyshortcuts={tool.keys}
						title={`${tool.name} (${tool.hint})`}
						tabIndex={index === focusIndex ? 0 : -1}
						disabled={disabled}
						// A click must not take the focus, so the selection in the editor stays.
						onMouseDown={(event) => event.preventDefault()}
						onFocus={() => setFocusIndex(index)}
						onClick={() => run(tool)}
					>
						<Icon name={tool.icon} size={18} />
					</button>
				))}
			</div>
			{linkTarget &&
				createPortal(
					<LinkDialog
						target={linkTarget}
						onApply={(href, text) => editLink(setLink(href, text))}
						onRemove={() => editLink(removeLink)}
						onClose={closeLink}
					/>,
					document.body,
				)}
		</div>
	);
}

interface LinkDialogProps {
	target: LinkTarget;
	onApply: (href: string, text: string) => void;
	onRemove: () => void;
	onClose: () => void;
}

function LinkDialog({ target, onApply, onRemove, onClose }: LinkDialogProps) {
	const [text, setText] = useState(target.text);
	const [address, setAddress] = useState(target.href ?? "");
	const [error, setError] = useState<string | null>(null);
	const ids = { text: useId(), address: useId(), error: useId() };

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		// The dialog is in a portal, but React sends its events up the component tree. Without this
		// line, the submit also reaches the composer form and sends the message.
		event.stopPropagation();
		const href = normalizeLink(address);
		if (href === null) {
			setError("Enter a web address, for example https://example.com, or an email address.");
			return;
		}
		onApply(href, target.textEditable ? text || address.trim() : "");
	}

	return (
		<Dialog title={target.href === null ? "Add link" : "Edit link"} onClose={onClose} className="dialog-small">
			<form onSubmit={submit} noValidate>
				<div className="dialog-body link-fields">
					{target.textEditable && (
						<div className="field">
							<label htmlFor={ids.text} className="field-label">
								Text to show
							</label>
							<input id={ids.text} className="input" value={text} onChange={(event) => setText(event.target.value)} />
						</div>
					)}
					<div className="field">
						<label htmlFor={ids.address} className="field-label">
							Web address or email
						</label>
						<input
							id={ids.address}
							className="input"
							type="text"
							inputMode="url"
							autoComplete="off"
							spellCheck={false}
							value={address}
							onChange={(event) => {
								setAddress(event.target.value);
								setError(null);
							}}
							aria-invalid={error ? true : undefined}
							aria-describedby={error ? ids.error : undefined}
							data-autofocus
						/>
						{error && (
							<p id={ids.error} className="field-error" role="alert">
								{error}
							</p>
						)}
					</div>
				</div>
				<div className="dialog-actions">
					{target.href !== null && (
						<button type="button" className="button link-remove" onClick={onRemove}>
							Remove link
						</button>
					)}
					<button type="button" className="button" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="button button-primary">
						Apply
					</button>
				</div>
			</form>
		</Dialog>
	);
}
