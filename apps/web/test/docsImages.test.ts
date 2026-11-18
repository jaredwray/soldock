import { DOC_LIMITS, DocContent, type DocImage } from "@soldock/contracts";
import { history, redo, undo } from "prosemirror-history";
import type { Node } from "prosemirror-model";
import { type Command, EditorState, NodeSelection, type TextSelection } from "prosemirror-state";
import { describe, expect, it, vi } from "vitest";
import {
	insertImages,
	pendingImage,
	selectedImage,
	setImageAttrs,
	settleImages,
	startPastedImages,
} from "../src/features/docs/imageCommands.ts";
import {
	cropStyle,
	fitWidth,
	layoutForMode,
	layoutForSide,
	movedCrop,
	presetOf,
	presetWidth,
	resizedCrop,
	resizedWidth,
	widthAfterCrop,
} from "../src/features/docs/imageModel.ts";
import { DocImages, dataUrlBlob, fileProblem, type ImageJob, type ImageSource } from "../src/features/docs/images.ts";
import { contentToDoc, docToContent, imageAttrs, importableSrc, schema } from "../src/features/docs/schema.ts";

const { nodes } = schema;

const ID = "img_01JD3V0Y9XG8Q2W4E6R8T0Y2V4";
const OTHER = "img_01JD3V0Y9XG8Q2W4E6R8T0Y2V5";

function p(...content: (string | Node)[]): Node {
	return nodes.paragraph.create(
		null,
		content.map((part) => (typeof part === "string" ? schema.text(part) : part)),
	);
}

const image = (attrs: Record<string, unknown> = {}) => nodes.image.create({ id: ID, ...attrs });
const doc = (...content: Node[]) => nodes.doc.create(null, content);

function meta(id: string, width = 800, height = 600): DocImage {
	return {
		id,
		mime_type: "image/png",
		size: 1000,
		width,
		height,
		name: null,
		created_at: "2026-01-01T00:00:00.000Z",
		untrusted: false,
	};
}

/** The images of a document, as the server gets them. */
function imagesOf(content: DocContent) {
	return JSON.stringify(content).match(/"type":"image"/g)?.length ?? 0;
}

describe("the content of a doc with images", () => {
	// The server stores the content that the editor sends. The same doc must make the same content, or
	// each load of a doc makes a new revision.
	it("comes back the same from the editor, with each option of an image", () => {
		const content: DocContent = {
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [
						{ type: "text", text: "Before " },
						{ type: "image", attrs: { id: ID, width: 320, layout: "inline" } },
						{
							type: "image",
							attrs: {
								id: OTHER,
								width: 200,
								layout: "wrap_right",
								alt: "A chart",
								caption: "Sales by month",
								crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.25 },
							},
						},
					],
				},
				{
					type: "heading",
					attrs: { level: 2 },
					content: [{ type: "image", attrs: { id: ID, layout: "break_center" } }],
				},
			],
		};
		expect(docToContent(contentToDoc(content))).toEqual(content);
		expect(DocContent.safeParse(docToContent(contentToDoc(content))).success).toBe(true);
	});

	// The server refuses content with an image that the doc does not hold. Such a save would fail each time.
	it("has no image that still uploads, and no image that the doc does not hold", () => {
		const editorDoc = doc(
			p(
				"a ",
				image(),
				nodes.image.create({ id: "", pending: "job:1" }),
				image({ id: OTHER }),
				image({ pending: "job:2" }),
			),
		);
		expect(imagesOf(docToContent(editorDoc))).toBe(2);
		expect(imagesOf(docToContent(editorDoc, { holdsImage: (id) => id === ID }))).toBe(1);
		expect(DocContent.safeParse(docToContent(editorDoc)).success).toBe(true);
	});

	// A paste can bring a slice of a ProseMirror editor with any attribute. Only values that the server
	// accepts go into a save.
	it("has each option of an image in the limits of the server", () => {
		const hostile = image({
			width: 99_999,
			layout: "behind",
			alt: `line one\nline two${"x".repeat(2000)}`,
			caption: "",
			crop: { x: -1, y: 0.9999, width: 5, height: 5 },
			pending: null,
		});
		const content = docToContent(doc(p(hostile, image({ width: "12abc", crop: { x: 0, y: 0, width: 1, height: 1 } }))));
		expect(DocContent.safeParse(content).success).toBe(true);
		const [first, second] = (content.content[0] as { content: { attrs: Record<string, unknown> }[] }).content;
		expect(first?.attrs).toMatchObject({ width: DOC_LIMITS.imageMaxWidth, layout: "inline" });
		expect(first?.attrs.alt).toMatch(/^line one line two/);
		expect(first?.attrs).not.toHaveProperty("caption");
		expect(first?.attrs.crop).toEqual({ x: 0, y: 0.99, width: 1, height: 0.01 });
		// A width that is not a number, and a crop of the whole image, go away.
		expect(second?.attrs).toEqual({ id: ID, layout: "inline" });
	});

	it("reads a pasted address only when the editor can bring the picture into the doc", () => {
		expect(importableSrc("https://example.com/a.png?size=2")).toBe("https://example.com/a.png?size=2");
		expect(importableSrc("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
		for (const src of [
			"http://example.com/a.png",
			"javascript:alert(1)",
			"data:image/svg+xml;base64,AAAA",
			"data:text/html;base64,AAAA",
			"blob:https://example.com/1",
			"file:///C:/a.png",
			"/relative.png",
			`https://example.com/${"a".repeat(3000)}`,
		]) {
			expect(importableSrc(src), src).toBeNull();
		}
	});
});

