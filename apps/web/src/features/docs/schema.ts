import { DOC_LIMITS, type DocBlock, type DocContent, type DocInline, type DocMark } from "@soldock/contracts";
import { Fragment, type Mark, type Node, Schema, Slice } from "prosemirror-model";
import { safeHref } from "../mail/richText.ts";

// The document model of the Docs editor. Its JSON form is `DocContent` of the contracts: the same
// node names, mark names and attributes. The schema is an allowlist: pasted HTML goes through the
// parse rules below, so only these nodes and marks can come into the editor. This module needs no
// DOM, so the Node tests can run it.

/** The same pattern as the link of `DocContent`: an absolute http, https or mailto link. */
const HREF = /^(?:https?:\/\/[^\s/?#]|mailto:[^\s])[^\s]*$/i;

/** True when the server accepts the address as the link of a doc. */
export function isDocHref(href: unknown): href is string {
	return typeof href === "string" && href.length <= DOC_LIMITS.hrefChars && HREF.test(href);
}

/** The link for an address from a paste or from the link dialog, or null when a doc cannot hold it. */
export function docHref(href: string): string | null {
	const safe = safeHref(href);
	return safe !== null && isDocHref(safe) ? safe : null;
}

export const HEADING_LEVELS = [1, 2, 3] as const;
export type HeadingLevel = (typeof HEADING_LEVELS)[number];

/**
 * The level of a heading. The attribute has no schema validation, because a pasted ProseMirror
 * slice can hold any value, and a failed validation stops the paste. Each reader of the attribute
 * uses this function, so only 1, 2 or 3 reaches the page and the server.
 */
export function headingLevel(value: unknown): HeadingLevel {
	const level = typeof value === "string" ? Number.parseInt(value, 10) : value;
	if (level === 1 || level === 2) return level;
	return 3;
}

/** The first number of a numbered list, for the same reason as `headingLevel`. */
export function listOrder(value: unknown): number {
	const order = typeof value === "string" ? Number.parseInt(value, 10) : value;
	return typeof order === "number" && Number.isSafeInteger(order) && order >= 0 && order <= 99_999 ? order : 1;
}

/** True when a CSS text-decoration value has the line. */
function decorationHas(line: string) {
	return (value: string) => value.split(/\s+/).includes(line) && null;
}

export const schema = new Schema({
	nodes: {
		doc: { content: "block+" },
		paragraph: {
			content: "inline*",
			group: "block",
			parseDOM: [{ tag: "p" }],
			toDOM: () => ["p", 0],
		},
		heading: {
			content: "inline*",
			group: "block",
			defining: true,
			attrs: { level: { default: 1 } },
			parseDOM: [
				{ tag: "h1", attrs: { level: 1 } },
				{ tag: "h2", attrs: { level: 2 } },
				{ tag: "h3", attrs: { level: 3 } },
				// A doc has three levels. A deeper heading becomes level 3.
				{ tag: "h4", attrs: { level: 3 } },
				{ tag: "h5", attrs: { level: 3 } },
				{ tag: "h6", attrs: { level: 3 } },
			],
			toDOM: (node) => [`h${headingLevel(node.attrs.level)}`, 0],
		},
		blockquote: {
			content: "block+",
			group: "block",
			defining: true,
			parseDOM: [{ tag: "blockquote" }],
			toDOM: () => ["blockquote", 0],
		},
		bullet_list: {
			content: "list_item+",
			group: "block",
			parseDOM: [{ tag: "ul" }],
			toDOM: () => ["ul", 0],
		},
		ordered_list: {
			content: "list_item+",
			group: "block",
			attrs: { order: { default: 1 } },
			parseDOM: [{ tag: "ol", getAttrs: (dom) => ({ order: listOrder(dom.getAttribute("start")) }) }],
			toDOM: (node) => {
				const order = listOrder(node.attrs.order);
				return order === 1 ? ["ol", 0] : ["ol", { start: String(order) }, 0];
			},
		},
		// `DocContent` lets each block be the first block of a list item, so the schema does the same.
		list_item: {
			content: "block+",
			defining: true,
			parseDOM: [{ tag: "li" }],
			toDOM: () => ["li", 0],
		},
		code_block: {
			content: "text*",
			marks: "",
			group: "block",
			code: true,
			defining: true,
			parseDOM: [{ tag: "pre", preserveWhitespace: "full" }],
			toDOM: () => ["pre", ["code", 0]],
		},
		horizontal_rule: {
			group: "block",
			parseDOM: [{ tag: "hr" }],
			toDOM: () => ["hr"],
		},
		text: { group: "inline" },
		hard_break: {
			inline: true,
			group: "inline",
			selectable: false,
			// A change of the block type to code makes each break a line feed, and back.
			linebreakReplacement: true,
			leafText: () => "\n",
			parseDOM: [{ tag: "br" }],
			toDOM: () => ["br"],
		},
	},
	// The order is the nesting order in the page: a link holds the other marks.
	marks: {
		link: {
			attrs: { href: { validate: "string" } },
			inclusive: false,
			parseDOM: [
				{
					tag: "a[href]",
					getAttrs: (dom) => {
						const href = docHref(dom.getAttribute("href") ?? "");
						return href === null ? false : { href };
					},
				},
			],
			// A link that is not safe gets no address. The parse rules and the link dialog never make one.
			toDOM: (mark) =>
				isDocHref(mark.attrs.href)
					? [
							"a",
							{
								href: mark.attrs.href,
								title: mark.attrs.href,
								target: "_blank",
								rel: "noopener noreferrer nofollow",
							},
							0,
						]
					: ["a", 0],
		},
		strong: {
			parseDOM: [
				{ tag: "strong" },
				// Google Docs wraps a whole copy in <b style="font-weight:normal">.
				{ tag: "b", getAttrs: (dom) => dom.style.fontWeight !== "normal" && null },
				{ style: "font-weight=400", clearMark: (mark) => mark.type.name === "strong" },
				{ style: "font-weight", getAttrs: (value) => /^(?:bold(?:er)?|[5-9]\d{2})$/.test(value) && null },
			],
			toDOM: () => ["strong", 0],
		},
		em: {
			parseDOM: [
				{ tag: "i" },
				{ tag: "em" },
				{ style: "font-style=italic" },
				{ style: "font-style=normal", clearMark: (mark) => mark.type.name === "em" },
			],
			toDOM: () => ["em", 0],
		},
		underline: {
			parseDOM: [
				{ tag: "u" },
				{ style: "text-decoration", getAttrs: decorationHas("underline") },
				{ style: "text-decoration-line", getAttrs: decorationHas("underline") },
			],
			toDOM: () => ["u", 0],
		},
		strike: {
			parseDOM: [
				{ tag: "s" },
				{ tag: "strike" },
				{ tag: "del" },
				{ style: "text-decoration", getAttrs: decorationHas("line-through") },
				{ style: "text-decoration-line", getAttrs: decorationHas("line-through") },
			],
			toDOM: () => ["s", 0],
		},
		code: {
			parseDOM: [{ tag: "code" }],
			toDOM: () => ["code", 0],
		},
	},
});

const { nodes, marks } = schema;

/**
 * The deepest block of a doc that the editor makes. `DOC_LIMITS.depth` is the limit of the server.
 * The editor stops two levels before it, so no way to count the levels makes a save fail.
 */
export const EDITOR_MAX_DEPTH = DOC_LIMITS.depth - 2;

/** The depth of the deepest block: 1 for a doc of paragraphs, 3 for a paragraph in a list item. */
export function blockDepth(doc: Node): number {
	let deepest = 0;
	const visit = (node: Node, depth: number) => {
		node.forEach((child) => {
			if (!child.isBlock) return;
			if (depth + 1 > deepest) deepest = depth + 1;
			if (!child.isTextblock) visit(child, depth + 1);
		});
	};
	visit(doc, 0);
	return deepest;
}

function splitLines(text: string): string[] {
	return text.replace(/\r\n?/g, "\n").split("\n");
}

/**
 * Pasted plain text. In a code block, the text goes in as it is. In each other block, each line is
 * a paragraph, also an empty line, and the first and last paragraphs join the text around the cursor.
 */
export function plainTextSlice(text: string, inCode: boolean, lineMarks: readonly Mark[] = []): Slice {
	if (inCode) {
		const value = text.replace(/\r\n?/g, "\n");
		return value === "" ? Slice.empty : new Slice(Fragment.from(schema.text(value)), 0, 0);
	}
	const paragraphs = splitLines(text).map((line) =>
		nodes.paragraph.create(null, line === "" ? null : schema.text(line, lineMarks)),
	);
	return new Slice(Fragment.from(paragraphs), 1, 1);
}

/** The document of the editor for the content that `docs.get` returned. */
export function contentToDoc(content: DocContent): Node {
	const doc = schema.nodeFromJSON(content);
	doc.check();
	return doc;
}

function markJson(mark: Mark): DocMark | null {
	switch (mark.type) {
		case marks.link:
			return isDocHref(mark.attrs.href) ? { type: "link", attrs: { href: mark.attrs.href } } : null;
		case marks.strong:
			return { type: "strong" };
		case marks.em:
			return { type: "em" };
		case marks.underline:
			return { type: "underline" };
		case marks.strike:
			return { type: "strike" };
		case marks.code:
			return { type: "code" };
		default:
			return null;
	}
}

function inlineJson(node: Node): DocInline[] {
	const content: DocInline[] = [];
	node.forEach((child) => {
		if (child.type === nodes.hard_break) {
			content.push({ type: "hard_break" });
		} else if (child.isText && child.text) {
			const marksJson = child.marks.map(markJson).filter((mark): mark is DocMark => mark !== null);
			content.push(
				marksJson.length > 0
					? { type: "text", text: child.text, marks: marksJson }
					: { type: "text", text: child.text },
			);
		}
	});
	return content;
}

function blocksJson(node: Node): DocBlock[] {
	const blocks: DocBlock[] = [];
	node.forEach((child) => {
		blocks.push(blockJson(child));
	});
	return blocks;
}

function listItemsJson(list: Node) {
	const items: { type: "list_item"; content: DocBlock[] }[] = [];
	list.forEach((item) => {
		items.push({ type: "list_item", content: blocksJson(item) });
	});
	return items;
}

function blockJson(node: Node): DocBlock {
	switch (node.type) {
		case nodes.heading: {
			const content = inlineJson(node);
			const attrs = { level: headingLevel(node.attrs.level) };
			return content.length > 0 ? { type: "heading", attrs, content } : { type: "heading", attrs };
		}
		case nodes.blockquote:
			return { type: "blockquote", content: blocksJson(node) };
		case nodes.bullet_list:
			return { type: "bullet_list", content: listItemsJson(node) };
		case nodes.ordered_list:
			return { type: "ordered_list", attrs: { order: listOrder(node.attrs.order) }, content: listItemsJson(node) };
		case nodes.code_block:
			return node.textContent === ""
				? { type: "code_block" }
				: { type: "code_block", content: [{ type: "text", text: node.textContent }] };
		case nodes.horizontal_rule:
			return { type: "horizontal_rule" };
		default: {
			const content = inlineJson(node);
			return content.length > 0 ? { type: "paragraph", content } : { type: "paragraph" };
		}
	}
}

/**
 * The content that `docs.update` gets. For a document that the editor made, it is the same as
 * `doc.toJSON()`. It also makes each attribute safe: a heading level from 1 to 3, a list number in
 * range, and no link that is not http, https or mailto.
 */
export function docToContent(doc: Node): DocContent {
	return { type: "doc", content: blocksJson(doc) };
}
