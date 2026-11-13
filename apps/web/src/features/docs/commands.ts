import { exitCode, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import { redo, undo } from "prosemirror-history";
import type { MarkType, NodeType, ResolvedPos } from "prosemirror-model";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import { type Command, type EditorState, Plugin, TextSelection, type Transaction } from "prosemirror-state";
import { liftTarget, ReplaceAroundStep, ReplaceStep } from "prosemirror-transform";
import { blockDepth, docHref, EDITOR_MAX_DEPTH, type HeadingLevel, headingLevel, schema } from "./schema.ts";

// The commands of the Docs toolbar and its shortcuts. Each one works on an EditorState only, so the
// Node tests can run them without a DOM.

const { nodes, marks } = schema;

/** The marks that "Remove formatting" removes. A link is not formatting, so it stays. */
const FORMAT_MARKS: readonly MarkType[] = [marks.strong, marks.em, marks.underline, marks.strike, marks.code];

/** True when the mark is on the cursor, or on some text of the selection. Toggling then removes it. */
export function isMarkActive(state: EditorState, type: MarkType): boolean {
	const { from, to, empty, $from } = state.selection;
	if (empty) return type.isInSet(state.storedMarks ?? $from.marks()) !== undefined;
	return state.doc.rangeHasMark(from, to, type);
}

function isList(type: NodeType): boolean {
	return type === nodes.bullet_list || type === nodes.ordered_list;
}

/** The type of the innermost list that holds the selection, or null. */
export function listTypeAt(state: EditorState): NodeType | null {
	const { $from, $to } = state.selection;
	return $from.blockRange($to, (node) => isList(node.type))?.parent.type ?? null;
}

/** True when the selection is in a quote. */
export function isQuoteActive(state: EditorState): boolean {
	const { $from, $to } = state.selection;
	return $from.blockRange($to, (node) => node.type === nodes.blockquote) !== null;
}

/**
 * A list button: it removes the list when the selection is in that type of list, changes the
 * type of a list of the other type, and otherwise makes a list.
 */
export function toggleList(listType: NodeType): Command {
	return (state, dispatch) => {
		const { $from, $to } = state.selection;
		const range = $from.blockRange($to, (node) => isList(node.type));
		if (range === null) return wrapInList(listType)(state, dispatch);
		if (range.parent.type === listType) return liftListItem(nodes.list_item)(state, dispatch);
		if (dispatch) dispatch(state.tr.setNodeMarkup(range.$from.before(range.depth), listType).scrollIntoView());
		return true;
	};
}

/** The quote button: it lifts the selection out of its quote, or puts the selection in a quote. */
export const toggleQuote: Command = (state, dispatch) => {
	const { $from, $to } = state.selection;
	const range = $from.blockRange($to, (node) => node.type === nodes.blockquote);
	if (range === null) return wrapIn(nodes.blockquote)(state, dispatch);
	const target = liftTarget(range);
	if (target === null) return false;
	if (dispatch) dispatch(state.tr.lift(range, target).scrollIntoView());
	return true;
};

/** The type of a text block, as the block type control shows it. */
export type BlockType = "paragraph" | "heading-1" | "heading-2" | "heading-3" | "code_block";

/** The type of the text blocks of the selection, or null when they have different types. */
export function blockTypeAt(state: EditorState): BlockType | null {
	const { from, to } = state.selection;
	const found = new Set<BlockType>();
	state.doc.nodesBetween(from, to, (node) => {
		if (!node.isTextblock) return true;
		if (node.type === nodes.heading) found.add(`heading-${headingLevel(node.attrs.level)}`);
		else if (node.type === nodes.code_block) found.add("code_block");
		else found.add("paragraph");
		return false;
	});
	const [first] = found;
	return found.size === 1 && first !== undefined ? first : null;
}

/** Makes each text block of the selection a paragraph. */
export const setParagraph: Command = setBlockType(nodes.paragraph);

/** Makes each text block of the selection a heading of the level. */
export function setHeading(level: HeadingLevel): Command {
	return setBlockType(nodes.heading, { level });
}

/** The code block button: it makes the text blocks of the selection code, or makes code a paragraph again. */
export const toggleCodeBlock: Command = (state, dispatch) =>
	blockTypeAt(state) === "code_block" ? setParagraph(state, dispatch) : setBlockType(nodes.code_block)(state, dispatch);

/**
 * Puts a horizontal rule at the cursor. The text before the cursor stays above the rule, and the
 * text after it goes below. The cursor is then in a text block below the rule, so typing continues.
 */
export const insertRule: Command = (state, dispatch) => {
	const tr = state.tr;
	if (!tr.selection.empty) tr.deleteSelection();
	const $pos = tr.selection.$from;
	if (!$pos.parent.isTextblock || $pos.depth === 0) return false;
	if (!dispatch) return true;
	const rule = nodes.horizontal_rule.create();
	if ($pos.parentOffset === 0) {
		// At the start of a block, also an empty block: the rule goes above it.
		tr.insert($pos.before(), rule);
	} else if ($pos.parentOffset === $pos.parent.content.size) {
		const after = $pos.after();
		tr.insert(after, [rule, nodes.paragraph.create()]);
		tr.setSelection(TextSelection.create(tr.doc, after + rule.nodeSize + 1));
	} else {
		tr.split($pos.pos);
		tr.insert($pos.pos + 1, rule);
		tr.setSelection(TextSelection.create(tr.doc, $pos.pos + 1 + rule.nodeSize + 1));
	}
	dispatch(tr.scrollIntoView());
	return true;
};

/** Removes bold, italic, underline, strikethrough and code from the selection, or from the next text at the cursor. */
export const clearFormatting: Command = (state, dispatch) => {
	if (!dispatch) return true;
	const { from, to, empty, $from } = state.selection;
	const tr = state.tr;
	if (empty) {
		tr.setStoredMarks((state.storedMarks ?? $from.marks()).filter((mark) => !FORMAT_MARKS.includes(mark.type)));
	} else {
		for (const type of FORMAT_MARKS) tr.removeMark(from, to, type);
	}
	dispatch(tr.scrollIntoView());
	return true;
};

/** A new line in the same block. A code block cannot hold a break, so it gets a line feed. */
export const insertHardBreak: Command = (state, dispatch) => {
	if (!dispatch) return true;
	const inCode = state.selection.$from.parent.type.spec.code === true;
	dispatch(
		inCode
			? state.tr.insertText("\n").scrollIntoView()
			: state.tr.replaceSelectionWith(nodes.hard_break.create()).scrollIntoView(),
	);
	return true;
};

/** The text that the link dialog acts on. */
export interface LinkTarget {
	from: number;
	to: number;
	/** The address of the link that is there now, or null. */
	href: string | null;
	text: string;
	/** False when the range holds more than one line, so one text field cannot replace it. */
	textEditable: boolean;
}

/** The run of text around a position that has the same link. */
function linkExtent($pos: ResolvedPos): { from: number; to: number; href: string } | null {
	const parent = $pos.parent;
	let found = parent.childAfter($pos.parentOffset);
	let mark = found.node ? marks.link.isInSet(found.node.marks) : undefined;
	if (!mark) {
		found = parent.childBefore($pos.parentOffset);
		mark = found.node ? marks.link.isInSet(found.node.marks) : undefined;
	}
	if (!mark || !found.node) return null;
	let first = found.index;
	let last = found.index;
	while (first > 0 && mark.isInSet(parent.child(first - 1).marks)) first -= 1;
	while (last + 1 < parent.childCount && mark.isInSet(parent.child(last + 1).marks)) last += 1;
	let from = $pos.start();
	for (let index = 0; index < first; index += 1) from += parent.child(index).nodeSize;
	let to = from;
	for (let index = first; index <= last; index += 1) to += parent.child(index).nodeSize;
	return { from, to, href: mark.attrs.href as string };
}

/** The selection, or the whole link around the cursor. */
export function linkTargetAt(state: EditorState): LinkTarget {
	const { from, to, empty, $from, $to } = state.selection;
	if (empty) {
		const extent = linkExtent($from);
		if (extent === null) return { from, to, href: null, text: "", textEditable: true };
		const text = state.doc.textBetween(extent.from, extent.to, "\n", "\n");
		return { ...extent, text, textEditable: !text.includes("\n") };
	}
	let href: string | null = null;
	state.doc.nodesBetween(from, to, (node) => {
		href ??= (marks.link.isInSet(node.marks)?.attrs.href as string | undefined) ?? null;
	});
	const text = state.doc.textBetween(from, to, "\n", "\n");
	const oneLine = $from.sameParent($to) && $from.parent.isTextblock && !text.includes("\n");
	return { from, to, href, text, textEditable: oneLine };
}

/** True when the selection can hold a link. A code block cannot. */
export function canLink(state: EditorState): boolean {
	const { $from, $to } = state.selection;
	return $from.parent.type.allowsMarkType(marks.link) && $to.parent.type.allowsMarkType(marks.link);
}

/**
 * Links the target of the link dialog to `href`. With no selection, it puts `text` at the cursor
 * as a link. When the text changed, it replaces the target. Otherwise it only sets the link, so
 * the formatting of the text stays.
 */
export function setLink(href: string, text: string): Command {
	return (state, dispatch) => {
		const safe = docHref(href);
		if (safe === null || !canLink(state)) return false;
		if (!dispatch) return true;
		const target = linkTargetAt(state);
		const link = marks.link.create({ href: safe });
		const tr = state.tr;
		if (target.from === target.to || (target.textEditable && text !== "" && text !== target.text)) {
			const content = text === "" ? safe : text;
			const around =
				target.from === target.to
					? (state.storedMarks ?? state.selection.$from.marks())
					: (state.doc.nodeAt(target.from)?.marks ?? []);
			tr.replaceWith(target.from, target.to, schema.text(content, link.addToSet(around)));
			tr.setSelection(TextSelection.create(tr.doc, target.from + content.length));
		} else {
			tr.removeMark(target.from, target.to, marks.link).addMark(target.from, target.to, link);
		}
		dispatch(tr.scrollIntoView());
		return true;
	};
}

/** Removes the link from the selection, or from the whole link around the cursor. */
export const removeLink: Command = (state, dispatch) => {
	const target = linkTargetAt(state);
	if (target.href === null) return false;
	if (dispatch) dispatch(state.tr.removeMark(target.from, target.to, marks.link).scrollIntoView());
	return true;
};

/** True when a step can make blocks deeper. A step that only changes text or marks cannot. */
function changesStructure(tr: Transaction): boolean {
	return tr.steps.some((step) => {
		if (step instanceof ReplaceAroundStep) return true;
		if (!(step instanceof ReplaceStep)) return false;
		let blocks = false;
		step.slice.content.forEach((node) => {
			if (!node.isInline) blocks = true;
		});
		return blocks;
	});
}

/**
 * Refuses a change that makes the blocks deeper than `EDITOR_MAX_DEPTH`, for example a list level
 * or a paste. The server refuses a doc that is too deep, and the save then fails each time. A doc
 * that is already deeper can still change, if the change does not make it deeper.
 */
export function depthLimit(maxDepth: number = EDITOR_MAX_DEPTH): Plugin {
	return new Plugin({
		filterTransaction(tr, state) {
			if (!tr.docChanged || !changesStructure(tr)) return true;
			const depth = blockDepth(tr.doc);
			return depth <= maxDepth || depth <= blockDepth(state.doc);
		},
	});
}

function inList(state: EditorState): boolean {
	return listTypeAt(state) !== null;
}

/**
 * A list level key. In a list, it keeps the key from the browser, also when the item cannot move.
 * Outside a list, the browser gets the key: Tab moves the focus, so the editor is no keyboard trap.
 */
function inListOnly(command: Command): Command {
	return (state, dispatch, view) => {
		if (!inList(state)) return false;
		command(state, dispatch, view);
		return true;
	};
}

/**
 * Runs the command and keeps the key from the browser, also when the command does nothing. On a
 * Mac, ⌘[ and ⌘] are Back and Forward, which would close the editor.
 */
function keepKey(command: Command): Command {
	return (state, dispatch, view) => {
		command(state, dispatch, view);
		return true;
	};
}

/**
 * Arrow down at the end of a code block that is the last block of the doc: a paragraph comes after
 * it. Without this key, a person cannot put the cursor below such a block.
 */
const leaveLastCodeBlock: Command = (state, dispatch) => {
	const { $head, empty } = state.selection;
	if (!empty || $head.parent.type.spec.code !== true) return false;
	if ($head.pos + $head.depth !== state.doc.content.size) return false;
	return exitCode(state, dispatch);
};

/** The keys of the editor. `openLink` opens the link dialog. */
export function docKeys(openLink: Command): Record<string, Command> {
	const sink = sinkListItem(nodes.list_item);
	const lift = liftListItem(nodes.list_item);
	return {
		"Mod-z": undo,
		"Shift-Mod-z": redo,
		"Mod-y": redo,
		"Mod-b": toggleMark(marks.strong),
		"Mod-i": toggleMark(marks.em),
		"Mod-u": toggleMark(marks.underline),
		"Shift-Mod-x": toggleMark(marks.strike),
		"Mod-e": toggleMark(marks.code),
		"Mod-k": openLink,
		"Mod-Alt-0": setParagraph,
		"Mod-Alt-1": setHeading(1),
		"Mod-Alt-2": setHeading(2),
		"Mod-Alt-3": setHeading(3),
		"Shift-Mod-e": toggleCodeBlock,
		"Shift-Mod-7": toggleList(nodes.ordered_list),
		"Shift-Mod-8": toggleList(nodes.bullet_list),
		"Shift-Mod-9": toggleQuote,
		"Mod-\\": clearFormatting,
		"Mod-]": keepKey(sink),
		"Mod-[": keepKey(lift),
		Tab: inListOnly(sink),
		"Shift-Tab": inListOnly(lift),
		Enter: splitListItem(nodes.list_item),
		"Shift-Enter": insertHardBreak,
		ArrowDown: leaveLastCodeBlock,
	};
}
