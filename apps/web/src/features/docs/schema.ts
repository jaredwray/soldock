import {
	DOC_IMAGE_LAYOUTS,
	DOC_LIMITS,
	type DocBlock,
	type DocContent,
	type DocImageCrop,
	type DocImageLayout,
	type DocImageNode,
	type DocInline,
	type DocMark,
} from "@soldock/contracts";
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

// --- Images ---------------------------------------------------------------------------------------
//
// An image node names an image that the doc holds (`id`). It never has an address: the editor gets
// the bytes with `docs.get_image`. The attributes have no schema validation, for the same reason as
// the level of a heading. Each reader uses `imageAttrs`, so only good values reach the page and the
// server.

const IMAGE_ID = /^img_[0-9A-HJKMNP-TV-Z]{26}$/;

/** True for the id of an image that a doc can hold. A new image has no id until its upload ends. */
export function isImageId(value: unknown): value is string {
	return typeof value === "string" && IMAGE_ID.test(value);
}

export interface ImageAttrs {
	/** The id of the image in the doc, or "" while the image uploads. */
	id: string;
	/** The shown width in CSS pixels, or null for the width of the file. */
	width: number | null;
	layout: DocImageLayout;
	alt: string;
	/** Null for no caption. "" for a caption line that has no text yet. */
	caption: string | null;
	crop: DocImageCrop | null;
	/**
	 * For an image that the doc does not hold yet. `job:<key>` names an upload of this editor.
	 * `src:<address>` and `doc:<space id>:<item id>` come from a paste, before the upload starts.
	 */
	pending: string | null;
}

/** One line of text for a person, without control characters, at most `max` characters. */
export function oneLine(value: unknown, max: number): string {
	if (typeof value !== "string") return "";
	return value
		.replace(/\p{Cc}+/gu, " ")
		.trim()
		.slice(0, max)
		.trim();
}

/** The layout of an image. A value that is not a layout is `inline`. */
export function imageLayout(value: unknown): DocImageLayout {
	return (DOC_IMAGE_LAYOUTS as readonly unknown[]).includes(value) ? (value as DocImageLayout) : "inline";
}

/** The shown width of an image in the limits of the server, or null. */
export function imageWidth(value: unknown): number | null {
	const width = typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : value;
	if (typeof width !== "number" || !Number.isFinite(width)) return null;
	return Math.max(DOC_LIMITS.imageMinWidth, Math.min(Math.round(width), DOC_LIMITS.imageMaxWidth));
}

/** A part of an image with 4 decimals, as the server stores it. */
function part(value: number): number {
	return Math.round(value * 10_000) / 10_000;
}

/** The crop of an image, in the image. Null for a value that is not a crop, and for the whole image. */
export function imageCrop(value: unknown): DocImageCrop | null {
	if (typeof value !== "object" || value === null) return null;
	const { x, y, width, height } = value as Record<string, unknown>;
	if (![x, y, width, height].every((number) => typeof number === "number" && Number.isFinite(number))) return null;
	const min = DOC_LIMITS.imageMinCrop;
	const left = part(Math.max(0, Math.min(x as number, 1 - min)));
	const top = part(Math.max(0, Math.min(y as number, 1 - min)));
	const crop = {
		x: left,
		y: top,
		width: part(Math.max(min, Math.min(width as number, 1 - left))),
		height: part(Math.max(min, Math.min(height as number, 1 - top))),
	};
	return crop.x === 0 && crop.y === 0 && crop.width === 1 && crop.height === 1 ? null : crop;
}

/** The attributes of an image node, each one made safe. */
export function imageAttrs(node: Node): ImageAttrs {
	const { id, width, layout, alt, caption, crop, pending } = node.attrs;
	return {
		id: isImageId(id) ? id : "",
		width: imageWidth(width),
		layout: imageLayout(layout),
		alt: oneLine(alt, DOC_LIMITS.imageAltChars),
		caption: typeof caption === "string" ? oneLine(caption, DOC_LIMITS.imageCaptionChars) : null,
		crop: imageCrop(crop),
		pending: typeof pending === "string" && pending !== "" ? pending : null,
	};
}

/** The crop as text for an attribute of the clipboard: `x,y,width,height`. */
function cropText(crop: DocImageCrop | null): string | null {
	return crop ? [crop.x, crop.y, crop.width, crop.height].join(",") : null;
}

function cropFromText(text: string | null): DocImageCrop | null {
	const [x, y, width, height] = (text ?? "").split(",").map(Number);
	return imageCrop({ x, y, width, height });
}

/** The attributes of the `<img>` that the clipboard gets for an image. It has no address. */
export function imageDomAttrs(node: Node): Record<string, string> {
	const attrs = imageAttrs(node);
	const dom: Record<string, string> = { "data-doc-image": attrs.id, "data-layout": attrs.layout, alt: attrs.alt };
	if (attrs.width !== null) dom["data-width"] = String(attrs.width);
	if (attrs.caption !== null) dom["data-caption"] = attrs.caption;
	const crop = cropText(attrs.crop);
	if (crop !== null) dom["data-crop"] = crop;
	return dom;
}

/** The most characters of a `data:` address: the base64 of the largest image, and the start of the address. */
const DATA_IMAGE_CHARS = Math.ceil(DOC_LIMITS.imageBytes / 3) * 4 + 64;

/** The image types of a `data:` address that a paste can hold. */
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,/i;

/**
 * The address of a pasted image when the editor can bring it into the doc: an image as a `data:`
 * address, or an https address that the server downloads one time. Null for each other address.
 */
