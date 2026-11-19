import { dropCursor } from "prosemirror-dropcursor";
import { DOMSerializer, type Slice } from "prosemirror-model";
import { Plugin } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { insertImages, pendingImage, settleImages, startPastedImages } from "./imageCommands.ts";
import { type DocImages, fileProblem, type ImageSource } from "./images.ts";
import { ImageView } from "./imageView.ts";
import { imageDomAttrs, schema } from "./schema.ts";

// The editor side of the images of a doc: the view of an image, a drop and a paste of image files,
// images in pasted HTML, and the end of each upload.
//
// Security rules:
// - A pasted `<img>` never loads. The parse rule of the schema keeps its address as data, and the
//   store uploads the bytes (a `data:` address) or asks the server to download them one time (https).
// - The page shows an image from a `blob:` address of a raster type only.

export interface ImagePluginOptions {
	images: DocImages;
	/** Shows a message to the person, for example the reason that an upload failed. */
	notify: (message: string) => void;
}

/** The image files of a drop or a paste, and the problem of each file that cannot be an image of a doc. */
function imageFiles(data: DataTransfer | null): { files: File[]; problems: string[] } {
	const files: File[] = [];
	const problems: string[] = [];
	for (const file of data?.files ?? []) {
		const problem = fileProblem(file);
		if (problem === null) files.push(file);
		else if (!problems.includes(problem)) problems.push(problem);
	}
	return { files, problems };
}

function hasText(slice: Slice): boolean {
	let found = false;
	slice.content.descendants((node) => {
		if (node.isText) found = true;
		return !found;
	});
	return found;
}

/** Starts a job for each source and puts an image for each job at `pos`, or at the selection. */
export function insertSources(
	view: EditorView,
	images: DocImages,
	sources: readonly ImageSource[],
	pos?: number,
): void {
	if (sources.length === 0 || !view.editable) return;
	const nodes = sources.map((source) => pendingImage(images.start(source)));
	const tr = view.state.tr;
	// Without a position, the new images replace the selection.
	if (pos === undefined && !tr.selection.empty) tr.deleteSelection();
	view.dispatch(insertImages(tr, pos ?? tr.selection.from, nodes));
}

/** The sources for files from a drop, a paste or the file dialog. */
export function fileSources(files: readonly File[]): ImageSource[] {
	return files.map((file) => ({ kind: "file", file, name: file.name || null }));
}

/**
 * The serializer of the clipboard. An image gets the drive and the item of its doc, so a paste into a
 * different doc can copy the image.
 */
function clipboardSerializer(images: DocImages): DOMSerializer {
	const base = DOMSerializer.fromSchema(schema);
	return new DOMSerializer(
		{
			...base.nodes,
			image: (node) => {
				const { spaceId, itemId } = images.target;
				return ["img", { ...imageDomAttrs(node), "data-doc-item": itemId, "data-doc-space": spaceId }];
			},
		},
		base.marks,
	);
}

/** The plugins for the images of a doc: the line that shows where a drop goes, and the image plugin. */
export function imagePlugins({ images, notify }: ImagePluginOptions): Plugin[] {
	const plugin = new Plugin({
		props: {
			nodeViews: {
				image: (node, view, getPos) => new ImageView(node, view, getPos, images),
			},
			clipboardSerializer: clipboardSerializer(images),
			handleDrop(view, event, _slice, moved) {
				const data = event.dataTransfer;
				if (moved || !data || data.files.length === 0) return false;
				const { files, problems } = imageFiles(data);
				for (const problem of problems) notify(problem);
				const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
				insertSources(view, images, fileSources(files), pos ?? view.state.selection.from);
				// The browser must not open a dropped file, so each drop of files stops here.
				return true;
			},
			handlePaste(view, event, slice) {
				// A copy of one picture has its bytes and, often, HTML with its address. The bytes are
				// here, so the server does not download the address. A copy of text with pictures from an
				// office app can have a picture of the whole selection: the text wins.
				const { files } = imageFiles(event.clipboardData);
				if (files.length > 0 && !hasText(slice)) {
					insertSources(view, images, fileSources(files));
					return true;
				}
				// A paste with nothing to parse would go to the fallback of ProseMirror, which lets the
				// browser paste into a live element. Nothing can be inserted, so stop it.
				return slice.content.size === 0;
			},
		},
		appendTransaction(transactions, _before, state) {
			if (!transactions.some((tr) => tr.docChanged)) return null;
			return startPastedImages(state, images);
		},
		view(editorView) {
			let scheduled = false;
			const settle = () => {
				scheduled = false;
				if (editorView.isDestroyed) return;
				const { tr, errors } = settleImages(editorView.state, (key) => images.job(key), editorView.dom.clientWidth);
				if (tr) editorView.dispatch(tr);
				for (const error of errors) notify(`The image did not go into the doc. ${error}`);
			};
			// Not in the update of the view: a dispatch there would run in the dispatch that caused it.
			const schedule = () => {
				if (scheduled) return;
				scheduled = true;
				queueMicrotask(settle);
			};
			const unsubscribe = images.subscribe((job) => {
				if (job) schedule();
			});
			return {
				update(view, before) {
					// An undo or a redo can bring back an image of a job that ended.
					if (before.doc !== view.state.doc) schedule();
				},
				destroy: unsubscribe,
			};
		},
	});
	return [dropCursor({ color: "var(--focus)", width: 2 }), plugin];
}
