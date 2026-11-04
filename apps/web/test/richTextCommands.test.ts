import type { Mark, Node } from "prosemirror-model";
import { AllSelection, type Command, EditorState, TextSelection } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import { docToHtml, schema } from "../src/features/mail/richText.ts";
import {
	clearFormatting,
	editorKeys,
	isQuoteActive,
	linkTargetAt,
	listTypeAt,
	removeLink,
	setLink,
	toggleList,
	toggleQuote,
} from "../src/features/mail/richTextCommands.ts";

const { nodes, marks } = schema;
const bold = marks.strong.create();
const italic = marks.em.create();
const link = (href: string) => marks.link.create({ href });

function p(...content: (string | Node)[]): Node {
	return nodes.paragraph.create(
		null,
		content.map((item) => (typeof item === "string" ? schema.text(item) : item)),
	);
}

function text(value: string, ...textMarks: Mark[]): Node {
	return schema.text(value, textMarks);
}

/** A state with the selection from `from` to `to`. In doc(p("Hello world")), "world" is 7 to 12. */
function state(content: Node[], from: number, to = from): EditorState {
	const doc = nodes.doc.create(null, content);
	return EditorState.create({ doc, selection: TextSelection.create(doc, from, to) });
}

function run(current: EditorState, command: Command): EditorState {
	let next = current;
	const done = command(current, (tr) => {
		next = current.apply(tr);
	});
	expect(done).toBe(true);
	return next;
}

describe("toolbar commands", () => {
	it("makes a list, changes its type, and removes it with the button of its type", () => {
		const start = state([p("one"), p("two")], 1, 8);
		const bulleted = run(start, toggleList(nodes.bullet_list));
		expect(listTypeAt(bulleted)).toBe(nodes.bullet_list);
		expect(docToHtml(bulleted.doc)).toBe("<ul><li><div>one</div></li><li><div>two</div></li></ul>");
		const numbered = run(bulleted, toggleList(nodes.ordered_list));
		expect(listTypeAt(numbered)).toBe(nodes.ordered_list);
		expect(docToHtml(numbered.doc)).toBe("<ol><li><div>one</div></li><li><div>two</div></li></ol>");
		const removed = run(numbered, toggleList(nodes.ordered_list));
		expect(listTypeAt(removed)).toBeNull();
		expect(docToHtml(removed.doc)).toBe("<div>one</div><div>two</div>");
	});

	it("puts the selection in a quote, and takes it out again", () => {
		const start = state([p("intro"), p("cited")], 9);
		const quoted = run(start, toggleQuote);
		expect(isQuoteActive(quoted)).toBe(true);
		expect(quoted.doc.child(1).type).toBe(nodes.blockquote);
		const lifted = run(quoted, toggleQuote);
		expect(isQuoteActive(lifted)).toBe(false);
		expect(lifted.doc.eq(start.doc)).toBe(true);
	});

	it("keeps Mod-[ and Mod-] from the browser outside a list, where a Mac goes back or forward", () => {
		const keys = editorKeys(() => true);
		const start = state([p("text")], 2);
		expect(keys["Mod-["]?.(start, () => {})).toBe(true);
		expect(keys["Mod-]"]?.(start, () => {})).toBe(true);
	});

	it("removes bold and italic but keeps a link", () => {
		const start = state([p(text("styled", bold, italic, link("https://example.com/")), " plain")], 1, 7);
		const cleared = run(start, clearFormatting);
		expect(docToHtml(cleared.doc)).toBe('<div><a href="https://example.com/">styled</a> plain</div>');
	});
});

describe("links", () => {
	it("links the selected text and keeps its formatting", () => {
		const start = state([p("Hello ", text("world", bold))], 7, 12);
		const linked = run(start, setLink("https://example.com/", "world"));
		expect(docToHtml(linked.doc)).toBe('<div>Hello <a href="https://example.com/"><b>world</b></a></div>');
	});

	it("puts new linked text at the cursor, and replaces the text of a link when it changes", () => {
		const inserted = run(state([p("See ")], 5), setLink("https://example.com/", "the docs"));
		expect(docToHtml(inserted.doc)).toBe('<div>See <a href="https://example.com/">the docs</a></div>');
		// The cursor in the link selects all of the link.
		const inside = inserted.apply(inserted.tr.setSelection(TextSelection.create(inserted.doc, 8)));
		expect(linkTargetAt(inside)).toMatchObject({ from: 5, to: 13, href: "https://example.com/", text: "the docs" });
		const renamed = run(inside, setLink("https://example.org/", "guide"));
		expect(docToHtml(renamed.doc)).toBe('<div>See <a href="https://example.org/">guide</a></div>');
		const unlinked = run(renamed.apply(renamed.tr.setSelection(TextSelection.create(renamed.doc, 7))), removeLink);
		expect(docToHtml(unlinked.doc)).toBe("<div>See guide</div>");
	});

	it("refuses a link that is not http, https or mailto", () => {
		const start = state([p("Hello")], 1, 6);
		expect(setLink("javascript:alert(1)", "Hello")(start, () => {})).toBe(false);
	});

	it("does not offer one text field for a selection over more than one paragraph", () => {
		const start = state([p("one"), p("two")], 2, 8);
		expect(linkTargetAt(start).textEditable).toBe(false);
		// Select all in one paragraph: the selection is in the document, not in a paragraph.
		const one = nodes.doc.create(null, [p("one")]);
		const all = EditorState.create({ doc: one, selection: new AllSelection(one) });
		expect(linkTargetAt(all).textEditable).toBe(false);
		const linked = run(start, setLink("https://example.com/", ""));
		expect(docToHtml(linked.doc)).toBe(
			'<div>o<a href="https://example.com/">ne</a></div><div><a href="https://example.com/">tw</a>o</div>',
		);
	});
});
