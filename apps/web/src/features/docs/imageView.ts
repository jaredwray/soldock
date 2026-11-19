import { DOC_LIMITS } from "@asterra/contracts";
import { closeHistory } from "prosemirror-history";
import type { Node } from "prosemirror-model";
import { NodeSelection } from "prosemirror-state";
import type { EditorView, NodeView } from "prosemirror-view";
import { type Corner, cropStyle, fitWidth, resizedWidth, type Size, shownSize } from "./imageModel.ts";
import type { DocImages } from "./images.ts";
import { imageAttrs, oneLine } from "./schema.ts";

// The view of one image in the editor. It makes its DOM with createElement, and the picture gets a
// `blob:` address from the image store only. The corners change the width, and the line below the
// picture is the caption.

const CORNERS: readonly Corner[] = ["nw", "ne", "sw", "se"];

/** The width of an image while its size is not known: an import from a web address, before its answer. */
const UNKNOWN_WIDTH = 320;

/** The distance from the screen at which an image gets its bytes. */
const LOAD_MARGIN = "800px";

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	node.className = className;
	return node;
}

export class ImageView implements NodeView {
	readonly dom: HTMLElement;
	private node: Node;
	private readonly view: EditorView;
	private readonly getPos: () => number | undefined;
	private readonly images: DocImages;
	private readonly frame: HTMLElement;
	private readonly picture: HTMLImageElement;
	private readonly status: HTMLElement;
	private readonly badge: HTMLElement;
	private caption: HTMLTextAreaElement | null = null;
	/** The size of the picture on screen, for an image whose size the store does not have yet. */
	private loaded: Size | null = null;
	/** What the picture shows: the id of an image, or the address of a preview. */
	private shown: string | null = null;
	private failed = false;
	private near = false;
	private resizing = false;
	private readonly observer: IntersectionObserver | null;
	private readonly unsubscribe: () => void;

	constructor(node: Node, view: EditorView, getPos: () => number | undefined, images: DocImages) {
		this.node = node;
		this.view = view;
		this.getPos = getPos;
		this.images = images;

		this.dom = element("span", "doc-image");
		this.dom.contentEditable = "false";
		this.frame = element("span", "doc-image-frame");
		this.picture = element("img", "doc-image-picture");
		// The node is what a person drags, not the picture in it.
		this.picture.draggable = false;
		this.picture.addEventListener("load", () => {
			this.loaded = { width: this.picture.naturalWidth, height: this.picture.naturalHeight };
			this.dom.classList.add("doc-image-loaded");
			this.render();
		});
		this.status = element("span", "doc-image-status");
		this.badge = element("span", "doc-image-size");
		this.badge.setAttribute("aria-hidden", "true");
		// The clip cuts the picture to the crop. The corners are outside the clip, so they show whole.
		const clip = element("span", "doc-image-clip");
		clip.append(this.picture);
		this.frame.append(clip, this.status, this.badge);
		for (const corner of CORNERS) {
			const handle = element("span", `doc-image-handle doc-image-handle-${corner}`);
			handle.setAttribute("aria-hidden", "true");
			handle.addEventListener("pointerdown", (event) => this.startResize(event, corner));
			this.frame.append(handle);
		}
		this.dom.append(this.frame);

		// An image far below the screen does not get its bytes until a person scrolls near it.
		this.observer =
			typeof IntersectionObserver === "undefined"
				? null
				: new IntersectionObserver(
						(entries) => {
							if (!entries.some((entry) => entry.isIntersecting)) return;
							this.near = true;
							this.observer?.disconnect();
							this.render();
						},
						{ rootMargin: LOAD_MARGIN },
					);
		if (this.observer) this.observer.observe(this.dom);
		else this.near = true;
		// The store tells when an upload has a preview, when it ends, and when the list of the images changes.
		this.unsubscribe = images.subscribe(() => this.render());
		this.render();
	}

	/** The width of the block that holds the image: the most that the image can show. */
	private available(): number {
		return this.dom.parentElement?.clientWidth || this.view.dom.clientWidth || DOC_LIMITS.imageTextWidth;
	}

	private render(): void {
		const attrs = imageAttrs(this.node);
		const job = attrs.pending ? this.images.job(attrs.pending) : undefined;
		const meta = attrs.pending === null && attrs.id !== "" ? this.images.meta(attrs.id) : undefined;
		const natural: Size | null = meta ?? this.loaded;
		const uploading = attrs.pending !== null;
		const missing = !uploading && meta === undefined;

		this.dom.className = [
			"doc-image",
			`doc-image-${attrs.layout.replace("_", "-")}`,
			uploading ? "doc-image-pending" : "",
			missing || this.failed ? "doc-image-missing" : "",
			this.dom.classList.contains("doc-image-loaded") ? "doc-image-loaded" : "",
			this.dom.classList.contains("ProseMirror-selectednode") ? "ProseMirror-selectednode" : "",
			this.resizing ? "doc-image-resizing" : "",
		]
			.filter(Boolean)
			.join(" ");
		this.dom.dataset.layout = attrs.layout;

		if (!this.resizing) {
			const width = attrs.width ?? (natural ? fitWidth(natural, attrs.crop, this.available()) : UNKNOWN_WIDTH);
			this.frame.style.width = `${width}px`;
		}
		const shown = natural ? shownSize(natural, attrs.crop) : { width: 4, height: 3 };
		this.frame.style.aspectRatio = `${shown.width} / ${shown.height}`;
		Object.assign(this.picture.style, cropStyle(attrs.crop));
		this.picture.alt = attrs.alt;

		if (meta) {
			if (this.near && this.shown !== meta.id) {
				this.shown = meta.id;
				this.failed = false;
				const id = meta.id;
				this.images.load(id).then(
					(url) => {
						if (this.shown === id) this.picture.src = url;
					},
					() => {
						if (this.shown !== id) return;
						this.failed = true;
						this.render();
					},
				);
			}
		} else if (job?.preview && this.shown !== job.preview) {
			this.shown = job.preview;
			this.picture.src = job.preview;
		}
		this.status.textContent = uploading
			? job?.preview
				? "Uploading…"
				: "Getting the image…"
			: missing
				? "This image is not available."
				: this.failed
					? "The image did not load."
					: "";

		this.renderCaption(attrs.caption);
	}

