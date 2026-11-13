import { DOC_LIMITS, type DocBlock, type DocContent, type DocInline, type DocMark } from "@soldock/contracts";

// Markdown for agents and for downloads. The two functions are a pair: `markdownToDoc` reads all that
// `docToMarkdown` writes. Markdown has no underline and no empty paragraph, so a doc loses those in
// Markdown. Each other format comes back the same.

type ListBlock = Extract<DocBlock, { type: "bullet_list" | "ordered_list" }>;
type ListItem = ListBlock["content"][number];

const LINK_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:", "mailto:"]);

/** The URL as an absolute http, https or mailto URL without spaces, or null for each other URL. */
function safeHref(href: string): string | null {
	let url: URL;
	try {
		url = new URL(href);
	} catch {
		return null;
	}
	if (!LINK_PROTOCOLS.has(url.protocol)) return null;
	if (url.protocol !== "mailto:" && url.hostname === "") return null;
	return url.href.length <= DOC_LIMITS.hrefChars && !/\s/.test(url.href) ? url.href : null;
}

// --- Markdown to doc: inline ----------------------------------------------------------------------

/** The marks in one order, each type one time, so two equal texts have equal JSON. */
const MARK_ORDER = ["link", "strong", "em", "underline", "strike", "code"] as const;

function withMark(marks: readonly DocMark[], mark: DocMark): DocMark[] {
	const next = [...marks.filter((existing) => existing.type !== mark.type), mark];
	return next.sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
}

type Token =
	| { kind: "text"; text: string }
	| { kind: "code"; text: string }
	| { kind: "break" }
	| { kind: "link"; href: string; children: Token[] }
	| { kind: "group"; mark: "strong" | "em" | "strike"; children: Token[] }
	| { kind: "delim"; ch: "*" | "_" | "~"; count: number; canOpen: boolean; canClose: boolean };

type Delim = Extract<Token, { kind: "delim" }>;

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!~<>|"']/;
const WORD = /[\p{L}\p{N}]/u;

function isSpace(ch: string | undefined): boolean {
	return ch === undefined || /\s/.test(ch);
}