describe("the geometry of an image", () => {
	it("gives an image without a width the width of its shown part, at most the width of the text", () => {
		expect(fitWidth({ width: 3000, height: 1000 }, null, 654)).toBe(654);
		expect(fitWidth({ width: 200, height: 100 }, null, 654)).toBe(200);
		expect(fitWidth({ width: 1000, height: 100 }, { x: 0, y: 0, width: 0.25, height: 1 }, 654)).toBe(250);
		expect(fitWidth({ width: 4, height: 4 }, null, 654)).toBe(DOC_LIMITS.imageMinWidth);
	});

	// The corner must stay below the pointer, at each side and in each layout.
	it("changes the width with the corner that moves, in the limits", () => {
		expect(resizedWidth(300, 40, "se", "inline", 654)).toBe(340);
		expect(resizedWidth(300, 40, "ne", "wrap_left", 654)).toBe(340);
		expect(resizedWidth(300, 40, "sw", "inline", 654)).toBe(260);
		expect(resizedWidth(300, -40, "nw", "wrap_right", 654)).toBe(340);
		// An image in the center grows at its two sides.
		expect(resizedWidth(300, 40, "se", "break_center", 654)).toBe(380);
		expect(resizedWidth(300, 900, "se", "inline", 654)).toBe(654);
		expect(resizedWidth(300, -900, "se", "inline", 654)).toBe(24);
	});

	it("shows only the crop in the frame of the image", () => {
		expect(cropStyle(null)).toEqual({ width: "100%", height: "100%", left: "0%", top: "0%" });
		expect(cropStyle({ x: 0.5, y: 0.25, width: 0.5, height: 0.25 })).toEqual({
			width: "200%",
			height: "400%",
			left: "-100%",
			top: "-100%",
		});
	});

	it("keeps a crop in the image, and not smaller than the limit", () => {
		const crop = { x: 0.2, y: 0.2, width: 0.5, height: 0.5 };
		expect(movedCrop(crop, 0.9, -0.9)).toEqual({ x: 0.5, y: 0, width: 0.5, height: 0.5 });
		expect(resizedCrop(crop, "w", 0.1, 0)).toMatchObject({ x: expect.closeTo(0.3), width: expect.closeTo(0.4) });
		expect(resizedCrop(crop, "se", 5, 5)).toMatchObject({ x: 0.2, y: 0.2, width: 0.8, height: 0.8 });
		// A side cannot go over the opposite side.
		const thin = resizedCrop(crop, "e", -5, 0);
		expect(thin.x).toBe(0.2);
		expect(thin.width).toBeCloseTo(DOC_LIMITS.imageMinCrop);
		const flat = resizedCrop(crop, "n", 0, 5);
		expect(flat.y + flat.height).toBeCloseTo(0.7);
		expect(flat.height).toBeCloseTo(DOC_LIMITS.imageMinCrop);
	});

	it("keeps the scale of the picture after a crop", () => {
		expect(widthAfterCrop(400, null, { x: 0.5, y: 0, width: 0.5, height: 1 })).toBe(200);
		expect(widthAfterCrop(200, { x: 0.5, y: 0, width: 0.5, height: 1 }, null)).toBe(400);
	});

	it("gives the sizes of the size control, and finds the size of an image in them", () => {
		const natural = { width: 400, height: 300 };
		expect(presetWidth("50", natural, null, 654)).toBe(327);
		expect(presetWidth("original", natural, null, 654)).toBe(400);
		expect(presetOf(327, natural, null, 654)).toBe("50");
		expect(presetOf(400, natural, null, 654)).toBe("original");
		expect(presetOf(null, natural, null, 654)).toBe("original");
		expect(presetOf(301, natural, null, 654)).toBeNull();
	});

	it("keeps the side of an image when the mode changes, where the mode has that side", () => {
		expect(layoutForMode("wrap", "inline")).toBe("wrap_left");
		expect(layoutForMode("break", "inline")).toBe("break_center");
		expect(layoutForMode("break", "wrap_right")).toBe("break_right");
		expect(layoutForMode("wrap", "break_right")).toBe("wrap_right");
		// The text cannot go around an image in the center.
		expect(layoutForMode("wrap", "break_center")).toBe("wrap_left");
		expect(layoutForMode("inline", "break_center")).toBe("inline");
		expect(layoutForSide("center", "wrap_left")).toBeNull();
		expect(layoutForSide("right", "wrap_left")).toBe("wrap_right");
		expect(layoutForSide("center", "break_left")).toBe("break_center");
		expect(layoutForSide("left", "inline")).toBeNull();
	});
});

