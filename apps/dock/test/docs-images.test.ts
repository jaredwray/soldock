import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { DOC_LIMITS, type InputOf, UNTRUSTED_NOTICE } from "@asterra/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ATTACHMENT_KEEP_MS } from "../src/collab/index.ts";
import { readImageInfo } from "../src/docs/image.ts";
import { type Actor, api, callTool, codeOf, drainDrive, seedOrg } from "./helpers.ts";

let owner: Actor;
let ada: Actor;
let bot: Actor;

beforeEach(async () => {
	({ owner, ada, bot } = await seedOrg());
});

afterEach(() => {
	vi.restoreAllMocks();
});

// --- Image files, written by hand: the header of each format, which is all that the server reads ----

function bytesOf(...parts: (number[] | string)[]): Uint8Array {
	return Uint8Array.from(
		parts.flatMap((part) => (typeof part === "string" ? [...part].map((char) => char.charCodeAt(0)) : part)),
	);
}

const be16 = (value: number) => [value >> 8, value & 0xff];
const be32 = (value: number) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
const le16 = (value: number) => [value & 0xff, value >> 8];
const le24 = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff];
const le32 = (value: number) => [...le16(value & 0xffff), ...le16(value >>> 16)];

function png(width: number, height: number): Uint8Array {
	return bytesOf([0x89], "PNG\r\n", [0x1a, 0x0a], be32(13), "IHDR", be32(width), be32(height), [8, 6, 0, 0, 0]);
}

function gif(width: number, height: number): Uint8Array {
	return bytesOf("GIF89a", le16(width), le16(height), [0, 0, 0]);
}

/**
 * A GIF file whose first picture is larger than its screen: a screen of 1 by 1 with a color table of
 * two colors, a comment, then the picture.
 */
function gifWithFrame(width: number, height: number): Uint8Array {
	const comment = [0x21, 0xfe, 2, 0x68, 0x69, 0];
	return bytesOf(
		"GIF89a",
		le16(1),
		le16(1),
		[0x80, 0, 0],
		[0, 0, 0, 255, 255, 255],
		comment,
		[0x2c],
		le16(0),
		le16(0),
		le16(width),
		le16(height),
		[0],
	);
}

/**
 * A JPEG header: an optional EXIF segment with an orientation, then the frame header. With `xmp`, a
 * second APP1 segment that is not EXIF comes after the EXIF segment, as in the photos of many phones.
 */
function jpeg(width: number, height: number, orientation?: number, xmp = false): Uint8Array {
	const exif =
		orientation === undefined
			? []
			: [
					...bytesOf([0xff, 0xe1], be16(2 + 6 + 8 + 2 + 12), "Exif\0\0", "MM", be16(42), be32(8), be16(1)),
					...bytesOf(be16(0x0112), be16(3), be32(1), be16(orientation), [0, 0]),
				];
	const more = xmp ? [...bytesOf([0xff, 0xe1], be16(2 + 29 + 4), "http://ns.adobe.com/xap/1.0/\0", "<x/>")] : [];
	const frame = bytesOf([0xff, 0xc0], be16(17), [8], be16(height), be16(width), [3, 1, 0x22, 0, 2, 0x11]);
	return bytesOf([0xff, 0xd8], exif, more, [...frame]);
}

const riff = (chunk: Uint8Array) => bytesOf("RIFF", le32(4 + chunk.length), "WEBP", [...chunk]);

const WEBP = {
	lossy: (width: number, height: number) =>
		riff(bytesOf("VP8 ", le32(10), [0, 0, 0, 0x9d, 0x01, 0x2a], le16(width), le16(height))),
	lossless: (width: number, height: number) =>
		riff(bytesOf("VP8L", le32(5), [0x2f], le32(((height - 1) << 14) | (width - 1)), [0])),
	extended: (width: number, height: number) =>
		riff(bytesOf("VP8X", le32(10), [0, 0, 0, 0], le24(width - 1), le24(height - 1))),
};

function toBase64(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes));
}

const upload = (actor: Actor, itemId: string, bytes: Uint8Array, name?: string) =>
	actor.call("docs.upload_image", { item_id: itemId, content_base64: toBase64(bytes), ...(name ? { name } : {}) });

const imageIn = (attrs: Record<string, unknown>): InputOf<"docs.update">["content"] =>
	({ type: "doc", content: [{ type: "paragraph", content: [{ type: "image", attrs }] }] }) as never;

const documentOf = (itemId: string) => env.DOCUMENT.get(env.DOCUMENT.idFromName(itemId));

async function imageKeys(itemId: string): Promise<string[]> {
	return (await env.BLOBS.list({ prefix: `document/${itemId}/` })).objects.map((object) => object.key);
}

/** Runs the alarm of a document until the drive has its message. */
async function drainDocument(itemId: string): Promise<void> {
	await vi.waitFor(
		async () => {
			await runDurableObjectAlarm(documentOf(itemId));
			const waiting = await runInDurableObject(
				documentOf(itemId),
				(_instance, state) => state.storage.sql.exec("SELECT COUNT(*) AS n FROM pending").one().n,
			);
			if (waiting !== 0) throw new Error("the message for the drive waits");
		},
		{ timeout: 5000, interval: 20 },
	);
}

/** Makes each image that the content does not use older by `ms`. */
async function ageUnused(itemId: string, ms: number): Promise<void> {
	await runInDurableObject(documentOf(itemId), (_instance, state) => {
		state.storage.sql.exec("UPDATE attachments SET unused_since = unused_since - ? WHERE unused_since IS NOT NULL", ms);
	});
}

