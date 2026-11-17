import type { ChatBody } from "@soldock/contracts";
import { ChatBody as ChatBodySchema } from "@soldock/contracts";
import type { Node } from "prosemirror-model";
import { EditorState, Selection, TextSelection, type Transaction } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import { markdownRules, newLine, toggleCodeBlock } from "../src/features/chat/composerCommands.ts";
import { bodyToDoc, chatSchema, docToBody, sameInBox, textToBody } from "../src/features/chat/composerSchema.ts";

const { nodes, marks } = chatSchema;
const p = (...content: Node[]) => nodes.paragraph.create(null, content);
const t = (text: string, ...markNames: ("strong" | "em" | "code")[]) =>
	chatSchema.text(
		text,
		markNames.map((name) => marks[name].create()),
	);
const doc = (...blocks: Node[]) => nodes.doc.create(null, blocks);

describe("the body of the box", () => {
	// A person writes lines. In a message, the lines of a paragraph are hard breaks, as in the text form.
	it("joins the lines of the box into one paragraph, keeps empty lines between them, and drops them at the ends", () => {
		const box = doc(p(), p(t("one")), p(t("two", "strong")), p(), p(t("three")), p());
		expect(docToBody(box)).toEqual({
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [
						{ type: "text", text: "one" },
						{ type: "hard_break" },
						{ type: "text", text: "two", marks: [{ type: "strong" }] },
						{ type: "hard_break" },
						{ type: "hard_break" },
						{ type: "text", text: "three" },
					],
				},
			],
		});
		// A box with no text has no body: Enter sends nothing.
		expect(docToBody(doc(p(), p()))).toBeNull();
		expect(docToBody(doc(nodes.code_block.create(null, chatSchema.text("\n\n"))))).toBeNull();
	});

	it("keeps lists, quotes, code blocks and links, as the contract takes them", () => {
		const link = marks.link.create({ href: "https://example.com/notes" });
		const box = doc(
			nodes.bullet_list.create(null, [nodes.list_item.create(null, p(t("item")))]),
			nodes.ordered_list.create({ order: 3 }, [nodes.list_item.create(null, p(chatSchema.text("notes", [link])))]),
			nodes.blockquote.create(null, [p(t("quoted")), p(t("more"))]),
			nodes.code_block.create(null, chatSchema.text("make a\nmake b\n")),
		);
		const body = docToBody(box) as ChatBody;
		expect(ChatBodySchema.safeParse(body).success).toBe(true);
		expect(body.content).toEqual([
			{
				type: "bullet_list",
				content: [{ type: "list_item", content: [{ type: "paragraph", content: [{ type: "text", text: "item" }] }] }],
			},
			{
				type: "ordered_list",
				attrs: { order: 3 },
				content: [
					{
						type: "list_item",
						content: [
							{
								type: "paragraph",
								content: [
									{
										type: "text",
										text: "notes",
										marks: [{ type: "link", attrs: { href: "https://example.com/notes" } }],
									},
								],
							},
						],
					},
				],
			},
			{
				type: "blockquote",
				content: [
					{
						type: "paragraph",
						content: [{ type: "text", text: "quoted" }, { type: "hard_break" }, { type: "text", text: "more" }],
					},
				],
			},
			// New lines at the end of a code block go.
			{ type: "code_block", content: [{ type: "text", text: "make a\nmake b" }] },
		]);
	});

	// An edit opens the body of the message in the box. A save must send the same body back.
	it("opens a body in the box and gives the same body back, with each line of a paragraph as a line of the box", () => {
		const body: ChatBody = {
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [
						{ type: "text", text: "Ship", marks: [{ type: "strong" }] },
						{ type: "hard_break" },
						{ type: "text", text: "today" },
					],
				},
				{
					type: "bullet_list",
					content: [{ type: "list_item", content: [{ type: "code_block", content: [{ type: "text", text: "x" }] }] }],
				},
			],
		};
		const box = bodyToDoc(body);
		expect(box.child(0).textContent).toBe("Ship");
		expect(box.child(1).textContent).toBe("today");
		// An item of the box starts with a paragraph. The empty paragraph goes again in the body.
		expect(box.child(2).firstChild?.firstChild?.type).toBe(nodes.paragraph);
		expect(docToBody(box)).toEqual(body);
		// Two paragraphs of a message (from Markdown) open with an empty line between them. A save makes
		// one paragraph, and the same body opens the same box again.
		const markdown: ChatBody = {
			type: "doc",
			content: [
				{ type: "paragraph", content: [{ type: "text", text: "a" }] },
				{ type: "paragraph", content: [{ type: "text", text: "b" }] },
			],
		};
		const saved = docToBody(bodyToDoc(markdown)) as ChatBody;
		expect(saved).toEqual(textToBody("a\n\nb"));
		expect(sameInBox(markdown, saved)).toBe(true);
		expect(sameInBox(markdown, textToBody("a\nb"))).toBe(false);
		expect(bodyToDoc(null).textContent).toBe("");
	});
});

