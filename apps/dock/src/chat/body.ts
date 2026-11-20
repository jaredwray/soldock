import {
	CHAT_LIMITS,
	ChatBody,
	type ChatBodyBlock,
	type ChatBodyInline,
	type DocBlock,
	type DocContent,
	type DocInline,
	docToMarkdown,
	type GroupMention,
	markdownToDoc,
} from "@asterra/contracts";
import { OperationError } from "../platform/index.ts";

// The body of a message, from each form that a call can send: text, Markdown or the JSON tree. The
// Markdown reads and writes with the code of the contracts, so a message and a doc have the same
// Markdown. A chat body has fewer formats than a doc: see `fromDoc`.

/** The content of a message as the room stores it: the body, and its plain text. */
export interface MessageContent {
	body: ChatBody;
	text: string;
}

/**
 * The body of a plain text: one paragraph, with a line break for each new line. A CR, or a CR and an
 * LF, is a new line too: an old message can have them.
 */
export function textBody(text: string): ChatBody {
	const content: ChatBodyInline[] = [];
	text.split(/\r\n?|\n/).forEach((line, index) => {
		if (index > 0) content.push({ type: "hard_break" });
		if (line !== "") content.push({ type: "text", text: line });
	});
	return { type: "doc", content: [content.length > 0 ? { type: "paragraph", content } : { type: "paragraph" }] };
}

const CHAT_MARKS: ReadonlySet<string> = new Set(["strong", "em", "strike", "code", "link"]);

function inlineFromDoc(content: readonly DocInline[] | undefined, strong: boolean): ChatBodyInline[] {
	return (content ?? []).flatMap((node): ChatBodyInline[] => {
		// A chat message has no image. The Markdown of a message is read without images, so none comes here.
		if (node.type === "image") return [];
		if (node.type === "hard_break") return [node];
		const marks = (node.marks ?? []).filter((mark) => CHAT_MARKS.has(mark.type)) as NonNullable<
			Extract<ChatBodyInline, { type: "text" }>["marks"]
		>;
		if (strong && !marks.some((mark) => mark.type === "strong") && !marks.some((mark) => mark.type === "code")) {
			marks.push({ type: "strong" });
		}
		return [marks.length > 0 ? { type: "text", text: node.text, marks } : { type: "text", text: node.text }];
	});
}

/**
 * The chat body of a doc. A chat message has no heading, no rule and no underline: a heading becomes
 * a paragraph in bold, a rule goes away, and underline goes away.
 */
function fromDoc(doc: DocContent): ChatBody {
	function blocks(list: readonly DocBlock[]): ChatBodyBlock[] {
		const out: ChatBodyBlock[] = [];
		for (const block of list) {
			switch (block.type) {
				case "paragraph":
				case "heading": {
					const content = inlineFromDoc(block.content, block.type === "heading");
					out.push(content.length > 0 ? { type: "paragraph", content } : { type: "paragraph" });
					break;
				}
				case "code_block":
					out.push(block.content ? { type: "code_block", content: block.content } : { type: "code_block" });
					break;
				case "blockquote": {
					const content = blocks(block.content);
					if (content.length > 0) out.push({ type: "blockquote", content });
					break;
				}
				case "bullet_list":
				case "ordered_list": {
					const items = block.content
						.map((item) => ({ type: "list_item" as const, content: blocks(item.content) }))
						.filter((item) => item.content.length > 0);
					if (items.length === 0) break;
					if (block.type === "bullet_list") out.push({ type: "bullet_list", content: items });
					else
						out.push(
							block.attrs
								? { type: "ordered_list", attrs: block.attrs, content: items }
								: { type: "ordered_list", content: items },
						);
					break;
				}
				case "horizontal_rule":
					break;
			}
		}
		return out;
	}
	const content = blocks(doc.content);
	return { type: "doc", content: content.length > 0 ? content : [{ type: "paragraph" }] };
}

/**
 * The text of an inline node: its text, "@" and the label of a mention, "@" and the group of a mention of
 * a group, or a new line for a line break.
 */