export function importableSrc(src: string): string | null {
	// A `data:` address over the size of the largest image is refused before the editor decodes it.
	if (DATA_IMAGE.test(src)) return src.length <= DATA_IMAGE_CHARS ? src : null;
	if (src.length > DOC_LIMITS.imageUrlChars || /\s/.test(src)) return null;
	try {
		return new URL(src).protocol === "https:" ? src : null;
	} catch {
		return null;
	}
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
		image: {
			inline: true,
			group: "inline",
			atom: true,
			draggable: true,
			attrs: {
				id: { default: "" },
				width: { default: null },
				layout: { default: "inline" },
				alt: { default: "" },
				caption: { default: null },
				crop: { default: null },
				pending: { default: null },
			},
			// The plain text of a copy has the alt text of the image.
			leafText: (node) => oneLine(node.attrs.alt, DOC_LIMITS.imageAltChars),
			parseDOM: [
				// An image that this editor wrote to the clipboard. The paste handler brings an image of a
				// different doc into this doc.
				{
					tag: "img[data-doc-image]",
					getAttrs: (dom) => {
						const id = dom.getAttribute("data-doc-image");
						if (!isImageId(id)) return false;
						const item = dom.getAttribute("data-doc-item");
						return {
							id,
							width: imageWidth(dom.getAttribute("data-width")),
							layout: imageLayout(dom.getAttribute("data-layout")),
							alt: oneLine(dom.getAttribute("alt"), DOC_LIMITS.imageAltChars),
							caption: dom.hasAttribute("data-caption")
								? oneLine(dom.getAttribute("data-caption"), DOC_LIMITS.imageCaptionChars)
								: null,
							crop: cropFromText(dom.getAttribute("data-crop")),
							pending: item ? `doc:${dom.getAttribute("data-doc-space") ?? ""}:${item}` : null,
						};
					},
				},
				// An image of a web page or of a different app. It has no id: the paste handler uploads it.
				{
					tag: "img[src]",
					getAttrs: (dom) => {
						const src = importableSrc(dom.getAttribute("src") ?? "");
						if (src === null) return false;
						return {
							id: "",
							width: imageWidth(dom.getAttribute("width")),
							alt: oneLine(dom.getAttribute("alt"), DOC_LIMITS.imageAltChars),
							pending: `src:${src}`,
						};
					},
				},
			],
			// For the clipboard. The editor shows an image with a node view, which gets the bytes.
			toDOM: (node) => ["img", imageDomAttrs(node)],
		},
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

/** How `docToContent` reads a document. */
export interface ContentOptions {
	/**
	 * True for an image that the doc holds. An image that the doc does not hold is not in the content:
	 * the server refuses content with such an image. Without this function, each image with an id is in.
	 */
	holdsImage?: (id: string) => boolean;
}

/** The image for the server, or null for an image that the doc does not hold yet. */
function imageJson(node: Node, options: ContentOptions): DocImageNode | null {
	const attrs = imageAttrs(node);
	if (attrs.id === "" || attrs.pending !== null) return null;
	if (options.holdsImage && !options.holdsImage(attrs.id)) return null;
	return {
		type: "image",
		attrs: {
			id: attrs.id,
			...(attrs.width === null ? {} : { width: attrs.width }),
			layout: attrs.layout,
			...(attrs.alt === "" ? {} : { alt: attrs.alt }),
			...(attrs.caption ? { caption: attrs.caption } : {}),
			...(attrs.crop ? { crop: attrs.crop } : {}),
		},
	};
}

function inlineJson(node: Node, options: ContentOptions): DocInline[] {
	const content: DocInline[] = [];
	node.forEach((child) => {
		if (child.type === nodes.hard_break) {
			content.push({ type: "hard_break" });
		} else if (child.type === nodes.image) {
			const image = imageJson(child, options);
			if (image) content.push(image);
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

function blocksJson(node: Node, options: ContentOptions): DocBlock[] {
	const blocks: DocBlock[] = [];
	node.forEach((child) => {
		blocks.push(blockJson(child, options));
	});
	return blocks;
}

function listItemsJson(list: Node, options: ContentOptions) {
	const items: { type: "list_item"; content: DocBlock[] }[] = [];
	list.forEach((item) => {
		items.push({ type: "list_item", content: blocksJson(item, options) });
	});
	return items;
}

function blockJson(node: Node, options: ContentOptions): DocBlock {
	switch (node.type) {
		case nodes.heading: {
			const content = inlineJson(node, options);
			const attrs = { level: headingLevel(node.attrs.level) };
			return content.length > 0 ? { type: "heading", attrs, content } : { type: "heading", attrs };
		}
		case nodes.blockquote:
			return { type: "blockquote", content: blocksJson(node, options) };
		case nodes.bullet_list:
			return { type: "bullet_list", content: listItemsJson(node, options) };
		case nodes.ordered_list:
			return {
				type: "ordered_list",
				attrs: { order: listOrder(node.attrs.order) },
				content: listItemsJson(node, options),
			};
		case nodes.code_block:
			return node.textContent === ""
				? { type: "code_block" }
				: { type: "code_block", content: [{ type: "text", text: node.textContent }] };
		case nodes.horizontal_rule:
			return { type: "horizontal_rule" };
		default: {
			const content = inlineJson(node, options);
			return content.length > 0 ? { type: "paragraph", content } : { type: "paragraph" };
		}
	}
}

/**
 * The content that `docs.update` gets. It makes each attribute safe: a heading level from 1 to 3, a
 * list number in range, no link that is not http, https or mailto, and each option of an image in its
 * limits. An image that still uploads is not in the content: a later save has it.
 */
export function docToContent(doc: Node, options: ContentOptions = {}): DocContent {
	return { type: "doc", content: blocksJson(doc, options) };
}