function stateOf(content: Node, selection?: (doc: Node) => TextSelection | NodeSelection): EditorState {
	return EditorState.create({
		doc: content,
		plugins: [history()],
		...(selection ? { selection: selection(content) } : {}),
	});
}

function run(current: EditorState, command: Command): EditorState {
	let next = current;
	expect(command(current, (tr) => (next = current.apply(tr)))).toBe(true);
	return next;
}

const job = (key: string, status: ImageJob["status"], result: Partial<ImageJob> = {}): ImageJob => ({
	key,
	status,
	preview: null,
	image: null,
	error: null,
	...result,
});

describe("new images in the editor", () => {
	const pending = (key: string) => pendingImage({ key });

	it("go into the text at a position in a block of text", () => {
		const state = stateOf(doc(p("Hello world")));
		const next = state.apply(insertImages(state.tr, 7, [pending("job:1"), pending("job:2")]));
		const paragraph = next.doc.firstChild as Node;
		expect(next.doc.childCount).toBe(1);
		expect([
			paragraph.child(0).text,
			paragraph.child(1).type.name,
			paragraph.child(2).type.name,
			paragraph.child(3).text,
		]).toEqual(["Hello ", "image", "image", "world"]);
		// The cursor is after the images, so the person can continue with the text.
		expect(next.selection.from).toBe(9);
	});

	it("get a paragraph of their own at a position between blocks, below a code block, and in a list", () => {
		const blocks = doc(
			p("one"),
			nodes.code_block.create(null, schema.text("let a;")),
			nodes.bullet_list.create(null, [nodes.list_item.create(null, p("item"))]),
		);
		const state = stateOf(blocks);
		// Between the first paragraph and the code block.
		let next = state.apply(insertImages(state.tr, 5, [pending("job:1")]));
		expect(next.doc.child(1).type).toBe(nodes.paragraph);
		expect(next.doc.child(1).firstChild?.type).toBe(nodes.image);
		// In the code block: a code block holds text only.
		next = state.apply(insertImages(state.tr, 8, [pending("job:1")]));
		expect(next.doc.child(1).textContent).toBe("let a;");
		expect(next.doc.child(2).firstChild?.type).toBe(nodes.image);
		// Between the items of a list: no paragraph can be there, so the image goes to a place that holds one.
		const listStart = 5 + blocks.child(1).nodeSize;
		next = state.apply(insertImages(state.tr, listStart + 1, [pending("job:1")]));
		expect(() => next.doc.check()).not.toThrow();
		expect(JSON.stringify(next.doc.toJSON())).toContain('"pending":"job:1"');
	});

	// A save has only the images that the store holds. A pasted image that the store does not hold
	// must get a job, also when it is an image of this doc from a second tab, or the save loses it.
	it("start an upload for a pasted address, and a copy for an image that the store does not hold", () => {
		const started: ImageSource[] = [];
		const store = {
			holds: (id: string) => id === OTHER,
			start: (source: ImageSource) => {
				started.push(source);
				return job(`job:${started.length}`, "running");
			},
		};
		const pasted = doc(
			p(
				nodes.image.create({ id: "", pending: "src:https://example.com/a.png", alt: "Web" }),
				// An image that the store holds: no work.
				image({ id: OTHER, pending: "doc:prn_1:itm_other" }),
				// An image of a different doc.
				image({ pending: "doc:prn_2:itm_other", width: 240 }),
				// Not a value that the paste rules make.
				image({ pending: "what" }),
			),
		);
		const state = stateOf(pasted);
		const tr = startPastedImages(state, store);
		expect(tr).not.toBeNull();
		const next = state.apply(tr as NonNullable<typeof tr>);
		expect(started).toEqual([
			{ kind: "doc", spaceId: "prn_2", itemId: "itm_other", imageId: ID },
			{ kind: "address", src: "https://example.com/a.png" },
		]);
		const found: [string, string | null][] = [];
		next.doc.descendants((node) => {
			if (node.type === nodes.image) found.push([imageAttrs(node).id, imageAttrs(node).pending]);
		});
		expect(found).toEqual([
			["", "job:2"],
			[OTHER, null],
			[ID, "job:1"],
		]);
		// A second pass finds no work, so one paste starts each upload one time.
		expect(startPastedImages(next, store)).toBeNull();
	});

	it("get their id when the upload ends, and leave the doc when it fails", () => {
		const state = stateOf(
			doc(p("a", pending("job:done"), pending("job:running"), pending("job:failed"), pending("job:gone"))),
		);
		const jobs = new Map([
			["job:done", job("job:done", "done", { image: meta(ID, 2000, 1000) })],
			["job:running", job("job:running", "running")],
			["job:failed", job("job:failed", "failed", { error: "The file is not an image." })],
		]);
		const { tr, errors } = settleImages(state, (key) => jobs.get(key), 654);
		expect(errors).toEqual(["The file is not an image."]);
		const next = state.apply(tr as NonNullable<typeof tr>);
		const paragraph = next.doc.firstChild as Node;
		expect(paragraph.childCount).toBe(3);
		// The image has the width of its file, at most the width of the text.
		expect(imageAttrs(paragraph.child(1))).toMatchObject({ id: ID, pending: null, width: 654 });
		expect(imageAttrs(paragraph.child(2))).toMatchObject({ id: "", pending: "job:running" });
		expect(settleImages(next, (key) => jobs.get(key), 654).tr).toBeNull();
	});

	// The end of an upload is not a step of Undo. One Undo removes the image, and Redo brings it back
	// with its id, not as an upload that never ends.
	it("undo the insert in one step, and redo it with the id of the image", () => {
		const jobs = new Map([["job:1", job("job:1", "done", { image: meta(ID) })]]);
		const jobOf = (key: string) => jobs.get(key);
		const empty = stateOf(doc(p("text")));
		const inserted = empty.apply(insertImages(empty.tr, 5, [pending("job:1")]));
		const settled = inserted.apply(
			settleImages(inserted, jobOf, 654).tr as NonNullable<ReturnType<typeof settleImages>["tr"]>,
		);
		expect(imagesOf(docToContent(settled.doc))).toBe(1);
		const undone = run(settled, undo);
		expect(undone.doc.textContent).toBe("text");
		expect(undone.doc.firstChild?.childCount).toBe(1);
		const redone = run(undone, redo);
		const again = settleImages(redone, jobOf, 654).tr;
		const final = again ? redone.apply(again) : redone;
		expect(imagesOf(docToContent(final.doc))).toBe(1);
	});

	it("keep a selected image selected when its upload ends", () => {
		const content = doc(p("a", pending("job:1")));
		const state = stateOf(content, (node) => NodeSelection.create(node, 2));
		const { tr } = settleImages(state, () => job("job:1", "done", { image: meta(ID) }), 654);
		const next = state.apply(tr as NonNullable<typeof tr>);
		expect(selectedImage(next)?.attrs.id).toBe(ID);
	});
});