/** The end of the link that starts with `[` at `start`, with its label and target, or null. */
function readLink(src: string, start: number): { label: string; href: string; end: number } | null | "none" {
	let depth = 0;
	let close = -1;
	for (let i = start; i < src.length; i++) {
		const ch = src[i];
		if (ch === "\\") i++;
		else if (ch === "[") depth++;
		else if (ch === "]" && --depth === 0) {
			close = i;
			break;
		}
	}
	// No bracket closes after this point, so no later link can exist in this text.
	if (close < 0) return "none";
	if (src[close + 1] !== "(") return null;
	const target = /^\(\s*(?:<([^<>\n]*)>|((?:[^\s()\\]|\\.|\([^\s()]*\))*))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/.exec(
		src.slice(close + 1),
	);
	if (!target) return null;
	const href = (target[1] ?? target[2] ?? "").replace(/\\(.)/g, "$1");
	return { label: src.slice(start + 1, close), href, end: close + 1 + target[0].length };
}

/** Cuts inline Markdown into tokens. Emphasis marks stay as `delim` tokens for `matchDelims`. */
function tokenize(src: string, linkDepth: number): Token[] {
	const tokens: Token[] = [];
	let text = "";
	let links = linkDepth < 4;
	/** The lengths of backtick runs that have no closing run after the current position. */
	const openRuns = new Set<number>();
	const flush = () => {
		if (text !== "") tokens.push({ kind: "text", text });
		text = "";
	};
	for (let i = 0; i < src.length; ) {
		const ch = src[i] as string;
		const next = src[i + 1];
		if (ch === "\\" && next !== undefined && ESCAPABLE.test(next)) {
			text += next;
			i += 2;
		} else if (ch === "\n") {
			flush();
			tokens.push({ kind: "break" });
			i++;
		} else if (ch === "`") {
			let length = 1;
			while (src[i + length] === "`") length++;
			let close = -1;
			if (!openRuns.has(length)) {
				for (let j = i + length; j < src.length; j++) {
					if (src[j] !== "`") continue;
					let run = 1;
					while (src[j + run] === "`") run++;
					if (run === length) {
						close = j;
						break;
					}
					j += run - 1;
				}
				if (close < 0) openRuns.add(length);
			}
			if (close < 0) {
				text += src.slice(i, i + length);
				i += length;
			} else {
				let code = src.slice(i + length, close).replace(/\n/g, " ");
				if (code.length > 1 && code.startsWith(" ") && code.endsWith(" ") && code.trim() !== "")
					code = code.slice(1, -1);
				flush();
				if (code !== "") tokens.push({ kind: "code", text: code });
				i = close + length;
			}
		} else if (ch === "[" && links) {
			const link = readLink(src, i);
			if (link === "none") links = false;
			if (link === null || link === "none") {
				text += ch;
				i++;
			} else {
				flush();
				const href = safeHref(link.href);
				const children = matchDelims(tokenize(link.label, linkDepth + 1));
				// A link that is not safe keeps its text and loses its target.
				if (href === null) tokens.push(...children);
				else tokens.push({ kind: "link", href, children });
				i = link.end;
			}
		} else if (ch === "<") {
			const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(src.slice(i, i + DOC_LIMITS.hrefChars + 2));
			const href = auto ? safeHref(auto[1] as string) : null;
			if (auto && href !== null) {
				flush();
				tokens.push({ kind: "link", href, children: [{ kind: "text", text: auto[1] as string }] });
				i += auto[0].length;
			} else {
				text += ch;
				i++;
			}
		} else if (ch === "*" || ch === "_" || ch === "~") {
			let count = 1;
			while (src[i + count] === ch) count++;
			const before = src[i - 1];
			const after = src[i + count];
			const left = !isSpace(after);
			const right = !isSpace(before);
			flush();
			tokens.push({
				kind: "delim",
				ch,
				count,
				// An underscore in a word is text: snake_case_name has no emphasis.
				canOpen: left && (ch !== "_" || before === undefined || !WORD.test(before)),
				canClose: right && (ch !== "_" || after === undefined || !WORD.test(after)),
			});
			i += count;
		} else {
			text += ch;
			i++;
		}
	}
	flush();
	return tokens;
}

/**
 * Pairs the emphasis marks: `*` and `_` for em, `**` and `__` for strong, `~~` for strike. A closing
 * mark pairs with the nearest opening mark of the same character. A mark without a pair stays text.
 */
function matchDelims(tokens: Token[]): Token[] {
	const out: Token[] = [];
	const openers: Record<Delim["ch"], number[]> = { "*": [], _: [], "~": [] };
	for (const token of tokens) {
		if (token.kind !== "delim") {
			out.push(token);
			continue;
		}
		const delim = { ...token };
		const stack = openers[delim.ch];
		while (delim.canClose && delim.count > 0 && stack.length > 0) {
			const index = stack[stack.length - 1] as number;
			const opener = out[index] as Delim;
			if (delim.ch === "~" && (opener.count < 2 || delim.count < 2)) break;
			const use = delim.ch === "~" || (opener.count >= 2 && delim.count >= 2) ? 2 : 1;
			const children = out.splice(index + 1);
			// The opening marks in the children have no pair now. They stay text.
			for (const other of Object.values(openers)) {
				while (other.length > 0 && (other[other.length - 1] as number) > index) other.pop();
			}
			opener.count -= use;
			delim.count -= use;
			if (opener.count === 0) {
				out.pop();
				stack.pop();
			}
			out.push({ kind: "group", mark: delim.ch === "~" ? "strike" : use === 2 ? "strong" : "em", children });
		}
		if (delim.count > 0) {
			out.push(delim);
			if (delim.canOpen) stack.push(out.length - 1);
		}
	}
	return out;
}

function sameMarks(a: readonly DocMark[] | undefined, b: readonly DocMark[]): boolean {
	return JSON.stringify(a ?? []) === JSON.stringify(b);
}

function flatten(tokens: Token[], marks: DocMark[], out: DocInline[]): DocInline[] {
	const pushText = (text: string, textMarks: DocMark[]) => {
		if (text === "") return;
		const last = out[out.length - 1];
		if (last?.type === "text" && sameMarks(last.marks, textMarks)) last.text += text;
		else out.push(textMarks.length > 0 ? { type: "text", text, marks: textMarks } : { type: "text", text });
	};
	for (const token of tokens) {
		switch (token.kind) {
			case "text":
				pushText(token.text, marks);
				break;
			case "code":
				pushText(token.text, withMark(marks, { type: "code" }));
				break;
			case "break":
				out.push({ type: "hard_break" });
				break;
			case "delim":
				pushText(token.ch.repeat(token.count), marks);
				break;
			case "link":
				flatten(token.children, withMark(marks, { type: "link", attrs: { href: token.href } }), out);
				break;
			case "group":
				flatten(token.children, withMark(marks, { type: token.mark }), out);
				break;
		}
	}
	return out;
}

function parseInline(src: string): DocInline[] {
	const inline = flatten(matchDelims(tokenize(src, 0)), [], []);
	// A hard break at the end of a block shows nothing.
	while (inline[inline.length - 1]?.type === "hard_break") inline.pop();
	return inline;
}

function withContent<T extends object>(node: T, content: DocInline[]): T & { content?: DocInline[] } {
	return content.length > 0 ? { ...node, content } : node;
}

// --- Markdown to doc: blocks ----------------------------------------------------------------------

// The text after a fence of backticks has no backtick. Thus a line that starts with a code span is not a fence.
const FENCE = /^ {0,3}(?:(`{3,})[^`]*|(~{3,}).*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>/;
const LIST = /^( {0,3})([-*+]|\d{1,9}[.)])( +|$)(.*)$/;

function isBlank(line: string): boolean {
	return line.trim() === "";
}

function indentOf(line: string): number {
	return line.length - line.trimStart().length;
}

/** The character that tells one list from the next: the bullet, or the mark after the number. */
function listKey(marker: string): string {
	return marker[marker.length - 1] as string;
}

function startsBlock(line: string): boolean {
	return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST.test(line);
}

/** The text of the lines of a paragraph. A line that ends with two spaces or a backslash ends with a hard break. */
function paragraphText(lines: string[]): string {
	let text = "";
	lines.forEach((line, index) => {
		const last = index === lines.length - 1;
		// An odd number of backslashes at the end: the last one is the hard break. An even number is text.
		const slashes = /\\+$/.exec(line)?.[0].length ?? 0;
		const hard = slashes % 2 === 1 ? { index: line.length - 1 } : / {2,}$/.exec(line);
		const body = (hard && !last ? line.slice(0, hard.index) : line).trim();
		text += body;
		if (!last) text += hard ? "\n" : " ";
	});
	return text;
}

function paragraph(lines: string[]): DocBlock {
	return withContent({ type: "paragraph" as const }, parseInline(paragraphText(lines)));
}

/** `depth` is the level of the blocks that these lines make. Blocks over the limit become paragraphs. */
function parseBlocks(lines: string[], depth: number): DocBlock[] {
	const blocks: DocBlock[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] as string;
		if (isBlank(line)) {
			i++;
			continue;
		}
		const fence = FENCE.exec(line);
		if (fence) {
			const marker = (fence[1] ?? fence[2]) as string;
			const close = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`);
			const code: string[] = [];
			i++;
			while (i < lines.length && !close.test(lines[i] as string)) code.push(lines[i++] as string);
			i++;
			const text = code.join("\n");
			blocks.push(text === "" ? { type: "code_block" } : { type: "code_block", content: [{ type: "text", text }] });
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading) {
			const level = Math.min((heading[1] as string).length, 3);
			blocks.push(withContent({ type: "heading" as const, attrs: { level } }, parseInline((heading[2] ?? "").trim())));
			i++;
			continue;
		}
		if (RULE.test(line)) {
			blocks.push({ type: "horizontal_rule" });
			i++;
			continue;
		}
		if (QUOTE.test(line) && depth < DOC_LIMITS.depth) {
			const inner: string[] = [];
			while (i < lines.length && QUOTE.test(lines[i] as string)) {
				inner.push((lines[i++] as string).replace(/^ {0,3}> ?/, ""));
			}
			const content = parseBlocks(inner, depth + 1);
			blocks.push({ type: "blockquote", content: content.length > 0 ? content : [{ type: "paragraph" }] });
			continue;
		}
		const first = LIST.exec(line);
		if (first && depth + 1 < DOC_LIMITS.depth) {
			const key = listKey(first[2] as string);
			const ordered = /\d/.test(first[2] as string);
			const items: ListItem[] = [];
			while (i < lines.length) {
				const match = LIST.exec(lines[i] as string);
				if (!match || listKey(match[2] as string) !== key || RULE.test(lines[i] as string)) break;
				const spaces = (match[3] as string).length;
				const indent =
					(match[1] as string).length + (match[2] as string).length + (spaces >= 1 && spaces <= 4 ? spaces : 1);
				const itemLines = [match[4] as string];
				i++;
				while (i < lines.length) {
					const next = lines[i] as string;
					if (isBlank(next)) {
						let j = i;
						while (j < lines.length && isBlank(lines[j] as string)) j++;
						if (j >= lines.length || indentOf(lines[j] as string) < indent) break;
						while (i < j) {
							itemLines.push("");
							i++;
						}
					} else if (indentOf(next) >= indent) {
						itemLines.push(next.slice(indent));
						i++;
					} else {
						break;
					}
				}
				const content = parseBlocks(itemLines, depth + 2);
				items.push({ type: "list_item", content: content.length > 0 ? content : [{ type: "paragraph" }] });
				// Empty lines between two items of the same list do not end the list.
				let j = i;
				while (j < lines.length && isBlank(lines[j] as string)) j++;
				const after = j < lines.length ? LIST.exec(lines[j] as string) : null;
				if (after && listKey(after[2] as string) === key) i = j;
			}
			blocks.push(
				ordered
					? { type: "ordered_list", attrs: { order: Number.parseInt(first[2] as string, 10) }, content: items }
					: { type: "bullet_list", content: items },
			);
			continue;
		}
		const text = [line];
		i++;
		while (i < lines.length && !isBlank(lines[i] as string) && !startsBlock(lines[i] as string)) {
			text.push(lines[i++] as string);
		}
		blocks.push(paragraph(text));
	}
	return blocks;
}

/** Reads Markdown into the content of a doc. Text that is not Markdown of this subset stays text. */
export function markdownToDoc(markdown: string): DocContent {
	const blocks = parseBlocks(markdown.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n"), 1);
	return { type: "doc", content: blocks.length > 0 ? blocks : [{ type: "paragraph" }] };
}

// --- Doc to Markdown ------------------------------------------------------------------------------

function escapeText(text: string): string {
	return text.replace(/\n/g, " ").replace(/[\\`*_[\]<~]/g, "\\$&");
}