describe("the type and the size of an image file", () => {
	// A browser shows a JPEG with the orientation 5 to 8 a quarter turn, so the frame of the editor needs the turned sides.
	it("come from the bytes of each format", () => {
		expect(readImageInfo(png(640, 480))).toEqual({ type: "image/png", width: 640, height: 480 });
		expect(readImageInfo(gif(320, 200))).toEqual({ type: "image/gif", width: 320, height: 200 });
		expect(readImageInfo(jpeg(4000, 3000))).toEqual({ type: "image/jpeg", width: 4000, height: 3000 });
		expect(readImageInfo(jpeg(4000, 3000, 1))).toEqual({ type: "image/jpeg", width: 4000, height: 3000 });
		expect(readImageInfo(jpeg(4000, 3000, 6))).toEqual({ type: "image/jpeg", width: 3000, height: 4000 });
		// A segment that is not EXIF does not change the orientation of the EXIF segment before it.
		expect(readImageInfo(jpeg(4000, 3000, 6, true))).toEqual({ type: "image/jpeg", width: 3000, height: 4000 });
		expect(readImageInfo(jpeg(4000, 3000, undefined, true))).toEqual({ type: "image/jpeg", width: 4000, height: 3000 });
		// A browser can show the first picture of a GIF file larger than the screen of the file.
		expect(readImageInfo(gifWithFrame(60_000, 500))).toEqual({ type: "image/gif", width: 60_000, height: 500 });
		expect(readImageInfo(WEBP.lossy(800, 600))).toEqual({ type: "image/webp", width: 800, height: 600 });
		expect(readImageInfo(WEBP.lossless(801, 601))).toEqual({ type: "image/webp", width: 801, height: 601 });
		expect(readImageInfo(WEBP.extended(5000, 70))).toEqual({ type: "image/webp", width: 5000, height: 70 });
	});

	it("are null for a file that is not one of the four formats, and for a cut file", () => {
		const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
		expect(readImageInfo(bytesOf(svg))).toBeNull();
		expect(readImageInfo(bytesOf("%PDF-1.7"))).toBeNull();
		expect(readImageInfo(png(640, 480).subarray(0, 20))).toBeNull();
		expect(readImageInfo(jpeg(10, 10).subarray(0, 6))).toBeNull();
		expect(readImageInfo(new Uint8Array())).toBeNull();
	});
});

