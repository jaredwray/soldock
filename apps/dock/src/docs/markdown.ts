import {
	DOC_LIMITS,
	type DocBlock,
	type DocContent,
	type DocImageNode,
	type DocInline,
	type DocMark,
} from "@asterra/contracts";

// Markdown for agents and for downloads. The two functions are a pair: `markdownToDoc` reads all that
// `docToMarkdown` writes. Markdown has no underline and no empty paragraph, so a doc loses those in
// Markdown. Each other format comes back the same.
//
// An image of a doc is `![alt](image:img_… "caption")`. Its options are a query after the id:
// `?width=320&layout=wrap_left&crop=0.1,0.1,0.8,0.8`. The target is the id of an image that the doc
// holds, never an address.

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
	| { kind: "image"; node: DocImageNode }
	| { kind: "group"; mark: "strong" | "em" | "strike"; children: Token[] }
	| { kind: "delim"; ch: "*" | "_" | "~"; count: number; canOpen: boolean; canClose: boolean };

type Delim = Extract<Token, { kind: "delim" }>;

/** The most emphasis marks in emphasis marks. More than a person writes, and few enough for the call stack. */
const MAX_OPEN_MARKS = 32;

/** The longest run of one emphasis character that can be marks: three that close and three that open. */
const MAX_MARK_RUN = 6;

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!~<>|"']/;
const WORD = /[\p{L}\p{N}]/u;

function isSpace(ch: string | undefined): boolean {
	return ch === undefined || /\s/.test(ch);
}

/**
 * The closing bracket of each opening bracket, by position. One pass finds all pairs, so text with
 * many brackets costs no more than its length.
 */
function matchBrackets(src: string): Map<number, number> {
	const pairs = new Map<number, number>();
	const open: number[] = [];
	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		if (ch === "\\") i++;
		else if (ch === "[") open.push(i);
		else if (ch === "]" && open.length > 0) pairs.set(open.pop() as number, i);
	}
	return pairs;
}

/** The start of each run of backticks, by the length of the run, in the order of the text. */
function backtickRuns(src: string): Map<number, number[]> {
	const runs = new Map<number, number[]>();
	for (let i = 0; i < src.length; i++) {
		if (src[i] !== "`") continue;
		let length = 1;
		while (src[i + length] === "`") length++;
		const starts = runs.get(length);
		if (starts) starts.push(i);
		else runs.set(length, [i]);
		i += length - 1;
	}
	return runs;
}

interface LinkSyntax {
	label: string;
	href: string;
	/** The text in quotes after the target, or null. */
	title: string | null;
	end: number;
}

/** A target is at most a link and a title. The title of an image is its caption, with an escape for each character at most. */
const TARGET_CHARS = DOC_LIMITS.hrefChars + 2 * DOC_LIMITS.imageCaptionChars + 100;

function isBlankChar(ch: string | undefined): boolean {
	return ch !== undefined && /\s/.test(ch);
}

/**
 * The link that starts with `[` at `start` and has its `]` at `close`: its label, its target, its title
 * and its end. The scan reads each character one time, so a long run of spaces costs no more than its
 * length. A regular expression with two parts that read spaces would read such a run many times.
 */
