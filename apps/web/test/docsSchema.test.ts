import { DocContent } from "@soldock/contracts";
import type { Node } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import {
	blockDepth,
	contentToDoc,
	docHref,
	docToContent,
	plainTextSlice,
	schema,
} from "../src/features/docs/schema.ts";

const { nodes, marks } = schema;

const text = (value: string, ...names: string[]) =>
	schema.text(
		value,
		names.map((name) => schema.mark(name)),
	);
const p = (...content: Node[]) => nodes.paragraph.create(null, content);
const item = (...content: Node[]) => nodes.list_item.create(null, content);

/** A document with each node and each mark of the schema. */
function fullDoc(): Node {
	return nodes.doc.create(null, [
		nodes.heading.create({ level: 1 }, text("Title")),
		nodes.heading.create({ level: 2 }),
		p(
			text("plain "),
			text("bold", "strong"),
			text("italic", "em"),
			text("under", "underline"),
			text("gone", "strike"),
			text("x = 1", "code"),
			schema.text("all", [
				marks.link.create({ href: "https://example.com/a?b=c#d" }),
				marks.strong.create(),
				marks.em.create(),
				marks.underline.create(),
				marks.strike.create(),
				marks.code.create(),
			]),
			nodes.hard_break.create(),
			schema.text("mail", [marks.link.create({ href: "mailto:ada@example.com" })]),
		),
		p(),
		nodes.blockquote.create(null, [
			p(text("quote")),
			nodes.bullet_list.create(null, [
				item(p(text("one"))),
				item(p(text("two")), nodes.heading.create({ level: 3 }, text("in item"))),
			]),
		]),
		nodes.ordered_list.create({ order: 4 }, [
			item(p(text("four")), nodes.ordered_list.create(null, [item(p(text("nested")))])),
		]),
		nodes.code_block.create(null, schema.text("const a = 1;\nconst b = 2;")),
		nodes.code_block.create(),
		nodes.horizontal_rule.create(),
		p(text("end")),
	]);
}

describe("the Docs schema", () => {
	// docs.update refuses content outside DocContent, so each node and mark name must be the name of the contract.
	it("writes each node and each mark in the form that the contract accepts, and reads it back", () => {
		const doc = fullDoc();
		doc.check();
		const content = docToContent(doc);
		expect(DocContent.safeParse(content).error).toBeUndefined();
		// For a document that the editor made, the content is the JSON of ProseMirror, with no change.
		expect(content).toEqual(doc.toJSON());
		expect(contentToDoc(content).eq(doc)).toBe(true);
	});

	// docs.get can return each valid content, also forms that the editor does not make itself.
	it("reads valid content that the editor does not make itself", () => {
		const content: DocContent = {
			type: "doc",
			content: [
				{
					type: "bullet_list",
					content: [
						// A list item that starts with a heading, a list or a rule, as Markdown from an agent can give.
						{
							type: "list_item",
							content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "H" }] }],
						},
						{
							type: "list_item",
							content: [{ type: "bullet_list", content: [{ type: "list_item", content: [{ type: "paragraph" }] }] }],
						},
						{ type: "list_item", content: [{ type: "horizontal_rule" }] },
					],
				},
				// A numbered list without the order attribute starts at 1.
				{ type: "ordered_list", content: [{ type: "list_item", content: [{ type: "code_block" }] }] },
				{
					type: "paragraph",
					content: [
						{
							type: "text",
							text: "link",
							marks: [{ type: "code" }, { type: "link", attrs: { href: "HTTPS://Example.com" } }],
						},
					],
				},
			],
		};
		expect(DocContent.safeParse(content).success).toBe(true);
		const out = docToContent(contentToDoc(content));
		expect(DocContent.safeParse(out).error).toBeUndefined();
		expect(out.content[1]).toEqual({
			type: "ordered_list",
			attrs: { order: 1 },
			content: [{ type: "list_item", content: [{ type: "code_block" }] }],
		});
		// The address of a link from the server is not changed.
		expect(JSON.stringify(out)).toContain('"href":"HTTPS://Example.com"');
	});

	// A pasted ProseMirror slice can hold each attribute value. The save must still pass.
	it("makes each attribute safe before the save", () => {
		const doc = nodes.doc.create(null, [
			nodes.heading.create({ level: 6 }, text("deep")),
			nodes.heading.create({ level: "2" }, text("as text")),
			nodes.ordered_list.create({ order: 1e9 }, [item(p(text("a")))]),
			nodes.ordered_list.create({ order: "x" }, [item(p(text("b")))]),
			p(
				schema.text("bad", [marks.link.create({ href: "javascript:alert(1)" }), marks.strong.create()]),
				schema.text("empty", [marks.link.create({ href: "mailto:" })]),
				schema.text("long", [marks.link.create({ href: `https://example.com/${"a".repeat(2100)}` })]),
			),
		]);
		const content = docToContent(doc);
		expect(DocContent.safeParse(content).error).toBeUndefined();
		expect(content.content.slice(0, 4).map((block) => ("attrs" in block ? block.attrs : null))).toEqual([
			{ level: 3 },
			{ level: 2 },
			{ order: 1 },
			{ order: 1 },
		]);
		expect(content.content[4]).toEqual({
			type: "paragraph",
			content: [
				{ type: "text", text: "bad", marks: [{ type: "strong" }] },
				{ type: "text", text: "empty" },
				{ type: "text", text: "long" },
			],
		});
	});

	it("accepts only the links that a doc can hold", () => {
		expect(docHref("https://example.com")).toBe("https://example.com/");
		expect(docHref("http://example.com/a b")).toBe("http://example.com/a%20b");
		expect(docHref("mailto:ada@example.com")).toBe("mailto:ada@example.com");
		for (const href of [
			"javascript:alert(1)",
			"data:text/html,<script>alert(1)</script>",
			"ftp://example.com",
			"/relative",
			"example.com",
			"mailto:",
			"https://",
			`https://example.com/${"a".repeat(2100)}`,
		]) {
			expect(docHref(href), href).toBeNull();
			expect(
				DocContent.safeParse({
					type: "doc",
					content: [
						{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href } }] }] },
					],
				}).success,
				href,
			).toBe(false);
		}
	});

	// The depth limit of the editor counts blocks the same way for each document.
	it("counts the depth of the deepest block", () => {
		expect(blockDepth(nodes.doc.create(null, [p(text("a")), nodes.horizontal_rule.create()]))).toBe(1);
		expect(blockDepth(fullDoc())).toBe(5);
	});

	it("pastes plain text as one paragraph for each line, and as it is in a code block", () => {
		const slice = plainTextSlice("one\r\n\r\nthree", false, [marks.strong.create()]);
		expect(slice.openStart).toBe(1);
		expect(slice.content.toJSON()).toEqual([
			{ type: "paragraph", content: [{ type: "text", text: "one", marks: [{ type: "strong" }] }] },
			{ type: "paragraph" },
			{ type: "paragraph", content: [{ type: "text", text: "three", marks: [{ type: "strong" }] }] },
		]);
		const code = plainTextSlice("a\r\n  b", true);
		expect(code.content.toJSON()).toEqual([{ type: "text", text: "a\n  b" }]);
		expect(plainTextSlice("", true).size).toBe(0);
	});
});
