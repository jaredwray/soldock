import {
	DOC_LIMITS,
	type DocBlock,
	type DocContent,
	type DocImage,
	type DocImageNode,
	type DocInline,
} from "@soldock/contracts";

/** A doc with no text: one empty paragraph. */
export const EMPTY_DOC: DocContent = { type: "doc", content: [{ type: "paragraph" }] };

/**
 * The rule that the schema of the contracts cannot say: the limit of blocks in blocks. Returns a
 * message when the doc is over the limit, or null. The editor of the web app has a lower limit.
 */
export function checkDoc(doc: DocContent): string | null {
	function check(blocks: readonly DocBlock[], depth: number): string | null {
		if (depth > DOC_LIMITS.depth) return `A doc can have at most ${DOC_LIMITS.depth} levels of blocks in blocks.`;
		for (const block of blocks) {
			if (block.type === "blockquote") {
				const error = check(block.content, depth + 1);
				if (error) return error;
			} else if (block.type === "bullet_list" || block.type === "ordered_list") {
				for (const item of block.content) {
					const error = check(item.content, depth + 2);
					if (error) return error;
				}
			}
		}
		return null;
	}
	return check(doc.content, 1);
}

/** The text of an image for the search index: its alt text and its caption. */
function imageText(node: DocImageNode): string {
	return [node.attrs.alt, node.attrs.caption].filter((text) => text !== undefined).join(" ");
}

function inlineText(content: readonly DocInline[] | undefined): string {
	return (content ?? [])
		.map((node) => (node.type === "text" ? node.text : node.type === "image" ? ` ${imageText(node)} ` : "\n"))
		.join("");
}

/** Each image of a doc, in the order of the text. */
export function imageNodes(doc: DocContent): DocImageNode[] {
	const found: DocImageNode[] = [];
	function walk(blocks: readonly DocBlock[]): void {
		for (const block of blocks) {
			switch (block.type) {
				case "paragraph":
				case "heading":
					for (const node of block.content ?? []) if (node.type === "image") found.push(node);
					break;
				case "blockquote":
					walk(block.content);
					break;
				case "bullet_list":
				case "ordered_list":
					for (const item of block.content) walk(item.content);
					break;
				case "code_block":
				case "horizontal_rule":
					break;
			}
		}
	}
	walk(doc.content);
	return found;
}

/** A part of an image with 4 decimals, so the same crop always has the same JSON. */
function part(value: number): number {
	return Math.round(value * 10_000) / 10_000;
}

/**
 * Makes each image of a doc complete, in place, for the images that the doc holds. An image without a
 * width gets the width of its file, at most the width of the text. A crop of the whole image goes
 * away. Returns a message when the doc does not hold an image of the content, or null.
 */
export function completeImages(doc: DocContent, held: ReadonlyMap<string, DocImage>): string | null {
	for (const node of imageNodes(doc)) {
		const { attrs } = node;
		const image = held.get(attrs.id);
		if (!image) {
			return `The doc does not hold the image ${attrs.id}. Add an image with docs.upload_image, docs.copy_image or docs.import_image, then use the id that the call returns. An image that the content did not use for 24 hours is deleted.`;
		}
		if (attrs.crop) {
			const crop = {
				x: part(attrs.crop.x),
				y: part(attrs.crop.y),
				width: part(Math.min(attrs.crop.width, 1 - attrs.crop.x)),
				height: part(Math.min(attrs.crop.height, 1 - attrs.crop.y)),
			};
			if (crop.x === 0 && crop.y === 0 && crop.width === 1 && crop.height === 1) delete attrs.crop;
			else attrs.crop = crop;
		}
		if (attrs.width === undefined) {
			const shown = Math.round(image.width * (attrs.crop?.width ?? 1));
			attrs.width = Math.max(DOC_LIMITS.imageMinWidth, Math.min(shown, DOC_LIMITS.imageTextWidth));
		}
	}
	return null;
}

/** The plain text of a doc, one line for each block. The search index of Drive uses it. */
export function docText(doc: DocContent): string {
	const lines: string[] = [];
	let chars = 0;
	const add = (line: string) => {
		if (line.trim() === "") return;
		lines.push(line);
		chars += line.length + 1;
	};
	function walk(blocks: readonly DocBlock[]): void {
		for (const block of blocks) {
			if (chars > DOC_LIMITS.textChars) return;
			switch (block.type) {
				case "paragraph":
				case "heading":
					add(inlineText(block.content));
					break;
				case "code_block":
					add((block.content ?? []).map((node) => node.text).join(""));
					break;
				case "blockquote":
					walk(block.content);
					break;
				case "bullet_list":
				case "ordered_list":
					for (const item of block.content) walk(item.content);
					break;
				case "horizontal_rule":
					break;
			}
		}
	}
	walk(doc.content);
	return lines.join("\n").slice(0, DOC_LIMITS.textChars);
}
