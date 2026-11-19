import type { GroupMention } from "@asterra/contracts";
import { chainCommands, liftEmptyBlock, newlineInCode, splitBlock, toggleMark } from "prosemirror-commands";
import { redo, undo } from "prosemirror-history";
import { InputRule, textblockTypeInputRule, undoInputRule, wrappingInputRule } from "prosemirror-inputrules";
import type { MarkType, Node } from "prosemirror-model";
import { liftListItem, sinkListItem, splitListItem } from "prosemirror-schema-list";
import { type Command, type EditorState, TextSelection, type Transaction } from "prosemirror-state";
import { createRichTextCommands, keepKey, type RichTextSchema } from "../mail/richTextCommands.ts";
import { chatSchema } from "./composerSchema.ts";
import { emojiOfCode, emojiQueryAt, FULL_CODE } from "./emoji.ts";
import { insertMention, mentionAt } from "./mentions.ts";

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
		// A line break is a new line. A mention keeps its text: "@" and its label, or "@" and its group.
		const leaf = (node: Node) =>
			node.type === nodes.mention
				? `@${node.attrs.label}`
				: node.type === nodes.group_mention
					? `@${node.attrs.group}`
					: "\n";
		const text = blocks.map((block) => block.textBetween(0, block.content.size, "\n", leaf)).join("\n");
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
 * - `:tada:`, the full code of an emoji: the emoji.
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
	// A full code such as `:tada:` becomes its emoji. A code that no emoji has stays text.
	new InputRule(
		FULL_CODE,
		(state, match, start, end) => {
			const choice = emojiOfCode(match[1] ?? "");
			return choice ? state.tr.insertText(choice.emoji, start, end) : null;
		},
		{ inCodeMark: false },
	),
];

/** The mention that the person types: from its "@" (`from`) to the caret (`to`), in positions of the document. */
export interface TypedMention {
	from: number;
	to: number;
	query: string;
	/** The text of the line before the "@", the typed text and the text after the caret, for `insertMention`. */
	before: string;
	after: string;
}

/** The mention before the caret, or null. A code block and a code mark have no mention. */
export function typedMention(state: EditorState): TypedMention | null {
	const { $head, empty } = state.selection;
	if (!empty || !$head.parent.isTextblock || $head.parent.type.spec.code) return null;
	if ($head.marks().some((mark) => mark.type === marks.code)) return null;
	const parent = $head.parent;
	const before = parent.textBetween(0, $head.parentOffset, undefined, "￼");
	const token = mentionAt(before, before.length);
	if (!token) return null;
	const start = $head.start();
	return {
		from: start + token.start,
		to: $head.pos,
		query: token.query,
		before,
		after: parent.textBetween($head.parentOffset, parent.content.size, undefined, "￼"),
	};
}

/**
 * The change that puts a mention node of the principal in place of the mention that the person types,
 * with the caret after it. A space follows, as `insertMention` does in a text: not before a space or a
 * mark that ends a word. The label is the handle.
 */
export function insertTypedMention(state: EditorState, person: { id: string; handle: string }): Transaction | null {
	return replaceTypedMention(state, person.handle, nodes.mention.create({ id: person.id, label: person.handle }));
}

/** The change that puts a mention of a group ("@here", "@channel") in place of the mention that the person types. */
export function insertTypedGroupMention(state: EditorState, group: GroupMention): Transaction | null {
	return replaceTypedMention(state, group, nodes.group_mention.create({ group }));
}

/** The typed mention replaced by `node`, which shows "@" and `label`, with a space and the caret after it. */
function replaceTypedMention(state: EditorState, label: string, node: Node): Transaction | null {
	const mention = typedMention(state);
	if (!mention) return null;
	const text = mention.before + mention.after;
	const start = mention.before.length - mention.query.length - 1;
	const next = insertMention(text, { start, end: mention.before.length, query: mention.query }, label);
	const typed = next.value.slice(start, next.value.length - mention.after.length);
	const space = typed.endsWith(" ");
	// insertMention puts the caret after the mention, and after one space that follows it.
	const afterMention = next.caret - start - `@${label}`.length;
	const tr = state.tr.replaceWith(mention.from, mention.to, space ? [node, chatSchema.text(" ")] : [node]);
	return tr.setSelection(TextSelection.create(tr.doc, mention.from + 1 + afterMention)).scrollIntoView();
}

/** The code of an emoji that the person types: from its ":" (`from`) to the caret (`to`). */
export interface TypedEmoji {
	from: number;
	to: number;
	query: string;
	/** The text after the caret on its line. */
	after: string;
}

/** The code of an emoji before the caret, or null. A code block and a code mark have no emoji. */
export function typedEmoji(state: EditorState): TypedEmoji | null {
	const { $head, empty } = state.selection;
	if (!empty || !$head.parent.isTextblock || $head.parent.type.spec.code) return null;
	if ($head.marks().some((mark) => mark.type === marks.code)) return null;
	const parent = $head.parent;
	const token = emojiQueryAt(parent.textBetween(0, $head.parentOffset, undefined, "\ufffc"));
	if (!token) return null;
	return {
		from: $head.start() + token.start,
		to: $head.pos,
		query: token.query,
		after: parent.textBetween($head.parentOffset, parent.content.size, undefined, "\ufffc"),
	};
}

/**
 * The change that puts `emoji` in place of the code that the person types, with the caret after it. A
 * space follows the emoji, unless a space or a mark that ends a word follows it already.
 */
export function insertTypedEmoji(state: EditorState, emoji: string): Transaction | null {
	const typed = typedEmoji(state);
	if (!typed) return null;
	const text = /^[\s,.;:!?)\]}'"’”]/u.test(typed.after) ? emoji : `${emoji} `;
	const tr = state.tr.insertText(text, typed.from, typed.to);
	return tr.setSelection(TextSelection.create(tr.doc, typed.from + text.length)).scrollIntoView();
}