	private renderCaption(text: string | null): void {
		if (text === null) {
			this.caption?.remove();
			this.caption = null;
			return;
		}
		if (!this.caption) {
			const caption = element("textarea", "doc-image-caption");
			caption.rows = 1;
			caption.maxLength = DOC_LIMITS.imageCaptionChars;
			caption.placeholder = "Add a caption";
			caption.setAttribute("aria-label", "Caption of the image");
			caption.addEventListener("input", () => {
				this.fitCaption();
				this.change({ caption: oneLine(caption.value, DOC_LIMITS.imageCaptionChars) });
			});
			caption.addEventListener("keydown", (event) => {
				// A caption is one line. Enter and Escape go back to the text of the doc.
				if (event.key !== "Enter" && event.key !== "Escape") return;
				event.preventDefault();
				this.view.focus();
			});
			caption.addEventListener("focus", () => this.select());
			// A caption line without text goes away when the person leaves it.
			caption.addEventListener("blur", () => {
				if (caption.value.trim() === "" && this.view.editable) this.change({ caption: null });
			});
			this.caption = caption;
			this.dom.append(caption);
		}
		this.caption.readOnly = !this.view.editable;
		// The person types in the field, so its own text is the newest.
		if (document.activeElement !== this.caption && this.caption.value !== text) this.caption.value = text;
		this.fitCaption();
	}

	/** The caption has the height of its text. A browser without `field-sizing` needs this. */
	private fitCaption(): void {
		const caption = this.caption;
		if (!caption?.isConnected) return;
		caption.style.height = "auto";
		caption.style.height = `${caption.scrollHeight}px`;
	}

	private select(): void {
		const pos = this.getPos();
		if (pos === undefined) return;
		const { selection, doc, tr } = this.view.state;
		if (selection instanceof NodeSelection && selection.from === pos) return;
		this.view.dispatch(tr.setSelection(NodeSelection.create(doc, pos)));
	}

	/**
	 * Changes attributes of the image, and keeps the image selected. A change of the size is one step of
	 * Undo. The characters of a caption go into one step, as the characters of the text do.
	 */
	private change(patch: Record<string, unknown>, ownStep = false): void {
		const pos = this.getPos();
		if (pos === undefined || !this.view.editable) return;
		const tr = this.view.state.tr.setNodeMarkup(pos, null, { ...this.node.attrs, ...patch });
		tr.setSelection(NodeSelection.create(tr.doc, pos));
		this.view.dispatch(ownStep ? closeHistory(tr) : tr);
	}

	private startResize(event: PointerEvent, corner: Corner): void {
		if (!this.view.editable || event.button !== 0 || imageAttrs(this.node).pending !== null) return;
		event.preventDefault();
		event.stopPropagation();
		this.select();
		const handle = event.currentTarget as HTMLElement;
		const box = this.frame.getBoundingClientRect();
		const start = box.width;
		const ratio = box.height / box.width;
		const max = this.available();
		const { layout } = imageAttrs(this.node);
		let width = Math.round(start);
		handle.setPointerCapture(event.pointerId);
		this.resizing = true;
		this.dom.classList.add("doc-image-resizing");
		const show = () => {
			this.frame.style.width = `${width}px`;
			this.badge.textContent = `${width} × ${Math.round(width * ratio)}`;
		};
		show();
		const move = (moved: PointerEvent) => {
			width = resizedWidth(start, moved.clientX - event.clientX, corner, layout, max);
			show();
		};
		const end = (ended: PointerEvent) => {
			handle.removeEventListener("pointermove", move);
			handle.removeEventListener("pointerup", end);
			handle.removeEventListener("pointercancel", end);
			if (handle.hasPointerCapture(ended.pointerId)) handle.releasePointerCapture(ended.pointerId);
			this.resizing = false;
			if (ended.type === "pointerup" && width !== Math.round(start)) this.change({ width }, true);
			this.render();
		};
		handle.addEventListener("pointermove", move);
		handle.addEventListener("pointerup", end);
		handle.addEventListener("pointercancel", end);
	}

	update(node: Node): boolean {
		if (node.type !== this.node.type) return false;
		const before = imageAttrs(this.node);
		const after = imageAttrs(node);
		// A different image in the same place gets a new view, so no picture of the old image shows.
		if (before.id !== after.id && before.id !== "") return false;
		this.node = node;
		this.render();
		return true;
	}

	/** The caption and the corners handle their own events. Each other event goes to the editor. */
	stopEvent(event: Event): boolean {
		const target = event.target;
		if (!(target instanceof Element)) return false;
		return target === this.caption || target.classList.contains("doc-image-handle");
	}

	ignoreMutation(): boolean {
		return true;
	}

	destroy(): void {
		this.observer?.disconnect();
		this.unsubscribe();
	}
}
