import { DOC_LIMITS, DocContent, type DocImage, type OperationName } from "@soldock/contracts";
import { z } from "zod";
import { type AttachmentRecord, attachmentKey, documentStub } from "../collab/index.ts";
import {
	accept,
	auditOk,
	idempotencyOf,
	type OpenSpace,
	openSpace,
	readDocument,
	toOneItem,
	writeDocument,
} from "../drive/index.ts";
import type { CallContext } from "../identity/index.ts";
import { base64ToBytes, bytesToBase64, type HandlerMap, newId, OperationError } from "../platform/index.ts";
import { outboundHostAllowed, publicUrlProblem } from "../webhooks/index.ts";
import { checkDoc, completeImages, docText, EMPTY_DOC, imageNodes } from "./content.ts";
import { type ImageInfo, imageProblem, readImageInfo } from "./image.ts";
import { docToMarkdown, markdownToDoc } from "./markdown.ts";

type DocsOperation = Extract<OperationName, `docs.${string}`>;

/** The content of a call, from `content` or from `markdown`. Null when the call has neither. */
function contentOf(input: { content?: DocContent | undefined; markdown?: string | undefined }): DocContent | null {
	if (input.content === undefined && input.markdown === undefined) return null;
	let content = input.content;
	if (content === undefined) {
		// Markdown can make content over a limit of the schema, for example one text of more than
		// 100,000 characters. Such content must not go into storage: no read can return it.
		const parsed = DocContent.safeParse(markdownToDoc(input.markdown as string, { images: true }));
		if (!parsed.success) {
			throw new OperationError("invalid", `The Markdown makes a doc over a limit. ${z.prettifyError(parsed.error)}`);
		}
		content = parsed.data;
	}
	const error = checkDoc(content);
	if (error) throw new OperationError("invalid", error);
	return content;
}

/** The JSON that the document object stores. Refuses content over the limit of one row. */
function stored(content: DocContent): string {
	const json = JSON.stringify(content);
	if (new TextEncoder().encode(json).byteLength > DOC_LIMITS.contentBytes) {
		throw new OperationError(
			"payload_too_large",
			`The content of a doc can be at most ${DOC_LIMITS.contentBytes} bytes.`,
		);
	}
	return json;
}

/** R2 holds the bytes of an image with a neutral type. Nothing serves them from R2 to a browser. */
const STORED_TYPE = { httpMetadata: { contentType: "application/octet-stream" } };

/** What the document object keeps for an image, as JSON. */
type ImageMeta = Pick<DocImage, "mime_type" | "width" | "height" | "name" | "untrusted">;

function toImage(record: AttachmentRecord): DocImage {
	const meta = JSON.parse(record.meta) as ImageMeta;
	return { id: record.id, size: record.size, created_at: new Date(record.createdAt).toISOString(), ...meta };
}

/** The images that a doc holds. */
async function imagesOf(call: CallContext, itemId: string): Promise<DocImage[]> {
	return (await documentStub(call.env, itemId).attachments()).map(toImage);
}

/**
 * Writes the content of a doc. The doc must hold each image of the content. The document object gets
 * the ids of those images, so it keeps them and deletes the other images after a time.
 */
async function write(call: CallContext, opened: OpenSpace, itemId: string, content: DocContent, base: number | null) {
	const nodes = imageNodes(content);
	if (nodes.length > 0) {
		const held = new Map((await imagesOf(call, itemId)).map((image) => [image.id, image]));
		const problem = completeImages(content, held);
		if (problem) throw new OperationError("invalid", problem);
		// The completed content goes into storage, so it gets the check of the schema again. Content
		// that the schema refuses would fail each later read of the doc.
		const checked = DocContent.safeParse(content);
		if (!checked.success) {
			throw new OperationError("invalid", `An image of the content is over a limit. ${z.prettifyError(checked.error)}`);
		}
	}
	return writeDocument(call, opened, itemId, {
		content: stored(content),
		text: docText(content),
		baseRevision: base,
		attachmentIds: nodes.map((node) => node.attrs.id),
	});
}

/** The doc of an image operation, when the caller can change it. */
async function openDocForEdit(call: CallContext, input: { space_id?: string | undefined; item_id: string }) {
	const opened = await openSpace(call, input.space_id);
	accept(await opened.space.checkItem(opened.ctx, input.item_id, "editor", ["doc"]));
	return opened;
}

/** The bytes of an image and what the server read from them. Refuses a file that a doc cannot hold. */
function examine(bytes: Uint8Array): ImageInfo {
	if (bytes.byteLength > DOC_LIMITS.imageBytes) {
		throw new OperationError("payload_too_large", `An image can be at most ${DOC_LIMITS.imageBytes} bytes.`);
	}
	const info = readImageInfo(bytes);
	const problem = imageProblem(info);
	if (problem || info === null) throw new OperationError("invalid", problem ?? "The file is not an image.");
	return info;
}