/** A state with the text of `box`, and the caret at `at`, or at the end of the text. */
function stateAt(box: Node, at?: number): EditorState {
	const state = EditorState.create({ doc: box });
	return state.apply(
		state.tr.setSelection(at === undefined ? Selection.atEnd(state.doc) : TextSelection.create(state.doc, at)),
	);
}

function run(state: EditorState, command: (s: EditorState, d: (tr: Transaction) => void) => boolean): EditorState {
	let next = state;
	expect(command(state, (tr) => (next = state.apply(tr)))).toBe(true);
	return next;
}

describe("the commands of the box", () => {
	it("makes a code block of the selected lines, and lines of a code block", () => {
		const box = doc(p(t("make a")), p(t("make b")));
		const state = EditorState.create({ doc: box });
		const all = state.apply(state.tr.setSelection(TextSelection.create(box, 1, box.content.size - 1)));
		const code = run(all, toggleCodeBlock);
		expect(code.doc.childCount).toBe(1);
		expect(code.doc.child(0).type).toBe(nodes.code_block);
		expect(code.doc.child(0).textContent).toBe("make a\nmake b");
		const back = run(code, toggleCodeBlock);
		expect(back.doc.eq(box)).toBe(true);
		// A list is not lines of text: the button does nothing there.
		const list = stateAt(
			doc(nodes.bullet_list.create(null, [nodes.list_item.create(null, p(t("item")))]), p(t("x"))),
			0,
		);
		const listAll = list.apply(list.tr.setSelection(TextSelection.create(list.doc, 3, list.doc.content.size - 1)));
		expect(toggleCodeBlock(listAll)).toBe(false);
	});

	// Shift+Enter makes a new line. The person must be able to leave a code block and a quote with it.
	it("makes a new line, leaves a code block after an empty line, and leaves a quote from an empty line", () => {
		const code = stateAt(doc(nodes.code_block.create(null, chatSchema.text("a"))));
		const second = run(code, newLine);
		expect(second.doc.child(0).textContent).toBe("a\n");
		const out = run(second, newLine);
		expect(out.doc.child(0).textContent).toBe("a");
		expect(out.doc.child(1).type).toBe(nodes.paragraph);
		expect(out.selection.$head.parent).toBe(out.doc.child(1));

		const quote = stateAt(doc(nodes.blockquote.create(null, [p(t("quoted")), p()])));
		const left = run(quote, newLine);
		expect(left.doc.child(0).type).toBe(nodes.blockquote);
		expect(left.doc.child(1).type).toBe(nodes.paragraph);
		expect(left.doc.child(0).childCount).toBe(1);

		const line = run(stateAt(doc(p(t("one")))), newLine);
		expect(line.doc.childCount).toBe(2);
	});
});

/** Types `text` at the caret, as the input rules of the box see a typed character. */
function type(state: EditorState, text: string): EditorState {
	let next = state;
	for (const char of text) {
		const { from, $from } = next.selection;
		const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼") + char;
		let applied = false;
		for (const rule of markdownRules) {
			const match = (rule as unknown as { match: RegExp }).match.exec(before);
			if (!match) continue;
			const handler = (
				rule as unknown as {
					handler: (s: EditorState, m: RegExpMatchArray, a: number, b: number) => Transaction | null;
				}
			).handler;
			const tr = handler(next, match, from - (match[0].length - 1), from);
			if (tr) {
				next = next.apply(tr);
				applied = true;
				break;
			}
		}
		if (!applied) next = next.apply(next.tr.insertText(char));
	}
	return next;
}

describe("the Markdown marks of the box", () => {
	it("makes bold, italic, strike and code at the closing mark, and keeps a mark in a word as text", () => {
		const typed = type(stateAt(doc(p())), "a **b** *c* _d_ ~~e~~ `f` 2*3*4");
		expect(docToBody(typed.doc)?.content[0]).toEqual({
			type: "paragraph",
			content: [
				{ type: "text", text: "a " },
				{ type: "text", text: "b", marks: [{ type: "strong" }] },
				{ type: "text", text: " " },
				{ type: "text", text: "c", marks: [{ type: "em" }] },
				{ type: "text", text: " " },
				{ type: "text", text: "d", marks: [{ type: "em" }] },
				{ type: "text", text: " " },
				{ type: "text", text: "e", marks: [{ type: "strike" }] },
				{ type: "text", text: " " },
				{ type: "text", text: "f", marks: [{ type: "code" }] },
				{ type: "text", text: " 2*3*4" },
			],
		});
	});
});
