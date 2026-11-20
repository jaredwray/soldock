import type { ChatBody } from "@asterra/contracts";
import { ChatBody as ChatBodySchema } from "@asterra/contracts";
import { inputRules, undoInputRule } from "prosemirror-inputrules";
import type { Node } from "prosemirror-model";
import { EditorState, Selection, TextSelection, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { describe, expect, it } from "vitest";
import {
	insertTypedEmoji,
	insertTypedGroupMention,
	insertTypedMention,
	markdownRules,
	newLine,
	textMentions,
	toggleCodeBlock,
	typedEmoji,
	typedMention,
} from "../src/features/chat/composerCommands.ts";
import {
	bodyToDoc,
	chatSchema,
	docToBody,
	plainTextSlice,
	sameInBox,
	textToBody,
} from "../src/features/chat/composerSchema.ts";
import { mentionDirectory } from "../src/features/chat/mentions.ts";

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

describe("the safety and the form of the body of the box", () => {
	// The box and the message must never hold a link that runs script. The server refuses it too, but
	// the box must not keep it, and a draft must not hold it.
	it("drops a link that is not http, https or mailto, keeps a safe link as written, and keeps a list number in range", () => {
		const unsafe = marks.link.create({ href: "javascript:alert(1)" });
		const safe = marks.link.create({ href: "https://Example.com/A" });
		const body = docToBody(
			doc(
				p(chatSchema.text("bad", [unsafe]), chatSchema.text(" good", [safe])),
				nodes.ordered_list.create({ order: 1_000_000 }, [nodes.list_item.create(null, p(t("item")))]),
			),
		) as ChatBody;
		expect(body.content[0]).toEqual({
			type: "paragraph",
			content: [
				{ type: "text", text: "bad" },
				{ type: "text", text: " good", marks: [{ type: "link", attrs: { href: "https://Example.com/A" } }] },
			],
		});
		expect(body.content[1]).toMatchObject({ type: "ordered_list", attrs: { order: 1 } });
		expect(ChatBodySchema.safeParse(body).success).toBe(true);
		// A body from storage with an unsafe link opens without the link.
		const opened = bodyToDoc({
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }],
				},
			],
		} as never);
		expect(opened.rangeHasMark(0, opened.content.size, marks.link)).toBe(false);
		expect(sameInBox(body, docToBody(bodyToDoc(body)) as ChatBody)).toBe(true);
	});

	it("pastes plain text as one line for each line, with the marks at the caret", () => {
		const slice = plainTextSlice("a\r\nb\n\nc", [marks.strong.create()]);
		expect([slice.openStart, slice.openEnd]).toEqual([1, 1]);
		const lines: string[] = [];
		slice.content.forEach((line) => {
			lines.push(line.textContent);
			line.forEach((text) => {
				expect(text.marks.map((mark) => mark.type)).toEqual([marks.strong]);
			});
		});
		expect(lines).toEqual(["a", "b", "", "c"]);
	});

	// An edit with no change must not send an edit. So a body opens and saves to the same body again.
	it("keeps the lines around a block with no text as one paragraph, so a body gives the same body again", () => {
		expect(docToBody(doc(p(t("a")), nodes.code_block.create(), p(t("b"))))).toEqual(textToBody("a\nb"));
		const agent: ChatBody = {
			type: "doc",
			content: [
				{ type: "paragraph", content: [{ type: "text", text: "a" }] },
				{ type: "code_block" },
				{ type: "paragraph", content: [{ type: "text", text: "b" }] },
			],
		};
		const once = docToBody(bodyToDoc(agent)) as ChatBody;
		expect(docToBody(bodyToDoc(once))).toEqual(once);
		expect(sameInBox(agent, once)).toBe(true);
	});
});

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
		// A mention keeps its text in the code block.
		const mentioned = doc(p(t("Hi "), nodes.mention.create({ id: "prn_01JD0000000000000000000ADA", label: "ada" })));
		const mentionState = EditorState.create({ doc: mentioned });
		const inCode = run(
			mentionState.apply(mentionState.tr.setSelection(TextSelection.create(mentioned, 1))),
			toggleCodeBlock,
		);
		expect(inCode.doc.child(0).textContent).toBe("Hi @ada");
		// A list is not lines of text: the button does nothing there.
		const list = stateAt(
			doc(nodes.bullet_list.create(null, [nodes.list_item.create(null, p(t("item")))]), p(t("x"))),
			0,
		);
		const listAll = list.apply(list.tr.setSelection(TextSelection.create(list.doc, 3, list.doc.content.size - 1)));
		expect(toggleCodeBlock(listAll)).toBe(false);
	});

	// Shift+Enter makes a new line. The person must be able to leave a code block and a quote with it.
	it("makes a new line or a new item, and leaves a code block, a quote or a list from an empty line", () => {
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

		// In a list, a new item. On the empty item, the line leaves the list.
		const list = stateAt(doc(nodes.bullet_list.create(null, [nodes.list_item.create(null, p(t("one")))])));
		const item = run(list, newLine);
		expect(item.doc.child(0).childCount).toBe(2);
		const after = run(item, newLine);
		expect(after.doc.child(0).childCount).toBe(1);
		expect(after.doc.child(1).type).toBe(nodes.paragraph);
		expect(after.selection.$head.parent).toBe(after.doc.child(1));
	});
});