/**
 * Records an image of a doc after its bytes are in R2. When the document object refuses, the object of
 * this attempt goes away, because no image uses it.
 */
async function record(
	call: CallContext,
	itemId: string,
	image: { id: string; size: number; meta: ImageMeta },
): Promise<DocImage> {
	const blobKey = attachmentKey(itemId, image.id);
	const answer = await documentStub(call.env, itemId).addAttachment({
		id: image.id,
		blobKey,
		size: image.size,
		meta: JSON.stringify(image.meta),
		used: false,
		limit: DOC_LIMITS.images,
	});
	if ("error" in answer) {
		await call.env.BLOBS.delete(blobKey);
		if (answer.error.code === "unavailable") throw new OperationError("unavailable", answer.error.message);
		throw new OperationError(
			"invalid",
			`A doc can hold at most ${DOC_LIMITS.images} images. An image that the content does not use is deleted after 24 hours.`,
		);
	}
	return toImage(answer);
}

/** Stores new bytes as an image of a doc. */
async function storeImage(
	call: CallContext,
	itemId: string,
	bytes: Uint8Array,
	options: { name: string | null; untrusted: boolean },
): Promise<DocImage> {
	const info = examine(bytes);
	const id = newId("img");
	await call.env.BLOBS.put(attachmentKey(itemId, id), bytes, STORED_TYPE);
	return record(call, itemId, {
		id,
		size: bytes.byteLength,
		meta: { mime_type: info.type, width: info.width, height: info.height, ...options },
	});
}

const IMPORT_TIMEOUT_MS = 15_000;
const IMPORT_REDIRECTS = 3;

/** Refuses a web address that the Worker must not get, or that the outbound policy of an agent does not allow. */
function checkImportUrl(call: CallContext, url: string): void {
	const problem = publicUrlProblem(url, call.origin);
	if (problem) throw new OperationError("invalid", problem);
	const { principal } = call.caller;
	if (!outboundHostAllowed(principal, url)) {
		throw new OperationError(
			"policy_denied",
			`The outbound policy of this agent (${principal.outbound_mode ?? "internal-only"}) does not allow a request to ${new URL(url).hostname}. Ask its sponsor to add the host to the allowlist, or to import the image for you.`,
		);
	}
}

