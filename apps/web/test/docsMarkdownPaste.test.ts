import { DOC_LIMITS, type DocContent } from "@asterra/contracts";
import { history, undo } from "prosemirror-history";
import { Slice } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import { formatPaste, fromMarkdownEditor, markdownSlice, textPaste } from "../src/features/docs/markdownPaste.ts";
import { contentToDoc, docToContent, plainTextSlice } from "../src/features/docs/schema.ts";

const EMPTY: DocContent = { type: "doc", content: [{ type: "paragraph" }] };
const HELLO: DocContent = {
	type: "doc",
	content: [{ type: "paragraph", content: [{ type: "text", text: "Hello world" }] }],
};

/** An editor with the selection from `from` to `to`. */
function editor(content: DocContent, from: number, to = from): EditorState {
	const state = EditorState.create({ doc: contentToDoc(content), plugins: [history()] });
	return state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
}

/** The two steps of a paste of Markdown, as the plugin sends them. Returns the state after each step. */
function paste(before: EditorState, text: string): { asText: EditorState; formatted: EditorState } {
	const markdown = markdownSlice(text);
	if (markdown === null) throw new Error("the text does not read as Markdown");
	// The view opens the two ends of the text slice before the paste handler gets it.
	const first = textPaste(before, Slice.maxOpen(plainTextSlice(text, false).content));
	const asText = before.apply(first);
	return { asText, formatted: asText.apply(formatPaste(before, first, asText, markdown)) };
}

function undone(state: EditorState): EditorState {
	let next = state;
	undo(state, (tr) => {
		next = state.apply(tr);
	});
	return next;
}

const text = (value: string, ...marks: string[]) =>
	marks.length === 0
		? { type: "text", text: value }
		: { type: "text", text: value, marks: marks.map((type) => ({ type })) };
const p = (...content: unknown[]) => ({ type: "paragraph", content });
const item = (...content: unknown[]) => ({ type: "list_item", content });

describe("a paste of Markdown", () => {
	it("puts each block and each mark of the Markdown into an empty doc", () => {
		const markdown = [
			"# Plan",
			"Text with **bold**, *italic*, ~~gone~~, `code` and [a link](https://example.com/a).",
			"- one\n- two\n  1. deep",
			"> quote",
			"```\nconst a = 1;\n```",
			"---",
			"End",
		].join("\n\n");
		expect(docToContent(paste(editor(EMPTY, 1), markdown).formatted.doc)).toEqual({
			type: "doc",
			content: [
				{ type: "heading", attrs: { level: 1 }, content: [text("Plan")] },
				p(
					text("Text with "),
					text("bold", "strong"),
					text(", "),
					text("italic", "em"),
					text(", "),
					text("gone", "strike"),
					text(", "),
					text("code", "code"),
					text(" and "),
					{ type: "text", text: "a link", marks: [{ type: "link", attrs: { href: "https://example.com/a" } }] },
					text("."),
				),
				{
					type: "bullet_list",
					content: [
						item(p(text("one"))),
						item(p(text("two")), { type: "ordered_list", attrs: { order: 1 }, content: [item(p(text("deep")))] }),
					],
				},
				{ type: "blockquote", content: [p(text("quote"))] },
				{ type: "code_block", content: [text("const a = 1;")] },
				{ type: "horizontal_rule" },
				p(text("End")),
			],
		});
	});

	it("puts the formats at the selection of before the paste, in the text around it", () => {
		// "world" is the selection. The pasted line joins the paragraph.
		const { formatted } = paste(editor(HELLO, 7, 12), "**big** place");
		expect(docToContent(formatted.doc)).toEqual({
			type: "doc",
			content: [p(text("Hello "), text("big", "strong"), text(" place"))],
		});
		// The cursor is after the pasted text, so the person continues to type there.
		expect([formatted.selection.from, formatted.selection.to]).toEqual([16, 16]);
	});

	it("is two steps of Undo: the first Undo gives the text back, the second removes it", () => {
		const { asText, formatted } = paste(editor(HELLO, 7, 12), "# Title\n\n- one");
		const first = undone(formatted);
		expect(docToContent(first.doc)).toEqual(docToContent(asText.doc));
		expect(first.doc.textContent).toBe("Hello # Title- one");
		expect(docToContent(undone(first).doc)).toEqual(HELLO);
	});

	it("keeps an image of Markdown as text, because a pasted id can be the image of a different doc", () => {
		const { formatted } = paste(editor(EMPTY, 1), "**See** ![chart](image:img_01HZX3V7Q8R9S0T1A2B3C4D5E6)");
		expect(docToContent(formatted.doc)).toEqual({
			type: "doc",
			content: [p(text("See", "strong"), text(" !chart"))],
		});
	});
});

describe("markdownSlice", () => {
	it.each([
		["lines and empty lines", "The first line\n\nThe second line\nThe third line"],
		["a hard break only", "The first line\\\nThe second line"],
		["marks in words and marks with spaces", "snake_case_name and 2 * 3 * 4"],
		["an escape", "C:\\_work\\*.txt"],
		["HTML", "<b>bold</b> <script>alert(1)</script>"],
		["Markdown over the limit of a doc", `# ${"a".repeat(DOC_LIMITS.markdownChars)}`],
	])("is null for text without a format: %s", (_name, value) => {
		expect(markdownSlice(value)).toBeNull();
	});
});

describe("fromMarkdownEditor", () => {
	const clipboard = (editorData: string) => ({
		getData: (type: string) => (type === "vscode-editor-data" ? editorData : ""),
	});

	it("is true only for the text of a Markdown file from a code editor", () => {
		expect(fromMarkdownEditor(clipboard('{"version":1,"isFromEmptySelection":false,"mode":"markdown"}'))).toBe(true);
		expect(fromMarkdownEditor(clipboard('{"version":1,"isFromEmptySelection":false,"mode":"python"}'))).toBe(false);
		expect(fromMarkdownEditor(clipboard("not JSON"))).toBe(false);
		expect(fromMarkdownEditor(clipboard("null"))).toBe(false);
		expect(fromMarkdownEditor(clipboard(""))).toBe(false);
	});
});
