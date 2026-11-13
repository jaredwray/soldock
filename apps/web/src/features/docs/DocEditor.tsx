import "prosemirror-view/style/prosemirror.css";
import { baseKeymap, toggleMark } from "prosemirror-commands";
import { history, redo, redoDepth, undo, undoDepth } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import type { Node } from "prosemirror-model";
import { type Command, EditorState, Plugin, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import {
	type FormEvent,
	type KeyboardEvent,
	type MouseEvent,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { Dialog } from "../../lib/Dialog.tsx";
import { Icon, type IconName } from "../../lib/icons.tsx";
import { normalizeLink } from "../mail/richText.ts";
import {
	type BlockType,
	blockTypeAt,
	canLink,
	clearFormatting,
	depthLimit,
	docKeys,
	insertRule,
	isMarkActive,
	isQuoteActive,
	type LinkTarget,
	linkTargetAt,
	listTypeAt,
	removeLink,
	setHeading,
	setLink,
	setParagraph,
	toggleCodeBlock,
	toggleList,
	toggleQuote,
} from "./commands.ts";
import { docHref, plainTextSlice, schema } from "./schema.ts";

// Security rules for the editor:
// - The editor DOM holds only the nodes and marks of the schema in schema.ts. ProseMirror parses
//   pasted and dropped HTML in a detached document, which loads nothing and runs nothing, and keeps
//   only what the parse rules of the schema accept.
// - Each link is http, https or mailto (docHref), from the parse rules or from the link dialog.
// - The app writes no HTML into the page. The editor makes its DOM with createElement.

const MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);

interface Tool {
	name: string;
	icon: IconName;
	/** The value of aria-keyshortcuts, and the shortcut in the tooltip. A tool can have no shortcut. */
	keys?: string;
	hint?: string;
	run: Command | "link";
	/** For a toggle button: true when it is on. */
	pressed?: (state: EditorState) => boolean;
	/** False when the tool can do nothing now. The button stays in the tab order. */
	enabled?: (state: EditorState) => boolean;
	/** True for the first button of a group. */
	groupStart?: boolean;
}

function shortcut(key: string, shift?: "Shift"): Required<Pick<Tool, "keys" | "hint">> {
	return {
		keys: [MAC ? "Meta" : "Control", ...(shift ? ["Shift"] : []), key].join("+"),
		hint: MAC ? `${shift ? "⇧" : ""}⌘${key}` : `Ctrl+${shift ? "Shift+" : ""}${key}`,
	};
}

const { marks, nodes } = schema;

const TOOLS: readonly Tool[] = [
	{ name: "Undo", icon: "undo", ...shortcut("Z"), run: undo, enabled: (s) => undoDepth(s) > 0 },
	{ name: "Redo", icon: "redo", ...shortcut("Y"), run: redo, enabled: (s) => redoDepth(s) > 0 },
	{
		name: "Bold",
		icon: "bold",
		...shortcut("B"),
		run: toggleMark(marks.strong),
		pressed: (s) => isMarkActive(s, marks.strong),
		groupStart: true,
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
		...shortcut("X", "Shift"),
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
	{ name: "Link", icon: "link", ...shortcut("K"), run: "link", enabled: canLink, groupStart: true },
	{
		name: "Bulleted list",
		icon: "listBulleted",
		...shortcut("8", "Shift"),
		run: toggleList(nodes.bullet_list),
		pressed: (s) => listTypeAt(s) === nodes.bullet_list,
		groupStart: true,
	},
	{
		name: "Numbered list",
		icon: "listNumbered",
		...shortcut("7", "Shift"),
		run: toggleList(nodes.ordered_list),
		pressed: (s) => listTypeAt(s) === nodes.ordered_list,
	},
	{ name: "Quote", icon: "quote", ...shortcut("9", "Shift"), run: toggleQuote, pressed: isQuoteActive },
	{
		name: "Code block",
		icon: "codeBlock",
		...shortcut("E", "Shift"),
		run: toggleCodeBlock,
		pressed: (s) => blockTypeAt(s) === "code_block",
	},
	{ name: "Horizontal rule", icon: "rule", run: insertRule },
	{ name: "Remove formatting", icon: "clearFormat", ...shortcut("\\"), run: clearFormatting, groupStart: true },
];

/** The types of the block type control, with the command of each one. */
const BLOCK_TYPES: readonly { value: BlockType; name: string; key: string; run: Command }[] = [
	{ value: "paragraph", name: "Normal text", key: "0", run: setParagraph },
	{ value: "heading-1", name: "Heading 1", key: "1", run: setHeading(1) },
	{ value: "heading-2", name: "Heading 2", key: "2", run: setHeading(2) },
	{ value: "heading-3", name: "Heading 3", key: "3", run: setHeading(3) },
];

/** Shows the placeholder in the first paragraph while the document is empty. */
function placeholderPlugin(text: string): Plugin {
	return new Plugin({
		props: {
			decorations(state) {
				const first = state.doc.firstChild;
				if (state.doc.childCount !== 1 || first?.type !== nodes.paragraph || first.content.size > 0) return null;
				return DecorationSet.create(state.doc, [
					Decoration.node(0, first.nodeSize, { class: "rich-placeholder", "data-placeholder": text }),
				]);
			},
		},
	});
}

const PLACEHOLDER = "Type the text of the doc";

interface DocEditorProps {
	/** The document to show. The editor reads it at the start, and again when `version` changes. */
	doc: Node;
	/** Grows when the page loads new content from the server. The editor then shows `doc`. */
	version: number;
	/** False for a viewer: the text cannot change, and the toolbar does not show. */
	editable: boolean;
	/** The accessible name of the text area. */
	label: string;
	onChange: (doc: Node) => void;
}

/**
 * The Docs editor on ProseMirror: the formatting toolbar, then the text on a sheet of paper. The
 * buttons of the toolbar are one tab stop: the arrow keys, Home and End move between them. Each
 * button also has a shortcut.
 */
export function DocEditor({ doc, version, editable, label, onChange }: DocEditorProps) {
	const [linkTarget, setLinkTarget] = useState<LinkTarget | null>(null);
	const [refocus, setRefocus] = useState(0);
	const [focusIndex, setFocusIndex] = useState(0);
	const editorId = useId();
	const mountRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
	const onChangeRef = useRef(onChange);
	const editableRef = useRef(editable);
	// The first props make the view once. Later changes to them do not make a new view.
	const [config] = useState(() => ({ label, editorId }));
	const [plugins] = useState(() => [
		history(),
		keymap(
			docKeys((state) => {
				if (editableRef.current && canLink(state)) setLinkTarget(linkTargetAt(state));
				return true;
			}),
		),
		keymap(baseKeymap),
		depthLimit(),
		placeholderPlugin(PLACEHOLDER),
	]);
	const [initialState] = useState(() => EditorState.create({ doc, plugins }));
	const [editorState, setEditorState] = useState(initialState);
	// The newest state. React runs an effect twice in development, and the second view starts from it.
	const stateRef = useRef(initialState);
	const shownVersion = useRef(version);

	useEffect(() => {
		onChangeRef.current = onChange;
	});

	useLayoutEffect(() => {
		const mount = mountRef.current;
		if (!mount) return;
		const view: EditorView = new EditorView(mount, {
			state: stateRef.current,
			attributes: () => ({
				id: config.editorId,
				class: "doc-body",
				role: "textbox",
				"aria-multiline": "true",
				"aria-label": config.label,
				"aria-readonly": editableRef.current ? "false" : "true",
				spellcheck: "true",
			}),
			editable: () => editableRef.current,
			clipboardTextParser: (text, $context) =>
				plainTextSlice(text, $context.parent.type.spec.code === true, $context.marks()),
			// A paste with nothing to parse (only an image, for example) would go to the fallback of
			// ProseMirror, which lets the browser paste into a live element. Nothing can be inserted, so stop it.
			handlePaste: (_view, _event, slice) => slice.content.size === 0,
			dispatchTransaction(tr) {
				const next = view.state.apply(tr);
				view.updateState(next);
				stateRef.current = next;
				setEditorState(next);
				if (tr.docChanged) onChangeRef.current(next.doc);
			},
		});
		viewRef.current = view;
		// On a computer, the person can type at once. On a phone, the focus would open the keyboard.
		if (editableRef.current && window.matchMedia("(pointer: fine)").matches) view.focus();
		return () => {
			view.destroy();
			viewRef.current = null;
		};
	}, [config]);

	useEffect(() => {
		editableRef.current = editable;
		// New props make the view read `editable` and the attributes again.
		viewRef.current?.setProps({ editable: () => editable });
	}, [editable]);

	// New content from the server replaces the document. The cursor stays near its position, and the
	// undo history starts again, because its steps do not apply to the new document.
	useEffect(() => {
		if (shownVersion.current === version) return;
		shownVersion.current = version;
		const view = viewRef.current;
		const { anchor, head } = stateRef.current.selection;
		const limit = doc.content.size;
		const selection = TextSelection.between(doc.resolve(Math.min(anchor, limit)), doc.resolve(Math.min(head, limit)));
		const next = EditorState.create({ doc, plugins, selection });
		stateRef.current = next;
		setEditorState(next);
		view?.updateState(next);
	}, [version, doc, plugins]);

	// After the link dialog closes, the editor gets the focus and its selection back.
	useEffect(() => {
		if (refocus > 0) viewRef.current?.focus();
	}, [refocus]);

	function isEnabled(tool: Tool): boolean {
		return tool.enabled === undefined || tool.enabled(editorState);
	}

	function run(tool: Tool) {
		const view = viewRef.current;
		if (!view || !editable || !isEnabled(tool)) return;
		if (tool.run === "link") {
			setLinkTarget(linkTargetAt(view.state));
			return;
		}
		tool.run(view.state, view.dispatch, view);
		view.focus();
	}

	function setBlock(value: string) {
		const view = viewRef.current;
		const type = BLOCK_TYPES.find((entry) => entry.value === value);
		if (!view || !type) return;
		type.run(view.state, view.dispatch, view);
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
		// The block type control is a select, which uses the arrow keys itself.
		if (event.target instanceof HTMLSelectElement) return;
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

	/** A click on the paper around the text puts the cursor in the text. */
	function onPaperMouseDown(event: MouseEvent<HTMLDivElement>) {
		if (event.target !== event.currentTarget) return;
		event.preventDefault();
		viewRef.current?.focus();
	}

	const blockType = blockTypeAt(editorState);
	const knownBlock = BLOCK_TYPES.some((entry) => entry.value === blockType);

	return (
		<div className="doc-editor">
			{editable && (
				<div
					role="toolbar"
					aria-label="Formatting"
					aria-controls={editorId}
					className="doc-toolbar"
					onKeyDown={onToolbarKeyDown}
				>
					<select
						className="doc-block-type"
						aria-label="Text style"
						title={`Text style (${MAC ? "⌥⌘0 to ⌥⌘3" : "Ctrl+Alt+0 to Ctrl+Alt+3"})`}
						value={knownBlock && blockType ? blockType : "other"}
						onChange={(event) => setBlock(event.target.value)}
					>
						{BLOCK_TYPES.map((entry) => (
							<option key={entry.value} value={entry.value}>
								{entry.name}
							</option>
						))}
						{!knownBlock && (
							<option value="other" disabled>
								{blockType === "code_block" ? "Code block" : "More than one style"}
							</option>
						)}
					</select>
					{TOOLS.map((tool, index) => {
						const enabled = isEnabled(tool);
						return (
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
								// Not the disabled attribute: the button then stays a tab stop of the toolbar.
								aria-disabled={enabled ? undefined : true}
								title={tool.hint ? `${tool.name} (${tool.hint})` : tool.name}
								tabIndex={index === focusIndex ? 0 : -1}
								// A click must not take the focus, so the selection in the editor stays.
								onMouseDown={(event) => event.preventDefault()}
								onFocus={() => setFocusIndex(index)}
								onClick={() => run(tool)}
							>
								<Icon name={tool.icon} size={18} />
							</button>
						);
					})}
				</div>
			)}
			<div className="doc-scroll">
				{/* biome-ignore lint/a11y/noStaticElementInteractions: the click only moves the focus to the text box in it. */}
				<div className="doc-paper" onMouseDown={onPaperMouseDown}>
					<div ref={mountRef} className="doc-mount" />
				</div>
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
		event.stopPropagation();
		const normal = normalizeLink(address);
		const href = normal === null ? null : docHref(normal);
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
