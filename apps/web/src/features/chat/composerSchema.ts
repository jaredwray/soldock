import { CHAT_LIMITS, type ChatBody, type ChatBodyBlock, type ChatBodyInline } from "@soldock/contracts";
import { Fragment, type Mark, type Node, Schema, Slice } from "prosemirror-model";
import { safeHref } from "../mail/richText.ts";

// The document model of the chat box, and the change between it and the body of a message. The schema
// is an allowlist: pasted HTML goes through the parse rules below, so only the nodes and marks of a
// message body can come into the box. Each link must pass `safeHref`. It has no DOM, so apps/web/test
// checks it.
//
// In the box, each line is a paragraph: Markdown shortcuts such as "- " then work at the start of
// each line. In a message, the lines of one paragraph are hard breaks, as in the plain text form. So
// `docToBody` joins the paragraphs that follow one another into one paragraph, and `bodyToDoc` splits
// a paragraph at its hard breaks.

/** The first number of a numbered list, as the contract takes it. Each other value is 1. */
function listOrder(value: unknown): number {
	const order = typeof value === "string" ? Number.parseInt(value, 10) : value;
	return typeof order === "number" && Number.isSafeInteger(order) && order >= 0 && order <= 99_999 ? order : 1;
}

export const chatSchema = new Schema({
	nodes: {
		doc: { content: "block+" },
		paragraph: {
			content: "inline*",
			group: "block",
			parseDOM: [{ tag: "p" }],
			toDOM: () => ["p", 0],
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
		list_item: {
			content: "paragraph block*",
			defining: true,
			parseDOM: [{ tag: "li" }],
			toDOM: () => ["li", 0],
		},
		text: { group: "inline" },
		hard_break: {
			inline: true,
			group: "inline",
			selectable: false,
			leafText: () => "\n",
			parseDOM: [{ tag: "br" }],
			toDOM: () => ["br"],
		},
	},
	// The order is the nesting order in the HTML: a link holds the other marks.
	marks: {
		link: {
			attrs: { href: { validate: "string" } },
			inclusive: false,
			parseDOM: [
				{
					tag: "a[href]",
					getAttrs: (dom) => {
						const href = safeHref(dom.getAttribute("href") ?? "");
						return href === null ? false : { href };
					},
				},
			],
			toDOM: (mark) => ["a", { href: mark.attrs.href, title: mark.attrs.href, rel: "noopener noreferrer nofollow" }, 0],
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
		strike: {
			parseDOM: [{ tag: "s" }, { tag: "strike" }, { tag: "del" }],
			toDOM: () => ["s", 0],
		},
		code: {
			// `code` tells ProseMirror and the Markdown shortcuts that the text of the mark is code.
			code: true,
			parseDOM: [{ tag: "code" }],
			toDOM: () => ["code", 0],
		},
	},
});

const { nodes, marks } = chatSchema;

type BodyText = Extract<ChatBodyInline, { type: "text" }>;
type BodyMark = NonNullable<BodyText["marks"]>[number];

// --- Box to body ---------------------------------------------------------------------------------

function markToBody(mark: Mark): BodyMark | null {
	switch (mark.type.name) {
		case "strong":
		case "em":
		case "strike":
		case "code":
			return { type: mark.type.name };
		case "link": {
			// The link keeps its form, so an edit with no change gives the same body.
			const href = String(mark.attrs.href);
			return safeHref(href) === null ? null : { type: "link", attrs: { href } };
		}
		default:
			return null;
	}
}

function inlineToBody(paragraph: Node): ChatBodyInline[] {
	const out: ChatBodyInline[] = [];
	paragraph.forEach((child) => {
		if (child.type === nodes.hard_break) {
			out.push({ type: "hard_break" });
			return;
		}
		if (!child.isText || !child.text) return;
		const bodyMarks = child.marks.map(markToBody).filter((mark): mark is BodyMark => mark !== null);
		// A pasted text can hold a new line. In a message, a new line is a hard break.
		child.text.split(/\r\n?|\n/).forEach((line, index) => {
			if (index > 0) out.push({ type: "hard_break" });
			for (const text of pieces(line)) {
				out.push(bodyMarks.length > 0 ? { type: "text", text, marks: bodyMarks } : { type: "text", text });
			}
		});
	});
	return out;
}

/**
 * A text in pieces of at most `CHAT_LIMITS.messageChars` characters: the limit of one text node. A long
 * draft is then a body that the contract takes, so the store keeps it, and the person can shorten it.
 * The send of a plain text above the limit stays blocked. A piece does not end inside a surrogate pair.
 */
function pieces(text: string): string[] {
	const out: string[] = [];
	let rest = text;
	while (rest.length > CHAT_LIMITS.messageChars) {
		let cut = CHAT_LIMITS.messageChars;
		const code = rest.charCodeAt(cut - 1);
		if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
		out.push(rest.slice(0, cut));
		rest = rest.slice(cut);
	}
	if (rest !== "") out.push(rest);
	return out;
}

/** The paragraphs that follow one another as one paragraph, one hard break between two lines. Empty lines at the start and at the end go. */
function joinLines(lines: readonly Node[]): ChatBodyBlock | null {
	const content: ChatBodyInline[] = [];
	lines.forEach((line, index) => {
		if (index > 0) content.push({ type: "hard_break" });
		content.push(...inlineToBody(line));
	});
	while (content[0]?.type === "hard_break") content.shift();
	while (content.at(-1)?.type === "hard_break") content.pop();
	return content.length > 0 ? { type: "paragraph", content } : null;
}

function blocksToBody(container: Node): ChatBodyBlock[] {
	const out: ChatBodyBlock[] = [];
	let lines: Node[] = [];
	const flush = () => {
		const joined = joinLines(lines);
		if (joined) out.push(joined);
		lines = [];
	};
	container.forEach((block) => {
		if (block.type === nodes.paragraph) {
			lines.push(block);
			return;
		}
		// A block with no text goes away. The lines before and after it stay one paragraph, so the body
		// of a body is the same body again.
		const converted = blockToBody(block);
		if (!converted) return;
		flush();
		out.push(converted);
	});
	flush();
	return out;
}

/** A block that is not a paragraph, or null when it has no text. */
function blockToBody(block: Node): ChatBodyBlock | null {
	if (block.type === nodes.code_block) {
		// New lines at the end of a code block show nothing.
		const text = block.textContent.replace(/\n+$/, "");
		return text === ""
			? null
			: { type: "code_block", content: pieces(text).map((piece) => ({ type: "text", text: piece })) };
	}
	if (block.type === nodes.blockquote) {
		const content = blocksToBody(block);
		return content.length > 0 ? { type: "blockquote", content } : null;
	}
	if (block.type === nodes.bullet_list || block.type === nodes.ordered_list) {
		const items: { type: "list_item"; content: ChatBodyBlock[] }[] = [];
		block.forEach((item) => {
			const content = blocksToBody(item);
			if (content.length > 0) items.push({ type: "list_item", content });
		});
		if (items.length === 0) return null;
		return block.type === nodes.bullet_list
			? { type: "bullet_list", content: items }
			: { type: "ordered_list", attrs: { order: listOrder(block.attrs.order) }, content: items };
	}
	return null;
}

/** The body of the box, or null when the box has no text. */
export function docToBody(doc: Node): ChatBody | null {
	const content = blocksToBody(doc);
	const body: ChatBody | null = content.length > 0 ? { type: "doc", content } : null;
	return body && bodyText(body).trim() !== "" ? body : null;
}

// --- Body to box ---------------------------------------------------------------------------------

function marksFromBody(bodyMarks: BodyText["marks"]): Mark[] {
	const out: Mark[] = [];
	for (const mark of bodyMarks ?? []) {
		if (mark.type === "link") {
			if (safeHref(mark.attrs.href) !== null) out.push(marks.link.create({ href: mark.attrs.href }));
		} else {
			out.push(marks[mark.type].create());
		}
	}
	return out;
}

/** A paragraph of the body as the lines of the box: one paragraph for each line. */
function linesFromBody(content: readonly ChatBodyInline[] | undefined): Node[] {
	const lines: Node[][] = [[]];
	for (const inline of content ?? []) {
		if (inline.type === "hard_break") lines.push([]);
		else (lines.at(-1) as Node[]).push(chatSchema.text(inline.text, marksFromBody(inline.marks)));
	}
	return lines.map((line) => nodes.paragraph.create(null, line));
}

function blocksFromBody(blocks: readonly ChatBodyBlock[]): Node[] {
	const out: Node[] = [];
	let afterParagraph = false;
	for (const block of blocks) {
		if (block.type === "paragraph") {
			// Two paragraphs of a message have a space between them: an empty line in the box.
			if (afterParagraph) out.push(nodes.paragraph.create());
			out.push(...linesFromBody(block.content));
			afterParagraph = true;
			continue;
		}
		afterParagraph = false;
		switch (block.type) {
			case "code_block": {
				const text = (block.content ?? []).map((node) => node.text).join("");
				out.push(nodes.code_block.create(null, text === "" ? null : chatSchema.text(text)));
				break;
			}
			case "blockquote":
				out.push(nodes.blockquote.create(null, withBlock(blocksFromBody(block.content))));
				break;
			case "bullet_list":
			case "ordered_list": {
				const items = block.content.map((item) => {
					const content = withBlock(blocksFromBody(item.content));
					// An item of the box starts with a paragraph.
					if (content[0]?.type !== nodes.paragraph) content.unshift(nodes.paragraph.create());
					return nodes.list_item.create(null, content);
				});
				out.push(
					block.type === "bullet_list"
						? nodes.bullet_list.create(null, items)
						: nodes.ordered_list.create({ order: listOrder(block.attrs?.order) }, items),
				);
				break;
			}
		}
	}
	return out;
}

function withBlock(blocks: Node[]): Node[] {
	return blocks.length > 0 ? blocks : [nodes.paragraph.create()];
}

/** The document of the box for a body, for an edit and for a draft. An empty box for null. */
export function bodyToDoc(body: ChatBody | null): Node {
	return nodes.doc.create(null, withBlock(body ? blocksFromBody(body.content) : []));
}

/**
 * True when two bodies are the same in the box. The box has its own form of a body (one paragraph for
 * each line), so an edit that the person did not change can have a different body than the message.
 */
export function sameInBox(a: ChatBody, b: ChatBody): boolean {
	return JSON.stringify(docToBody(bodyToDoc(a))) === JSON.stringify(docToBody(bodyToDoc(b)));
}

// --- Text ----------------------------------------------------------------------------------------

/** The body of a plain text: one paragraph, with a hard break for each new line. As `textBody` of the server. */
export function textToBody(text: string): ChatBody {
	const content: ChatBodyInline[] = [];
	text.split(/\r\n?|\n/).forEach((line, index) => {
		if (index > 0) content.push({ type: "hard_break" });
		if (line !== "") content.push({ type: "text", text: line });
	});
	return { type: "doc", content: [content.length > 0 ? { type: "paragraph", content } : { type: "paragraph" }] };
}

/** The plain text of a body: one line for each block. As `bodyText` of the server. */
export function bodyText(body: ChatBody): string {
	const lines: string[] = [];
	const walk = (blocks: readonly ChatBodyBlock[]) => {
		for (const block of blocks) {
			switch (block.type) {
				case "paragraph":
					lines.push((block.content ?? []).map((node) => (node.type === "text" ? node.text : "\n")).join(""));
					break;
				case "code_block":
					lines.push((block.content ?? []).map((node) => node.text).join(""));
					break;
				case "blockquote":
					walk(block.content);
					break;
				case "bullet_list":
				case "ordered_list":
					for (const item of block.content) walk(item.content);
					break;
			}
		}
	};
	walk(body.content);
	return lines.join("\n").trim();
}

/**
 * Pasted plain text: one paragraph for each line, also for an empty line. The first and last
 * paragraphs join the paragraphs around the cursor. In a code block, ProseMirror pastes the text as it
 * is and does not call this function.
 */
export function plainTextSlice(text: string, lineMarks: readonly Mark[]): Slice {
	const normal = text.replace(/\r\n?/g, "\n");
	const lines = normal
		.split("\n")
		.map((line) => nodes.paragraph.create(null, line === "" ? null : chatSchema.text(line, lineMarks)));
	return new Slice(Fragment.from(lines), 1, 1);
}
