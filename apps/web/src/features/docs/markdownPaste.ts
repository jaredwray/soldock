import { DOC_LIMITS, type DocBlock, markdownToDoc } from "@asterra/contracts";
import { closeHistory } from "prosemirror-history";
import { Slice } from "prosemirror-model";
import { type EditorState, Plugin, Selection, type Transaction } from "prosemirror-state";
import { contentToDoc, plainTextSlice } from "./schema.ts";

// A paste of Markdown into a doc. Pasted text that reads as Markdown gets its formats: the headings,
// the lists, the quotes, the code, the rules, the links and the marks. `markdownToDoc` of the
// contracts reads the text, so a paste and `docs.update` read Markdown in the same way.
//
// The paste is two steps of Undo. The first step puts the text in as it is. The second step puts the
// formats in its place. Thus one Undo gives the text back, for text that only looks like Markdown.

/** True when the blocks have a format: a block that is not a paragraph, or a text with a mark. */
function hasFormat(blocks: readonly DocBlock[]): boolean {
	return blocks.some(
		(block) =>
			block.type !== "paragraph" ||
			(block.content ?? []).some((node) => node.type === "text" && node.marks !== undefined),
	);
}

/**
 * The content of pasted text that reads as Markdown, or null for text without a format. Such text
 * goes in as plain text, which keeps each line and each empty line. An image stays text: a pasted
 * id can be the image of a different doc.
 */
export function markdownSlice(text: string): Slice | null {
	if (text.length > DOC_LIMITS.markdownChars) return null;
	const content = markdownToDoc(text);
	if (!hasFormat(content.content)) return null;
	// The slice is open at its two ends, as pasted HTML is: its first and last lines can join the
	// text around the cursor.
	return Slice.maxOpen(contentToDoc(content).content);
}

/**
 * True when the clipboard has the text of a Markdown file from a code editor. VS Code, and the
 * editors that come from it, put the language of the text on the clipboard. The HTML of such a copy
 * has only the colors of the editor, so the text form is the content.
 */
export function fromMarkdownEditor(data: Pick<DataTransfer, "getData">): boolean {
	const editor = data.getData("vscode-editor-data");
	if (editor === "") return false;
	try {
		return (JSON.parse(editor) as { mode?: unknown } | null)?.mode === "markdown";
	} catch {
		return false;
	}
}

function asPaste(tr: Transaction): Transaction {
	return tr.scrollIntoView().setMeta("paste", true).setMeta("uiEvent", "paste");
}

/** The first step of a Markdown paste: the pasted content goes in as it is, as each other paste. */
export function textPaste(state: EditorState, slice: Slice): Transaction {
	return asPaste(state.tr.replaceSelection(slice));
}

/**
 * The second step of a Markdown paste, for the state after `text`. It takes the pasted text out and
 * puts the Markdown form at the selection of `before`, so the doc is the same as after a paste of
 * only the Markdown form. It is a new step of Undo.
 */
export function formatPaste(before: EditorState, text: Transaction, after: EditorState, markdown: Slice): Transaction {
	const tr = after.tr;
	for (let index = text.steps.length - 1; index >= 0; index--) {
		const step = text.steps[index];
		const doc = text.docs[index];
		if (step && doc) tr.step(step.invert(doc));
	}
	const direct = before.tr.replaceSelection(markdown);
	for (const step of direct.steps) tr.step(step);
	tr.setSelection(Selection.fromJSON(tr.doc, direct.selection.toJSON()));
	return asPaste(closeHistory(tr));
}

/**
 * The plugin for pasted text. Text that reads as Markdown gets its formats, and each other text
 * goes in as plain text. Text stays as it is in a code block, and with Shift, the key of a paste
 * without formats.
 */
export function markdownPaste(): Plugin {
	/** The text that the view reads from the clipboard now. A paste is one task, so it is null in the next one. */
	let reading: { text: string; plain: boolean } | null = null;
	return new Plugin({
		props: {
			clipboardTextParser(text, $context, plain) {
				reading = { text, plain };
				queueMicrotask(() => {
					reading = null;
				});
				return plainTextSlice(text, $context.parent.type.spec.code === true, $context.marks());
			},
			handlePaste(view, event, slice) {
				const read = reading;
				reading = null;
				const before = view.state;
				if (slice.content.size === 0 || before.selection.$from.parent.type.spec.code === true) return false;
				let source: string;
				if (read !== null) {
					if (read.plain) return false;
					source = read.text;
				} else {
					// The view used the HTML of the clipboard. Only the HTML of a code editor is replaced.
					const data = event.clipboardData;
					if (!data || !fromMarkdownEditor(data)) return false;
					source = data.getData("text/plain");
				}
				const markdown = markdownSlice(source);
				if (markdown === null) return false;
				const text = textPaste(before, slice);
				view.dispatch(text);
				// A plugin can refuse the text or change it. The formats then have no place to go.
				if (view.state.doc !== text.doc) return true;
				// A plugin can refuse the formats, for example blocks that are too deep. The text then stays.
				view.dispatch(formatPaste(before, text, view.state, markdown));
				return true;
			},
		},
	});
}
