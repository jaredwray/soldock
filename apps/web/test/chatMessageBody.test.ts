import type { ChatBody } from "@asterra/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageBody } from "../src/features/chat/MessageBody.tsx";
import { type MentionPerson, mentionDirectory } from "../src/features/chat/mentions.ts";

const ADA: MentionPerson = {
	id: "prn_01JD0000000000000000000ADA",
	kind: "human",
	display_name: "Ada Lovelace",
	address: "ada@example.com",
	archived_at: null,
};
const BOB: MentionPerson = {
	...ADA,
	id: "prn_01JD0000000000000000000B0B",
	display_name: "Bob",
	address: "bob@example.com",
};

function render(body: ChatBody, ownId = BOB.id): string {
	const mentions = { directory: mentionDirectory([ADA, BOB]), memberIds: new Set<string>(), ownId, groups: true };
	return renderToStaticMarkup(createElement(MessageBody, { body, text: "", mentions }));
}

const paragraph = (
	...content: NonNullable<Extract<ChatBody["content"][number], { type: "paragraph" }>["content"]>
): ChatBody => ({
	type: "doc",
	content: [{ type: "paragraph", content }],
});

describe("a mention node in a message", () => {
	// The node has the id. The link must follow the id, not the label: a handle can change.
	it("links to the profile of its id with its label, marks a mention of the reader or a group, and shows an unknown id as text", () => {
		const html = render(paragraph({ type: "mention", attrs: { id: ADA.id, label: "old-handle" } }));
		expect(html).toContain(`href="/chat/people/${ADA.id}"`);
		expect(html).toContain(">@old-handle</a>");
		expect(html).toContain('title="Ada Lovelace"');
		expect(html).not.toContain("chat-mention-own");
		expect(render(paragraph({ type: "mention", attrs: { id: ADA.id, label: "ada" } }), ADA.id)).toContain(
			"chat-mention-own",
		);
		const gone = render(paragraph({ type: "mention", attrs: { id: "prn_01JD0000000000000000000000", label: "carl" } }));
		expect(gone).toContain("<span>@carl</span>");
		expect(gone).not.toContain("<a");
		// A mention of a group mentions each reader, and links to no profile.
		const group = render(paragraph({ type: "group_mention", attrs: { group: "here" } }));
		expect(group).toBe(
			'<p class="chat-paragraph"><span class="chat-mention chat-mention-own" title="Each member of this room">@here</span></p>',
		);
	});
});
