import { DocContent } from "@soldock/contracts";
import type { Node } from "prosemirror-model";
import { sinkListItem } from "prosemirror-schema-list";
import { type Command, EditorState, TextSelection } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import {
	blockTypeAt,
	depthLimit,
	docKeys,
	insertRule,
	removeLink,
	setHeading,
	setLink,
	setParagraph,
	toggleCodeBlock,
} from "../src/features/docs/commands.ts";
import { blockDepth, docToContent, schema } from "../src/features/docs/schema.ts";

const { nodes, marks } = schema;

function p(...content: (string | Node)[]): Node {
	return nodes.paragraph.create(
		null,
		content.map((part) => (typeof part === "string" ? schema.text(part) : part)),
	);
}

/** A state with the selection from `from` to `to`. In doc(p("Hello world")), "world" is 7 to 12. */
function state(content: Node[], from: number, to = from, plugins = [depthLimit()]): EditorState {
	const doc = nodes.doc.create(null, content);
	return EditorState.create({ doc, selection: TextSelection.create(doc, from, to), plugins });
}

function run(current: EditorState, command: Command): EditorState {
	let next = current;
	const done = command(current, (tr) => {
		next = current.apply(tr);
	});
	expect(done).toBe(true);
	return next;
}

/** The blocks of the document, as the server gets them. Each result must be valid content. */
function blocks(current: EditorState) {
	const content = docToContent(current.doc);
	expect(DocContent.safeParse(content).error).toBeUndefined();
	return content.content;
}

const keys = docKeys(() => true);