describe("docs.upload_image and docs.get_image", () => {
	it("store an image in the doc, with the type and the size that the bytes have", async () => {
		const { item } = await ada.call("docs.create", { name: "Report" });
		const bytes = png(1200, 800);
		const { image } = await upload(ada, item.id, bytes, "chart.png");
		expect(image).toMatchObject({
			id: expect.stringMatching(/^img_/),
			mime_type: "image/png",
			size: bytes.byteLength,
			width: 1200,
			height: 800,
			name: "chart.png",
			untrusted: false,
		});
		expect((await ada.call("docs.get", { item_id: item.id })).images).toEqual([image]);
		const read = await ada.call("docs.get_image", { item_id: item.id, image_id: image.id });
		expect(read).toEqual({ image, content_base64: toBase64(bytes) });
		// The upload does not change the text, so the doc has no revision yet.
		expect((await ada.call("docs.get", { item_id: item.id })).revision).toBe(0);
	});

	it("refuse a file that is not a raster image, and an image with too many pixels", async () => {
		const { item } = await ada.call("docs.create", { name: "Report" });
		const svg = bytesOf('<svg xmlns="http://www.w3.org/2000/svg"/>');
		expect(await codeOf(upload(ada, item.id, svg))).toBe("invalid");
		expect(await codeOf(upload(ada, item.id, png(DOC_LIMITS.imageSide + 1, 10)))).toBe("invalid");
		expect(await codeOf(upload(ada, item.id, png(10_000, 10_000)))).toBe("invalid");
		expect(await codeOf(upload(ada, item.id, png(0, 10)))).toBe("invalid");
		expect(await codeOf(upload(ada, item.id, gifWithFrame(60_000, 60_000)))).toBe("invalid");
		expect(await imageKeys(item.id)).toEqual([]);
	});

	it("follow the role of the caller for the doc: humans and agents", async () => {
		const { item } = await ada.call("docs.create", { name: "Report" });
		const { image } = await upload(ada, item.id, png(10, 10));
		// No access: the doc does not exist for the caller.
		expect(await codeOf(upload(bot, item.id, png(10, 10)))).toBe("not_found");
		expect(await codeOf(bot.call("docs.get_image", { item_id: item.id, image_id: image.id, space_id: ada.id }))).toBe(
			"not_found",
		);
		// A viewer reads the image, and cannot add one.
		await ada.call("drive.share_item", { item_id: item.id, principal_id: bot.id, role: "viewer" });
		const asViewer = { item_id: item.id, space_id: ada.id };
		expect((await bot.call("docs.get_image", { ...asViewer, image_id: image.id })).image.id).toBe(image.id);
		expect(await codeOf(bot.call("docs.upload_image", { ...asViewer, content_base64: toBase64(png(10, 10)) }))).toBe(
			"forbidden",
		);
		// An editor adds an image.
		await ada.call("drive.share_item", { item_id: item.id, principal_id: bot.id, role: "editor" });
		const added = await bot.call("docs.upload_image", { ...asViewer, content_base64: toBase64(gif(20, 20)) });
		expect(added.image.mime_type).toBe("image/gif");
		expect((await ada.call("docs.get", { item_id: item.id })).images).toHaveLength(2);
	});

	// A key or a token with a part of the scopes of its principal: the scopes of each operation apply.
	it("follow the scopes of the credential", async () => {
		const { item } = await ada.call("docs.create", { name: "Report" });
		const other = await ada.call("docs.create", { name: "Other" });
		const { image } = await upload(ada, item.id, png(10, 10));
		const keyWith = async (scopes: ("drive.read" | "drive.write")[]) =>
			api((await ada.call("account.create_api_key", { label: scopes.join(" "), scopes })).api_key.secret);
		const content_base64 = toBase64(png(10, 10));
		const copy = { item_id: other.item.id, from_item_id: item.id, from_image_id: image.id };
		const web = { item_id: item.id, url: "https://images.example.com/a.png" };
		const requests = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(png(10, 10)));

		const reader = await keyWith(["drive.read"]);
		expect((await reader("docs.get_image", { item_id: item.id, image_id: image.id })).image.id).toBe(image.id);
		expect(await codeOf(reader("docs.upload_image", { item_id: item.id, content_base64 }))).toBe("forbidden");
		expect(await codeOf(reader("docs.copy_image", copy))).toBe("forbidden");
		expect(await codeOf(reader("docs.import_image", web))).toBe("forbidden");
		expect(requests).not.toHaveBeenCalled();

		// A copy reads the source and writes the doc, so it needs the two scopes.
		const writer = await keyWith(["drive.write"]);
		expect((await writer("docs.upload_image", { item_id: item.id, content_base64 })).image.width).toBe(10);
		expect(await codeOf(writer("docs.get_image", { item_id: item.id, image_id: image.id }))).toBe("forbidden");
		expect(await codeOf(writer("docs.copy_image", copy))).toBe("forbidden");
		expect((await ada.call("docs.get", { item_id: other.item.id })).images).toEqual([]);

		const both = await keyWith(["drive.read", "drive.write"]);
		expect((await both("docs.copy_image", copy)).image.id).toBe(image.id);
	});

	it("refuse a doc in the trash, a sheet, and an image id that the doc does not hold", async () => {
		const { item } = await ada.call("docs.create", { name: "Report" });
		const other = await ada.call("docs.create", { name: "Other" });
		const { image } = await upload(ada, other.item.id, png(10, 10));
		expect(await codeOf(ada.call("docs.get_image", { item_id: item.id, image_id: image.id }))).toBe("not_found");
		const sheet = await ada.call("sheets.create", { name: "Numbers" });
		expect(await codeOf(upload(ada, sheet.item.id, png(10, 10)))).toBe("invalid");
		await ada.call("drive.trash_items", { item_ids: [item.id] });
		expect(await codeOf(upload(ada, item.id, png(10, 10)))).toBe("invalid");
	});

	it("refuse one more image than a doc can hold", async () => {
		const { item } = await ada.call("docs.create", { name: "Report" });
		const first = await upload(ada, item.id, png(10, 10));
		await runInDurableObject(documentOf(item.id), (_instance, state) => {
			for (let n = 1; n < DOC_LIMITS.images; n++) {
				state.storage.sql.exec(
					"INSERT INTO attachments (id, blob_key, size, meta, created_at, unused_since) SELECT 'img_' || ?, blob_key, size, meta, created_at, unused_since FROM attachments WHERE id = ?",
					n,
					first.image.id,
				);
			}
		});
		await expect(upload(ada, item.id, png(10, 10))).rejects.toMatchObject({
			code: "invalid",
			message: expect.stringContaining(`at most ${DOC_LIMITS.images} images`),
		});
		// The bytes of the refused image do not stay in R2.
		expect(await imageKeys(item.id)).toHaveLength(1);
	});
});

