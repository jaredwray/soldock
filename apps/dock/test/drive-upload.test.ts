import { createExecutionContext, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { DRIVE_LIMITS, driveDownloadPath, driveUploadPartPath } from "@asterra/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import {
	type Actor,
	api,
	base64,
	callTool,
	codeOf,
	drainDrive,
	driveBlobKeys,
	ORIGIN,
	request,
	seedOrg,
	signIn,
} from "./helpers.ts";

let owner: Actor;
let ada: Actor;
let bot: Actor;

beforeEach(async () => {
	({ owner, ada, bot } = await seedOrg());
});

const MiB = 1024 * 1024;
const PART = DRIVE_LIMITS.uploadPartBytes;

/** Bytes that differ in each part, so a part in the wrong place changes the file. */
function bytesOf(size: number, seed = 1): Uint8Array {
	const bytes = new Uint8Array(size);
	const words = new Uint32Array(bytes.buffer, 0, Math.floor(size / 4));
	let state = seed >>> 0 || 1;
	for (let index = 0; index < words.length; index++) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		words[index] = state >>> 0;
	}
	for (let index = words.length * 4; index < size; index++) bytes[index] = index & 0xff;
	return bytes;
}

async function sha256(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const bearer = (actor: Actor) => ({ authorization: `Bearer ${actor.key}` });

/** The bytes of part `number` of a file. */
const partOf = (bytes: Uint8Array, number: number) => bytes.subarray((number - 1) * PART, number * PART);

/** Sends the raw bytes of one part, as the web app does. */
function putPart(
	headers: Record<string, string>,
	spaceId: string,
	uploadId: string,
	number: number,
	bytes: Uint8Array,
	fetcher: (request: Request) => Promise<Response> = async (req) => exports.default.fetch(req),
) {
	return fetcher(
		new Request(`${ORIGIN}${driveUploadPartPath(spaceId, uploadId, number)}`, {
			method: "PUT",
			headers: { ...headers, "content-length": String(bytes.byteLength) },
			body: bytes,
		}),
	);
}

/** Sends a request to the Worker with a different R2 binding. */
function withBlobs(blobs: R2Bucket) {
	return async (req: Request) =>
		(worker as unknown as Required<Pick<ExportedHandler<Env>, "fetch">>).fetch(
			req as Parameters<NonNullable<ExportedHandler<Env>["fetch"]>>[0],
			{ ...env, BLOBS: blobs } as unknown as Env,
			createExecutionContext(),
		);
}

/** An R2 binding whose next `uploadPart` fails. */
function failingPartUpload(): R2Bucket {
	let failed = false;
	return new Proxy(env.BLOBS, {
		get(target, property) {
			if (property === "resumeMultipartUpload") {
				return (key: string, uploadId: string) => {
					const multipart = target.resumeMultipartUpload(key, uploadId);
					return {
						uploadId: multipart.uploadId,
						key: multipart.key,
						uploadPart: (number: number, value: ReadableStream) => {
							if (!failed) {
								failed = true;
								return value.cancel().then(() => Promise.reject(new Error("R2 is not available")));
							}
							return multipart.uploadPart(number, value);
						},
						abort: () => multipart.abort(),
						complete: (parts: R2UploadedPart[]) => multipart.complete(parts),
					};
				};
			}
			const value = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** Runs the alarm of a drive with a stopped clock. */
async function expireUploads(spaceId: string) {
	const stub = env.DRIVE_SPACE.get(env.DRIVE_SPACE.idFromName(spaceId));
	await runInDurableObject(stub, (_instance, state) => {
		state.storage.sql.exec("UPDATE uploads SET expires_at = ?", Date.now() - 1);
	});
	await runDurableObjectAlarm(stub);
}

async function uploadRows(spaceId: string): Promise<number> {
	const stub = env.DRIVE_SPACE.get(env.DRIVE_SPACE.idFromName(spaceId));
	return runInDurableObject(
		stub,
		(_instance, state) =>
			state.storage.sql
				.exec<{ n: number }>("SELECT (SELECT COUNT(*) FROM uploads) + (SELECT COUNT(*) FROM upload_parts) AS n")
				.one().n,
	);
}

/** Uploads a file in parts through the raw path, and returns the new item. */
async function uploadInParts(actor: Actor, bytes: Uint8Array, extra: { parent_id?: string; space_id?: string } = {}) {
	const { upload } = await actor.call("drive.create_upload", { name: "big.bin", size: bytes.byteLength, ...extra });
	for (let number = 1; number <= upload.part_count; number++) {
		const res = await putPart(bearer(actor), upload.space_id, upload.id, number, partOf(bytes, number));
		expect(res.status).toBe(200);
	}
	return (await actor.call("drive.complete_upload", { space_id: upload.space_id, upload_id: upload.id })).item;
}

describe("an upload in parts", () => {
	// Acceptance of issue 74: a file of 100 MB uploads, and a part that fails uploads again without a new start.
	it("uploads a file of 100 MB, and sends a part that failed again without a new start", {
		timeout: 60_000,
	}, async () => {
		const bytes = bytesOf(100_000_000);
		const hash = await sha256(bytes);
		const { upload } = await ada.call("drive.create_upload", {
			name: "video.mp4",
			size: bytes.byteLength,
			sha256: hash,
		});
		expect(upload).toMatchObject({ part_size: PART, part_count: 12, parts_received: [], state: "open", item_id: null });

		// R2 fails on part 5. A part with the wrong size never reaches R2.
		const failed = await putPart(bearer(ada), ada.id, upload.id, 5, partOf(bytes, 5), withBlobs(failingPartUpload()));
		expect(failed.status).toBe(503);
		const short = await putPart(bearer(ada), ada.id, upload.id, 6, partOf(bytes, 6).subarray(1));
		expect(short.status).toBe(400);
		for (let number = 1; number <= 12; number++) {
			if (number === 5) continue;
			expect((await putPart(bearer(ada), ada.id, upload.id, number, partOf(bytes, number))).status).toBe(200);
		}
		// The upload kept each part that arrived, so only part 5 goes again.
		const state = await ada.call("drive.get_upload", { upload_id: upload.id });
		expect(state.upload.parts_received).toEqual([1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12]);
		expect(await codeOf(ada.call("drive.complete_upload", { upload_id: upload.id }))).toBe("invalid");
		expect((await putPart(bearer(ada), ada.id, upload.id, 5, partOf(bytes, 5))).status).toBe(200);

		const { item } = await ada.call("drive.complete_upload", { upload_id: upload.id });
		expect(item).toMatchObject({ name: "video.mp4", size: 100_000_000, kind: "file" });
		const { versions } = await ada.call("drive.list_versions", { item_id: item.id });
		expect(versions[0]?.sha256).toBe(hash);
		// The same file comes back whole from the download path.
		const res = await request(driveDownloadPath(ada.id, item.id), { headers: bearer(ada) });
		expect(res.status).toBe(200);
		expect(await sha256(new Uint8Array(await res.arrayBuffer()))).toBe(hash);
		expect((await ada.call("drive.get_upload", { upload_id: upload.id })).upload).toMatchObject({
			state: "done",
			item_id: item.id,
		});
	});

	// Parity: an agent without a raw path does the same upload through MCP, with base64 parts.
	it("uploads in parts through the MCP tools, for an agent in its own drive", async () => {
		const bytes = bytesOf(PART + 3 * MiB, 7);
		const created = await callTool(bot.key, "drive_create_upload", { name: "data.bin", size: bytes.byteLength });
		const upload = (created.structuredContent as { upload: { id: string; part_count: number } }).upload;
		expect(upload.part_count).toBe(2);
		for (const number of [2, 1]) {
			const sent = await callTool(bot.key, "drive_upload_part", {
				upload_id: upload.id,
				part_number: number,
				content_base64: btoa(Array.from(partOf(bytes, number), (byte) => String.fromCharCode(byte)).join("")),
			});
			expect(sent.isError).not.toBe(true);
		}
		const done = await callTool(bot.key, "drive_complete_upload", { upload_id: upload.id });
		const item = (done.structuredContent as { item: { id: string; size: number } }).item;
		expect(item.size).toBe(bytes.byteLength);
		const { versions } = await bot.call("drive.list_versions", { item_id: item.id });
		expect(versions[0]?.sha256).toBe(await sha256(bytes));
	});

	// A browser sends the session cookie with a request from each site. A part is a change.
	it("takes a part with the session cookie only from this origin", async () => {
		const cookie = await signIn(ada.address);
		const bytes = bytesOf(1000);
		const { upload } = await ada.call("drive.create_upload", { name: "a.bin", size: bytes.byteLength });
		const foreign = await putPart({ cookie }, ada.id, upload.id, 1, bytes);
		expect(foreign.status).toBe(403);
		const own = await putPart({ cookie, origin: ORIGIN }, ada.id, upload.id, 1, bytes);
		expect(own.status).toBe(200);
		expect(((await own.json()) as { upload: { parts_received: number[] } }).upload.parts_received).toEqual([1]);
	});

	// The upload belongs to the principal that started it, also in a folder that others can write to.
	it("gives the upload of a different principal as not_found, also to an editor of the folder", async () => {
		const { item: folder } = await ada.call("drive.create_folder", { name: "Team" });
		await ada.call("drive.share_item", { item_id: folder.id, principal_id: bot.id, role: "editor" });
		const bytes = bytesOf(1000);
		const { upload } = await ada.call("drive.create_upload", {
			name: "a.bin",
			size: bytes.byteLength,
			parent_id: folder.id,
		});
		expect((await putPart(bearer(bot), ada.id, upload.id, 1, bytes)).status).toBe(404);
		for (const name of ["drive.get_upload", "drive.complete_upload"] as const) {
			expect(await codeOf(bot.call(name, { space_id: ada.id, upload_id: upload.id }))).toBe("not_found");
		}
		expect(await bot.call("drive.abort_upload", { space_id: ada.id, upload_id: upload.id })).toEqual({
			aborted: false,
		});
		// The editor can upload in parts to the folder: the owner of the drive owns the file.
		const item = await uploadInParts(bot, bytes, { space_id: ada.id, parent_id: folder.id });
		expect(item).toMatchObject({ space_id: ada.id, parent_id: folder.id, role: "editor" });
		// A viewer cannot start an upload in the folder.
		await ada.call("drive.share_item", { item_id: folder.id, principal_id: owner.id, role: "viewer" });
		expect(
			await codeOf(owner.call("drive.create_upload", { space_id: ada.id, parent_id: folder.id, name: "x", size: 10 })),
		).toBe("forbidden");
	});

	// A key with drive.read cannot write, and a key without drive.read cannot download.
	it("checks the scopes of the credential on each path", async () => {
		const { api_key: reader } = await ada.call("account.create_api_key", { label: "read", scopes: ["drive.read"] });
		const { api_key: writer } = await ada.call("account.create_api_key", { label: "write", scopes: ["drive.write"] });
		const bytes = bytesOf(1000);
		expect(await codeOf(api(reader.secret)("drive.create_upload", { name: "a.bin", size: 1000 }))).toBe("forbidden");
		const { upload } = await api(writer.secret)("drive.create_upload", { name: "a.bin", size: 1000 });
		const refused = await putPart({ authorization: `Bearer ${reader.secret}` }, ada.id, upload.id, 1, bytes);
		expect(refused.status).toBe(403);
		expect((await putPart({ authorization: `Bearer ${writer.secret}` }, ada.id, upload.id, 1, bytes)).status).toBe(200);
		const { item } = await api(writer.secret)("drive.complete_upload", { upload_id: upload.id });
		const path = driveDownloadPath(ada.id, item.id);
		expect((await request(path, { headers: { authorization: `Bearer ${writer.secret}` } })).status).toBe(403);
		expect((await request(path, { headers: { authorization: `Bearer ${reader.secret}` } })).status).toBe(200);
	});

	it("returns the same upload for a key, and the same file for a second completion", async () => {
		const bytes = bytesOf(1000);
		const input = { name: "a.bin", size: bytes.byteLength, idempotency_key: "k1" };
		const first = await ada.call("drive.create_upload", input);
		expect((await ada.call("drive.create_upload", input)).upload.id).toBe(first.upload.id);
		expect(await codeOf(ada.call("drive.create_upload", { ...input, name: "b.bin" }))).toBe("conflict");
		expect((await putPart(bearer(ada), ada.id, first.upload.id, 1, bytes)).status).toBe(200);
		const done = await ada.call("drive.complete_upload", { upload_id: first.upload.id });
		const again = await ada.call("drive.complete_upload", { upload_id: first.upload.id });
		expect(again.item.id).toBe(done.item.id);
		expect((await ada.call("drive.list_items", {})).items.map((item) => item.name)).toEqual(["a.bin"]);
		// A done upload takes no part, and a stop keeps its file.
		expect((await putPart(bearer(ada), ada.id, first.upload.id, 1, bytes)).status).toBe(400);
		expect(await ada.call("drive.abort_upload", { upload_id: first.upload.id })).toEqual({ aborted: false });
	});

	// Review of issue 74: a second completion that failed after the first one deleted the bytes of the file.
	it("keeps the bytes of the file when a second completion fails after the first one", async () => {
		const bytes = bytesOf(1000);
		const { upload } = await ada.call("drive.create_upload", { name: "a.bin", size: bytes.byteLength });
		expect((await putPart(bearer(ada), ada.id, upload.id, 1, bytes)).status).toBe(200);
		let firstItem = "";
		// The first completion ends while the second one reads the joined object, and then the upload expires.
		const blobs = new Proxy(env.BLOBS, {
			get(target, property) {
				if (property === "get") {
					return async (key: string, options?: R2GetOptions) => {
						if (firstItem === "" && options === undefined) {
							firstItem = (await ada.call("drive.complete_upload", { upload_id: upload.id })).item.id;
							await runInDurableObject(env.DRIVE_SPACE.get(env.DRIVE_SPACE.idFromName(ada.id)), (_i, state) => {
								state.storage.sql.exec("UPDATE uploads SET expires_at = ?", Date.now() - 1);
							});
						}
						return target.get(key, options as R2GetOptions);
					};
				}
				const value = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const second = await withBlobs(blobs)(
			new Request(`${ORIGIN}/api/v1/drive/uploads/${upload.id}/complete`, {
				method: "POST",
				headers: { ...bearer(ada), "content-type": "application/json" },
				body: "{}",
			}),
		);
		expect(second.status).toBe(404);
		await drainDrive(ada.id);
		const got = await ada.call("drive.download_file", { item_id: firstItem });
		expect(got.size).toBe(1000);
	});

	// Review of issue 74: a principal that lost its role in the folder sends no more parts.
	it("stops the parts of a principal that lost the access to the folder", async () => {
		const { item: folder } = await ada.call("drive.create_folder", { name: "Team" });
		await ada.call("drive.share_item", { item_id: folder.id, principal_id: bot.id, role: "editor" });
		const bytes = bytesOf(1000);
		const { upload } = await bot.call("drive.create_upload", {
			space_id: ada.id,
			parent_id: folder.id,
			name: "a.bin",
			size: bytes.byteLength,
		});
		await ada.call("drive.unshare_item", { item_id: folder.id, principal_id: bot.id });
		expect((await putPart(bearer(bot), ada.id, upload.id, 1, bytes)).status).toBe(404);
		expect(await codeOf(bot.call("drive.get_upload", { space_id: ada.id, upload_id: upload.id }))).toBe("not_found");
	});

	// Review of issue 74: a camera JPEG has its EXIF data before the frame header, past the first 4 KiB.
	it("finds a JPEG with a large EXIF block, so the picture gets a preview", async () => {
		const exif = new Uint8Array(8004);
		exif.set([0xff, 0xe1, 0x1f, 0x42]);
		exif.set(new TextEncoder().encode("Exif\0\0"), 4);
		const frame = [
			0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x04, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xd9,
		];
		const jpeg = new Uint8Array([0xff, 0xd8, ...exif, ...frame]);
		const { item } = await ada.call("drive.upload_file", {
			name: "photo.jpg",
			content_base64: btoa(Array.from(jpeg, (byte) => String.fromCharCode(byte)).join("")),
		});
		const { versions } = await ada.call("drive.list_versions", { item_id: item.id });
		expect(versions[0]?.detected_type).toBe("image/jpeg");
		const res = await request(driveDownloadPath(ada.id, item.id), { headers: bearer(ada) });
		expect(res.headers.get("content-type")).toBe("image/jpeg");
	});

	it("removes an upload whose parts do not have the SHA-256 of the start", async () => {
		const bytes = bytesOf(1000);
		const { upload } = await ada.call("drive.create_upload", {
			name: "a.bin",
			size: bytes.byteLength,
			sha256: "0".repeat(64),
		});
		expect((await putPart(bearer(ada), ada.id, upload.id, 1, bytes)).status).toBe(200);
		expect(await codeOf(ada.call("drive.complete_upload", { upload_id: upload.id }))).toBe("conflict");
		expect(await codeOf(ada.call("drive.get_upload", { upload_id: upload.id }))).toBe("not_found");
		await drainDrive(ada.id);
		expect(await driveBlobKeys(ada.id)).toEqual([]);
		expect((await ada.call("drive.list_items", {})).items).toEqual([]);
	});

	// The check of the folder runs again at the completion, before R2 joins the parts.
	it("refuses the file while the folder is in the trash, and keeps the parts for a later call", async () => {
		const { item: folder } = await ada.call("drive.create_folder", { name: "Later" });
		const bytes = bytesOf(1000);
		const { upload } = await ada.call("drive.create_upload", {
			name: "a.bin",
			size: bytes.byteLength,
			parent_id: folder.id,
		});
		expect((await putPart(bearer(ada), ada.id, upload.id, 1, bytes)).status).toBe(200);
		await ada.call("drive.trash_items", { item_ids: [folder.id] });
		expect(await codeOf(ada.call("drive.complete_upload", { upload_id: upload.id }))).toBe("invalid");
		expect((await ada.call("drive.list_items", { parent_id: folder.id, view: "folder" })).items).toEqual([]);
		await ada.call("drive.restore_items", { item_ids: [folder.id] });
		const { item } = await ada.call("drive.complete_upload", { upload_id: upload.id });
		expect(item.parent_id).toBe(folder.id);
	});

	it("removes an upload after its time, with its parts", async () => {
		const bytes = bytesOf(1000);
		const { upload } = await ada.call("drive.create_upload", { name: "a.bin", size: bytes.byteLength });
		expect((await putPart(bearer(ada), ada.id, upload.id, 1, bytes)).status).toBe(200);
		await expireUploads(ada.id);
		expect(await uploadRows(ada.id)).toBe(0);
		expect((await putPart(bearer(ada), ada.id, upload.id, 1, bytes)).status).toBe(404);
		await drainDrive(ada.id);
		expect(await driveBlobKeys(ada.id)).toEqual([]);
	});

	it("stops an upload, and limits the open uploads of one principal", async () => {
		const opened = [];
		for (let index = 0; index < DRIVE_LIMITS.openUploads; index++) {
			opened.push((await ada.call("drive.create_upload", { name: `f${index}`, size: 10 })).upload);
		}
		expect(await codeOf(ada.call("drive.create_upload", { name: "one more", size: 10 }))).toBe("conflict");
		expect(await ada.call("drive.abort_upload", { upload_id: opened[0]?.id as string })).toEqual({ aborted: true });
		expect(await ada.call("drive.abort_upload", { upload_id: opened[0]?.id as string })).toEqual({ aborted: false });
		expect((await ada.call("drive.create_upload", { name: "one more", size: 10 })).upload.state).toBe("open");
		// The limit is for each principal: a different principal can start an upload.
		expect((await bot.call("drive.create_upload", { name: "bot", size: 10 })).upload.state).toBe("open");
	});

	it("refuses a file over the limit at the start", async () => {
		expect(await codeOf(ada.call("drive.create_upload", { name: "huge", size: DRIVE_LIMITS.uploadBytes + 1 }))).toBe(
			"invalid",
		);
		expect(
			(
				await request(driveUploadPartPath(ada.id, "upl_01JD0000000000000000000000", 1), {
					method: "PUT",
					headers: { ...bearer(ada), "content-length": String(PART + 1) },
					body: new Uint8Array(PART + 1),
				})
			).status,
		).toBe(413);
	});
});

describe("a download under /dl/", () => {
	const html = "<html><script>alert(1)</script></html>";

	// Acceptance of issue 74: each download checks the access, and no address works without a credential.
	it("checks the access on each download, and works only with a credential", async () => {
		const { item } = await ada.call("drive.upload_file", {
			name: "page.html",
			mime_type: "text/html",
			content_base64: base64(html),
		});
		const path = driveDownloadPath(ada.id, item.id);
		const anonymous = await request(path);
		expect(anonymous.status).toBe(401);
		expect(anonymous.headers.get("www-authenticate")).toContain("Bearer");

		const res = await request(path, { headers: bearer(ada) });
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(html);
		// User content never runs as active content on the origin.
		expect(Object.fromEntries(res.headers)).toMatchObject({
			"content-type": "application/octet-stream",
			"content-disposition": `attachment; filename="page.html"; filename*=UTF-8''page.html`,
			"x-content-type-options": "nosniff",
			"content-security-policy": "default-src 'none'; sandbox; frame-ancestors 'none'",
			"cache-control": "private, no-store",
			"cross-origin-resource-policy": "same-origin",
		});

		expect((await request(path, { headers: bearer(bot) })).status).toBe(404);
		await ada.call("drive.share_item", { item_id: item.id, principal_id: bot.id, role: "viewer" });
		expect((await request(path, { headers: bearer(bot) })).status).toBe(200);
		await ada.call("drive.unshare_item", { item_id: item.id, principal_id: bot.id });
		expect((await request(path, { headers: bearer(bot) })).status).toBe(404);
		await ada.call("drive.share_item", { item_id: item.id, principal_id: bot.id, role: "viewer" });
		await ada.call("drive.trash_items", { item_ids: [item.id] });
		expect((await request(path, { headers: bearer(bot) })).status).toBe(404);
	});

	it("takes the session cookie from this origin only", async () => {
		const cookie = await signIn(ada.address);
		const { item } = await ada.call("drive.upload_file", { name: "a.txt", content_base64: base64("hello") });
		const path = driveDownloadPath(ada.id, item.id);
		expect((await request(path, { headers: { cookie, "sec-fetch-site": "same-origin" } })).status).toBe(200);
		expect((await request(path, { headers: { cookie, "sec-fetch-site": "none" } })).status).toBe(200);
		expect((await request(path, { headers: { cookie, "sec-fetch-site": "cross-site" } })).status).toBe(403);
		expect((await request(path, { headers: { cookie, "sec-fetch-site": "same-site" } })).status).toBe(403);
	});

	it("serves one range of bytes, and the length for HEAD", async () => {
		const text = "0123456789";
		const { item } = await ada.call("drive.upload_file", { name: "digits.txt", content_base64: base64(text) });
		const path = driveDownloadPath(ada.id, item.id);
		const ranged = async (range: string, extra: Record<string, string> = {}) =>
			request(path, { headers: { ...bearer(ada), range, ...extra } });
		const cases: [string, number, string, string | null][] = [
			["bytes=2-4", 206, "234", "bytes 2-4/10"],
			["bytes=7-", 206, "789", "bytes 7-9/10"],
			["bytes=-2", 206, "89", "bytes 8-9/10"],
			["bytes=5-100", 206, "56789", "bytes 5-9/10"],
			["bytes=0-1,4-5", 200, text, null],
		];
		for (const [range, status, body, contentRange] of cases) {
			const res = await ranged(range);
			expect([range, res.status, await res.text(), res.headers.get("content-range")]).toEqual([
				range,
				status,
				body,
				contentRange,
			]);
		}
		const past = await ranged("bytes=10-");
		expect([past.status, past.headers.get("content-range")]).toEqual([416, "bytes */10"]);
		// A range for a different version of the file gets all the bytes.
		const stale = await ranged("bytes=2-4", { "if-range": '"ver_old"' });
		expect([stale.status, await stale.text()]).toEqual([200, text]);
		const head = await request(path, { method: "HEAD", headers: bearer(ada) });
		expect([head.status, head.headers.get("content-length"), await head.text()]).toEqual([200, "10", ""]);
	});

	it("keeps one JSON answer at 10 MiB, and gives larger files in ranges", async () => {
		const bytes = bytesOf(DRIVE_LIMITS.fileBytes + 10, 3);
		const item = await uploadInParts(ada, bytes);
		expect(await codeOf(ada.call("drive.download_file", { item_id: item.id }))).toBe("payload_too_large");
		const tail = await ada.call("drive.download_file", {
			item_id: item.id,
			offset: DRIVE_LIMITS.fileBytes,
			length: 100,
		});
		expect(tail).toMatchObject({ size: bytes.byteLength, offset: DRIVE_LIMITS.fileBytes, length: 10 });
		const got = Uint8Array.from(atob(tail.content_base64), (char) => char.charCodeAt(0));
		expect([...got]).toEqual([...bytes.subarray(DRIVE_LIMITS.fileBytes)]);
		expect(await codeOf(ada.call("drive.download_file", { item_id: item.id, offset: bytes.byteLength }))).toBe(
			"invalid",
		);
		// An image of a doc comes from a file of at most 10 MiB.
		const doc = (await ada.call("docs.create", { name: "Doc" })).item;
		expect(await codeOf(ada.call("docs.copy_image", { item_id: doc.id, from_item_id: item.id }))).toBe(
			"payload_too_large",
		);
	});
});
