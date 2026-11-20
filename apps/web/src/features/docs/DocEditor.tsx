import "prosemirror-view/style/prosemirror.css";
import { baseKeymap, toggleMark } from "prosemirror-commands";
import { history, redo, redoDepth, undo, undoDepth } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import type { Node } from "prosemirror-model";
import { type Command, EditorState, Plugin, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import {
	type ChangeEvent,
	type DragEvent,
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
import { Select } from "../../lib/Select.tsx";
import { useToast } from "../../lib/toast.tsx";
import { Menu, type MenuItem } from "../drive/Menu.tsx";
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
import { AltTextDialog, CropDialog, DriveImageDialog, ImageUrlDialog } from "./ImageDialogs.tsx";
import { ImageToolbar } from "./ImageToolbar.tsx";
import { removeImage, selectedImage, setImageAttrs } from "./imageCommands.ts";
import { widthAfterCrop } from "./imageModel.ts";
import { fileSources, imagePlugins, insertSources } from "./imagePlugin.ts";
import { DOC_IMAGE_ACCEPT, type DocImages, fileProblem, type ImageSource } from "./images.ts";
import { markdownPaste } from "./markdownPaste.ts";
import { docHref, type ImageAttrs, schema } from "./schema.ts";

// Security rules for the editor:
// - The editor DOM holds only the nodes and marks of the schema in schema.ts. ProseMirror parses
//   pasted and dropped HTML in a detached document, which loads nothing and runs nothing, and keeps
//   only what the parse rules of the schema accept.
// - Each link is http, https or mailto (docHref), from the parse rules or from the link dialog.
// - The app writes no HTML into the page. The editor makes its DOM with createElement.
// - Pasted Markdown becomes nodes and marks of the schema (markdownPaste.ts). HTML in it stays text.
// - An image shows from a `blob:` address of a raster type, which the image store makes from the bytes
//   of `docs.get_image`. A pasted `<img>` never loads: imagePlugin.ts brings its bytes into the doc.

const MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);

interface Tool {
	name: string;
	icon: IconName;
	/** The value of aria-keyshortcuts, and the shortcut in the tooltip. A tool can have no shortcut. */
	keys?: string;
	hint?: string;
	run: Command | "link" | "image";
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
	{ name: "Insert image", icon: "image", run: "image" },
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

const BLOCK_OPTIONS = BLOCK_TYPES.map((entry) => ({ value: entry.value, label: entry.name }));

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
	/** The images of the doc. The editor gets the bytes of each image from it, and uploads new images with it. */
	images: DocImages;
	onChange: (doc: Node) => void;
}

/** The dialog of the editor that is open. */
type Panel =
	| { kind: "link"; target: LinkTarget }
	| { kind: "image-url" }
	| { kind: "image-drive" }
	| { kind: "alt"; alt: string }
	| { kind: "crop"; id: string };

/**
 * The Docs editor on ProseMirror: the formatting toolbar, then the text on a sheet of paper. The
 * buttons of the toolbar are one tab stop: the arrow keys, Home and End move between them. Each
 * button also has a shortcut.
 */
export function DocEditor({ doc, version, editable, label, images, onChange }: DocEditorProps) {
	const toast = useToast();
	const [panel, setPanel] = useState<Panel | null>(null);
	const [dropping, setDropping] = useState(false);
	const [refocus, setRefocus] = useState(0);
	const [focusIndex, setFocusIndex] = useState(0);
	const editorId = useId();
	const mountRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	const toolbarRef = useRef<HTMLDivElement>(null);
	const fileRef = useRef<HTMLInputElement>(null);
	const onChangeRef = useRef(onChange);
	const toastRef = useRef(toast);
	const editableRef = useRef(editable);
	// The first props make the view once. Later changes to them do not make a new view.
	const [config] = useState(() => ({ label, editorId }));
	const [plugins] = useState(() => [
		history(),
		keymap(
			docKeys((state) => {
				if (editableRef.current && canLink(state)) setPanel({ kind: "link", target: linkTargetAt(state) });
				return true;
			}),
		),
		keymap(baseKeymap),
		depthLimit(),
		placeholderPlugin(PLACEHOLDER),
		// Before the image plugin: pasted text with a picture of the text is text.
		markdownPaste(),
		...imagePlugins({ images, notify: (message) => toastRef.current({ message, tone: "error" }) }),
	]);
	const [initialState] = useState(() => EditorState.create({ doc, plugins }));
	const [editorState, setEditorState] = useState(initialState);
	// The newest state. React runs an effect twice in development, and the second view starts from it.
	const stateRef = useRef(initialState);
	const shownVersion = useRef(version);

	useEffect(() => {
		onChangeRef.current = onChange;
		toastRef.current = toast;
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
			setPanel({ kind: "link", target: linkTargetAt(view.state) });
			return;
		}
		// The image button is a menu, which opens itself.
		if (tool.run === "image") return;
		tool.run(view.state, view.dispatch, view);
		view.focus();
	}

	/** Runs a command of the image toolbar. The image stays selected, and the editor keeps the focus. */
	function runCommand(command: Command) {
		const view = viewRef.current;
		if (!view || !editable) return;
		command(view.state, view.dispatch, view);
		view.focus();
	}

	/** Puts new images at the selection. Each one shows at once, and gets its id when its upload ends. */
	function insertImagesFrom(sources: readonly ImageSource[], pos?: number) {
		const view = viewRef.current;
		if (!view || !editable) return;
		insertSources(view, images, sources, pos);
		view.focus();
	}

	/** The image files of a list. The person gets the reason for each file that cannot go into a doc. */
	function usableFiles(list: FileList | null | undefined): File[] {
		const files: File[] = [];
		const problems = new Set<string>();
		for (const file of list ?? []) {
			const problem = fileProblem(file);
			if (problem === null) files.push(file);
			else problems.add(problem);
		}
		for (const problem of problems) toast({ message: problem, tone: "error" });
		return files;
	}

	function onFilesChosen(event: ChangeEvent<HTMLInputElement>) {
		insertImagesFrom(fileSources(usableFiles(event.target.files)));
		// The same file can be chosen again.
		event.target.value = "";
	}

	function hasFiles(event: DragEvent): boolean {
		return event.dataTransfer.types.includes("Files");
	}

	/** A file over the page of the doc. Without this, the browser opens a dropped file in the tab. */
	function onDragOver(event: DragEvent<HTMLDivElement>) {
		if (!hasFiles(event)) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = editable ? "copy" : "none";
		if (editable) setDropping(true);
	}

	/** A drop on the paper around the text. The editor handles a drop on the text itself. */
	function onDrop(event: DragEvent<HTMLDivElement>) {
		setDropping(false);
		if (!hasFiles(event) || event.defaultPrevented) return;
		event.preventDefault();
		const view = viewRef.current;
		if (!view || !editable) return;
		const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.doc.content.size;
		insertImagesFrom(fileSources(usableFiles(event.dataTransfer.files)), pos);
	}

	function toggleCaption() {
		const view = viewRef.current;
		const image = view ? selectedImage(view.state) : null;
		if (!view || !image || !editable) return;
		if (image.attrs.caption !== null) {
			runCommand(setImageAttrs({ caption: null }));
			return;
		}
		setImageAttrs({ caption: "" })(view.state, view.dispatch, view);
		// The caption line is in the view of the image. The person types the caption there.
		const dom = view.nodeDOM(image.pos);
		if (dom instanceof HTMLElement) dom.querySelector<HTMLElement>(".doc-image-caption")?.focus();
	}

	function setBlock(value: string) {
		const view = viewRef.current;
		const type = BLOCK_TYPES.find((entry) => entry.value === value);
		if (!view || !type) return;
		type.run(view.state, view.dispatch, view);
		view.focus();
	}

	function closePanel() {
		setPanel(null);
		setRefocus((count) => count + 1);
	}

	/** Runs the command of a dialog, then closes the dialog. */
	function applyPanel(command: Command) {
		const view = viewRef.current;
		if (view && editable) command(view.state, view.dispatch, view);
		closePanel();
	}

	function onToolbarKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		// The block type control is a select, which uses the arrow keys, Home and End itself. An open
		// menu is in the toolbar, and it uses those keys too.
		if (!(event.target instanceof HTMLElement)) return;
		if (event.target.getAttribute("role") === "combobox" || event.target.closest('[role="menu"]')) return;
		const buttons = [...(toolbarRef.current?.querySelectorAll<HTMLElement>(":scope > button") ?? [])];
		const last = buttons.length - 1;
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
		buttons[next]?.focus();
	}

	/** A click on the paper around the text puts the cursor in the text. */
	function onPaperMouseDown(event: MouseEvent<HTMLDivElement>) {
		if (event.target !== event.currentTarget) return;
		event.preventDefault();
		viewRef.current?.focus();
	}

	const blockType = blockTypeAt(editorState);
	const knownBlock = BLOCK_TYPES.some((entry) => entry.value === blockType);
	// The toolbar of a selected image. An image that still uploads has no options yet.
	const selected = editable ? selectedImage(editorState) : null;
	const image = selected && selected.attrs.pending === null && selected.attrs.id !== "" ? selected : null;
	const imageMeta = image ? images.meta(image.attrs.id) : undefined;
	const textWidth = viewRef.current?.dom.clientWidth ?? 0;
	const imageItems: MenuItem[] = [
		{ key: "upload", label: "Upload from this computer", icon: "upload", onSelect: () => fileRef.current?.click() },
		{ key: "drive", label: "From Drive", icon: "drive", onSelect: () => setPanel({ kind: "image-drive" }) },
		{ key: "url", label: "From a web address", icon: "link", onSelect: () => setPanel({ kind: "image-url" }) },
	];
	const historyTools = TOOLS.slice(0, 2).map((tool) => ({
		name: tool.name,
		icon: tool.icon,
		keys: tool.keys ?? "",
		hint: tool.hint ?? "",
		run: isEnabled(tool) ? () => run(tool) : null,
	}));

	return (
		<div className="doc-editor">
			{editable && image && (
				<ImageToolbar
					editorId={editorId}
					image={image}
					natural={imageMeta ?? null}
					available={textWidth}
					history={historyTools}
					onAttrs={(patch: Partial<ImageAttrs>) => runCommand(setImageAttrs(patch))}
					onCrop={() => setPanel({ kind: "crop", id: image.attrs.id })}
					onAlt={() => setPanel({ kind: "alt", alt: image.attrs.alt })}
					onCaption={toggleCaption}
					onRemove={() => runCommand(removeImage)}
				/>
			)}
			{editable && !image && (
				<div
					ref={toolbarRef}
					role="toolbar"
					aria-label="Formatting"
					aria-controls={editorId}
					className="editor-toolbar"
					onKeyDown={onToolbarKeyDown}
				>
					<Select
						className="doc-block-type"
						label="Text style"
						title={`Text style (${MAC ? "⌥⌘0 to ⌥⌘3" : "Ctrl+Alt+0 to Ctrl+Alt+3"})`}
						value={knownBlock && blockType ? blockType : ""}
						options={BLOCK_OPTIONS}
						placeholder={blockType === "code_block" ? "Code block" : "More than one style"}
						onChange={setBlock}
					/>
					{TOOLS.map((tool, index) => {
						const enabled = isEnabled(tool);
						if (tool.run === "image") {
							return (
								<Menu
									key={tool.name}
									label={tool.name}
									className="icon-button icon-button-small format-button"
									items={imageItems}
									align="start"
									tabIndex={index === focusIndex ? 0 : -1}
									onFocus={() => setFocusIndex(index)}
								>
									<Icon name={tool.icon} size={18} />
								</Menu>
							);
						}
						return (
							<button
								key={tool.name}
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
			{/* biome-ignore lint/a11y/noStaticElementInteractions: a drop of image files on the page puts them in the text box in it. */}
			<div className="doc-scroll" onDragOver={onDragOver} onDragLeave={() => setDropping(false)} onDrop={onDrop}>
				{/* biome-ignore lint/a11y/noStaticElementInteractions: the click only moves the focus to the text box in it. */}
				<div className={dropping ? "doc-paper doc-paper-drop" : "doc-paper"} onMouseDown={onPaperMouseDown}>
					<div ref={mountRef} className="doc-mount" />
				</div>
			</div>
			<input
				ref={fileRef}
				type="file"
				accept={DOC_IMAGE_ACCEPT}
				multiple
				hidden
				tabIndex={-1}
				aria-hidden="true"
				onChange={onFilesChosen}
			/>
			{panel?.kind === "link" &&
				createPortal(
					<LinkDialog
						target={panel.target}
						onApply={(href, text) => applyPanel(setLink(href, text))}
						onRemove={() => applyPanel(removeLink)}
						onClose={closePanel}
					/>,
					document.body,
				)}
			{panel?.kind === "image-url" &&
				createPortal(
					<ImageUrlDialog
						onApply={(src) => {
							closePanel();
							insertImagesFrom([{ kind: "address", src }]);
						}}
						onClose={closePanel}
					/>,
					document.body,
				)}
			{panel?.kind === "image-drive" &&
				createPortal(
					<DriveImageDialog
						onPick={(items) => {
							closePanel();
							insertImagesFrom(items.map((item) => ({ kind: "drive", spaceId: item.space_id, itemId: item.id })));
						}}
						onClose={closePanel}
					/>,
					document.body,
				)}
			{panel?.kind === "alt" &&
				createPortal(
					<AltTextDialog alt={panel.alt} onApply={(alt) => applyPanel(setImageAttrs({ alt }))} onClose={closePanel} />,
					document.body,
				)}
			{panel?.kind === "crop" &&
				imageMeta &&
				image &&
				createPortal(
					<CropDialog
						load={() => images.load(panel.id)}
						natural={imageMeta}
						crop={image.attrs.crop}
						onApply={(crop) =>
							applyPanel(
								setImageAttrs({
									crop,
									// The picture keeps its scale: a narrower crop makes a narrower image.
									...(image.attrs.width === null
										? {}
										: { width: widthAfterCrop(image.attrs.width, image.attrs.crop, crop) }),
								}),
							)
						}
						onClose={closePanel}
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
