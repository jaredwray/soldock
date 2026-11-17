import { toggleMark, wrapIn } from "prosemirror-commands";
import { redo, undo } from "prosemirror-history";
import type { MarkType, NodeType, ResolvedPos, Schema } from "prosemirror-model";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import { type Command, type EditorState, TextSelection } from "prosemirror-state";
import { liftTarget } from "prosemirror-transform";
import { safeHref, schema } from "./richText.ts";

// The commands of the composer toolbar and its shortcuts. Each one works on an EditorState only,
// so the Node tests can run them without a DOM. `createRichTextCommands` makes them for a schema with
// the lists, the quote, the hard break and the link of the mail schema: the chat box uses it too.

/** True when the mark is on the cursor, or on some text of the selection. Toggling then removes it. */
export function isMarkActive(state: EditorState, type: MarkType): boolean {
	const { from, to, empty, $from } = state.selection;
	if (empty) return type.isInSet(state.storedMarks ?? $from.marks()) !== undefined;
	return state.doc.rangeHasMark(from, to, type);
}

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

/** The marks and nodes that the commands use, from a schema like the mail schema. */
export type RichTextSchema = Schema<
	"doc" | "paragraph" | "blockquote" | "bullet_list" | "ordered_list" | "list_item" | "text" | "hard_break",
	"link"
>;

/**
 * The commands for a schema. `formatMarks` are the marks that "Remove formatting" removes. A link is
 * not formatting, so it stays.
 */
export function createRichTextCommands(schema: RichTextSchema, formatMarks: readonly MarkType[]) {
	const { nodes, marks } = schema;
	const FORMAT_MARKS = formatMarks;

	function isList(type: NodeType): boolean {
		return type === nodes.bullet_list || type === nodes.ordered_list;
	}

	/** The type of the innermost list that holds the selection, or null. */
	function listTypeAt(state: EditorState): NodeType | null {
		const { $from, $to } = state.selection;
		return $from.blockRange($to, (node) => isList(node.type))?.parent.type ?? null;
	}

	/** True when the selection is in a quote. */
	function isQuoteActive(state: EditorState): boolean {
		const { $from, $to } = state.selection;
		return $from.blockRange($to, (node) => node.type === nodes.blockquote) !== null;
	}

	/**
	 * A list button: it removes the list when the selection is in that type of list, changes the
	 * type of a list of the other type, and otherwise makes a list.
	 */
	function toggleList(listType: NodeType): Command {
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
	const toggleQuote: Command = (state, dispatch) => {
		const { $from, $to } = state.selection;
		const range = $from.blockRange($to, (node) => node.type === nodes.blockquote);
		if (range === null) return wrapIn(nodes.blockquote)(state, dispatch);
		const target = liftTarget(range);
		if (target === null) return false;
		if (dispatch) dispatch(state.tr.lift(range, target).scrollIntoView());
		return true;
	};

	/** Removes bold, italic, underline and strikethrough from the selection, or from the next text at the cursor. */
	const clearFormatting: Command = (state, dispatch) => {
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

	const insertHardBreak: Command = (state, dispatch) => {
		if (dispatch) dispatch(state.tr.replaceSelectionWith(nodes.hard_break.create()).scrollIntoView());
		return true;
	};

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
	function linkTargetAt(state: EditorState): LinkTarget {
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

	/**
	 * Links the target of the link dialog to `href`. With no selection, it puts `text` at the cursor
	 * as a link. When the text changed, it replaces the target. Otherwise it only sets the link, so
	 * the formatting of the text stays.
	 */
	function setLink(href: string, text: string): Command {
		return (state, dispatch) => {
			const safe = safeHref(href);
			if (safe === null) return false;
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
	const removeLink: Command = (state, dispatch) => {
		const target = linkTargetAt(state);
		if (target.href === null) return false;
		if (dispatch) dispatch(state.tr.removeMark(target.from, target.to, marks.link).scrollIntoView());
		return true;
	};

	return {
		listTypeAt,
		isQuoteActive,
		toggleList,
		toggleQuote,
		clearFormatting,
		insertHardBreak,
		linkTargetAt,
		setLink,
		removeLink,
	};
}

const { marks, nodes } = schema;

export const {
	listTypeAt,
	isQuoteActive,
	toggleList,
	toggleQuote,
	clearFormatting,
	insertHardBreak,
	linkTargetAt,
	setLink,
	removeLink,
} = createRichTextCommands(schema, [marks.strong, marks.em, marks.underline, marks.strike]);

/**
 * Runs the command and keeps the key from the browser, also when the command does nothing. On a
 * Mac, ⌘[ and ⌘] are Back and Forward, which would close the app and lose the draft.
 */
export function keepKey(command: Command): Command {
	return (state, dispatch, view) => {
		command(state, dispatch, view);
		return true;
	};
}

/** The keys of the editor. `openLink` opens the link dialog. */
export function editorKeys(openLink: Command): Record<string, Command> {
	return {
		"Mod-z": undo,
		"Shift-Mod-z": redo,
		"Mod-y": redo,
		"Mod-b": toggleMark(marks.strong),
		"Mod-i": toggleMark(marks.em),
		"Mod-u": toggleMark(marks.underline),
		"Shift-Mod-x": toggleMark(marks.strike),
		"Mod-k": openLink,
		"Shift-Mod-7": toggleList(nodes.ordered_list),
		"Shift-Mod-8": toggleList(nodes.bullet_list),
		"Shift-Mod-9": toggleQuote,
		"Mod-\\": clearFormatting,
		"Mod-]": keepKey(sinkListItem(nodes.list_item)),
		"Mod-[": keepKey(liftListItem(nodes.list_item)),
		Enter: splitListItem(nodes.list_item),
		"Shift-Enter": insertHardBreak,
	};
}
