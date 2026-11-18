import type { DocImage } from "@soldock/contracts";
import { closeHistory } from "prosemirror-history";
import { Fragment, type Node } from "prosemirror-model";
import { type Command, type EditorState, NodeSelection, Selection, type Transaction } from "prosemirror-state";
import { insertPoint } from "prosemirror-transform";
import { fitWidth } from "./imageModel.ts";
import type { ImageJob, ImageSource } from "./images.ts";
import { type ImageAttrs, imageAttrs, schema } from "./schema.ts";

// The commands for the images of a doc. Each one works on an EditorState only, so the Node tests can
// run them without a DOM.

const { nodes } = schema;

export interface SelectedImage {
	pos: number;
	node: Node;
	attrs: ImageAttrs;
}

/** The image that is selected as a node, or null. The image toolbar shows for it. */
export function selectedImage(state: EditorState): SelectedImage | null {
	const { selection } = state;
	if (!(selection instanceof NodeSelection) || selection.node.type !== nodes.image) return null;
	return { pos: selection.from, node: selection.node, attrs: imageAttrs(selection.node) };
}

/** Changes attributes of the selected image. The image stays selected. */
export function setImageAttrs(patch: Partial<ImageAttrs>): Command {
	return (state, dispatch) => {
		const image = selectedImage(state);
		if (!image) return false;
		if (dispatch) {
			const tr = state.tr.setNodeMarkup(image.pos, null, { ...image.node.attrs, ...patch });
			// Each change of the toolbar is one step of Undo, also when two changes come fast.
			dispatch(closeHistory(tr.setSelection(NodeSelection.create(tr.doc, image.pos))));
		}
		return true;
	};
}

/** Removes the selected image. */
export const removeImage: Command = (state, dispatch) => {
	if (!selectedImage(state)) return false;
	if (dispatch) dispatch(state.tr.deleteSelection().scrollIntoView());
	return true;
};

/** An image node that waits for the end of a job of the image store. */
export function pendingImage(job: Pick<ImageJob, "key">, attrs: Partial<ImageAttrs> = {}): Node {
	return nodes.image.create({ ...attrs, id: "", pending: job.key });
}

/**
 * Adds to `tr`: image nodes at a position of its document, and the cursor after them. In a block of
 * text, the images go into the text. At a position between blocks, they get a paragraph of their own.
 * A code block holds text only, so there the images go below the block.
 */
export function insertImages(tr: Transaction, position: number, images: readonly Node[]): Transaction {
	if (images.length === 0) return tr;
	let pos = Math.max(0, Math.min(position, tr.doc.content.size));
	let $pos = tr.doc.resolve(pos);
	if ($pos.parent.type.spec.code) {
		pos = $pos.after();
		$pos = tr.doc.resolve(pos);
	}
	if ($pos.parent.inlineContent) {
		tr.insert(pos, Fragment.from(images));
		tr.setSelection(Selection.near(tr.doc.resolve(pos + images.reduce((size, node) => size + node.nodeSize, 0)), -1));
		return tr.scrollIntoView();
	}
	const paragraph = nodes.paragraph.create(null, Fragment.from(images));
	// The nearest place that can hold a paragraph, or the end of the document.
	const at = insertPoint(tr.doc, pos, nodes.paragraph) ?? tr.doc.content.size;
	tr.insert(at, paragraph);
	tr.setSelection(Selection.near(tr.doc.resolve(at + paragraph.nodeSize - 1), -1));
	return tr.scrollIntoView();
}

interface Found {
	pos: number;
	node: Node;
	attrs: ImageAttrs;
}

/** Each image of the document that the doc does not hold yet. */
function pendingImages(doc: Node): Found[] {
	const found: Found[] = [];
	doc.descendants((node, pos) => {
		if (node.type !== nodes.image) return !node.isTextblock || node.childCount > 0;
		const attrs = imageAttrs(node);
		if (attrs.pending !== null) found.push({ pos, node, attrs });
		return false;
	});
	return found;
}

/** Applies a change to each found image, from the last to the first, so each position stays good. */
function changeEach(
	state: EditorState,
	found: readonly Found[],
	change: (image: Found) => Partial<ImageAttrs> | "remove" | null,
): Transaction | null {
	const tr = state.tr;
	const selected = selectedImage(state)?.pos ?? null;
	let keepSelected = false;
	for (const image of [...found].reverse()) {
		const next = change(image);
		if (next === null) continue;
		if (next === "remove") {
			tr.delete(image.pos, image.pos + image.node.nodeSize);
		} else {
			tr.setNodeMarkup(image.pos, null, { ...image.node.attrs, ...next });
			if (image.pos === selected) keepSelected = true;
		}
	}
	if (!tr.docChanged) return null;
	// A change of a node puts the cursor next to it. A selected image stays selected.
	if (keepSelected && selected !== null) {
		const pos = tr.mapping.map(selected, -1);
		if (tr.doc.nodeAt(pos)?.type === nodes.image) tr.setSelection(NodeSelection.create(tr.doc, pos));
	}
	return tr;
}

/**
 * Starts the work for each image that a paste or a drop of HTML brought in. An image of a web page
 * has `src:<address>`: the store uploads it or asks the server to download it. An image of a
 * different doc has `doc:<space id>:<item id>`: the store copies it, with the same id. An image of
 * this doc needs no work. Returns the transaction that gives each node its job, or null.
 */
export function startPastedImages(
	state: EditorState,
	store: { target: { itemId: string }; holds: (id: string) => boolean; start: (source: ImageSource) => ImageJob },
): Transaction | null {
	const found = pendingImages(state.doc).filter((image) => !image.attrs.pending?.startsWith("job:"));
	return changeEach(state, found, ({ attrs }) => {
		const pending = attrs.pending as string;
		if (pending.startsWith("src:")) {
			return { pending: store.start({ kind: "address", src: pending.slice(4) }).key };
		}
		const [kind, spaceId, itemId] = pending.split(":");
		if (kind !== "doc" || attrs.id === "" || !itemId) return "remove";
		if (itemId === store.target.itemId || store.holds(attrs.id)) return { pending: null };
		return {
			pending: store.start({ kind: "doc", spaceId: spaceId || null, itemId, imageId: attrs.id }).key,
		};
	});
}

/**
 * Gives each image of an ended job its id, and removes each image of a failed job. `errors` has the
 * message of each failed job. The transaction is not a step of the undo history: an undo of the
 * insert removes the image, and a redo brings it back with its job, which this function reads again.
 */
export function settleImages(
	state: EditorState,
	jobOf: (key: string) => ImageJob | undefined,
	available: number,
): { tr: Transaction | null; errors: string[] } {
	const errors: string[] = [];
	const found = pendingImages(state.doc).filter((image) => image.attrs.pending?.startsWith("job:"));
	const tr = changeEach(state, found, ({ attrs }) => {
		const job = jobOf(attrs.pending as string);
		// A job of a different editor, for example from a copy in a second tab: nothing ends it here.
		if (!job) return "remove";
		if (job.status === "running") return null;
		if (job.status === "failed" || !job.image) {
			if (job.error && !errors.includes(job.error)) errors.push(job.error);
			return "remove";
		}
		return settled(job.image, attrs, available);
	});
	return { tr: tr?.setMeta("addToHistory", false) ?? null, errors };
}

function settled(image: DocImage, attrs: ImageAttrs, available: number): Partial<ImageAttrs> {
	return { id: image.id, pending: null, width: attrs.width ?? fitWidth(image, attrs.crop, available) };
}