const rulesPlugin = inputRules({ rules: [...markdownRules] });

/** A state of the box with the Markdown shortcuts, and the caret at the end, or at `at`. */
function typingState(box: Node, at?: number): EditorState {
	const state = EditorState.create({ doc: box, plugins: [rulesPlugin] });
	return state.apply(
		state.tr.setSelection(at === undefined ? Selection.atEnd(state.doc) : TextSelection.create(state.doc, at)),
	);
}

/** Types `text` one character at a time, through the plugin of the Markdown shortcuts, as a view does. */
function type(state: EditorState, text: string): EditorState {
	let current = state;
	const view = {
		get state() {
			return current;
		},
		composing: false,
		dispatch(tr: Transaction) {
			current = current.apply(tr);
		},
	} as unknown as EditorView;
	for (const char of text) {
		const { from, to } = current.selection;
		const handled = rulesPlugin.props.handleTextInput?.call(rulesPlugin, view, from, to, char, () => current.tr);
		if (!handled) current = current.apply(current.tr.insertText(char, from, to));
	}
	return current;
}

describe("the Markdown shortcuts of the box", () => {
	it("make bold, italic, strike and code at the closing mark, and keep a mark in a word as text", () => {
		const typed = type(typingState(doc(p())), "a **b** *c* _d_ ~~e~~ `f` 2*3*4");
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

	it("make a list, a numbered list, a quote and a code block at the start of a line", () => {
		expect(type(typingState(doc(p())), "- x").doc.child(0).type).toBe(nodes.bullet_list);
		const ordered = type(typingState(doc(p())), "3. x").doc.child(0);
		expect([ordered.type, ordered.attrs.order]).toEqual([nodes.ordered_list, 3]);
		expect(type(typingState(doc(p())), "> x").doc.child(0).type).toBe(nodes.blockquote);
		expect(type(typingState(doc(p())), "```").doc.child(0).type).toBe(nodes.code_block);
	});

	// A person who wants the characters must get them back. Code shows its characters as they are.
	it("give the text back with Backspace right after a shortcut, and do nothing in code", () => {
		const bold = type(typingState(doc(p())), "a **b**");
		let undone = bold;
		expect(undoInputRule(bold, (tr) => (undone = bold.apply(tr)))).toBe(true);
		expect(undone.doc.textContent).toBe("a **b**");
		expect(undone.doc.rangeHasMark(0, undone.doc.content.size, marks.strong)).toBe(false);
		const list = type(typingState(doc(p())), "- ");
		let lineBack = list;
		expect(undoInputRule(list, (tr) => (lineBack = list.apply(tr)))).toBe(true);
		expect([lineBack.doc.child(0).type, lineBack.doc.textContent]).toEqual([nodes.paragraph, "- "]);

		const inCodeMark = type(typingState(doc(p(t("*y", "code")))), "*");
		expect(inCodeMark.doc.textContent).toBe("*y*");
		expect(inCodeMark.doc.rangeHasMark(0, inCodeMark.doc.content.size, marks.em)).toBe(false);
		const inBlock = type(typingState(doc(nodes.code_block.create(null, chatSchema.text("a *b")))), "*");
		expect(inBlock.doc.textContent).toBe("a *b*");
	});
});

describe("an emoji code in the box", () => {
	it("puts the emoji in place of the typed code, with a space when no space or mark follows", () => {
		const end = insertTypedEmoji(stateAt(doc(p(t("ship :ta")))), "🎉") as Transaction;
		expect(end.doc.textContent).toBe("ship 🎉 ");
		expect(end.selection.from).toBe(end.doc.content.size - 1);
		// "ship :ta|, now": a comma follows, so no space goes in.
		const middle = insertTypedEmoji(stateAt(doc(p(t("ship :ta, now"))), 9), "🎉") as Transaction;
		expect(middle.doc.textContent).toBe("ship 🎉, now");
		expect(typedEmoji(stateAt(doc(p(t(":ta", "code")))))).toBeNull();
		expect(typedEmoji(stateAt(doc(nodes.code_block.create(null, chatSchema.text(":ta")))))).toBeNull();
	});

	it("turns a full code into its emoji when the person types the closing ':', and keeps other text", () => {
		expect(type(typingState(doc(p())), "done :tada: :+1:").doc.textContent).toBe("done 🎉 👍");
		expect(type(typingState(doc(p())), "a :no_such_emoji: at 10:30:").doc.textContent).toBe(
			"a :no_such_emoji: at 10:30:",
		);
		expect(type(typingState(doc(p(t("x", "code")))), ":tada:").doc.textContent).toBe("x:tada:");
	});
});

describe("a mention in the box", () => {
	const at = (box: Node, pos?: number) => stateAt(box, pos);

	// The list replaces only the typed mention, also in the middle of a line and on a later line. The
	// mention is a node with the id of the principal, so the server needs no handle to find it.
	it("replaces the typed text with a mention node, with a space and the caret after it", () => {
		const ADA = { id: "prn_01JD0000000000000000000ADA", handle: "ada" };
		const end = insertTypedMention(at(doc(p(t("hi @ad")))), ADA) as Transaction;
		expect(end.doc.textContent).toBe("hi @ada ");
		expect(end.doc.firstChild?.child(1).type).toBe(nodes.mention);
		expect(end.doc.firstChild?.child(1).attrs).toEqual({ id: ADA.id, label: "ada" });
		expect(end.selection.from).toBe(end.doc.content.size - 1);
		expect(docToBody(end.doc)?.content[0]).toEqual({
			type: "paragraph",
			content: [
				{ type: "text", text: "hi " },
				{ type: "mention", attrs: { id: ADA.id, label: "ada" } },
				{ type: "text", text: " " },
			],
		});

		// "hi @ad|, see": a comma ends the word, so no space goes in. The node is one position.
		const middle = insertTypedMention(at(doc(p(t("hi @ad, see"))), 7), ADA) as Transaction;
		expect(middle.doc.textContent).toBe("hi @ada, see");
		expect(middle.selection.from).toBe(1 + "hi ".length + 1);

		const second = insertTypedMention(at(doc(p(t("bold", "strong")), p(t("x @ca")))), {
			id: "prn_01JD000000000000000000CAPT",
			handle: "captain",
		}) as Transaction;
		expect(second.doc.child(0).textContent).toBe("bold");
		expect(second.doc.child(1).textContent).toBe("x @captain ");
		expect(second.selection.$from.parent).toBe(second.doc.child(1));

		// A group from the list is a node too, so the server reads it as a group and not as a handle.
		const group = insertTypedGroupMention(at(doc(p(t("all: @he")))), "here") as Transaction;
		expect(group.doc.textContent).toBe("all: @here ");
		expect(docToBody(group.doc)?.content[0]).toEqual({
			type: "paragraph",
			content: [
				{ type: "text", text: "all: " },
				{ type: "group_mention", attrs: { group: "here" } },
				{ type: "text", text: " " },
			],
		});
	});

	// An edit opens a message with its mention nodes. A save must keep them.
	it("opens a body with a mention node and a mention of a group, and gives the same body back", () => {
		const body: ChatBody = {
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [
						{ type: "mention", attrs: { id: "prn_01JD0000000000000000000ADA", label: "ada" } },
						{ type: "text", text: " thanks, " },
						{ type: "group_mention", attrs: { group: "channel" } },
					],
				},
			],
		};
		expect(docToBody(bodyToDoc(body))).toEqual(body);
	});

	// The room makes a mention of "@" and a handle in the text of a body. The box must show the same
	// mentions, so the person sees who gets the mention before the send.
	it("finds the mentions that the person typed as text, with the rules of the room", () => {
		const principal = (name: string) => ({
			id: `prn_${name}`,
			kind: "agent" as const,
			display_name: name,
			address: `${name}@example.com`,
			archived_at: null,
		});
		const directory = mentionDirectory([principal("dot"), principal("captain")]);
		const captain = nodes.mention.create({ id: "prn_captain", label: "captain" });
		const link = marks.link.create({ href: "https://example.com/" });
		const typed = (box: Node) => textMentions(box, directory).map(({ from, to }) => box.textBetween(from, to));

		// A typed handle and a typed group are mentions. A node from the list is a mention already.
		const box = doc(p(t("@dot and "), captain, t(" - say hi")), p(t("bold", "strong"), t("@dot, @Here.")));
		expect(textMentions(box, directory)[0]).toEqual({ from: 1, to: 5 });
		expect(typed(box)).toEqual(["@dot", "@dot", "@Here"]);

		// The room keeps these as text: code, a link, an address, a handle that the directory does not have,
		// and a mention that touches a mention node.
		expect(
			typed(
				doc(
					p(t("@dot", "code"), chatSchema.text("@dot", [link]), t(" dot@example.com @nobody @dot"), captain),
					nodes.code_block.create(null, chatSchema.text("@dot")),
				),
			),
		).toEqual([]);
	});

	it("has no mention in a code block, in code, or away from an @", () => {
		expect(typedMention(at(doc(nodes.code_block.create(null, chatSchema.text("@ad")))))).toBeNull();
		expect(typedMention(at(doc(p(t("@ad", "code")))))).toBeNull();
		expect(typedMention(at(doc(p(t("mail ada@example")))))).toBeNull();
		expect(typedMention(at(doc(p(t("@ad")))))).toMatchObject({ from: 1, to: 4, query: "ad" });
	});
});
