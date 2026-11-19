import { deflateSync } from "node:zlib";
import type { BrowserContext, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { BASE_URL } from "./server.ts";

const JSON_HEADERS = { origin: BASE_URL, "content-type": "application/json" };

/** Calls the REST API with the session of the context. */
export async function call<T>(
	context: BrowserContext,
	method: "GET" | "POST",
	path: string,
	data?: unknown,
): Promise<T> {
	const response = await context.request.fetch(path, { method, headers: JSON_HEADERS, data: data ?? undefined });
	expect(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`).toBe(true);
	return (await response.json()) as T;
}

export interface DocImage {
	id: string;
	mime_type: string;
	width: number;
	height: number;
	untrusted: boolean;
}

export interface ImageAttrs {
	id: string;
	width?: number;
	layout: string;
	alt?: string;
	caption?: string;
	crop?: { x: number; y: number; width: number; height: number };
}

interface DocNode {
	type: string;
	attrs?: Record<string, unknown>;
	content?: DocNode[];
}

export interface Doc {
	revision: number;
	markdown: string;
	content: DocNode;
	images: DocImage[];
}

export interface DocRef {
	id: string;
	spaceId: string;
}

/** A new doc in the drive of the person of the context. */
export async function createDoc(context: BrowserContext, name: string, markdown?: string): Promise<DocRef> {
	const { item } = await call<{ item: { id: string; space_id: string } }>(context, "POST", "/api/v1/docs", {
		name,
		...(markdown ? { markdown } : {}),
	});
	return { id: item.id, spaceId: item.space_id };
}

export function getDoc(context: BrowserContext, itemId: string): Promise<Doc> {
	return call<Doc>(context, "GET", `/api/v1/docs/${itemId}`);
}

/** The images in the content of a doc, in the order of the text. */
export function imagesOf(doc: Doc): ImageAttrs[] {
	const found: ImageAttrs[] = [];
	const walk = (node: DocNode) => {
		if (node.type === "image") found.push(node.attrs as unknown as ImageAttrs);
		for (const child of node.content ?? []) walk(child);
	};
	walk(doc.content);
	return found;
}

/**
 * Waits until the server has a doc whose images pass `check`, and returns those images. The editor
 * saves a short time after a change. The error has the images that the server had at the end.
 */
export async function savedImages(
	context: BrowserContext,
	itemId: string,
	check: (images: ImageAttrs[]) => boolean,
): Promise<ImageAttrs[]> {
	let images: ImageAttrs[] = [];
	const deadline = Date.now() + 15_000;
	for (;;) {
		images = imagesOf(await getDoc(context, itemId));
		if (check(images)) return images;
		if (Date.now() > deadline) break;
		await new Promise((done) => setTimeout(done, 200));
	}
	throw new Error(`The saved images of the doc did not get the expected state: ${JSON.stringify(images)}`);
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
	const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}

/**
 * A PNG file that a browser shows: four quarters in four colors, so a crop and a turn show in a
 * screenshot. `tint` changes the colors, so two files of one size are different files.
 */
export function pngFile(width: number, height: number, tint = 0): Buffer {
	const row = 1 + width * 3;
	const raw = Buffer.alloc(row * height);
	const colors = [
		[230 - tint, 80, 70],
		[70, 150, 230 - tint],
		[90, 190 - tint, 110],
		[240, 200, 60 + tint],
	] as const;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const color = colors[(y < height / 2 ? 0 : 2) + (x < width / 2 ? 0 : 1)] as readonly number[];
			raw.set(color, y * row + 1 + x * 3);
		}
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 2, 0, 0, 0], 8);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", new Uint8Array()),
	]);
}

/** Adds an image to a doc through the API, as an agent does. */
export async function uploadImage(context: BrowserContext, itemId: string, file: Buffer, name = "image.png") {
	const { image } = await call<{ image: DocImage }>(context, "POST", `/api/v1/docs/${itemId}/images`, {
		name,
		content_base64: file.toString("base64"),
	});
	return image;
}

/** Opens a doc and waits for its text area. */
export async function openDoc(page: Page, doc: DocRef) {
	await page.goto(`/docs/${doc.spaceId}/${doc.id}`);
	const body = page.locator(".doc-body");
	try {
		await body.waitFor({ state: "visible", timeout: 10_000 });
	} catch {
		// The error has the text of the page, for example the message of a doc that did not load.
		const shown = await page
			.locator("body")
			.innerText()
			.catch(() => "no page");
		throw new Error(`The doc did not open at ${page.url()}. The page shows: ${shown.slice(0, 600)}`);
	}
	return body;
}

/** Drops files on an element of the page, as a person drops them from a folder of the computer. */
export async function dropFiles(
	page: Page,
	selector: string,
	files: { name: string; type: string; bytes: Buffer }[],
	at?: { x: number; y: number },
): Promise<void> {
	const data = await page.evaluateHandle(
		(entries) => {
			const transfer = new DataTransfer();
			for (const entry of entries) {
				const bytes = Uint8Array.from(atob(entry.base64), (char) => char.charCodeAt(0));
				transfer.items.add(new File([bytes], entry.name, { type: entry.type }));
			}
			return transfer;
		},
		files.map((file) => ({ name: file.name, type: file.type, base64: file.bytes.toString("base64") })),
	);
	const target = page.locator(selector);
	const box = await target.boundingBox();
	if (!box) throw new Error(`${selector} is not on the page`);
	const point = at ?? { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	const init = { dataTransfer: data, clientX: point.x, clientY: point.y, bubbles: true, cancelable: true };
	await target.dispatchEvent("dragover", init);
	await target.dispatchEvent("drop", init);
}
