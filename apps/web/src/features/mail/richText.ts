import { Fragment, type Mark, type Node, Schema, Slice } from "prosemirror-model";

// The document model of the composer. The schema is an allowlist: pasted HTML goes through the
// parse rules below, so only these nodes and marks can come into the editor. Each other element
// and attribute is dropped, and each link must pass `safeHref`. The functions that make the mail
// body (`docToHtml` and `docToText`) need no DOM, so the Node tests can run them.

const LINK_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:", "mailto:"]);

/** The URL as an absolute http, https or mailto URL, or null for each other URL. */
export function safeHref(href: string): string | null {
	let url: URL;
	try {
		url = new URL(href);
	} catch {
		return null;
	}
	if (!LINK_PROTOCOLS.has(url.protocol)) return null;
	if (url.protocol !== "mailto:" && url.hostname === "") return null;
	return url.href;
}

const SCHEME = /^[a-z][a-z0-9+-]*:/i;
const EMAIL_LIKE = /^[^\s@/:]+@[^\s@/:]+\.[^\s@/:]+$/;

/**
 * The link for the text that a person typed in the link dialog. An address without a scheme gets
 * mailto: or https:. The result is null when the text is not a safe link.
 */
export function normalizeLink(input: string): string | null {
	const value = input.trim();
	if (value === "" || /\s/.test(value)) return null;
	if (SCHEME.test(value)) return safeHref(value);
	if (EMAIL_LIKE.test(value)) return safeHref(`mailto:${value}`);
	return safeHref(`https://${value}`);
}

function listStart(value: string | null): number {
	const start = Number.parseInt(value ?? "", 10);
	return Number.isSafeInteger(start) && start >= 0 && start <= 99_999 ? start : 1;
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
			attrs: { order: { default: 1, validate: "number" } },
			parseDOM: [{ tag: "ol", getAttrs: (dom) => ({ order: listStart(dom.getAttribute("start")) }) }],
			toDOM: (node) => (node.attrs.order === 1 ? ["ol", 0] : ["ol", { start: String(node.attrs.order) }, 0]),
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
	},
});

const { nodes, marks } = schema;

function paragraph(line: string, lineMarks: readonly Mark[] = []): Node {
	return nodes.paragraph.create(null, line === "" ? null : schema.text(line, lineMarks));
}

function splitLines(text: string): string[] {
	return text.replace(/\r\n?/g, "\n").split("\n");
}

/**
 * Pasted plain text: one paragraph for each line, also for an empty line. The first and last
 * paragraphs join the paragraphs around the cursor.
 */
export function plainTextSlice(text: string, lineMarks: readonly Mark[] = []): Slice {
	return new Slice(Fragment.from(splitLines(text).map((line) => paragraph(line, lineMarks))), 1, 1);
}

/** Deeper quotes stay as text. The limit stops a hostile message from nesting without end. */
export const MAX_QUOTE_DEPTH = 8;

/**
 * The marker that `quote` in compose.ts puts before each line. A line that starts with `>` and no
 * space stays text, so the text of a draft comes back the same from `docToText`.
 */
const QUOTE_MARKER = "> ";

function textBlocks(lines: readonly string[], depth: number): Node[] {
	const blocks: Node[] = [];
	let index = 0;
	while (index < lines.length) {
		const line = lines[index] ?? "";
		if (depth >= MAX_QUOTE_DEPTH || !line.startsWith(QUOTE_MARKER)) {
			blocks.push(paragraph(line));
			index += 1;
			continue;
		}
		const quoted: string[] = [];
		for (let next = lines[index]; next?.startsWith(QUOTE_MARKER); next = lines[index]) {
			quoted.push(next.slice(QUOTE_MARKER.length));
			index += 1;
		}
		blocks.push(nodes.blockquote.create(null, textBlocks(quoted, depth + 1)));
	}
	return blocks;
}

/**
 * The first document of a composer, from the plain text of a draft. Each line is a paragraph. A
 * run of lines that start with `> ` is a quote, as in a reply.
 */
export function textToDoc(text: string): Node {
	return nodes.doc.create(null, textBlocks(splitLines(text), 0));
}

function linkLabel(text: string, href: string): string {
	if (text === "") return href;
	if (safeHref(text) === href || `mailto:${text}` === href) return text;
	return `${text} <${href}>`;
}

/** The text of a paragraph. A link shows its address after the text, as `text <address>`. */
function inlineText(node: Node): string {
	let text = "";
	let link: { href: string; text: string } | null = null;
	for (let index = 0; index < node.childCount; index += 1) {
		const child = node.child(index);
		const href = (marks.link.isInSet(child.marks)?.attrs.href as string | undefined) ?? null;
		if (link !== null && link.href !== href) {
			text += linkLabel(link.text, link.href);
			link = null;
		}
		const content = child.isText ? (child.text ?? "") : child.type === nodes.hard_break ? "\n" : "";
		if (href === null) text += content;
		else {
			link ??= { href, text: "" };
			link.text += content;
		}
	}
	if (link !== null) text += linkLabel(link.text, link.href);
	return text;
}