describe("an image in the content of a doc", () => {
	it("gets its width from the file, at most the width of the text, and keeps each option", async () => {
		const { item } = await ada.call("docs.create", { name: "Report" });
		const wide = (await upload(ada, item.id, png(3000, 1500))).image;
		const small = (await upload(ada, item.id, png(200, 100))).image;
		await ada.call("docs.update", {
			item_id: item.id,
			content: {
				type: "doc",
				content: [
					{
						type: "paragraph",
						content: [
							{ type: "image", attrs: { id: wide.id } },
							{ type: "image", attrs: { id: small.id, crop: { x: 0.5, y: 0, width: 0.5, height: 1 } } },
							{
								type: "image",
								attrs: { id: small.id, width: 120, layout: "wrap_right", alt: "A chart", caption: "Sales by month" },
							},
							{ type: "image", attrs: { id: small.id, crop: { x: 0, y: 0, width: 1, height: 1 } } },
						],
					},
				],
			},
		});
		const paragraph = (await ada.call("docs.get", { item_id: item.id })).content.content[0];
		expect(paragraph).toEqual({
			type: "paragraph",
			content: [
				{ type: "image", attrs: { id: wide.id, layout: "inline", width: DOC_LIMITS.imageTextWidth } },
				// The shown part is the half of the file, so the width is the half too.
				{
					type: "image",
					attrs: { id: small.id, layout: "inline", width: 100, crop: { x: 0.5, y: 0, width: 0.5, height: 1 } },
				},
				{
					type: "image",
					attrs: { id: small.id, width: 120, layout: "wrap_right", alt: "A chart", caption: "Sales by month" },
				},
				// A crop of the whole image is no crop.
				{ type: "image", attrs: { id: small.id, layout: "inline", width: 200 } },
			],
		});
	});

	// A crop at the edge of the image, in the limits of the input, must not become a crop that the
	// schema refuses when the server makes it complete. Each later read of the doc would fail.
	it("keeps a crop at the edge of the image in the limits, so the doc stays readable", async () => {
		const { item } = await ada.call("docs.create", { name: "Report" });
		const { image } = await upload(ada, item.id, png(1000, 1000));
		const edge = { x: 0.99, y: 0.99, width: 0.01, height: 0.01 };
		await ada.call("docs.update", {
			item_id: item.id,
			content: imageIn({ id: image.id, crop: { x: 0.9901, y: 0.9901, width: 0.01, height: 0.01 } }),
		});
		expect((await ada.call("docs.get", { item_id: item.id })).content).toEqual(
			imageIn({ id: image.id, layout: "inline", width: 16, crop: edge }),
		);
		await ada.call("docs.update", { item_id: item.id, markdown: `![](image:${image.id}?crop=0.9901,0,0.01,1)` });
		expect((await ada.call("docs.get", { item_id: item.id })).content).toEqual(
			imageIn({ id: image.id, layout: "inline", width: 16, crop: { x: 0.99, y: 0, width: 0.01, height: 1 } }),
		);
	});

	it("is refused when the doc does not hold the image, or an option has a bad value", async () => {
		const { item } = await ada.call("docs.create", { name: "Report" });
		const other = await ada.call("docs.create", { name: "Other" });
		const foreign = (await upload(ada, other.item.id, png(10, 10))).image;
		await expect(
			ada.call("docs.update", { item_id: item.id, content: imageIn({ id: foreign.id }) }),
		).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining(foreign.id) });
		const { image } = await upload(ada, item.id, png(10, 10));
		const bad: Record<string, unknown>[] = [
			{ id: image.id, width: 5 },
			{ id: image.id, layout: "behind" },
			{ id: image.id, crop: { x: 0.6, y: 0, width: 0.6, height: 1 } },
			{ id: image.id, alt: "line\nbreak" },
			{ id: image.id, src: "https://example.com/a.png" },
			{ id: "https://example.com/a.png" },
		];
		for (const attrs of bad) {
			expect(
				await codeOf(ada.call("docs.update", { item_id: item.id, content: imageIn(attrs) })),
				JSON.stringify(attrs),
			).toBe("invalid");
		}
		expect((await ada.call("docs.get", { item_id: item.id })).revision).toBe(0);
	});

	it("cannot be in a new doc, which holds no image", async () => {
		const { item } = await ada.call("docs.create", { name: "Report" });
		const { image } = await upload(ada, item.id, png(10, 10));
		expect(await codeOf(ada.call("docs.create", { name: "Copy", content: imageIn({ id: image.id }) }))).toBe("invalid");
		expect(await codeOf(ada.call("docs.create", { name: "Copy", markdown: `![](image:${image.id})` }))).toBe("invalid");
	});

	// An agent writes Markdown. The image must come back from Markdown with each option, or an agent that
	// changes one word of a doc would also change the layout of its images.
	it("is Markdown that an agent can write and read, with each option", async () => {
		const { item } = await bot.call("docs.create", { name: "Report" });
		const { image } = await upload(bot, item.id, png(1000, 500), "chart.png");
		const markdown = `# Sales\n\nThe chart: ![Sales [2026]](image:${image.id}?width=320&layout=wrap_left&crop=0.1,0.2,0.5,0.5 "The \\"best\\" year") shows growth.\n`;
		await bot.call("docs.update", { item_id: item.id, markdown });
		const doc = await bot.call("docs.get", { item_id: item.id });
		expect(doc.markdown).toBe(
			`# Sales\n\nThe chart: ![Sales \\[2026\\]](image:${image.id}?width=320&layout=wrap_left&crop=0.1,0.2,0.5,0.5 "The \\"best\\" year") shows growth.\n`,
		);
		expect(doc.content.content[1]).toEqual({
			type: "paragraph",
			content: [
				{ type: "text", text: "The chart: " },
				{
					type: "image",
					attrs: {
						id: image.id,
						width: 320,
						layout: "wrap_left",
						alt: "Sales [2026]",
						caption: 'The "best" year',
						crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.5 },
					},
				},
				{ type: "text", text: " shows growth." },
			],
		});
		// The Markdown that the doc returns makes the same doc: no revision.
		expect((await bot.call("docs.update", { item_id: item.id, markdown: doc.markdown })).revision).toBe(doc.revision);
		// A bad option is refused, and does not go away without a message.
		expect(
			await codeOf(bot.call("docs.update", { item_id: item.id, markdown: `![](image:${image.id}?width=wide)` })),
		).toBe("invalid");
		expect(
			await codeOf(bot.call("docs.update", { item_id: item.id, markdown: `![](image:${image.id}?crop=0.1,0.2)` })),
		).toBe("invalid");
		// An option that is not an option of an image gets a message with its name, and changes nothing.
		await expect(
			bot.call("docs.update", { item_id: item.id, markdown: `![](image:${image.id}?widht=200)` }),
		).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining('"widht"') });
		expect((await bot.call("docs.get", { item_id: item.id })).revision).toBe(doc.revision);
	});

	it("puts its alt text and its caption in the search index of the drive", async () => {
		const { item } = await ada.call("docs.create", { name: "Report" });
		const { image } = await upload(ada, item.id, png(10, 10));
		await ada.call("docs.update", {
			item_id: item.id,
			markdown: `Text ![a zeppelin](image:${image.id} "over the harbour")`,
		});
		for (const query of ["zeppelin", "harbour"]) {
			const found = await ada.call("drive.list_items", { view: "search", query });
			expect(
				found.items.map((entry) => entry.id),
				query,
			).toEqual([item.id]);
		}
	});
});