function readLink(src: string, start: number, close: number): LinkSyntax | null {
	if (src[close + 1] !== "(") return null;
	// The slice has a limit, so many links cost no more than their text.
	const limit = Math.min(src.length, close + 1 + TARGET_CHARS);
	let i = close + 2;
	const skipBlank = () => {
		while (i < limit && isBlankChar(src[i])) i++;
	};
	skipBlank();
	// The target: `<…>` on one line, or text without spaces. A parenthesis in it needs its pair.
	let href: string | null = null;
	if (src[i] === "<") {
		let end = i + 1;
		while (end < limit && src[end] !== ">" && src[end] !== "<" && src[end] !== "\n") end++;
		if (end < limit && src[end] === ">") {
			href = src.slice(i + 1, end);
			i = end + 1;
		}
	}
	if (href === null) {
		const from = i;
		while (i < limit) {
			const ch = src[i] as string;
			if (ch === "\\") {
				if (i + 1 >= limit || src[i + 1] === "\n") break;
				i += 2;
			} else if (ch === "(") {
				let end = i + 1;
				while (end < limit && !isBlankChar(src[end]) && src[end] !== "(" && src[end] !== ")") end++;
				if (end >= limit || src[end] !== ")") break;
				i = end + 1;
			} else if (ch === ")" || isBlankChar(ch)) {
				break;
			} else {
				i++;
			}
		}
		href = src.slice(from, i);
	}
	// The title: text in quotes, after one space or more.
	const afterTarget = i;
	skipBlank();
	let title: string | null = null;
	const quote = src[i];
	if (i > afterTarget && (quote === '"' || quote === "'")) {
		let end = i + 1;
		while (end < limit && src[end] !== quote) {
			if (src[end] === "\\") {
				if (end + 1 >= limit || src[end + 1] === "\n") return null;
				end++;
			}
			end++;
		}
		if (end >= limit) return null;
		title = src.slice(i + 1, end);
		i = end + 1;
		skipBlank();
	}
	if (i >= limit || src[i] !== ")") return null;
	return { label: src.slice(start + 1, close), href: href.replace(/\\(.)/g, "$1"), title, end: i + 1 };
}

