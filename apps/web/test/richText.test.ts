import type { Address, Message } from "@soldock/contracts";
import type { Mark, Node } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { replyDraft } from "../src/features/mail/compose.ts";
import {
	docToHtml,
	docToText,
	MAX_QUOTE_DEPTH,
	normalizeLink,
	plainTextSlice,
	safeHref,
	schema,
	textToDoc,
} from "../src/features/mail/richText.ts";

const { nodes, marks } = schema;

function text(value: string, ...textMarks: Mark[]): Node {
	return schema.text(value, textMarks);
}

function p(...content: (string | Node)[]): Node {
	return nodes.paragraph.create(
		null,
		content.map((item) => (typeof item === "string" ? text(item) : item)),
	);
}

function doc(...blocks: Node[]): Node {
	return nodes.doc.create(null, blocks);
}

function li(...blocks: Node[]): Node {
	return nodes.list_item.create(null, blocks);
}

const bold = marks.strong.create();
const italic = marks.em.create();
const link = (href: string) => marks.link.create({ href });

describe("docToHtml", () => {
	it("nests the formatting tags and keeps one link over text with different formatting", () => {
		const html = docToHtml(
			doc(
				p(
					"Hi ",
					text("bold ", bold),
					text("both", bold, italic),
					" ",
					text("go ", link("https://example.com/")),
					text("here", link("https://example.com/"), bold),
				),
			),
		);
		expect(html).toBe('<div>Hi <b>bold <i>both</i></b> <a href="https://example.com/">go <b>here</b></a></div>');
	});

	it("escapes the text, so typed markup stays text in the mail", () => {
		expect(docToHtml(doc(p('<img src=x onerror="alert(1)"> & more')))).toBe(
			"<div>&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; more</div>",
		);
	});

	it("never writes an unsafe link or an attribute value that is not a list number", () => {
		expect(docToHtml(doc(p(text("click", link("javascript:alert(1)")))))).toBe("<div>click</div>");
		// A pasted ProseMirror slice can carry any attribute value.
		const hostile = nodes.ordered_list.create({ order: '2"><script>alert(1)</script>' }, [li(p("x"))]);
		expect(docToHtml(doc(hostile))).toBe('<ol start="2"><li><div>x</div></li></ol>');
		const notNumber = nodes.ordered_list.create({ order: { start: 3 } }, [li(p("y"))]);
		expect(docToHtml(doc(notNumber))).toBe("<ol><li><div>y</div></li></ol>");
	});

	it("keeps empty lines, line breaks and runs of spaces as the person typed them", () => {
		const html = docToHtml(
			doc(p("  two  spaces"), p(), p("end", nodes.hard_break.create()), p(text("a "), text(" b", bold))),
		);
		expect(html).toBe(
			"<div>&nbsp;&nbsp;two &nbsp;spaces</div><div><br></div><div>end<br><br></div><div>a <b>&nbsp;b</b></div>",
		);
	});

	it("writes lists, the start of a numbered list, and a quote with a left border", () => {
		const html = docToHtml(
			doc(
				nodes.bullet_list.create(null, [li(p("one"), nodes.bullet_list.create(null, [li(p("inner"))]))]),
				nodes.ordered_list.create({ order: 3 }, [li(p("three"))]),
				nodes.blockquote.create(null, [p("quoted")]),
			),
		);
		expect(html).toBe(
			'<ul><li><div>one</div><ul><li><div>inner</div></li></ul></li></ul><ol start="3"><li><div>three</div></li></ol><blockquote style="margin:0 0 0 0.8ex;border-left:1px solid #ccc;padding-left:1ex"><div>quoted</div></blockquote>',
		);
	});
});

describe("docToText", () => {
	it("writes lists with markers, quotes with > and links with their address", () => {
		const value = docToText(
			doc(
				p("Plan:"),
				nodes.bullet_list.create(null, [
					li(p("first"), nodes.ordered_list.create({ order: 4 }, [li(p("four")), li(p("five"))])),
				]),
				nodes.blockquote.create(null, [p("said"), p()]),
				p(
					text("docs", link("https://example.com/docs")),
					" and ",
					text("https://example.com/", link("https://example.com/")),
				),
				p(text("ada@example.com", link("mailto:ada@example.com")), nodes.hard_break.create(), "next"),
			),
		);
		expect(value).toBe(
			[
				"Plan:",
				"- first",
				"  4. four",
				"  5. five",
				"> said",
				"> ",
				"docs <https://example.com/docs> and https://example.com/",
				"ada@example.com",
				"next",
			].join("\n"),
		);
	});
});

