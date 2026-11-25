import type { Node } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { type Draft, newDraft, withSignature } from "../src/features/mail/compose.ts";
import { docToText, schema, textToDoc } from "../src/features/mail/richText.ts";
import { swapSignature } from "../src/features/mail/signatureSwap.ts";

const ADA = "Ada Lovelace\nAnalyst";
// A line that starts with "> " becomes a quote in the body.
const SUPPORT = "Support team\n> We answer in one day";
const QUOTE = "On Monday, Ada wrote:\n> Hello\n> there";
const reply = newDraft({ title: "Reply", text: `\n\n${QUOTE}`, replyToMessageId: "msg_1" });

/** The first body of the composer: the draft with the signature. */
function start(draft: Draft, signature: string): Node {
	return textToDoc(withSignature(draft, signature).text);
}

/** The body after the person typed `text` on the first line. */
function typed(doc: Node, text: string): Node {
	const rest: Node[] = [];
	doc.forEach((child, _offset, index) => {
		if (index > 0) rest.push(child);
	});
	return schema.nodes.doc.create(null, [schema.nodes.paragraph.create(null, schema.text(text)), ...rest]);
}

function text(doc: Node | null): string | null {
	return doc && docToText(doc);
}

// A change of the From in the composer puts the signature of the new mailbox in place of the old one.
describe("the signature after a change of the From", () => {
	it("starts a body that the person did not change again, with the new signature", () => {
		const swapped = swapSignature(start(reply, ADA), reply, { untouched: true, previous: ADA, next: SUPPORT });
		expect(text(swapped)).toBe(text(start(reply, SUPPORT)));
	});

	it("changes the old signature in a changed body, also one with a quote line, and keeps the text around it", () => {
		const body = typed(start(reply, SUPPORT), "Thanks!");
		expect(text(swapSignature(body, reply, { untouched: false, previous: SUPPORT, next: ADA }))).toBe(
			`Thanks!\n\n-- \nAda Lovelace\nAnalyst\n\n${QUOTE}`,
		);
		// An empty signature removes the old one.
		expect(text(swapSignature(body, reply, { untouched: false, previous: SUPPORT, next: "" }))).toBe(
			`Thanks!\n\n\n${QUOTE}`,
		);
	});

	it("adds a signature to a changed body without one: above the quote of a reply, or at the end", () => {
		expect(
			text(swapSignature(typed(start(reply, ""), "Thanks!"), reply, { untouched: false, previous: "", next: ADA })),
		).toBe(`Thanks!\n\n-- \nAda Lovelace\nAnalyst\n\n${QUOTE}`);
		const fresh = newDraft();
		expect(
			text(swapSignature(typed(start(fresh, ""), "Hello"), fresh, { untouched: false, previous: "", next: ADA })),
		).toBe("Hello\n\n-- \nAda Lovelace\nAnalyst");
	});

	it("gives the signature back after a change to a From without one and back", () => {
		const body = typed(start(reply, ADA), "Thanks!");
		const without = swapSignature(body, reply, { untouched: false, previous: ADA, next: "" });
		expect(without).not.toBeNull();
		const back = without && swapSignature(without, reply, { untouched: false, previous: "", next: ADA });
		expect(text(back)).toBe(`Thanks!\n\n\n-- \nAda Lovelace\nAnalyst\n\n${QUOTE}`);
	});

	it("leaves a body alone when the person changed the lines of the signature", () => {
		const changed = textToDoc(docToText(typed(start(reply, ADA), "Thanks!")).replace("Analyst", "Engineer"));
		expect(swapSignature(changed, reply, { untouched: false, previous: ADA, next: SUPPORT })).toBeNull();
	});
});