describe("an image that the content does not use", () => {
	it("is deleted 24 hours after its last use, with its bytes", async () => {
		const { item } = await ada.call("docs.create", { name: "Report" });
		const kept = (await upload(ada, item.id, png(10, 10))).image;
		const unused = (await upload(ada, item.id, png(20, 20))).image;
		await ada.call("docs.update", { item_id: item.id, content: imageIn({ id: kept.id }) });
		// Before the time, the alarm deletes nothing.
		await ageUnused(item.id, ATTACHMENT_KEEP_MS - 60_000);
		expect(await runDurableObjectAlarm(documentOf(item.id))).toBe(true);
		expect((await ada.call("docs.get", { item_id: item.id })).images.map((image) => image.id)).toEqual([
			kept.id,
			unused.id,
		]);
		// After the time, the image that the text does not show goes away. The object set the alarm for it.
		await ageUnused(item.id, 120_000);
		expect(await runDurableObjectAlarm(documentOf(item.id))).toBe(true);
		expect((await ada.call("docs.get", { item_id: item.id })).images.map((image) => image.id)).toEqual([kept.id]);
		expect(await imageKeys(item.id)).toEqual([`document/${item.id}/${kept.id}`]);
		expect(await codeOf(ada.call("docs.get_image", { item_id: item.id, image_id: unused.id }))).toBe("not_found");
		// The content cannot use the deleted image again.
		expect(await codeOf(ada.call("docs.update", { item_id: item.id, content: imageIn({ id: unused.id }) }))).toBe(
			"invalid",
		);
	});

	// A person removes an image, then uses Undo. The image must be there.
	it("stays when the content uses it again in that time", async () => {
		const { item } = await ada.call("docs.create", { name: "Report" });
		const { image } = await upload(ada, item.id, png(10, 10));
		await ada.call("docs.update", { item_id: item.id, content: imageIn({ id: image.id }) });
		await ada.call("docs.update", { item_id: item.id, markdown: "no image now" });
		await ageUnused(item.id, ATTACHMENT_KEEP_MS - 60_000);
		await ada.call("docs.update", { item_id: item.id, content: imageIn({ id: image.id }) });
		await ageUnused(item.id, ATTACHMENT_KEEP_MS);
		await runDurableObjectAlarm(documentOf(item.id));
		expect((await ada.call("docs.get_image", { item_id: item.id, image_id: image.id })).image.id).toBe(image.id);
	});
});

/** The bindings of the document object, with `overrides` in place of some of them, until the returned function runs. */
async function withDocumentEnv(itemId: string, overrides: Record<string, unknown>): Promise<() => Promise<void>> {
	const patch = (next: unknown) =>
		runInDurableObject(documentOf(itemId), (instance) => {
			const holder = instance as unknown as { env: unknown };
			const before = holder.env;
			holder.env = next ?? before;
			return before;
		});
	const original = await patch(null);
	await patch({ ...(original as object), ...overrides });
	return async () => {
		await patch(original);
	};
}

const documentRows = (itemId: string, sql: string) =>
	runInDurableObject(documentOf(itemId), (_instance, state) => state.storage.sql.exec(sql).toArray());

describe("the alarm of a document with images", () => {
	// R2 can fail. The image must not come back, and its bytes must leave R2 at a later attempt.
	it("tries the delete of the bytes again after a failure of R2, and refuses the same image in that time", async () => {
		const source = (await ada.call("docs.create", { name: "Source" })).item;
		const target = (await ada.call("docs.create", { name: "Target" })).item;
		const { image } = await upload(ada, source.id, png(10, 10));
		const copy = { item_id: target.id, from_item_id: source.id, from_image_id: image.id };
		await ada.call("docs.copy_image", copy);
		await ageUnused(target.id, ATTACHMENT_KEEP_MS + 60_000);
		const restore = await withDocumentEnv(target.id, {
			BLOBS: { delete: () => Promise.reject(new Error("R2 is not available")) },
		});
		const before = Date.now();
		await runDurableObjectAlarm(documentOf(target.id));
		await restore();
		// The doc does not hold the image. R2 still has the bytes, and the object knows their key.
		expect((await ada.call("docs.get", { item_id: target.id })).images).toEqual([]);
		expect(await imageKeys(target.id)).toEqual([`document/${target.id}/${image.id}`]);
		expect(await documentRows(target.id, "SELECT blob_key FROM attachment_deletes")).toEqual([
			{ blob_key: `document/${target.id}/${image.id}` },
		]);
		const alarm = await runInDurableObject(documentOf(target.id), (_instance, state) => state.storage.getAlarm());
		expect(alarm).toBeGreaterThanOrEqual(before + 4 * 60_000);
		expect(alarm).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
		// A copy of the same image now would lose its bytes to the delete that waits.
		expect(await codeOf(ada.call("docs.copy_image", copy))).toBe("unavailable");
		expect(await runDurableObjectAlarm(documentOf(target.id))).toBe(true);
		expect(await imageKeys(target.id)).toEqual([]);
		expect(await documentRows(target.id, "SELECT blob_key FROM attachment_deletes")).toEqual([]);
		expect((await ada.call("docs.copy_image", copy)).image.id).toBe(image.id);
	});

	// One alarm does two jobs. A failed message for the drive must keep its retry when the same alarm
	// deletes an image, and the delete must not wait for the message.
	it("keeps the retry of the message for the drive when it also deletes an image", async () => {
		const { item } = await ada.call("docs.create", { name: "Report", markdown: "first" });
		const { image } = await upload(ada, item.id, png(10, 10));
		await drainDocument(item.id);
		const restore = await withDocumentEnv(item.id, {
			DRIVE_SPACE: {
				idFromName: (name: string) => name,
				get: () => ({ applyDocumentChange: () => Promise.reject(new Error("the drive is not available")) }),
			},
		});
		await ageUnused(item.id, ATTACHMENT_KEEP_MS + 60_000);
		await runInDurableObject(documentOf(item.id), (instance) =>
			instance.write({
				spaceId: ada.id,
				itemId: item.id,
				content: '{"type":"doc","content":[{"type":"paragraph"}]}',
				text: "",
				baseRevision: null,
				author: { principal_id: ada.id, kind: "human", display_name: "Ada" },
				attachmentIds: [],
			}),
		);
		// The write sets the alarm for now, and the runtime can run it before this test does. Thus the
		// message can have more than one failed attempt here.
		let attempts = 0;
		await vi.waitFor(
			async () => {
				await runDurableObjectAlarm(documentOf(item.id));
				const rows = await documentRows(item.id, "SELECT attempts FROM pending");
				attempts = Number(rows[0]?.attempts ?? 0);
				if (attempts < 1) throw new Error("the alarm did not try the message");
			},
			{ timeout: 5000, interval: 20 },
		);
		await restore();
		// The same alarm deleted the image, and the message waits for its retry.
		expect(await imageKeys(item.id)).toEqual([]);
		expect(await codeOf(ada.call("docs.get_image", { item_id: item.id, image_id: image.id }))).toBe("not_found");
		const alarm = await runInDurableObject(documentOf(item.id), (_instance, state) => state.storage.getAlarm());
		expect(alarm).toBeGreaterThan(Date.now());
		expect(alarm).toBeLessThanOrEqual(Date.now() + 60_000 * 2 ** (attempts - 1));
		// With the drive available again, the retry delivers the message.
		await drainDocument(item.id);
		expect((await ada.call("drive.get_item", { item_id: item.id })).item.size).toBe(47);
	});
});