function address(value: string, name: string | null = null): Address {
	return { name, address: value };
}

describe("textToDoc", () => {
	it("turns the quote of a reply into a quote block, and gives back the same text", () => {
		const original: Message = {
			id: "msg_1",
			thread_id: "thr_1",
			message_id_header: "<1@example.com>",
			from: address("ada@example.com", "Ada"),
			to: [address("me@soldock.test")],
			cc: [],
			bcc: [],
			reply_to: [],
			subject: "Plans",
			date: "2026-11-02T10:00:00.000Z",
			received_at: "2026-11-02T10:00:01.000Z",
			label_ids: ["INBOX"],
			snippet: "Hello",
			origin: "internal",
			untrusted: false,
			authentication: null,
			body: {
				text: "Hello\n\n> an older quote\n>>no space, so not a quote marker\nBye",
				html: null,
				remote_images_blocked: 0,
				truncated: false,
				omitted: false,
			},
			attachments: [],
			delivery: null,
			sent_by: null,
		};
		const draft = replyDraft(original, "me@soldock.test", false);
		const result = textToDoc(draft.text);
		expect(result.childCount).toBe(4);
		const quote = result.child(3);
		expect(quote.type).toBe(nodes.blockquote);
		// The older quote in the original message is a quote in the quote.
		expect(quote.child(2).type).toBe(nodes.blockquote);
		// Only "> " starts a quote. A line that starts with ">" and no space stays text.
		expect(quote.child(3).type).toBe(nodes.paragraph);
		expect(quote.child(3).textContent).toBe(">>no space, so not a quote marker");
		expect(docToText(result)).toBe(draft.text);
	});

	it("stops nesting quotes at the limit, so a hostile message cannot overflow the stack", () => {
		const result = textToDoc(`${"> ".repeat(100_000)}deep\r\nnext`);
		let depth = 0;
		let node = result.child(0);
		while (node.type === nodes.blockquote) {
			depth += 1;
			node = node.child(0);
		}
		expect(depth).toBe(MAX_QUOTE_DEPTH);
		expect(node.textContent).toBe(`${"> ".repeat(100_000 - MAX_QUOTE_DEPTH)}deep`);
		expect(result.child(1).textContent).toBe("next");
	});
});

describe("plainTextSlice", () => {
	it("makes one paragraph for each pasted line and keeps the empty lines", () => {
		const slice = plainTextSlice("one\r\n\ntwo", [bold]);
		expect(slice.openStart).toBe(1);
		expect(slice.openEnd).toBe(1);
		expect(slice.content.childCount).toBe(3);
		expect(slice.content.child(1).childCount).toBe(0);
		expect(slice.content.child(2).firstChild?.marks).toEqual([bold]);
	});
});

describe("links", () => {
	it.each([
		["example.com/path", "https://example.com/path"],
		["ada@example.com", "mailto:ada@example.com"],
		["mailto:ada@example.com", "mailto:ada@example.com"],
		["http://example.com", "http://example.com/"],
		["  https://example.com/a?b=c  ", "https://example.com/a?b=c"],
		["javascript:alert(1)", null],
		["JavaScript:alert(1)", null],
		["data:text/html,<script>alert(1)</script>", null],
		["java\tscript:alert(1)", null],
		["ftp://example.com", null],
		["https://", null],
		["", null],
	])("normalizes %j to %j", (input, expected) => {
		expect(normalizeLink(input)).toBe(expected);
	});

	it("accepts only absolute http, https and mailto addresses from pasted HTML", () => {
		expect(safeHref("https://example.com")).toBe("https://example.com/");
		expect(safeHref("/relative")).toBeNull();
		expect(safeHref("vbscript:msgbox(1)")).toBeNull();
		expect(safeHref("file:///etc/passwd")).toBeNull();
	});
});