/** Reads a response body, and stops when it has more bytes than an image can have. */
async function readLimited(response: Response): Promise<Uint8Array> {
	const tooLarge = () =>
		new OperationError("payload_too_large", `An image can be at most ${DOC_LIMITS.imageBytes} bytes.`);
	if (Number(response.headers.get("content-length") ?? 0) > DOC_LIMITS.imageBytes) {
		await response.body?.cancel();
		throw tooLarge();
	}
	const reader = response.body?.getReader();
	if (!reader) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > DOC_LIMITS.imageBytes) {
			await reader.cancel();
			throw tooLarge();
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

/**
 * Gets the bytes of a web address. The request has no cookie and no credential. Each redirect is
 * checked as the first address, and the whole download has one time limit.
 */
async function download(call: CallContext, address: string): Promise<Uint8Array> {
	const signal = AbortSignal.timeout(IMPORT_TIMEOUT_MS);
	let url = address;
	try {
		for (let hop = 0; hop <= IMPORT_REDIRECTS; hop++) {
			const response = await fetch(url, {
				redirect: "manual",
				signal,
				headers: { accept: "image/png, image/jpeg, image/gif, image/webp", "user-agent": "Soldock" },
			});
			if (response.status >= 300 && response.status < 400) {
				await response.body?.cancel();
				const location = response.headers.get("location");
				if (location === null) break;
				url = new URL(location, url).href;
				checkImportUrl(call, url);
				continue;
			}
			if (!response.ok) {
				await response.body?.cancel();
				throw new OperationError("invalid", `The web address did not return an image (HTTP ${response.status}).`);
			}
			return await readLimited(response);
		}
	} catch (error) {
		if (error instanceof OperationError) throw error;
		const name = error instanceof Error ? error.name : "";
		throw new OperationError(
			"unavailable",
			name === "TimeoutError" || name === "AbortError"
				? "The web address did not answer in time."
				: "The web address did not answer.",
		);
	}
	throw new OperationError("invalid", "The web address has too many redirects.");
}

/** The item after a change, with the time and the author of that change. */
async function itemOf(call: CallContext, opened: OpenSpace, itemId: string) {
	return toOneItem(call, accept(await opened.space.checkItem(opened.ctx, itemId, "viewer", ["doc"])));
}

export const docsHandlers: Pick<HandlerMap<CallContext>, DocsOperation> = {
	async "docs.create"(call, input) {
		const opened = await openSpace(call, input.space_id);
		const content = contentOf(input);
		// Refuse content over the limit before the item exists.
		if (content) stored(content);
		if (content && imageNodes(content).length > 0) {
			throw new OperationError(
				"invalid",
				"A new doc holds no image. Create the doc, add the images with docs.upload_image, docs.copy_image or docs.import_image, then put them in the text with docs.update.",
			);
		}
		const created = accept(
			await opened.space.createItem(opened.ctx, {
				id: newId("itm"),
				parentId: input.parent_id ?? null,
				kind: "doc",
				name: input.name,
				idempotency: await idempotencyOf(call, "docs.create", input),
			}),
		);
		const itemId = created.item.id;
		let revision = (await readDocument(call, itemId))?.revision ?? 0;
		// A retry with the same key finds the item. When the first call stopped before the content, the retry writes it.
		if (content && revision === 0) revision = (await write(call, opened, itemId, content, 0)).revision;
		if (!created.duplicate) auditOk(call, opened, "docs.create", itemId);
		return { item: await itemOf(call, opened, itemId), revision };
	},

	async "docs.get"(call, input) {
		const opened = await openSpace(call, input.space_id);
		const item = accept(await opened.space.checkItem(opened.ctx, input.item_id, "viewer", ["doc"]));
		const [state, images] = await Promise.all([readDocument(call, input.item_id), imagesOf(call, input.item_id)]);
		// The content was checked when it was stored. The output check of the operation reads it again.
		const content = state ? (JSON.parse(state.content) as DocContent) : EMPTY_DOC;
		return {
			item: await toOneItem(call, item),
			revision: state?.revision ?? 0,
			markdown: docToMarkdown(content),
			content,
			images,
		};
	},

	async "docs.update"(call, input) {
		const opened = await openSpace(call, input.space_id);
		accept(await opened.space.checkItem(opened.ctx, input.item_id, "editor", ["doc"]));
		const content = contentOf(input) as DocContent;
		const result = await write(call, opened, input.item_id, content, input.base_revision ?? null);
		if (result.changed) auditOk(call, opened, "docs.update", input.item_id);
		return { item: await itemOf(call, opened, input.item_id), revision: result.revision };
	},

	async "docs.upload_image"(call, input) {
		const opened = await openDocForEdit(call, input);
		let bytes: Uint8Array;
		try {
			bytes = base64ToBytes(input.content_base64);
		} catch {
			throw new OperationError("invalid", "content_base64 is not valid base64.");
		}
		const image = await storeImage(call, input.item_id, bytes, { name: input.name ?? null, untrusted: false });
		auditOk(call, opened, "docs.upload_image", input.item_id);
		return { image };
	},

	async "docs.copy_image"(call, input) {
		const opened = await openDocForEdit(call, input);
		const source = await openSpace(call, input.from_space_id);
		let image: DocImage;
		if (input.from_image_id === undefined) {
			// An image file of Drive. The bytes are read again, so the type comes from the file, not from its name.
			const file = accept(await source.space.fileContent(source.ctx, input.from_item_id, null));
			const object = await call.env.BLOBS.get(file.blobKey);
			if (!object) throw new Error("the file content is missing from R2");
			const bytes = new Uint8Array(await object.arrayBuffer());
			// Drive holds content of this organization only, so the image is not untrusted.
			image = await storeImage(call, input.item_id, bytes, { name: file.name, untrusted: false });
		} else {
			accept(await source.space.checkItem(source.ctx, input.from_item_id, "viewer", ["doc"]));
			const found = await documentStub(call.env, input.from_item_id).attachment(input.from_image_id);
			if (!found) throw new OperationError("not_found", "The doc from_item_id holds no image with that id.");
			// The image keeps its id, so content that names it is good in the two docs.
			const held = await documentStub(call.env, input.item_id).attachment(found.id);
			if (held) return { image: toImage(held) };
			const object = await call.env.BLOBS.get(found.blobKey);
			if (!object) throw new Error("the image content is missing from R2");
			await call.env.BLOBS.put(attachmentKey(input.item_id, found.id), object.body, STORED_TYPE);
			image = await record(call, input.item_id, {
				id: found.id,
				size: found.size,
				meta: JSON.parse(found.meta) as ImageMeta,
			});
		}
		auditOk(call, opened, "docs.copy_image", input.item_id);
		return { image };
	},

	async "docs.import_image"(call, input) {
		const opened = await openDocForEdit(call, input);
		checkImportUrl(call, input.url);
		const bytes = await download(call, input.url);
		const image = await storeImage(call, input.item_id, bytes, { name: input.name ?? null, untrusted: true });
		auditOk(call, opened, "docs.import_image", input.item_id);
		return { image };
	},

	async "docs.get_image"(call, input) {
		const opened = await openSpace(call, input.space_id);
		accept(await opened.space.checkItem(opened.ctx, input.item_id, "viewer", ["doc"]));
		const found = await documentStub(call.env, input.item_id).attachment(input.image_id);
		if (!found) throw new OperationError("not_found", "The doc holds no image with that id.");
		const object = await call.env.BLOBS.get(found.blobKey);
		if (!object) throw new Error("the image content is missing from R2");
		return { image: toImage(found), content_base64: bytesToBase64(new Uint8Array(await object.arrayBuffer())) };
	},
};
