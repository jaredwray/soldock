import { DOC_LIMITS, DocContent } from "@soldock/contracts";
import { describe, expect, it } from "vitest";
import { checkDoc, docText } from "../src/docs/content.ts";
import { docToMarkdown, markdownToDoc } from "../src/docs/markdown.ts";

type Inline = NonNullable<Extract<DocContent["content"][number], { type: "paragraph" }>["content"]>;

const text = (value: string, ...marks: string[]): Inline[number] =>
	marks.length === 0
		? { type: "text", text: value }
		: {
				type: "text",
				text: value,
				marks: marks.map((mark) =>
					mark.startsWith("http") || mark.startsWith("mailto")
						? { type: "link" as const, attrs: { href: mark } }
						: ({ type: mark } as { type: "strong" }),
				),
			};
const p = (...content: Inline): DocContent["content"][number] =>
	content.length > 0 ? { type: "paragraph", content } : { type: "paragraph" };
const doc = (...content: DocContent["content"]): DocContent => ({ type: "doc", content });

/** A doc with each block and each mark that Markdown can hold. */
const FULL = doc(
	{ type: "heading", attrs: { level: 1 }, content: [text("Plan for "), text("Q3", "em")] },
	p(
		text("Plain, "),
		text("bold", "strong"),
		text(", "),
		text("italic", "em"),
		text(", "),
		text("both", "strong", "em"),
		text(", "),
		text("gone", "strike"),
		text(", "),
		text("x = a * b", "code"),
		text(" and a "),
		text("link", "https://example.com/a_(b)?q=1&r=2"),
		text("."),
	),
	p(text("First line"), { type: "hard_break" }, text("second line")),
	{
		type: "bullet_list",
		content: [
			{ type: "list_item", content: [p(text("one"))] },
			{
				type: "list_item",
				content: [
					p(text("two")),
					{
						type: "ordered_list",
						attrs: { order: 3 },
						content: [
							{ type: "list_item", content: [p(text("three"))] },
							{ type: "list_item", content: [p(text("four")), p(text("with a second paragraph"))] },
						],
					},
				],
			},
		],
	},
	{ type: "bullet_list", content: [{ type: "list_item", content: [p(text("a second list"))] }] },
	{
		type: "blockquote",
		content: [p(text("A quote")), { type: "blockquote", content: [p(text("in a quote"))] }],
	},
	{ type: "code_block", content: [{ type: "text", text: "const a = `x`;\n\n```\n  indented" }] },
	{ type: "horizontal_rule" },
	{ type: "heading", attrs: { level: 3 }, content: [text("The end")] },
);