function inlineText(node: ChatBodyInline): string {
	if (node.type === "text") return node.text;
	if (node.type === "mention") return `@${node.attrs.label}`;
	if (node.type === "group_mention") return `@${node.attrs.group}`;
	return "\n";
}

/** The plain text of a body: one line for each block, and a new line for each line break. */
export function bodyText(body: ChatBody): string {
	const lines: string[] = [];
	function walk(list: readonly ChatBodyBlock[]): void {
		for (const block of list) {
			switch (block.type) {
				case "paragraph":
					lines.push((block.content ?? []).map(inlineText).join(""));
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
	}
	walk(body.content);
	return lines.join("\n").trim();
}

/** The depth of blocks in blocks of a body: 1 for a body of paragraphs. A list and its items are one level. */
function depthOf(list: readonly ChatBodyBlock[]): number {
	let deepest = 1;
	for (const block of list) {
		if (block.type === "blockquote") deepest = Math.max(deepest, 1 + depthOf(block.content));
		if (block.type === "bullet_list" || block.type === "ordered_list") {
			for (const item of block.content) deepest = Math.max(deepest, 1 + depthOf(item.content));
		}
	}
	return deepest;
}

/** The blocks of a body, with each list item, as `CHAT_LIMITS.bodyBlocks` counts them. */
function blockCount(list: readonly ChatBodyBlock[]): number {
	let count = 0;
	for (const block of list) {
		count += 1;
		if (block.type === "blockquote") count += blockCount(block.content);
		if (block.type === "bullet_list" || block.type === "ordered_list") {
			for (const item of block.content) count += 1 + blockCount(item.content);
		}
	}
	return count;
}

/**
 * The content of a message from the form that a call sent. Throws `invalid` for content with no text,
 * plain text above `CHAT_LIMITS.messageChars`, a body that is too deep or too large, Markdown with
 * no text, or a body with Markdown above `CHAT_LIMITS.markdownChars`.
 */
export function messageContent(input: {
	text?: string | undefined;
	markdown?: string | undefined;
	body?: ChatBody | undefined;
}): MessageContent {
	let content: MessageContent;
	if (input.text !== undefined) {
		// New lines at the end show nothing. Without them, the Markdown of the text reads back the same.
		const text = input.text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
		content = { body: textBody(text), text };
	} else {
		let body: ChatBody;
		if (input.markdown !== undefined) {
			const markdown = input.markdown.replace(/\r\n?/g, "\n");
			// As in each chat app, a new line is a line break. Markdown itself joins the lines of a paragraph.
			const doc = fromDoc(markdownToDoc(markdown, { lineBreaks: true }));
			// The cheap checks come before the schema, so a large input fails fast and with its reason.
			if (blockCount(doc.content) > CHAT_LIMITS.bodyBlocks) {
				throw new OperationError("invalid", `A message has at most ${CHAT_LIMITS.bodyBlocks} blocks and list items.`);
			}
			if (bodyText(doc).length > CHAT_LIMITS.messageChars) {
				throw new OperationError(
					"invalid",
					`The text of a message has at most ${CHAT_LIMITS.messageChars} characters.`,
				);
			}
			const parsed = ChatBody.safeParse(doc);
			if (!parsed.success) throw new OperationError("invalid", "The Markdown gives a message that Chat cannot show.");
			body = parsed.data;
		} else {
			body = input.body as ChatBody;
			if (blockCount(body.content) > CHAT_LIMITS.bodyBlocks) {
				throw new OperationError("invalid", `A message has at most ${CHAT_LIMITS.bodyBlocks} blocks and list items.`);
			}
		}
		if (depthOf(body.content) > CHAT_LIMITS.bodyDepth) {
			throw new OperationError(
				"invalid",
				`A message can have at most ${CHAT_LIMITS.bodyDepth} levels of blocks in blocks.`,
			);
		}
		content = { body, text: bodyText(body) };
	}
	// The room counts the mentions after it links them: a mention that stays text counts as no mention.
	return checkedContent(content.body, content.text, { countMentions: false });
}

/** The inline nodes of the paragraphs of a body, in the order of the body. A code block has text only. */
function inlineNodes(body: ChatBody): ChatBodyInline[] {
	const found: ChatBodyInline[] = [];
	const walk = (list: readonly ChatBodyBlock[]) => {
		for (const block of list) {
			if (block.type === "paragraph") found.push(...(block.content ?? []));
			else if (block.type === "blockquote") walk(block.content);
			else if (block.type === "bullet_list" || block.type === "ordered_list") {
				for (const item of block.content) walk(item.content);
			}
		}
	};
	walk(body.content);
	return found;
}

/** The mention nodes of the blocks, in the order of the body. */
export function mentionsOf(body: ChatBody): Extract<ChatBodyInline, { type: "mention" }>[] {
	return inlineNodes(body).filter((node) => node.type === "mention");
}

/** The groups that a body mentions ("here", "channel"), each one time, in the order of the body. */
export function groupMentions(body: ChatBody): GroupMention[] {
	const groups = inlineNodes(body).flatMap((node) => (node.type === "group_mention" ? [node.attrs.group] : []));
	return [...new Set(groups)];
}

/**
 * The content of a body after each check of the limits: text, characters, mentions, bytes and Markdown.
 * Each change of a body (the forms of a call, the mentions) ends here.
 */
export function checkedContent(
	body: ChatBody,
	text = bodyText(body),
	options: { countMentions: boolean } = { countMentions: true },
): MessageContent {
	const content: MessageContent = { body, text };
	if (content.text.trim() === "") throw new OperationError("invalid", "The message has no text.");
	if (options.countMentions && mentionsOf(body).length > CHAT_LIMITS.mentions) {
		throw new OperationError("invalid", `A message has at most ${CHAT_LIMITS.mentions} mentions.`);
	}
	if (content.text.length > CHAT_LIMITS.messageChars) {
		throw new OperationError("invalid", `The text of a message has at most ${CHAT_LIMITS.messageChars} characters.`);
	}
	if (new TextEncoder().encode(JSON.stringify(content.body)).length > CHAT_LIMITS.bodyBytes) {
		throw new OperationError("payload_too_large", "The body of the message is too large.");
	}
	// An edit sends the Markdown of the message back. So the Markdown must be in the limit of the input.
	if (bodyMarkdown(content.body).length > CHAT_LIMITS.markdownChars) {
		throw new OperationError(
			"invalid",
			`The Markdown of a message has at most ${CHAT_LIMITS.markdownChars} characters, so that an edit can send it back.`,
		);
	}
	return content;
}

/**
 * The body as Markdown, without the new line at the end that a file of Markdown has. A mention is "@"
 * and its label, and a mention of a group is "@" and the group, so the server reads it as the same
 * mention again.
 */
export function bodyMarkdown(body: ChatBody): string {
	return docToMarkdown(
		mapMentions(body, (node) => ({ type: "text", text: inlineText(node) })) as unknown as DocContent,
	).replace(/\n+$/, "");
}

type AnyMention = Extract<ChatBodyInline, { type: "mention" | "group_mention" }>;

/** The body with each mention node, and each mention of a group, in place of the nodes that `change` gives for it. */
export function mapMentions(body: ChatBody, change: (node: AnyMention) => ChatBodyInline | ChatBodyInline[]): ChatBody {
	const blocks = (list: readonly ChatBodyBlock[]): ChatBodyBlock[] =>
		list.map((block): ChatBodyBlock => {
			switch (block.type) {
				case "paragraph":
					return block.content
						? {
								...block,
								content: block.content.flatMap((node) =>
									node.type === "mention" || node.type === "group_mention" ? change(node) : [node],
								),
							}
						: block;
				case "blockquote":
					return { ...block, content: blocks(block.content) };
				case "bullet_list":
				case "ordered_list":
					return {
						...block,
						content: block.content.map((item) => ({ ...item, content: blocks(item.content) })),
					} as ChatBodyBlock;
				default:
					return block;
			}
		});
	return { ...body, content: blocks(body.content) };
}

/** The ids of the principals that a body mentions, each one time, in the order of the body. */
export function mentionIds(body: ChatBody): string[] {
	return [...new Set(mentionsOf(body).map((node) => node.attrs.id))];
}