describe("a change of the selected image", () => {
	const selected = () => stateOf(doc(p("a", image({ width: 300 }), "b")), (node) => NodeSelection.create(node, 2));

	it("keeps the image selected, so the toolbar stays", () => {
		const next = run(selected(), setImageAttrs({ layout: "wrap_right", width: 200 }));
		expect(selectedImage(next)?.attrs).toMatchObject({ id: ID, layout: "wrap_right", width: 200 });
		expect(setImageAttrs({ width: 1 })(stateOf(doc(p("no image"))))).toBe(false);
	});

	// Two clicks in the toolbar in less than a moment are two changes. Each one needs its own Undo.
	it("is one step of Undo for each change", () => {
		let state = run(selected(), setImageAttrs({ layout: "break_center" }));
		state = run(state, setImageAttrs({ width: 100 }));
		state = run(state, undo);
		expect(selectedImage(state)?.attrs).toMatchObject({ layout: "break_center", width: 300 });
		state = run(state, undo);
		expect(imageAttrs((state.doc.firstChild as Node).child(1))).toMatchObject({ layout: "inline", width: 300 });
	});
});

describe("the image store of a doc", () => {
	const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

	/** A store with a fake server that records each call and answers from `answers`. */
	function storeWith(answers: Record<string, (input: Record<string, unknown>) => unknown>) {
		const calls: { name: string; input: Record<string, unknown> }[] = [];
		const call = (async (name: string, input: Record<string, unknown>) => {
			calls.push({ name, input });
			const answer = answers[name];
			if (!answer) throw new Error(`no answer for ${name}`);
			return answer(input);
		}) as never;
		return { store: new DocImages({ spaceId: "prn_1", itemId: "itm_1" }, call), calls };
	}

	function ended(store: DocImages, source: ImageSource): Promise<ImageJob> {
		return new Promise((resolve) => {
			const stop = store.subscribe((done) => {
				if (!done) return;
				stop();
				resolve(done);
			});
			store.start(source);
		});
	}

	it("uploads a file, and shows it from the bytes that the editor has", async () => {
		const { store, calls } = storeWith({ "docs.upload_image": () => ({ image: meta(ID) }) });
		const file = new File([PNG], "chart.png", { type: "image/png" });
		const done = await ended(store, { kind: "file", file, name: "chart.png" });
		expect(done).toMatchObject({ status: "done", image: { id: ID } });
		expect(calls).toEqual([
			{
				name: "docs.upload_image",
				input: {
					space_id: "prn_1",
					item_id: "itm_1",
					name: "chart.png",
					content_base64: btoa(String.fromCharCode(...PNG)),
				},
			},
		]);
		expect(store.holds(ID)).toBe(true);
		// No download of bytes that are here.
		expect(await store.load(ID)).toBe(done.preview);
		expect(calls).toHaveLength(1);
		store.dispose();
	});

	// While an upload runs, the page must not replace the document of the editor with content from
	// the server: that content has no node for the image.
	it("is busy while an upload runs, also when the upload fails", async () => {
		let answer: ((value: unknown) => void) | null = null;
		const { store } = storeWith({
			"docs.upload_image": () =>
				new Promise((resolve) => {
					answer = resolve;
				}),
		});
		const ends: string[] = [];
		store.subscribe((job) => {
			if (job) ends.push(job.status);
		});
		expect(store.busy).toBe(false);
		store.start({ kind: "file", file: new File([PNG], "a.png", { type: "image/png" }), name: null });
		// This import has no answer in the fake server, so it fails.
		store.start({ kind: "address", src: "https://example.com/a.png" });
		expect(store.busy).toBe(true);
		await vi.waitFor(() => expect(ends).toEqual(["failed"]));
		expect(store.busy).toBe(true);
		await vi.waitFor(() => expect(answer).not.toBeNull());
		(answer as unknown as (value: unknown) => void)({ image: meta(ID) });
		await vi.waitFor(() => expect(ends).toEqual(["failed", "done"]));
		expect(store.busy).toBe(false);
		store.dispose();
	});

	it("refuses a file that is not a raster image, or is too large, before a request", async () => {
		const { store, calls } = storeWith({});
		const svg = new File(["<svg/>"], "a.svg", { type: "image/svg+xml" });
		expect((await ended(store, { kind: "file", file: svg, name: "a.svg" })).status).toBe("failed");
		expect(calls).toEqual([]);
		expect(fileProblem({ type: "image/png", size: DOC_LIMITS.imageBytes + 1 })).toMatch(/at most 10 MB/);
		expect(fileProblem({ type: "image/webp", size: 10 })).toBeNull();
		expect(dataUrlBlob("data:image/svg+xml;base64,AAAA")).toBeNull();
		expect(dataUrlBlob("data:image/png;base64,iVBORw==")?.type).toBe("image/png");
		store.dispose();
	});

	it("sends each other source to its operation", async () => {
		const { store, calls } = storeWith({
			"docs.import_image": () => ({ image: meta(ID) }),
			"docs.copy_image": () => ({ image: meta(OTHER) }),
		});
		await ended(store, { kind: "address", src: "https://example.com/a.png" });
		await ended(store, { kind: "drive", spaceId: "drv_1", itemId: "itm_file" });
		await ended(store, { kind: "doc", spaceId: null, itemId: "itm_doc", imageId: OTHER });
		const target = { space_id: "prn_1", item_id: "itm_1" };
		expect(calls).toEqual([
			{ name: "docs.import_image", input: { ...target, url: "https://example.com/a.png" } },
			{ name: "docs.copy_image", input: { ...target, from_space_id: "drv_1", from_item_id: "itm_file" } },
			{ name: "docs.copy_image", input: { ...target, from_item_id: "itm_doc", from_image_id: OTHER } },
		]);
		store.dispose();
	});

	it("gets the bytes of an image one time, and again after a failure", async () => {
		let fail = true;
		const { store, calls } = storeWith({
			"docs.get_image": () => {
				if (fail) throw new Error("offline");
				return { image: meta(ID), content_base64: btoa("bytes") };
			},
		});
		await expect(store.load(ID)).rejects.toThrow("offline");
		fail = false;
		const [first, second] = await Promise.all([store.load(ID), store.load(ID)]);
		expect(first).toMatch(/^blob:/);
		expect(second).toBe(first);
		expect(calls).toHaveLength(2);
		store.dispose();
	});

	// A doc can hold 200 images. The editor must not send 200 requests at one time.
	it("gets the bytes of a few images at the same time only", async () => {
		let running = 0;
		let most = 0;
		const { store } = storeWith({
			"docs.get_image": async () => {
				running += 1;
				most = Math.max(most, running);
				await new Promise((done) => setTimeout(done, 5));
				running -= 1;
				return { image: meta(ID), content_base64: btoa("bytes") };
			},
		});
		await Promise.all(Array.from({ length: 12 }, (_, n) => store.load(`img_${n}`)));
		expect(most).toBe(4);
		store.dispose();
	});

	it("does not show bytes with a type that is not a raster image", async () => {
		const { store } = storeWith({
			"docs.get_image": () => ({ image: { ...meta(ID), mime_type: "image/svg+xml" }, content_base64: btoa("<svg/>") }),
		});
		await expect(store.load(ID)).rejects.toThrow();
		store.dispose();
	});

	// A read of the doc that started before an upload ended has no such image. The image must stay in
	// the list, or the next save leaves it out of the content.
	it("keeps a new image for a short time when an answer of the server does not have it", async () => {
		const { store } = storeWith({ "docs.upload_image": () => ({ image: meta(ID) }) });
		await ended(store, { kind: "file", file: new File([PNG], "a.png", { type: "image/png" }), name: null });
		store.setAll([meta(OTHER)]);
		expect([store.holds(ID), store.holds(OTHER)]).toEqual([true, true]);
		// Later, the server is right: the doc does not hold the image.
		store.setAll([meta(OTHER)], Date.now() + 5 * 60_000);
		expect([store.holds(ID), store.holds(OTHER)]).toEqual([false, true]);
		store.dispose();
	});
});
