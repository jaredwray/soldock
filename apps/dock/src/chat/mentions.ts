import {
	type ChatBody,
	type ChatBodyBlock,
	type ChatBodyInline,
	hasMentionSyntax,
	type MentionDirectory,
	mentionDirectory,
	mentionFits,
	textParts,
} from "@soldock/contracts";
import { listPrincipals, type PrincipalRecord } from "../identity/index.ts";
import { bodyText, checkedContent, type MessageContent, mentionsOf } from "./body.ts";

// The mentions of a message. A mention is a node with the id of a principal. The server makes the nodes
// from the text: "@" and a handle or a name alias, with the rules of `mentionDirectory` in the contracts,
// which the web app uses too. So a mention that an agent writes in Markdown and a mention from the
// box of the web app are the same node.

type Mention = Extract<ChatBodyInline, { type: "mention" }>;
type Text = Extract<ChatBodyInline, { type: "text" }>;

/** True when a text can be a mention: it has an "@", and no code mark and no link mark. */
function canHoldMention(node: Text): boolean {
	return node.text.includes("@") && !(node.marks ?? []).some((mark) => mark.type === "code" || mark.type === "link");
}

/**
 * True when the body has a mention node, or a text with the syntax of a mention ("@" and a handle, not an
 * address). Only then the directory loads.
 */
function needsDirectory(body: ChatBody): boolean {
	if (mentionsOf(body).length > 0) return true;
	let found = false;
	const walk = (list: readonly ChatBodyBlock[]) => {
		for (const block of list) {
			if (found) return;
			if (block.type === "paragraph") {
				found = (block.content ?? []).some(
					(node) => node.type === "text" && canHoldMention(node) && hasMentionSyntax(node.text),
				);
			} else if (block.type === "blockquote") walk(block.content);
			else if (block.type === "bullet_list" || block.type === "ordered_list") {
				for (const item of block.content) walk(item.content);
			}
		}
	};
	walk(body.content);
	return found;
}

/** True when a principal can see the room of the message. A mention of any other principal is text. */
type CanSee = (principalId: string) => boolean;

/**
 * The inline nodes of a text, with a mention node for each mention of a principal of the directory that
 * can see the room. Each other mention stays the text that the caller wrote.
 */
function linkText(node: Text, directory: MentionDirectory<PrincipalRecord>, canSee: CanSee): ChatBodyInline[] {
	if (!canHoldMention(node)) return [node];
	return textParts(node.text, directory).map((part): ChatBodyInline => {
		if (part.person && canSee(part.person.id)) {
			return { type: "mention", attrs: { id: part.person.id, label: part.text.slice(1) } };
		}
		return node.marks ? { type: "text", text: part.text, marks: node.marks } : { type: "text", text: part.text };
	});
}

/**
 * A mention node with a label that finds its principal. The label of the time of the write stays when
 * it still finds the principal (a handle or a name alias). Each other label becomes the handle.
 *
 * A mention of a principal that cannot see the room, that the directory does not have (a deleted one),
 * or that has no handle, is text: "@" and the label that the caller sent. So a stored message with such
 * a mention can still change, and a call tells nothing about the ids or the handles outside the room.
 */
function checkedMention(node: Mention, directory: MentionDirectory<PrincipalRecord>, canSee: CanSee): ChatBodyInline {
	const person = directory.byId.get(node.attrs.id);
	const handle = directory.handleOf.get(node.attrs.id);
	if (!person || handle === undefined || !canSee(person.id)) return { type: "text", text: `@${node.attrs.label}` };
	const label = directory.byHandle.get(node.attrs.label.toLowerCase())?.id === person.id ? node.attrs.label : handle;
	return { type: "mention", attrs: { id: person.id, label } };
}

/** The text that an inline node shows: its text, "@" and a label, or a new line. */
function shown(node: ChatBodyInline | undefined): string {
	if (!node) return "";
	if (node.type === "text") return node.text;
	if (node.type === "mention") return `@${node.attrs.label}`;
	return "\n";
}

/**
 * The inline nodes with each mention node that touches a letter, a digit or a mark of an address as
 * text. Its Markdown would read back as a different mention, or as text: "@bot" and "x" is "@botx".
 * This is the rule of a mention in text too.
 */
function fitMentions(content: ChatBodyInline[]): ChatBodyInline[] {
	const out: ChatBodyInline[] = [];
	// The text before the node, back to the start of the line: a link can start in an earlier node. A text
	// with marks has its Markdown marks around it (`code`, **bold**, a link), which end a word. So it is a
	// boundary, before and after a mention.
	let before = "";
	content.forEach((node, index) => {
		const next = content[index + 1];
		const kept: ChatBodyInline =
			node.type === "mention" && !mentionFits(before, marked(next) ? "" : shown(next))
				? { type: "text", text: shown(node) }
				: node;
		out.push(kept);
		before = node.type === "hard_break" || marked(node) ? "" : before + shown(kept);
	});
	return out;
}

/** True for a text with marks. */
function marked(node: ChatBodyInline | undefined): boolean {
	return node?.type === "text" && (node.marks?.length ?? 0) > 0;
}

/** The body with mention nodes for the mentions in its text, and each mention node checked. */
export function linkMentions(body: ChatBody, directory: MentionDirectory<PrincipalRecord>, canSee: CanSee): ChatBody {
	const inline = (content: readonly ChatBodyInline[]): ChatBodyInline[] =>
		fitMentions(
			content.flatMap((node) => {
				if (node.type === "text") return linkText(node, directory, canSee);
				if (node.type === "mention") return [checkedMention(node, directory, canSee)];
				return [node];
			}),
		);
	const blocks = (list: readonly ChatBodyBlock[]): ChatBodyBlock[] =>
		list.map((block): ChatBodyBlock => {
			switch (block.type) {
				case "paragraph":
					return block.content ? { ...block, content: inline(block.content) } : block;
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

/**
 * The content with its mentions as nodes, for the principals that can see the room. The directory loads
 * only for a body with the syntax of a mention, or with a mention node. A plain text keeps its text as it
 * came. The limits, also the limit of mentions, apply to the result.
 */
export async function withMentions(db: D1Database, content: MessageContent, canSee: CanSee): Promise<MessageContent> {
	if (!needsDirectory(content.body)) return content;
	const directory = mentionDirectory(await listPrincipals(db));
	const body = linkMentions(content.body, directory, canSee);
	// A plain text keeps its spaces at the start. A mention is "@" and its label, so the text of a text
	// with mentions is the same text. A body form gets the text of its new labels.
	const sameText = content.text === bodyText(content.body);
	return checkedContent(body, sameText ? bodyText(body) : content.text);
}