/** Escapes the start of a line that Markdown reads as a heading, a quote, a list or a rule. */
function escapeLineStart(line: string): string {
	if (/^(?:#{1,6}(?:\s|$)|>|[+-](?:\s|$)|-{3,}\s*$)/.test(line)) return `\\${line}`;
	return line.replace(/^(\d{1,9})([.)])(?=\s|$)/, "$1\\$2");
}

function codeSpan(text: string): string {
	let fence = "`";
	while (text.includes(fence)) fence += "`";
	const pad = text.startsWith("`") || text.endsWith("`") || (text.startsWith(" ") && text.endsWith(" ")) ? " " : "";
	return `${fence}${pad}${text}${pad}${fence}`;
}

function hrefOf(node: DocInline): string | null {
	if (node.type !== "text") return null;
	const link = node.marks?.find((mark) => mark.type === "link");
	return link?.type === "link" ? link.attrs.href : null;
}

/** One text with its marks. Spaces at the start and at the end go out of the marks, as Markdown needs. */
function textToMarkdown(node: Extract<DocInline, { type: "text" }>): string {
	const types = new Set((node.marks ?? []).map((mark) => mark.type));
	const [, lead, body, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(node.text) as RegExpExecArray;
	if (body === "") return escapeText(node.text);
	let text = types.has("code") ? codeSpan(body as string) : escapeText(body as string);
	if (types.has("strike")) text = `~~${text}~~`;
	if (types.has("em")) text = `*${text}*`;
	if (types.has("strong")) text = `**${text}**`;
	return `${escapeText(lead as string)}${text}${escapeText(trail as string)}`;
}

function inlineToMarkdown(content: readonly DocInline[] | undefined, oneLine = false): string {
	let out = "";
	const nodes = content ?? [];
	for (let i = 0; i < nodes.length; ) {
		const node = nodes[i] as DocInline;
		if (node.type === "hard_break") {
			out += oneLine ? " " : "\\\n";
			i++;
			continue;
		}
		const href = hrefOf(node);
		if (href === null) {
			out += textToMarkdown(node);
			i++;
			continue;
		}
		// The texts with one link make one Markdown link.
		let label = "";
		while (i < nodes.length && hrefOf(nodes[i] as DocInline) === href) {
			label += textToMarkdown(nodes[i++] as Extract<DocInline, { type: "text" }>);
		}
		// A target with a parenthesis goes in angle brackets, so the link ends at the right place.
		out += /^[^\s()<>]+$/.test(href)
			? `[${label}](${href})`
			: `[${label}](<${href.replace(/[<>]/g, encodeURIComponent)}>)`;
	}
	return out
		.split("\n")
		.map((line) => escapeLineStart(line.trimStart()))
		.join("\n");
}

function indentLines(text: string, first: string, rest: string): string {
	return text
		.split("\n")
		.map((line, index) => (index === 0 ? `${first}${line}` : line === "" ? "" : `${rest}${line}`))
		.join("\n");
}

/** True when a list item is one paragraph, or one paragraph and then lists. Such an item needs no empty line. */
function isTight(item: ListItem): boolean {
	return item.content.every((block, index) =>
		index === 0 ? block.type === "paragraph" : block.type === "bullet_list" || block.type === "ordered_list",
	);
}

function listToMarkdown(list: ListBlock, alternate: boolean): string {
	const tight = list.content.every(isTight);
	const items = list.content.map((item, index) => {
		const marker =
			list.type === "bullet_list"
				? alternate
					? "* "
					: "- "
				: `${(list.attrs?.order ?? 1) + index}${alternate ? ")" : "."} `;
		const body = blocksToMarkdown(item.content, isTight(item) ? "\n" : "\n\n");
		return indentLines(body, marker, " ".repeat(marker.length)).trimEnd();
	});
	return items.join(tight ? "\n" : "\n\n");
}

function blocksToMarkdown(blocks: readonly DocBlock[], separator = "\n\n"): string {
	const parts: string[] = [];
	// The kind of the last block when it was a list, and the marks that it got.
	const last: { list: string | null; alternate: boolean } = { list: null, alternate: false };
	for (const block of blocks) {
		const before = last.list;
		last.list = null;
		switch (block.type) {
			case "paragraph": {
				const text = inlineToMarkdown(block.content);
				// Markdown has no empty paragraph. The first paragraph of a list item is the exception: it holds the place.
				if (text !== "" || parts.length === 0) parts.push(text);
				break;
			}
			case "heading":
				parts.push(`${"#".repeat(block.attrs.level)} ${inlineToMarkdown(block.content, true)}`.trimEnd());
				break;
			case "code_block": {
				const text = (block.content ?? []).map((node) => node.text).join("");
				let fence = "```";
				while (text.includes(fence)) fence += "`";
				parts.push(`${fence}\n${text}${text === "" ? "" : "\n"}${fence}`);
				break;
			}
			case "horizontal_rule":
				parts.push("---");
				break;
			case "blockquote":
				parts.push(
					blocksToMarkdown(block.content)
						.split("\n")
						.map((line) => (line === "" ? ">" : `> ${line}`))
						.join("\n"),
				);
				break;
			case "bullet_list":
			case "ordered_list":
				// Two lists of one kind, one after the other, get different marks. With one mark they are one list.
				last.alternate = before === block.type ? !last.alternate : false;
				last.list = block.type;
				parts.push(listToMarkdown(block, last.alternate));
				break;
		}
	}
	return parts.join(separator);
}

/** Writes the content of a doc as Markdown. */
export function docToMarkdown(doc: DocContent): string {
	const text = blocksToMarkdown(doc.content).trim();
	return text === "" ? "" : `${text}\n`;
}