describe("the images of a deleted doc and of a copy", () => {
	it("leave R2 when the doc is deleted permanently", async () => {
		const { item } = await ada.call("docs.create", { name: "Report" });
		const { image } = await upload(ada, item.id, png(10, 10));
		await upload(ada, item.id, png(20, 20));
		// An upload that stopped after its bytes went to R2: an object that no row of the doc names.
		await env.BLOBS.put(`document/${item.id}/img_stopped`, png(5, 5));
		// The same for a doc that holds no image at all: no row gives the object its prefix.
		const empty = (await ada.call("docs.create", { name: "Empty" })).item;
		await env.BLOBS.put(`document/${empty.id}/img_stopped`, png(5, 5));
		await ada.call("docs.update", { item_id: item.id, content: imageIn({ id: image.id }) });
		expect(await imageKeys(item.id)).toHaveLength(3);
		await ada.call("drive.trash_items", { item_ids: [item.id, empty.id] });
		await ada.call("drive.delete_items", { item_ids: [item.id, empty.id] });
		await drainDrive(ada.id);
		expect(await imageKeys(item.id)).toEqual([]);
		expect(await imageKeys(empty.id)).toEqual([]);
	});

	it("go into a copy of the doc, which keeps them after the first doc is deleted", async () => {
		const { item } = await ada.call("docs.create", { name: "Report" });
		const bytes = png(640, 480);
		const { image } = await upload(ada, item.id, bytes);
		const unused = (await upload(ada, item.id, png(20, 20))).image;
		await ada.call("docs.update", { item_id: item.id, content: imageIn({ id: image.id, width: 300 }) });
		const input = { item_id: item.id, idempotency_key: "copy-images" };
		const { item: copy } = await ada.call("drive.copy_item", input);
		// A retry of the copy adds no second image.
		await ada.call("drive.copy_item", input);
		const copied = await ada.call("docs.get", { item_id: copy.id });
		expect(copied.content).toEqual(imageIn({ id: image.id, width: 300, layout: "inline" }));
		// The copy holds the image that the text shows, and not the image that the text does not show.
		expect(copied.images.map((entry) => entry.id)).toEqual([image.id]);
		expect(copied.images.map((entry) => entry.id)).not.toContain(unused.id);
		await ada.call("drive.trash_items", { item_ids: [item.id] });
		await ada.call("drive.delete_items", { item_ids: [item.id] });
		await drainDrive(ada.id);
		const read = await ada.call("docs.get_image", { item_id: copy.id, image_id: image.id });
		expect(read.content_base64).toBe(toBase64(bytes));
		// The image of a copy is in use from the start: the alarm does not delete it.
		await ageUnused(copy.id, ATTACHMENT_KEEP_MS * 2);
		await runDurableObjectAlarm(documentOf(copy.id));
		expect((await ada.call("docs.get", { item_id: copy.id })).images).toHaveLength(1);
	});
});

