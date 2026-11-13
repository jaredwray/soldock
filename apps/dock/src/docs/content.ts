import { DOC_LIMITS, type DocBlock, type DocContent, type DocInline } from "@soldock/contracts";

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

function inlineText(content: readonly DocInline[] | undefined): string {
	return (content ?? []).map((node) => (node.type === "text" ? node.text : "\n")).join("");
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