function pushAll(target: string[], lines: readonly string[], prefix = "", firstPrefix = prefix): void {
	lines.forEach((line, index) => {
		const lead = index === 0 ? firstPrefix : prefix;
		target.push(line === "" ? lead.trimEnd() : lead + line);
	});
}

function blockLines(node: Node): string[] {
	const lines: string[] = [];
	node.forEach((child) => {
		switch (child.type) {
			case nodes.paragraph:
				pushAll(lines, inlineText(child).split("\n"));
				break;
			case nodes.blockquote:
				// "> " also on an empty line, as in the quote of a reply draft.
				for (const line of blockLines(child)) lines.push(`> ${line}`);
				break;
			case nodes.bullet_list:
			case nodes.ordered_list: {
				let number = child.attrs.order as number;
				child.forEach((item) => {
					const marker = child.type === nodes.bullet_list ? "- " : `${number}. `;
					number += 1;
					pushAll(lines, blockLines(item), " ".repeat(marker.length), marker);
				});
				break;
			}
			default:
				pushAll(lines, child.textContent.split("\n"));
		}
	});
	return lines;
}

/** The plain-text body: one line for each paragraph, `> ` for a quote, and `- ` or `1. ` for list items. */
export function docToText(doc: Node): string {
	return blockLines(doc).join("\n");
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * HTML collapses a run of spaces and removes a space at the start of a line. A space after a space
 * or at the start of a line becomes a non-breaking space, so the spaces show as typed. A tab is
 * four spaces.
 */
function textHtml(text: string, afterSpace: boolean): string {
	return escapeHtml(text.replace(/\t/g, "    ")).replace(
		/ +/g,
		(run: string, offset: number) => `${offset === 0 && afterSpace ? "&nbsp;" : " "}${"&nbsp;".repeat(run.length - 1)}`,
	);
}

const OPEN_TAGS: Readonly<Record<string, string>> = { strong: "<b>", em: "<i>", underline: "<u>", strike: "<s>" };
const CLOSE_TAGS: Readonly<Record<string, string>> = { strong: "</b>", em: "</i>", underline: "</u>", strike: "</s>" };

function openTag(mark: Mark): string {
	if (mark.type === marks.link) return `<a href="${escapeHtml(mark.attrs.href as string)}">`;
	return OPEN_TAGS[mark.type.name] ?? "";
}

function closeTag(mark: Mark): string {
	return mark.type === marks.link ? "</a>" : (CLOSE_TAGS[mark.type.name] ?? "");
}

/** A link mark that is not safe is left out. The parse rules and the link dialog never make one. */
function htmlMarks(node: Node): readonly Mark[] {
	return node.marks.filter(
		(mark) => mark.type !== marks.link || safeHref(mark.attrs.href as string) === mark.attrs.href,
	);
}

/** The inline content of a paragraph. Marks keep the schema order, so one stack of open tags is enough. */
function inlineHtml(node: Node): string {
	if (node.childCount === 0) return "<br>";
	let html = "";
	const open: Mark[] = [];
	let afterSpace = true;
	for (let index = 0; index < node.childCount; index += 1) {
		const child = node.child(index);
		const childMarks = htmlMarks(child);
		let keep = 0;
		while (keep < open.length && keep < childMarks.length && open[keep]?.eq(childMarks[keep] as Mark)) keep += 1;
		while (open.length > keep) html += closeTag(open.pop() as Mark);
		for (const mark of childMarks.slice(keep)) {
			html += openTag(mark);
			open.push(mark);
		}
		if (child.isText) {
			const text = child.text ?? "";
			html += textHtml(text, afterSpace);
			afterSpace = /[ \t]$/.test(text);
		} else if (child.type === nodes.hard_break) {
			html += "<br>";
			afterSpace = true;
		}
	}
	while (open.length > 0) html += closeTag(open.pop() as Mark);
	// A <br> at the end of a block shows no line. A second <br> shows the empty line that the person typed.
	if (node.lastChild?.type === nodes.hard_break) html += "<br>";
	return html;
}

const BLOCKQUOTE_STYLE = "margin:0 0 0 0.8ex;border-left:1px solid #ccc;padding-left:1ex";

function blocksHtml(node: Node): string {
	let html = "";
	node.forEach((child) => {
		switch (child.type) {
			case nodes.paragraph:
				html += `<div>${inlineHtml(child)}</div>`;
				break;
			case nodes.blockquote:
				html += `<blockquote style="${BLOCKQUOTE_STYLE}">${blocksHtml(child)}</blockquote>`;
				break;
			case nodes.bullet_list:
				html += `<ul>${blocksHtml(child)}</ul>`;
				break;
			case nodes.ordered_list:
				html +=
					child.attrs.order === 1
						? `<ol>${blocksHtml(child)}</ol>`
						: `<ol start="${child.attrs.order}">${blocksHtml(child)}</ol>`;
				break;
			case nodes.list_item:
				html += `<li>${blocksHtml(child)}</li>`;
				break;
			default:
				html += `<div>${textHtml(child.textContent, true)}</div>`;
		}
	});
	return html;
}

/**
 * The HTML body. Each paragraph is a `<div>`, as most mail apps write it, so a line has no extra
 * space. Only the tags of the schema are written, and each text and attribute value is escaped.
 */
export function docToHtml(doc: Node): string {
	return blocksHtml(doc);
}
