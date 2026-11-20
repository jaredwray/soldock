import type { ChatBody, ChatBodyBlock, ChatBodyInline } from "@asterra/contracts";
import { Fragment, type ReactNode, useEffect } from "react";
import { Link } from "../../lib/router.tsx";
import { profilePath } from "../../routes.ts";
import { type MentionContext, textParts } from "./mentions.ts";
import { bodyPeople } from "./people.ts";
import { useWantPeople } from "./usePeople.ts";

// The body of a message as React nodes. The body is data, never HTML: each node of the schema has
// one element here, and the text of a node is always text. A node that the schema does not have shows
// nothing, so a newer server cannot put HTML on the page.

type Text = Extract<ChatBodyInline, { type: "text" }>;

/** Text with the mentions of the directory as links to their profiles. */
function TextWithMentions({ text, mentions }: { text: string; mentions: MentionContext }) {
	const parts = textParts(text, mentions.directory);
	return (
		<>
			{parts.map((part, index) =>
				part.person ? (
					<Link
						// The parts of one text keep their order, so the index is a stable key.
						// biome-ignore lint/suspicious/noArrayIndexKey: the same text always gives the same parts.
						key={index}
						to={profilePath(part.person.id)}
						className={part.person.id === mentions.ownId ? "chat-mention chat-mention-own" : "chat-mention"}
						title={part.person.display_name}
					>
						{part.text}
					</Link>
				) : (
					// biome-ignore lint/suspicious/noArrayIndexKey: the same text always gives the same parts.
					<Fragment key={index}>{part.text}</Fragment>
				),
			)}
		</>
	);
}

/**
 * One text node with its marks. A mention in code is code, and a mention in a link is the text of the
 * link: a link in a link is not valid HTML.
 */
function TextNode({ node, mentions }: { node: Text; mentions: MentionContext }) {
	const marks = node.marks ?? [];
	const plain = marks.some((mark) => mark.type === "code" || mark.type === "link");
	let content: ReactNode = plain ? node.text : <TextWithMentions text={node.text} mentions={mentions} />;
	for (const mark of marks) {
		switch (mark.type) {
			case "code":
				content = <code className="chat-code">{content}</code>;
				break;
			case "strong":
				content = <strong>{content}</strong>;
				break;
			case "em":
				content = <em>{content}</em>;
				break;
			case "strike":
				content = <s>{content}</s>;
				break;
			case "link":
				// The schema allows only http, https and mailto. The link opens in a new tab, with no access
				// to this page.
				content = (
					<a href={mark.attrs.href} target="_blank" rel="noopener noreferrer nofollow" className="chat-link">
						{content}
					</a>
				);
				break;
		}
	}
	return <>{content}</>;
}

type Mention = Extract<ChatBodyInline, { type: "mention" }>;

/**
 * A mention node: a link to the profile of its principal, found by its id. So the link stays right when
 * the handle changes. A principal that the directory does not have (a deleted one, or one whose read
 * did not come yet) shows as text.
 */
function MentionNode({ node, mentions }: { node: Mention; mentions: MentionContext }) {
	const person = mentions.directory.byId.get(node.attrs.id);
	const text = `@${node.attrs.label}`;
	if (!person) return <span>{text}</span>;
	return (
		<Link
			to={profilePath(person.id)}
			className={person.id === mentions.ownId ? "chat-mention chat-mention-own" : "chat-mention"}
			title={person.display_name}
		>
			{text}
		</Link>
	);
}

function Inline({ content, mentions }: { content: readonly ChatBodyInline[] | undefined; mentions: MentionContext }) {
	return (
		<>
			{(content ?? []).map((node, index) =>
				node.type === "text" ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: the nodes of a body do not move while it shows.
					<TextNode key={index} node={node} mentions={mentions} />
				) : node.type === "hard_break" ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: the nodes of a body do not move while it shows.
					<br key={index} />
				) : node.type === "mention" ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: the nodes of a body do not move while it shows.
					<MentionNode key={index} node={node} mentions={mentions} />
				) : node.type === "group_mention" ? (
					// A mention of a group mentions each member, so it shows as a mention of the reader.
					// biome-ignore lint/suspicious/noArrayIndexKey: the nodes of a body do not move while it shows.
					<span key={index} className="chat-mention chat-mention-own" title="Each member of this room">
						@{node.attrs.group}
					</span>
				) : null,
			)}
		</>
	);
}

function Blocks({ blocks, mentions }: { blocks: readonly ChatBodyBlock[]; mentions: MentionContext }) {
	return (
		<>
			{blocks.map((block, index) => {
				switch (block.type) {
					case "paragraph":
						return (
							// biome-ignore lint/suspicious/noArrayIndexKey: the blocks of a body do not move while it shows.
							<p key={index} className="chat-paragraph">
								<Inline content={block.content} mentions={mentions} />
							</p>
						);
					case "code_block":
						return (
							// biome-ignore lint/suspicious/noArrayIndexKey: the blocks of a body do not move while it shows.
							<pre key={index} className="chat-code-block">
								<code>{(block.content ?? []).map((node) => node.text).join("")}</code>
							</pre>
						);
					case "blockquote":
						return (
							// biome-ignore lint/suspicious/noArrayIndexKey: the blocks of a body do not move while it shows.
							<blockquote key={index} className="chat-quote">
								<Blocks blocks={block.content} mentions={mentions} />
							</blockquote>
						);
					case "bullet_list":
					case "ordered_list": {
						const items = block.content.map((item, itemIndex) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: the items of a list do not move while it shows.
							<li key={itemIndex}>
								<Blocks blocks={item.content} mentions={mentions} />
							</li>
						));
						return block.type === "bullet_list" ? (
							// biome-ignore lint/suspicious/noArrayIndexKey: the blocks of a body do not move while it shows.
							<ul key={index} className="chat-list">
								{items}
							</ul>
						) : (
							// biome-ignore lint/suspicious/noArrayIndexKey: the blocks of a body do not move while it shows.
							<ol key={index} className="chat-list" start={block.attrs?.order}>
								{items}
							</ol>
						);
					}
					default:
						return null;
				}
			})}
		</>
	);
}

/**
 * The body of a message. Without a body (a message from an older server, or an edit that waits for
 * the server), the text shows as it is, one paragraph with its line breaks.
 *
 * The body asks for the principals of its mentions (`useWantPeople`): its mention nodes by their ids, and the
 * handles in its text. So a message reads its own people, not the directory.
 */
export function MessageBody({
	body,
	text,
	mentions,
}: {
	body: ChatBody | undefined;
	text: string;
	mentions: MentionContext;
}) {
	const wantPeople = useWantPeople();
	useEffect(() => wantPeople(bodyPeople(body, text)), [wantPeople, body, text]);
	if (body) return <Blocks blocks={body.content} mentions={mentions} />;
	return (
		<p className="chat-paragraph">
			<TextWithMentions text={text} mentions={mentions} />
		</p>
	);
}