const IMAGE_TARGET = /^image:(img_[0-9A-HJKMNP-TV-Z]{26})(?:\?([^#]*))?$/;

/** The text of an alt text or a caption: no escapes, and one line. */
function plain(text: string): string {
	return text
		.replace(/\\(.)/gs, "$1")
		.replace(/\s*\n\s*/g, " ")
		.trim();
}

const IMAGE_OPTIONS: ReadonlySet<string> = new Set(["width", "layout", "crop"]);

/** The most problems that one call reports. Hostile Markdown can have thousands of bad images. */
const MAX_PROBLEMS = 5;

/** A number in plain decimal form, or NaN. `Number` also reads "", "0x10" and "1e3". */
function decimal(value: string): number {
	return /^(?:\d+\.?\d*|\.\d+)$/.test(value.trim()) ? Number(value) : Number.NaN;
}

/**
 * The image of `![alt](image:img_… "caption")`, or null when the target is not an image of a doc. An
 * option with a bad value stays in the node, so the check of the content refuses it with a message.
 * The content cannot hold an option that is not an option of an image, an option that is there two
 * times, or a crop without 4 numbers. Each of these goes into `problems`: the writer of the Markdown
 * must get a message, because Markdown without that option would come back from the doc.
 */
function imageOf(link: LinkSyntax, problems: string[] | null): DocImageNode | null {
	const target = IMAGE_TARGET.exec(link.href);
	if (!target) return null;
	const id = target[1] as string;
	const report = (problem: string) => {
		if (problems && problems.length < MAX_PROBLEMS) problems.push(`The image ${id} ${problem}`);
	};
	const options = new URLSearchParams(target[2] ?? "");
	const seen = new Set<string>();
	for (const key of options.keys()) {
		if (!IMAGE_OPTIONS.has(key)) {
			report(`has the option "${key.slice(0, 40)}". The options of an image are width, layout and crop.`);
		} else if (seen.has(key)) {
			report(`has the option ${key} two times.`);
		}
		seen.add(key);
	}
	const attrs: DocImageNode["attrs"] = { id, layout: "inline" };
	const width = options.get("width");
	if (width !== null) attrs.width = decimal(width);
	const layout = options.get("layout");
	if (layout !== null) attrs.layout = layout as DocImageNode["attrs"]["layout"];
	const alt = plain(link.label);
	if (alt !== "") attrs.alt = alt;
	const caption = plain(link.title ?? "");
	if (caption !== "") attrs.caption = caption;
	const crop = options.get("crop");
	if (crop !== null) {
		const parts = crop.split(",").map(decimal);
		if (parts.length !== 4) report("has a crop without 4 numbers. A crop is x,y,width,height.");
		const [x, y, w, h] = parts;
		attrs.crop = { x: x ?? Number.NaN, y: y ?? Number.NaN, width: w ?? Number.NaN, height: h ?? Number.NaN };
	}
	return { type: "image", attrs };
}

/**
 * Cuts inline Markdown into tokens. Emphasis marks stay as `delim` tokens for `matchDelims`. With
 * `options.images`, the image of a doc is a token. Without it, such an image stays text.
 */
function tokenize(src: string, linkDepth: number, options: ReadOptions): Token[] {
	const tokens: Token[] = [];
	let text = "";
	const links = linkDepth < 4;
	let brackets: Map<number, number> | null = null;
	let runs: Map<number, number[]> | null = null;
	/** For each length of a backtick run, the place in its list of starts that the scan passed. */
	const passed = new Map<number, number>();
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
			// The closing run is the next run of the same length.
			runs ??= backtickRuns(src);
			const starts = runs.get(length) ?? [];
			let at = passed.get(length) ?? 0;
			while (at < starts.length && (starts[at] as number) < i + length) at++;
			passed.set(length, at);
			const close = at < starts.length ? (starts[at] as number) : -1;
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
		} else if (ch === "!" && next === "[" && options.images) {
			brackets ??= matchBrackets(src);
			const close = brackets.get(i + 1);
			const link = close === undefined ? null : readLink(src, i + 1, close);
			const node = link === null ? null : imageOf(link, options.problems);
			if (link === null || node === null) {
				// Not an image of a doc: the mark is text, and the bracket after it can be a link.
				text += ch;
				i++;
			} else {
				flush();
				tokens.push({ kind: "image", node });
				i = link.end;
			}
		} else if (ch === "[" && links) {
			brackets ??= matchBrackets(src);
			const close = brackets.get(i);
			const link = close === undefined ? null : readLink(src, i, close);
			if (link === null) {
				text += ch;
				i++;
			} else {
				flush();
				const href = safeHref(link.href);
				const children = matchDelims(tokenize(link.label, linkDepth + 1, options));
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
			// A longer run than the marks of two texts that touch is text. One run of thousands of marks
			// would make thousands of marks in marks.
			if (count > MAX_MARK_RUN) {
				text += src.slice(i, i + count);
				i += count;
				continue;
			}
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
	/** The opening marks that wait for a pair. Over the limit, a new mark stays text, so marks in marks stop there. */
	let waiting = 0;
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
				while (other.length > 0 && (other[other.length - 1] as number) > index) {
					other.pop();
					waiting--;
				}
			}
			opener.count -= use;
			delim.count -= use;
			if (opener.count === 0) {
				out.pop();
				stack.pop();
				waiting--;
			}
			out.push({ kind: "group", mark: delim.ch === "~" ? "strike" : use === 2 ? "strong" : "em", children });
		}
		if (delim.count > 0) {
			out.push(delim);
			if (delim.canOpen && waiting < MAX_OPEN_MARKS) {
				stack.push(out.length - 1);
				waiting++;
			}
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
			case "image":
				out.push(token.node);
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

/** How the blocks and the text of one call are read. */
interface ReadOptions {
	/** Each new line in a paragraph is a hard break, as in a chat. */
	breaks: boolean;
	/** The image of a doc is read. */
	images: boolean;
	/** Gets a message for each part of an image that the content cannot hold. */
	problems: string[] | null;
}

function parseInline(src: string, options: ReadOptions): DocInline[] {
	const inline = flatten(matchDelims(tokenize(src, 0, options)), [], []);
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
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>/;
// A list number has at most 5 digits: the limit of `order` in the content schema. A longer number is text.
const LIST = /^( {0,3})([-*+]|\d{1,5}[.)])( +|$)(.*)$/;

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

/** The text of a heading, without the closing run of # that some tools write. */
function headingText(raw: string): string {
	const text = raw.trim();
	let end = text.length;
	while (end > 0 && text[end - 1] === "#") end--;
	const closed = end < text.length && (end === 0 || text[end - 1] === " " || text[end - 1] === "\t");
	return closed ? text.slice(0, end).trim() : text;
}

/** The number of times that `ch` is at the end of `line`. */
function trailing(line: string, ch: string): number {
	let count = 0;
	while (count < line.length && line[line.length - 1 - count] === ch) count++;
	return count;
}

/**
 * The text of the lines of a paragraph. A line that ends with two spaces or a backslash ends with a hard break.
 * With `breaks`, each line ends with a hard break, as in a chat.
 */
function paragraphText(lines: string[], breaks: boolean): string {
	let text = "";
	lines.forEach((line, index) => {
		const last = index === lines.length - 1;
		// An odd number of backslashes at the end: the last one is the hard break. An even number is text.
		const cut = trailing(line, "\\") % 2 === 1 ? 1 : trailing(line, " ") >= 2 ? trailing(line, " ") : 0;
		const hard = cut > 0;
		const body = (hard && !last ? line.slice(0, line.length - cut) : line).trim();
		text += body;
		if (!last) text += hard || breaks ? "\n" : " ";
	});
	return text;
}

function paragraph(lines: string[], options: ReadOptions): DocBlock {
	return withContent({ type: "paragraph" as const }, parseInline(paragraphText(lines, options.breaks), options));
}

/** `depth` is the level of the blocks that these lines make. Blocks over the limit become paragraphs. */
function parseBlocks(lines: string[], depth: number, options: ReadOptions): DocBlock[] {
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
			blocks.push(
				withContent(
					{ type: "heading" as const, attrs: { level } },
					parseInline(headingText(heading[2] ?? ""), options),
				),
			);
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
			const content = parseBlocks(inner, depth + 1, options);
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
				const content = parseBlocks(itemLines, depth + 2, options);
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
		blocks.push(paragraph(text, options));
	}
	return blocks;
}

/**
 * Reads Markdown into the content of a doc. Text that is not Markdown of this subset stays text. With
 * `lineBreaks`, each new line in a paragraph is a hard break, as in a chat. Without it, Markdown joins the lines.
 * With `problems`, the list gets a message for each option of an image that the content cannot hold. A
 * caller that reads images gives the list and refuses the Markdown when the list has a message.
 * With `images`, `![alt](image:img_…)` is an image of the doc. Without it, that text stays text: a chat
 * message has no image.
 */
export function markdownToDoc(
	markdown: string,
	options: { lineBreaks?: boolean; images?: boolean; problems?: string[] } = {},
): DocContent {
	const lines = markdown.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
	const blocks = parseBlocks(lines, 1, {
		breaks: options.lineBreaks === true,
		images: options.images === true,
		problems: options.problems ?? null,
	});
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
	const body = node.text.trim();
	if (body === "") return escapeText(node.text);
	const start = node.text.length - node.text.trimStart().length;
	const lead = node.text.slice(0, start);
	const trail = node.text.slice(start + body.length);
	let text = types.has("code") ? codeSpan(body) : escapeText(body);
	if (types.has("strike")) text = `~~${text}~~`;
	if (types.has("em")) text = `*${text}*`;
	if (types.has("strong")) text = `**${text}**`;
	return `${escapeText(lead)}${text}${escapeText(trail)}`;
}

/** An image of the doc: the alt text, the id with the options, and the caption as the title. */
function imageToMarkdown(node: DocImageNode): string {
	const { id, width, layout, alt, caption, crop } = node.attrs;
	const options: string[] = [];
	if (width !== undefined) options.push(`width=${width}`);
	if (layout !== "inline") options.push(`layout=${layout}`);
	if (crop) options.push(`crop=${[crop.x, crop.y, crop.width, crop.height].join(",")}`);
	const target = `image:${id}${options.length > 0 ? `?${options.join("&")}` : ""}`;
	const title = caption === undefined ? "" : ` "${caption.replace(/[\\"]/g, "\\$&")}"`;
	return `![${(alt ?? "").replace(/[\\[\]]/g, "\\$&")}](${target}${title})`;
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
		if (node.type === "image") {
			out += imageToMarkdown(node);
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
