import type { Node } from "prosemirror-model";
import { type Draft, signatureLines, withSignature } from "./compose.ts";
import { linesToBlocks, replaceLines, schema, spliceBlocks, textToDoc } from "./richText.ts";

/** A change of the signature in the body of the composer, after a change of the From. */
export interface SignatureChange {
	/** True when the person did not change the body. */
	untouched: boolean;
	/** The signature in the body now, or an empty string for none. */
	previous: string;
	/** The signature of the new From, or an empty string for none. */
	next: string;
}

function isEmptyParagraph(node: Node): boolean {
	return node.type === schema.nodes.paragraph && node.childCount === 0;
}

/**
 * The index where the quote of a reply or the header of a forward starts: the blocks of the draft text
 * without its empty lines at the start. The length of the document when the draft has no such text, or
 * when the person changed it, so a new signature goes at the end.
 */
function tailStart(doc: Node, draft: Draft): number {
	const tail = linesToBlocks(draft.text.split("\n"));
	while (tail[0] && isEmptyParagraph(tail[0])) tail.shift();
	const start = doc.childCount - tail.length;
	if (tail.length === 0 || start < 0) return doc.childCount;
	return tail.every((block, offset) => doc.child(start + offset).eq(block)) ? start : doc.childCount;
}

/**
 * The body after a change of the From, with the signature `next` in place of `previous`. Null when the body
 * stays as it is.
 *
 * - A body that the person did not change starts again from the draft, with the new signature.
 * - In a changed body, the lines of the old signature change. When the person changed those lines, the body
 *   stays as it is.
 * - A changed body without a signature gets the new one where `withSignature` puts it: above the quote of a
 *   reply or the header of a forward, with an empty line around it. When the person changed that text, or the
 *   draft has none, the signature goes at the end.
 */
export function swapSignature(doc: Node, draft: Draft, change: SignatureChange): Node | null {
	if (change.untouched) return textToDoc(withSignature(draft, change.next).text);
	const previous = signatureLines(change.previous);
	const next = signatureLines(change.next);
	if (previous.length > 0) return replaceLines(doc, previous, next);
	if (next.length === 0) return null;
	const start = tailStart(doc, draft);
	const empty = schema.nodes.paragraph.create();
	const before = start > 0 && !isEmptyParagraph(doc.child(start - 1)) ? [empty] : [];
	const after = start < doc.childCount ? [empty] : [];
	return spliceBlocks(doc, start, 0, [...before, ...linesToBlocks(next), ...after]);
}