describe("docs.copy_image", () => {
	it("copies an image file of Drive into the doc, and refuses a file that is not an image", async () => {
		const { item } = await ada.call("docs.create", { name: "Report" });
		const bytes = jpeg(800, 600);
		const photo = await ada.call("drive.upload_file", {
			name: "photo.jpg",
			// The type that the client gave is wrong. The server reads the bytes.
			mime_type: "text/plain",
			content_base64: toBase64(bytes),
		});
		const { image } = await ada.call("docs.copy_image", { item_id: item.id, from_item_id: photo.item.id });
		expect(image).toMatchObject({
			mime_type: "image/jpeg",
			width: 800,
			height: 600,
			name: "photo.jpg",
			untrusted: false,
		});
		// The doc has its own copy: the delete of the file changes nothing.
		await ada.call("drive.trash_items", { item_ids: [photo.item.id] });
		await ada.call("drive.delete_items", { item_ids: [photo.item.id] });
		await drainDrive(ada.id);
		expect((await ada.call("docs.get_image", { item_id: item.id, image_id: image.id })).content_base64).toBe(
			toBase64(bytes),
		);
		const text = await ada.call("drive.upload_file", {
			name: "notes.png",
			mime_type: "image/png",
			content_base64: toBase64(bytesOf("not an image")),
		});
		expect(await codeOf(ada.call("docs.copy_image", { item_id: item.id, from_item_id: text.item.id }))).toBe("invalid");
	});

	it("copies an image of a different doc with the same id, one time", async () => {
		const source = (await ada.call("docs.create", { name: "Source" })).item;
		const target = (await ada.call("docs.create", { name: "Target" })).item;
		const bytes = png(64, 64);
		const { image } = await upload(ada, source.id, bytes);
		const input = { item_id: target.id, from_item_id: source.id, from_image_id: image.id };
		const first = await ada.call("docs.copy_image", input);
		expect(first.image).toMatchObject({ id: image.id, width: 64, height: 64, size: bytes.byteLength });
		await ada.call("docs.copy_image", input);
		expect((await ada.call("docs.get", { item_id: target.id })).images).toHaveLength(1);
		// A copy from the doc itself adds nothing. The editor uses it for an image that a second tab added.
		const same = await ada.call("docs.copy_image", {
			item_id: source.id,
			from_item_id: source.id,
			from_image_id: image.id,
		});
		expect(same.image).toEqual(image);
		expect((await ada.call("docs.get", { item_id: source.id })).images).toHaveLength(1);
		// Content that names the image is good in the target now.
		await ada.call("docs.update", { item_id: target.id, content: imageIn({ id: image.id }) });
		expect((await ada.call("docs.get_image", { item_id: target.id, image_id: image.id })).content_base64).toBe(
			toBase64(bytes),
		);
		expect(
			await codeOf(ada.call("docs.copy_image", { ...input, from_image_id: "img_00000000000000000000000000" })),
		).toBe("not_found");
	});

	// The copy must not be a way to read an image of a doc, or a file, that the caller cannot read.
	it("needs the viewer role for the source and the editor role for the doc", async () => {
		const secret = (await ada.call("docs.create", { name: "Secret" })).item;
		const { image } = await upload(ada, secret.id, png(64, 64));
		const file = await ada.call("drive.upload_file", {
			name: "secret.png",
			mime_type: "image/png",
			content_base64: toBase64(png(8, 8)),
		});
		const own = (await bot.call("docs.create", { name: "Mine" })).item;
		const fromDoc = { item_id: own.id, from_space_id: ada.id, from_item_id: secret.id, from_image_id: image.id };
		const fromFile = { item_id: own.id, from_space_id: ada.id, from_item_id: file.item.id };
		expect(await codeOf(bot.call("docs.copy_image", fromDoc))).toBe("not_found");
		expect(await codeOf(bot.call("docs.copy_image", fromFile))).toBe("not_found");
		expect((await bot.call("docs.get", { item_id: own.id })).images).toEqual([]);
		await ada.call("drive.share_item", { item_id: secret.id, principal_id: bot.id, role: "viewer" });
		expect((await bot.call("docs.copy_image", fromDoc)).image.id).toBe(image.id);
		// A viewer of a doc cannot copy an image into it.
		expect(
			await codeOf(
				bot.call("docs.copy_image", {
					item_id: secret.id,
					space_id: ada.id,
					from_item_id: own.id,
					from_image_id: image.id,
				}),
			),
		).toBe("forbidden");
	});
});

