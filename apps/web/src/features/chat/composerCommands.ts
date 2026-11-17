import { chainCommands, liftEmptyBlock, newlineInCode, splitBlock, toggleMark } from "prosemirror-commands";
import { redo, undo } from "prosemirror-history";
import { InputRule, textblockTypeInputRule, undoInputRule, wrappingInputRule } from "prosemirror-inputrules";
import type { MarkType, Node } from "prosemirror-model";
import { liftListItem, sinkListItem, splitListItem } from "prosemirror-schema-list";
import { type Command, type EditorState, TextSelection } from "prosemirror-state";
import { createRichTextCommands, keepKey, type RichTextSchema } from "../mail/richTextCommands.ts";
import { chatSchema } from "./composerSchema.ts";

// The commands, the keys and the Markdown shortcuts of the chat box. Each one works on an EditorState
// only, so the Node tests can run them without a DOM.

const { nodes, marks } = chatSchema;

/** The list, quote and link commands of the mail editor, for the chat schema. "Remove formatting" removes these marks. */
export const rich = createRichTextCommands(chatSchema as unknown as RichTextSchema, [
	marks.strong,
	marks.em,
	marks.strike,
	marks.code,
]);

/** True when the selection is in a code block. */
export function isCodeBlockActive(state: EditorState): boolean {
	return state.selection.$from.parent.type === nodes.code_block;
}

/**
 * The code block button. In a code block, each line becomes a paragraph again. Otherwise the selected
 * paragraphs become one code block, one line for each paragraph. A selection with other blocks, such as
 * a list, does not change.
 */
export const toggleCodeBlock: Command = (state, dispatch) => {
	const { $from, $to } = state.selection;
	if ($from.parent.type === nodes.code_block) {
		const block = $from.parent;
		const lines = block.textContent.split("\n");
		const paragraphs = lines.map((line) => nodes.paragraph.create(null, line === "" ? null : chatSchema.text(line)));
		const start = $from.before();
		if (dispatch) {
			const tr = state.tr.replaceWith(start, start + block.nodeSize, paragraphs);
			dispatch(tr.setSelection(TextSelection.create(tr.doc, start + 1)).scrollIntoView());
		}
		return true;
	}
	const range = $from.blockRange($to);
	if (range === null) return false;
	const blocks: Node[] = [];
	for (let index = range.startIndex; index < range.endIndex; index++) blocks.push(range.parent.child(index));
	if (blocks.length === 0 || blocks.some((block) => block.type !== nodes.paragraph)) return false;
	if (!range.parent.canReplaceWith(range.startIndex, range.endIndex, nodes.code_block)) return false;
	if (dispatch) {
		const text = blocks.map((block) => block.textBetween(0, block.content.size, "\n", "\n")).join("\n");
		const tr = state.tr.replaceWith(
			range.start,
			range.end,
			nodes.code_block.create(null, text === "" ? null : chatSchema.text(text)),
		);
		dispatch(tr.setSelection(TextSelection.create(tr.doc, range.start + 1 + text.length)).scrollIntoView());
	}
	return true;
};

/**
 * Shift+Enter in a code block: a new line. A second Shift+Enter at the end of the block, after an empty
 * line, leaves the block: the empty line goes, and a paragraph follows the block.
 */
const codeLine: Command = (state, dispatch) => {
	const { $head, empty } = state.selection;
	if (!$head.parent.type.spec.code) return false;
	const atEnd = empty && $head.parentOffset === $head.parent.content.size;
	if (!atEnd || !$head.parent.textContent.endsWith("\n")) return newlineInCode(state, dispatch);
	if (dispatch) {
		const after = $head.after();
		const tr = state.tr.delete($head.pos - 1, $head.pos);
		const at = tr.mapping.map(after);
		tr.insert(at, nodes.paragraph.create());
		dispatch(tr.setSelection(TextSelection.create(tr.doc, at + 1)).scrollIntoView());
	}
	return true;
};

/**
 * Shift+Enter on an empty line of a list item or a quote: the line leaves the list or the quote.
 * `splitListItem` gives an empty item of the outer list to this command.
 */