describe("docToMarkdown and markdownToDoc", () => {
	it("give back the same doc for each block and mark that Markdown has", () => {
		const markdown = docToMarkdown(FULL);
		expect(markdownToDoc(markdown)).toEqual(FULL);
		expect(DocContent.safeParse(markdownToDoc(markdown)).success).toBe(true);
	});

	it("write the Markdown that people and agents know", () => {
		expect(
			docToMarkdown(
				doc(
					{ type: "heading", attrs: { level: 2 }, content: [text("Title")] },
					p(text("Some "), text("bold", "strong"), text(" text.")),
					{
						type: "bullet_list",
						content: [
							{ type: "list_item", content: [p(text("one"))] },
							{ type: "list_item", content: [p(text("two"))] },
						],
					},
					{ type: "ordered_list", attrs: { order: 1 }, content: [{ type: "list_item", content: [p(text("first"))] }] },
					{ type: "blockquote", content: [p(text("quote"))] },
					{ type: "code_block", content: [{ type: "text", text: "code" }] },
				),
			),
		).toBe("## Title\n\nSome **bold** text.\n\n- one\n- two\n\n1. first\n\n> quote\n\n```\ncode\n```\n");
	});

	// Text that looks like Markdown must stay text, or a doc changes when an agent reads and writes it.
	it("keep text that looks like Markdown as text", () => {
		const tricky = [
			"# not a heading",
			"> not a quote",
			"- not a list",
			"1. not a list",
			"2) not a list",
			"--- not a rule",
			"---",
			"*not em* and **not strong** and ~~not strike~~",
			"a_b_c and __init__ and snake_case_name",
			"`not code` and [not a link](https://example.com)",
			"<https://example.com> and <b>not html</b>",
			"back\\slash and a trailing backslash\\",
			"5 * 3 * 2 = 30",
			"```",
		];
		for (const line of tricky) {
			const source = doc(p(text(line)), p(text("after")));
			expect(markdownToDoc(docToMarkdown(source)), line).toEqual(source);
		}
		const inList = doc({ type: "bullet_list", content: [{ type: "list_item", content: [p(text("- nested look"))] }] });
		expect(markdownToDoc(docToMarkdown(inList))).toEqual(inList);
	});

	it("keep the marks of texts that touch, and move spaces out of the marks", () => {
		const cases: Inline[] = [
			[text("a", "strong"), text("b", "em")],
			[text("a", "em"), text("b", "strong")],
			[text("a", "strong"), text("b", "strong", "em"), text("c")],
			[text("a"), text("b", "em"), text("c")],
			[text("see the "), text("docs", "https://example.com/", "strong"), text(" now")],
			[text("x", "strong", "code"), text(" y")],
			[text("a ``b` c", "code")],
		];
		for (const content of cases) {
			const source = doc(p(...content));
			expect(markdownToDoc(docToMarkdown(source)), docToMarkdown(source)).toEqual(source);
		}
		// Markdown cannot open emphasis before a space, so the space goes out of the mark.
		expect(docToMarkdown(doc(p(text("bold ", "strong"), text("next"))))).toBe("**bold** next\n");
	});

	it("read the usual Markdown of other tools", () => {
		expect(
			markdownToDoc("Title here\n\n* item\n* item 2\n\n1) one\n\n__bold__ and _em_\n\n~~~js\nlet a;\n~~~\n\n***\n"),
		).toEqual(
			doc(
				p(text("Title here")),
				{
					type: "bullet_list",
					content: [
						{ type: "list_item", content: [p(text("item"))] },
						{ type: "list_item", content: [p(text("item 2"))] },
					],
				},
				{ type: "ordered_list", attrs: { order: 1 }, content: [{ type: "list_item", content: [p(text("one"))] }] },
				p(text("bold", "strong"), text(" and "), text("em", "em")),
				{ type: "code_block", content: [{ type: "text", text: "let a;" }] },
				{ type: "horizontal_rule" },
			),
		);
		// Lines of one paragraph join with a space. Two spaces at the end of a line make a hard break.
		expect(markdownToDoc("one\ntwo  \nthree")).toEqual(doc(p(text("one two"), { type: "hard_break" }, text("three"))));
		expect(markdownToDoc("#### Deep heading ##")).toEqual(
			doc({ type: "heading", attrs: { level: 3 }, content: [text("Deep heading")] }),
		);
		expect(markdownToDoc("")).toEqual(doc(p()));
	});

	// A link is the one place where Markdown brings a URL into a doc.
	it("drop the target of a link that is not http, https or mailto, and keep its text", () => {
		const read = markdownToDoc(
			"[run](javascript:alert(1)) [data](data:text/html,x) [ok](mailto:ada@example.com) <javascript:alert(1)>",
		);
		expect(DocContent.safeParse(read).success).toBe(true);
		expect(JSON.stringify(read)).not.toMatch(/javascript:[^)]*"\s*}\s*}/);
		const hrefs = JSON.stringify(read).match(/"href":"[^"]*"/g);
		expect(hrefs).toEqual(['"href":"mailto:ada@example.com"']);
		expect(docText(read)).toContain("run");
	});

	it("lose only what Markdown does not have: underline and empty paragraphs", () => {
		const source = doc(p(text("under", "underline"), text(" line")), p(), p(text("next")));
		expect(markdownToDoc(docToMarkdown(source))).toEqual(doc(p(text("under line")), p(text("next"))));
	});

	// Deep input from a client must not make a doc that the editor cannot hold, or use up the stack.
	it("stop blocks in blocks at the limit, and stay fast for hostile input", () => {
		const deep = markdownToDoc(`${"> ".repeat(200)}deep`);
		expect(checkDoc(deep)).toBeNull();
		expect(docText(deep)).toContain("deep");
		const nested = markdownToDoc(Array.from({ length: 60 }, (_, level) => `${"  ".repeat(level)}- item`).join("\n"));
		expect(checkDoc(nested)).toBeNull();
	});

	// One request can hold 1 MB of Markdown, and a doc can hold a text of 100,000 characters. Work that
	// grows with the square of the length takes minutes at these sizes, and a request has a CPU limit.
	// Each input here is the slow case of one step. With linear work, all of them take a few
	// milliseconds, so the time limit has a wide margin.
	it("do work in proportion to the length of hostile input", () => {
		const n = 200_000;
		const runs = Array.from({ length: 600 }, (_, length) => `${"`".repeat(length + 1)}a`).join("");
		const hostile = [
			`${"[".repeat(n / 2)}${"]".repeat(n / 2)}`,
			`${"[a".repeat(n / 4)}${"](b".repeat(n / 4)}`,
			`# x${" ".repeat(n)}x`,
			`a${" ".repeat(n)}x\nb`,
			`a${"\\".repeat(n)}x\nb`,
			runs,
			"*a ".repeat(n / 4),
			`${"*a ".repeat(20_000)}${"a* ".repeat(20_000)}`,
			`${"**a ".repeat(20_000)}${"a** ".repeat(20_000)}`,
			`${"*".repeat(n / 2)}a${"*".repeat(n / 2)}`,
			`${"~".repeat(n / 2)}a${"~".repeat(n / 2)}`,
		];
		const start = Date.now();
		for (const markdown of hostile) {
			const read = markdownToDoc(markdown);
			docToMarkdown(read);
			docText(read);
		}
		// The slow cases of the writer and of the search text.
		docToMarkdown(doc(p(text(`x${" ".repeat(DOC_LIMITS.textChars - 2)}x`))));
		docText({ type: "doc", content: Array.from({ length: 40_000 }, () => p(text("x"))) });
		expect(Date.now() - start).toBeLessThan(3000);
	});

	// Marks in marks stop at a limit, so the text of a hostile doc cannot use up the call stack.
	it("keep emphasis marks over the limit as text", () => {
		const read = markdownToDoc(`${"*a ".repeat(100)}b${" a*".repeat(100)}`);
		expect(DocContent.safeParse(read).success).toBe(true);
		expect(docText(read)).toContain("*a *a");
		// One run of thousands of marks is text. Marks of two texts that touch still pair.
		expect(docText(markdownToDoc(`${"*".repeat(5000)}a${"*".repeat(5000)}`))).toBe(
			`${"*".repeat(5000)}a${"*".repeat(5000)}`,
		);
	});
});

describe("checkDoc", () => {
	it("refuses blocks in blocks over the limit", () => {
		let block: DocContent["content"][number] = p(text("deep"));
		for (let level = 0; level < DOC_LIMITS.depth; level++) block = { type: "blockquote", content: [block] };
		expect(checkDoc(doc(block))).toMatch(/at most/);
		expect(checkDoc(FULL)).toBeNull();
	});
});

describe("docText", () => {
	it("gives the text of each block for the search index", () => {
		expect(docText(FULL).split("\n")).toEqual(
			expect.arrayContaining(["Plan for Q3", "one", "three", "in a quote", "The end"]),
		);
	});
});