describe("docs.import_image", () => {
	/** Answers each outbound request of the Worker, and records the address of each one. */
	function web(respond: (url: string) => Response): string[] {
		const requests: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const outgoing = new Request(input, init);
			requests.push(outgoing.url);
			expect(outgoing.headers.get("cookie")).toBeNull();
			expect(outgoing.headers.get("authorization")).toBeNull();
			return respond(outgoing.url);
		});
		return requests;
	}

	const imageResponse = (bytes: Uint8Array) => new Response(bytes, { headers: { "content-type": "text/html" } });

	it("downloads the image one time and marks it as untrusted content, also for an MCP client", async () => {
		const { item } = await ada.call("docs.create", { name: "Report" });
		const bytes = WEBP.extended(1024, 512);
		const requests = web(() => imageResponse(bytes));
		const { image } = await ada.call("docs.import_image", {
			item_id: item.id,
			url: "https://images.example.com/chart.webp?size=large",
			name: "chart.webp",
		});
		expect(image).toMatchObject({
			mime_type: "image/webp",
			width: 1024,
			height: 512,
			name: "chart.webp",
			untrusted: true,
		});
		expect(requests).toEqual(["https://images.example.com/chart.webp?size=large"]);
		expect((await ada.call("docs.get_image", { item_id: item.id, image_id: image.id })).content_base64).toBe(
			toBase64(bytes),
		);
		// A copy of the image into a different doc is still untrusted.
		const other = (await ada.call("docs.create", { name: "Other" })).item;
		const copied = await ada.call("docs.copy_image", {
			item_id: other.id,
			from_item_id: item.id,
			from_image_id: image.id,
		});
		expect(copied.image.untrusted).toBe(true);
		const result = await callTool(ada.key, "docs_get", { item_id: item.id });
		expect(result.content[0]?.text).toBe(UNTRUSTED_NOTICE);
	});

	it("refuses an address that is not a public https address, before a request", async () => {
		const { item } = await ada.call("docs.create", { name: "Report" });
		const requests = web(() => imageResponse(png(10, 10)));
		for (const url of [
			"http://images.example.com/a.png",
			"https://127.0.0.1/a.png",
			"https://[::1]/a.png",
			"https://localhost/a.png",
			"https://storage.internal/a.png",
			"https://images.example.com:8443/a.png",
			"https://user:pass@images.example.com/a.png",
			"https://dock.test/api/v1/system/ping",
			"data:image/png;base64,AAAA",
			"not an address",
		]) {
			expect(await codeOf(ada.call("docs.import_image", { item_id: item.id, url })), url).toBe("invalid");
		}
		expect(requests).toEqual([]);
	});

	it("checks each redirect as the first address, and follows a few redirects only", async () => {
		const { item } = await ada.call("docs.create", { name: "Report" });
		const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });
		let requests = web((url) =>
			url.endsWith("/start") ? redirect("https://cdn.example.net/final.png") : imageResponse(png(30, 30)),
		);
		const { image } = await ada.call("docs.import_image", {
			item_id: item.id,
			url: "https://images.example.com/start",
		});
		expect(image.width).toBe(30);
		expect(requests).toEqual(["https://images.example.com/start", "https://cdn.example.net/final.png"]);
		vi.restoreAllMocks();
		requests = web(() => redirect("https://dock.test/api/v1/system/ping"));
		expect(await codeOf(ada.call("docs.import_image", { item_id: item.id, url: "https://images.example.com/a" }))).toBe(
			"invalid",
		);
		expect(requests).toEqual(["https://images.example.com/a"]);
		vi.restoreAllMocks();
		requests = web((url) => redirect(`${url}x`));
		expect(await codeOf(ada.call("docs.import_image", { item_id: item.id, url: "https://images.example.com/a" }))).toBe(
			"invalid",
		);
		expect(requests).toHaveLength(4);
	});

	it("refuses an answer that is not an image, an error answer, and a file over the limit", async () => {
		const { item } = await ada.call("docs.create", { name: "Report" });
		const url = "https://images.example.com/a.png";
		web(() => new Response("<html>Sign in</html>", { headers: { "content-type": "image/png" } }));
		expect(await codeOf(ada.call("docs.import_image", { item_id: item.id, url }))).toBe("invalid");
		vi.restoreAllMocks();
		web(() => new Response("gone", { status: 404 }));
		expect(await codeOf(ada.call("docs.import_image", { item_id: item.id, url }))).toBe("invalid");
		vi.restoreAllMocks();
		web(() => new Response(png(10, 10), { headers: { "content-length": String(DOC_LIMITS.imageBytes + 1) } }));
		expect(await codeOf(ada.call("docs.import_image", { item_id: item.id, url }))).toBe("payload_too_large");
		vi.restoreAllMocks();
		// A server that gives no length: the download stops at the limit.
		const chunk = new Uint8Array(1024 * 1024);
		let sent = 0;
		web(
			() =>
				new Response(
					new ReadableStream({
						pull(controller) {
							sent++;
							controller.enqueue(chunk);
						},
					}),
				),
		);
		expect(await codeOf(ada.call("docs.import_image", { item_id: item.id, url }))).toBe("payload_too_large");
		expect(sent).toBeLessThan(20);
		vi.restoreAllMocks();
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network"));
		expect(await codeOf(ada.call("docs.import_image", { item_id: item.id, url }))).toBe("unavailable");
		vi.restoreAllMocks();
		// The download has a time limit: the request gets a signal, and its end is not an internal error.
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			expect(init?.signal).toBeInstanceOf(AbortSignal);
			throw new DOMException("The operation timed out.", "TimeoutError");
		});
		await expect(ada.call("docs.import_image", { item_id: item.id, url })).rejects.toMatchObject({
			code: "unavailable",
			message: expect.stringContaining("in time"),
		});
		expect((await ada.call("docs.get", { item_id: item.id })).images).toEqual([]);
		expect(await imageKeys(item.id)).toEqual([]);
	});

	// A request to a web address can carry data out in the address. The outbound policy of the agent applies.
	it("follows the outbound policy of an agent, also for a redirect", async () => {
		const { item } = await bot.call("docs.create", { name: "Report" });
		const url = "https://images.example.com/a.png";
		let requests = web(() => imageResponse(png(10, 10)));
		await expect(bot.call("docs.import_image", { item_id: item.id, url })).rejects.toMatchObject({
			code: "policy_denied",
			message: expect.stringContaining("images.example.com"),
		});
		expect(requests).toEqual([]);
		await owner.call("directory.update_agent_policy", {
			principal_id: bot.id,
			mode: "allowlist",
			allowlist: ["images.example.com"],
		});
		expect((await bot.call("docs.import_image", { item_id: item.id, url })).image.untrusted).toBe(true);
		vi.restoreAllMocks();
		requests = web(
			() => new Response(null, { status: 301, headers: { location: "https://other.example.org/?q=secret" } }),
		);
		expect(await codeOf(bot.call("docs.import_image", { item_id: item.id, url }))).toBe("policy_denied");
		expect(requests).toEqual([url]);
	});
});