const leaveBlock: Command = (state, dispatch) => {
	const { $head, empty } = state.selection;
	if (!empty || $head.parent.content.size > 0) return false;
	for (let depth = $head.depth - 1; depth > 0; depth--) {
		const type = $head.node(depth).type;
		if (type === nodes.list_item) return liftListItem(nodes.list_item)(state, dispatch);
		if (type === nodes.blockquote) return liftEmptyBlock(state, dispatch);
	}
	return false;
};

/**
 * Shift+Enter: a new line. In a list, a new item (an empty item leaves the list). In a code block, a
 * new line of code. On an empty line of a quote, the line leaves the quote.
 */
export const newLine: Command = chainCommands(codeLine, splitListItem(nodes.list_item), leaveBlock, splitBlock);

/**
 * The keys of the box. Enter sends (`submit`), and Shift+Enter makes a new line. `openLink` opens the
 * link dialog.
 */
export function composerKeys(submit: Command, openLink: Command): Record<string, Command> {
	return {
		Enter: submit,
		"Mod-Enter": submit,
		"Shift-Enter": newLine,
		Backspace: undoInputRule,
		"Mod-z": undo,
		"Shift-Mod-z": redo,
		"Mod-y": redo,
		"Mod-b": toggleMark(marks.strong),
		"Mod-i": toggleMark(marks.em),
		"Shift-Mod-x": toggleMark(marks.strike),
		"Mod-e": toggleMark(marks.code),
		"Mod-k": openLink,
		"Shift-Mod-7": rich.toggleList(nodes.ordered_list),
		"Shift-Mod-8": rich.toggleList(nodes.bullet_list),
		"Shift-Mod-9": rich.toggleQuote,
		"Mod-Alt-c": toggleCodeBlock,
		"Mod-\\": rich.clearFormatting,
		"Mod-]": keepKey(sinkListItem(nodes.list_item)),
		"Mod-[": keepKey(liftListItem(nodes.list_item)),
	};
}

/**
 * A Markdown mark that a person types: `pattern` matches the text before the caret and the last
 * character typed. Group 1 is the text before the mark, group 2 the text in the mark. The marks
 * (`delimiter`) go away, and the text gets the mark. The marks that the text has stay.
 */
function markRule(pattern: RegExp, delimiter: number, type: MarkType): InputRule {
	return new InputRule(
		pattern,
		(state, match, start, end) => {
			const from = start + (match[1] ?? "").length;
			const textEnd = from + delimiter + (match[2] ?? "").length;
			const tr = state.tr;
			// The last character typed is not in the document yet: the closing mark there is one character shorter.
			if (end > textEnd) tr.delete(textEnd, end);
			tr.addMark(from + delimiter, textEnd, type.create());
			tr.delete(from, from + delimiter);
			tr.removeStoredMark(type);
			return tr;
		},
		{ inCodeMark: false },
	);
}

/**
 * The Markdown shortcuts of the box:
 * - `**bold**`, `*italic*` or `_italic_`, `~~strike~~` and `` `code` `` at the end of the text.
 * - `- `, `* ` or `+ ` at the start of a line: a bulleted list. `1. `: a numbered list. `> `: a quote.
 *   ```` ``` ````: a code block.
 * A mark in a word, such as `2*3*4`, stays text. Backspace right after a shortcut gives the text back.
 */
export const markdownRules: readonly InputRule[] = [
	markRule(/(^|[^*])\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/u, 2, marks.strong),
	markRule(/(^|[^*\p{L}\p{N}])\*([^*\s](?:[^*]*[^*\s])?)\*$/u, 1, marks.em),
	markRule(/(^|[^_\p{L}\p{N}])_([^_\s](?:[^_]*[^_\s])?)_$/u, 1, marks.em),
	markRule(/(^|[^~])~~([^~\s](?:[^~]*[^~\s])?)~~$/u, 2, marks.strike),
	markRule(/(^|[^`])`([^`]+)`$/u, 1, marks.code),
	wrappingInputRule(/^\s*([-+*])\s$/, nodes.bullet_list),
	wrappingInputRule(
		/^(\d{1,5})\.\s$/,
		nodes.ordered_list,
		(match) => ({ order: Number(match[1]) }),
		(match, node) => node.childCount + (node.attrs.order as number) === Number(match[1]),
	),
	wrappingInputRule(/^\s*>\s$/, nodes.blockquote),
	textblockTypeInputRule(/^```$/, nodes.code_block),
];