describe("Docs commands", () => {
	it("changes the type of the text blocks of the selection, and reports the type", () => {
		const start = state([p("Title"), p("Text")], 2);
		expect(blockTypeAt(start)).toBe("paragraph");
		const heading = run(start, setHeading(2));
		expect(blockTypeAt(heading)).toBe("heading-2");
		expect(blocks(heading)[0]).toEqual({
			type: "heading",
			attrs: { level: 2 },
			content: [{ type: "text", text: "Title" }],
		});
		// A selection over a heading and a paragraph has no single type.
		const both = heading.apply(heading.tr.setSelection(TextSelection.create(heading.doc, 2, 10)));
		expect(blockTypeAt(both)).toBeNull();
		expect(blocks(run(both, setParagraph)).map((block) => block.type)).toEqual(["paragraph", "paragraph"]);
	});

	// A code block holds text only. The marks go, and a line break becomes a line feed and back.
	it("makes a paragraph a code block without marks and breaks, and back", () => {
		const start = state([p(schema.text("let a", [marks.strong.create()]), nodes.hard_break.create(), "let b")], 2);
		const code = run(start, toggleCodeBlock);
		expect(blockTypeAt(code)).toBe("code_block");
		expect(blocks(code)).toEqual([{ type: "code_block", content: [{ type: "text", text: "let a\nlet b" }] }]);
		expect(blocks(run(code, toggleCodeBlock))).toEqual([
			{
				type: "paragraph",
				content: [{ type: "text", text: "let a" }, { type: "hard_break" }, { type: "text", text: "let b" }],
			},
		]);
		// Shift+Enter in a code block: a line feed, because a code block cannot hold a break.
		const fed = run(code, keys["Shift-Enter"] as Command);
		expect(blocks(fed)[0]).toEqual({ type: "code_block", content: [{ type: "text", text: "l\net a\nlet b" }] });
	});

	// After the rule, the cursor must be in a text block, or the person cannot continue to type.
	it("puts a rule at the cursor and keeps the cursor in a text block below it", () => {
		const cases: [number, string[], string][] = [
			// In the text: the text after the cursor goes below the rule.
			[4, ["paragraph:abc", "horizontal_rule", "paragraph:def"], "def"],
			// At the end: a new paragraph comes below the rule.
			[7, ["paragraph:abcdef", "horizontal_rule", "paragraph:"], ""],
			// At the start: the rule goes above the text.
			[1, ["horizontal_rule", "paragraph:abcdef"], "abcdef"],
		];
		for (const [cursor, expected, cursorBlock] of cases) {
			const next = run(state([p("abcdef")], cursor), insertRule);
			const shape = blocks(next).map((block) =>
				block.type === "paragraph"
					? `paragraph:${(block.content ?? []).map((part) => ("text" in part ? part.text : "")).join("")}`
					: block.type,
			);
			expect(shape, `cursor ${cursor}`).toEqual(expected);
			expect(next.selection.$from.parent.textContent, `cursor ${cursor}`).toBe(cursorBlock);
			expect(next.selection.$from.parentOffset).toBe(0);
		}
	});

	// The server refuses a doc that is too deep. Then no later save can pass, so the editor stops the change.
	it("refuses a change that makes the blocks deeper than the limit", () => {
		const list = (depth: number): Node =>
			nodes.bullet_list.create(null, [
				nodes.list_item.create(null, depth > 1 ? [p("x"), list(depth - 1)] : [p("x")]),
				...(depth === 1 ? [nodes.list_item.create(null, [p("y")])] : []),
			]);
		// Two levels of lists: the paragraphs of the second level have depth 5.
		const start = EditorState.create({ doc: nodes.doc.create(null, [list(2)]), plugins: [depthLimit(5)] });
		expect(blockDepth(start.doc)).toBe(5);
		let last = 0;
		start.doc.descendants((node, pos) => {
			if (node.isText && node.text === "y") last = pos;
		});
		const atLast = start.apply(start.tr.setSelection(TextSelection.create(start.doc, last)));
		// One more list level for the last item makes depth 7. The limit of 5 refuses it.
		expect(run(atLast, sinkListItem(nodes.list_item)).doc.eq(atLast.doc)).toBe(true);
		// Text and marks change nothing in the structure, so they pass.
		expect(atLast.apply(atLast.tr.insertText("z")).doc.textContent).toBe("xxzy");
		// The same change passes when the limit has room for it.
		const roomy = EditorState.create({ doc: atLast.doc, selection: atLast.selection, plugins: [depthLimit(7)] });
		expect(blockDepth(run(roomy, sinkListItem(nodes.list_item)).doc)).toBe(7);
	});

	// Tab must leave the editor when it has no list level to change, or the keyboard cannot go on.
	it("uses Tab for the list level in a list only", () => {
		const tab = keys.Tab as Command;
		expect(tab(state([p("text")], 2))).toBe(false);
		const items = [nodes.list_item.create(null, [p("one")]), nodes.list_item.create(null, [p("two")])];
		const inList = state([nodes.bullet_list.create(null, items)], 10);
		const sunk = run(inList, tab);
		expect(blocks(sunk)).toEqual([
			{
				type: "bullet_list",
				content: [
					{
						type: "list_item",
						content: [
							{ type: "paragraph", content: [{ type: "text", text: "one" }] },
							{
								type: "bullet_list",
								content: [
									{ type: "list_item", content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }] },
								],
							},
						],
					},
				],
			},
		]);
		expect(run(sunk, keys["Shift-Tab"] as Command).doc.eq(inList.doc)).toBe(true);
		// The first item cannot go deeper. The key still stays in the editor.
		expect(tab(state([nodes.bullet_list.create(null, items)], 3))).toBe(true);
	});

	it("sets a safe link on the selection, refuses each other address, and removes the link", () => {
		const start = state([p("Hello world")], 7, 12);
		expect(setLink("javascript:alert(1)", "")(start)).toBe(false);
		const linked = run(start, setLink("https://example.com/", ""));
		expect(blocks(linked)).toEqual([
			{
				type: "paragraph",
				content: [
					{ type: "text", text: "Hello " },
					{ type: "text", text: "world", marks: [{ type: "link", attrs: { href: "https://example.com/" } }] },
				],
			},
		]);
		expect(blocks(run(linked, removeLink))).toEqual([
			{ type: "paragraph", content: [{ type: "text", text: "Hello world" }] },
		]);
		// A code block holds no marks, so it takes no link.
		const code = state([nodes.code_block.create(null, schema.text("code"))], 1, 5);
		expect(setLink("https://example.com/", "")(code)).toBe(false);
	});

	// Without this key, a person cannot put the cursor below a code block at the end of the doc.
	it("makes a paragraph below a code block at the end of the doc with the down arrow", () => {
		const down = keys.ArrowDown as Command;
		const end = state([p("a"), nodes.code_block.create(null, schema.text("code"))], 8);
		expect(blocks(run(end, down)).map((block) => block.type)).toEqual(["paragraph", "code_block", "paragraph"]);
		// In the code, and in a code block that is not the last block, the arrow moves the cursor as usual.
		expect(down(state([p("a"), nodes.code_block.create(null, schema.text("code"))], 6))).toBe(false);
		expect(down(state([nodes.code_block.create(null, schema.text("code")), p("a")], 5))).toBe(false);
	});
});
